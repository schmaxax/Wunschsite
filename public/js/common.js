'use strict';

const GUEST_TOKEN_KEY = 'wunschsite.guestToken';
const GUEST_NAME_KEY = 'wunschsite.guestName';

function guestToken() {
  let token = localStorage.getItem(GUEST_TOKEN_KEY);
  if (!token || !/^[a-f0-9]{32,128}$/.test(token)) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(GUEST_TOKEN_KEY, token);
  }
  return token;
}

const NO_SERVER_MESSAGE = 'Der Wunschsite-Server läuft nicht.\n\nStarte ihn im Projektordner mit „npm start“ und öffne dann http://localhost:3000';

async function api(method, url, body) {
  if (location.protocol === 'file:') throw new Error(NO_SERVER_MESSAGE);
  const options = { method, headers: { 'X-Guest-Token': guestToken() }, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new Error(NO_SERVER_MESSAGE);
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  if (res.status !== 204 && !isJson) throw new Error(NO_SERVER_MESSAGE);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Da ist etwas schiefgelaufen (Fehler ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function loadMe() {
  try {
    return (await api('GET', '/api/me')).user;
  } catch {
    return null;
  }
}

/** Baut DOM-Elemente. Text-Kinder werden immer als Text eingefügt, nie als HTML. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function setChildren(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
}

// ---------- Formatierung ----------

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const formatPrice = (cents) => (cents == null ? '' : euro.format(cents / 100));
const priceInput = (cents) => (cents == null ? '' : (cents / 100).toFixed(2).replace('.', ',').replace(',00', ''));

function formatDate(value, withTime = false) {
  if (!value) return '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return date.toLocaleDateString('de-DE', withTime
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'long', year: 'numeric' });
}

function countdown(isoDate) {
  if (!isoDate) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(`${isoDate}T00:00:00`) - today) / 86_400_000);
  if (days > 1) return `noch ${days} Tage`;
  if (days === 1) return 'morgen!';
  if (days === 0) return 'heute!';
  return 'schon vorbei';
}

const PRIORITIES = { 1: 'Wäre nett', 2: 'Würde mich freuen', 3: 'Herzenswunsch' };

function stars(priority) {
  return h('span', { class: 'stars', title: PRIORITIES[priority], 'aria-label': `Wichtigkeit: ${PRIORITIES[priority]}` },
    '★'.repeat(priority) + '☆'.repeat(3 - priority));
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- Fenster-Bausteine ----------

function titleBar(title, { icon = '/favicon.svg', onClose } = {}) {
  return h('div', { class: 'title-bar' },
    h('div', { class: 'title-bar-text' }, h('img', { src: icon, alt: '' }), h('span', {}, title)),
    h('div', { class: 'title-bar-controls' },
      onClose ? h('button', { type: 'button', class: 'tb-btn close', 'aria-label': 'Schließen', onclick: onClose }, '×') : null));
}

function messageBox(message, { title = 'Wunschsite', icon = 'info', buttons = [{ label: 'OK', value: true }] } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const dialog = h('dialog', { class: 'window tb-blue msgbox', role: 'alertdialog', 'aria-label': title });
    const buttonEls = buttons.map((b, i) => h('button', {
      type: 'button',
      class: i === 0 ? 'btn-default' : null,
      onclick: () => { result = b.value; dialog.close(); },
    }, b.label));
    dialog.append(
      titleBar(title, { onClose: () => dialog.close() }),
      h('div', { class: 'window-body' },
        h('div', { class: 'msgbox-content' }, h('img', { src: `/img/icon-${icon}.svg`, alt: '' }), h('p', {}, message)),
        h('div', { class: 'button-row center' }, buttonEls)),
    );
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    document.body.append(dialog);
    dialog.showModal();
    buttonEls[0].focus();
  });
}

const showError = (err) => messageBox(err?.message || String(err), { title: 'Hoppla', icon: 'fehler' });

const confirmBox = (message, { title = 'Bist du sicher?', ok = 'Ja' } = {}) =>
  messageBox(message, { title, icon: 'frage', buttons: [{ label: ok, value: true }, { label: 'Nein', value: false }] });

/** Schließt Dialoge über Elemente mit data-close. */
document.addEventListener('click', (event) => {
  const closer = event.target.closest('[data-close]');
  if (closer) closer.closest('dialog')?.close();
});

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

/** Sperrt den Absenden-Knopf, solange die Anfrage läuft. */
async function busy(form, task) {
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  document.body.style.cursor = 'progress';
  try {
    return await task();
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    document.body.style.cursor = '';
  }
}

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!input) return false;
    input.select();
    return document.execCommand('copy');
  }
}

// ---------- Taskleiste & Startmenü ----------

function initTaskbar({ title, user }) {
  const startBtn = h('button', { type: 'button', class: 'start-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    h('img', { src: '/favicon.svg', alt: '' }), 'Start');
  const clock = h('div', { class: 'tray', 'aria-label': 'Uhrzeit' });
  const tick = () => {
    clock.textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  setInterval(tick, 15_000);

  const entry = (href, icon, label) => h('li', {}, h('a', { href, role: 'menuitem' }, h('img', { src: icon, alt: '' }), label));
  const logout = h('button', {
    type: 'button',
    role: 'menuitem',
    onclick: async () => {
      try {
        await api('POST', '/api/logout');
      } finally {
        location.href = '/';
      }
    },
  }, h('img', { src: '/img/icon-fehler.svg', alt: '' }), 'Abmelden');

  const menu = h('div', { class: 'start-menu', role: 'menu', hidden: true },
    h('div', { class: 'start-menu-stripe', 'aria-hidden': 'true' }, 'Wunsch', h('b', {}, 'site')),
    h('ul', {},
      entry('/', '/favicon.svg', 'Startseite'),
      user ? entry('/meine-listen', '/img/icon-liste.svg', 'Meine Listen') : entry('/#anmelden', '/img/icon-liste.svg', 'Anmelden'),
      user ? h('li', { class: 'sep', role: 'separator' }) : null,
      user ? h('li', {}, logout) : null));

  const setOpen = (open) => {
    menu.hidden = !open;
    startBtn.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('a, button')?.focus();
  };
  startBtn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { setOpen(false); startBtn.focus(); }
  });

  const taskTab = h('div', { class: 'task-tab' }, h('img', { src: '/favicon.svg', alt: '' }), h('span', {}, title));
  document.body.append(menu, h('nav', { class: 'taskbar', 'aria-label': 'Taskleiste' }, startBtn, taskTab, clock));
  return { setTitle: (t) => { taskTab.querySelector('span').textContent = t; } };
}

// ---------- Wunsch-Karte ----------

function wishImage(item) {
  const box = h('div', { class: 'wish-img' });
  const placeholder = () => h('img', { class: 'placeholder', src: '/favicon.svg', alt: '' });
  if (item.imageUrl) {
    const img = h('img', { src: item.imageUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
    box.append(img);
  } else {
    box.append(placeholder());
  }
  return box;
}

function shopName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Shop';
  }
}

function wishCard(item, { actions = [], stamp = null, reserved = false } = {}) {
  return h('article', { class: `wish${reserved ? ' reserved' : ''}` },
    wishImage(item),
    h('div', {},
      h('h3', {}, item.title),
      h('div', { class: 'wish-meta' },
        stars(item.priority),
        item.priceCents != null ? h('span', { class: 'price' }, `ca. ${formatPrice(item.priceCents)}`) : null),
      item.description ? h('p', { class: 'desc' }, item.description) : null,
      h('div', { class: 'actions' },
        item.url ? h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'btn btn-small' }, `Bei ${shopName(item.url)} ansehen`) : null,
        actions)),
    stamp);
}
