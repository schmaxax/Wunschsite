'use strict';

const state = { lists: [], current: null, taskbar: null };
const autoFetch = { timer: null, run: 0, lastUrl: '', filled: {} };

const $ = (id) => document.getElementById(id);
const pane = $('pane');
const setStatus = (text) => { $('status').textContent = text; };

(async () => {
  const user = await loadMe();
  if (!user) {
    location.href = '/#anmelden';
    return;
  }
  state.taskbar = initTaskbar({ title: 'Meine Wunschlisten', user });
  $('user-name').textContent = user.displayName;
  $('status-right').textContent = `Angemeldet als ${user.username}`;

  $('new-list-btn').addEventListener('click', () => openListDialog());
  $('list-form').addEventListener('submit', saveList);
  $('item-form').addEventListener('submit', saveItem);
  $('item-image').addEventListener('input', updatePreview);
  $('item-fetch').addEventListener('click', () => fetchProduct({ force: true }));
  $('item-url').addEventListener('paste', () => setTimeout(() => fetchProduct(), 0));
  $('item-url').addEventListener('input', () => {
    clearTimeout(autoFetch.timer);
    autoFetch.timer = setTimeout(() => fetchProduct(), 900);
  });
  $('item-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fetchProduct({ force: true });
    }
  });
  $('share-copy').addEventListener('click', async () => {
    const ok = await copyText($('share-url').value, $('share-url'));
    $('share-copy').textContent = ok ? 'Kopiert!' : 'Bitte selbst kopieren';
    setTimeout(() => { $('share-copy').textContent = 'Kopieren'; }, 2000);
  });
  window.addEventListener('hashchange', () => {
    const id = idFromHash();
    if (id && id !== state.current?.list.id) selectList(id);
  });

  try {
    await loadLists();
    const id = idFromHash() ?? state.lists[0]?.id;
    if (id && state.lists.some((l) => l.id === id)) await selectList(id);
    else if (state.lists[0]) await selectList(state.lists[0].id);
    else renderEmpty();
  } catch (err) {
    showError(err);
  }
})();

function idFromHash() {
  const match = location.hash.match(/^#liste-(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function loadLists() {
  state.lists = (await api('GET', '/api/lists')).lists;
  renderTree();
}

function renderTree() {
  const tree = $('list-tree');
  tree.replaceChildren();
  if (!state.lists.length) {
    tree.append(h('li', { class: 'empty' }, 'Noch keine Listen.'));
    return;
  }
  for (const list of state.lists) {
    tree.append(h('li', {},
      h('button', {
        type: 'button',
        'aria-current': state.current?.list.id === list.id ? 'true' : null,
        onclick: () => selectList(list.id),
      },
      h('img', { src: '/img/icon-liste.svg', alt: '' }),
      h('span', {}, list.title),
      h('span', { class: 'count' }, list.itemCount))));
  }
}

async function selectList(id) {
  setStatus('Lade Liste…');
  try {
    state.current = await api('GET', `/api/lists/${id}`);
    history.replaceState(null, '', `#liste-${id}`);
    renderTree();
    renderPane();
  } catch (err) {
    showError(err);
  }
}

function renderEmpty() {
  state.current = null;
  renderTree();
  setStatus('Bereit');
  state.taskbar?.setTitle('Meine Wunschlisten');
  document.title = 'Meine Listen – Wunschsite';
  history.replaceState(null, '', location.pathname);
  pane.replaceChildren(h('div', { class: 'empty-state' },
    h('img', { src: '/favicon.svg', alt: '' }),
    h('h2', {}, 'Hier ist noch alles leer'),
    h('p', {}, 'Leg deine erste Wunschliste an. Danach kannst du Wünsche eintragen und die Liste teilen.'),
    h('button', { type: 'button', class: 'btn-default btn-yellow', onclick: () => openListDialog() }, 'Erste Liste anlegen')));
}

function renderPane() {
  const { list, items } = state.current;
  state.taskbar?.setTitle(list.title);
  document.title = `${list.title} – Wunschsite`;

  const meta = [
    list.occasion ? h('span', {}, list.occasion) : null,
    list.eventDate ? h('span', {}, formatDate(list.eventDate), ' ', h('span', { class: 'badge' }, countdown(list.eventDate))) : null,
    h('span', {}, plural(items.length, 'Wunsch', 'Wünsche')),
  ];

  const wishes = items.length
    ? h('div', { class: 'wishes' }, items.map((item) => wishCard(item, {
      actions: [
        h('button', { type: 'button', class: 'btn-small', onclick: () => openItemDialog(item) }, 'Bearbeiten'),
        h('button', { type: 'button', class: 'btn-small', onclick: () => deleteItem(item) }, 'Löschen'),
      ],
    })))
    : h('div', { class: 'empty-state sunken gap-below' },
      h('p', {}, 'Noch keine Wünsche auf dieser Liste.'),
      h('button', { type: 'button', class: 'btn-default btn-yellow', onclick: () => openItemDialog() }, 'Ersten Wunsch eintragen'));

  setChildren(pane,
    h('div', { class: 'toolbar' },
      h('button', { type: 'button', class: 'btn-yellow', onclick: () => openItemDialog() }, h('img', { src: '/favicon.svg', alt: '' }), 'Wunsch hinzufügen'),
      h('button', { type: 'button', onclick: () => openShare(list) }, h('img', { src: '/img/icon-qr.svg', alt: '' }), 'Teilen…'),
      h('button', { type: 'button', onclick: () => openListDialog(list) }, 'Liste bearbeiten…'),
      h('button', { type: 'button', onclick: () => deleteList(list) }, 'Liste löschen')),
    h('div', { class: 'list-head' },
      h('img', { src: '/favicon.svg', alt: '' }),
      h('div', {},
        h('h2', {}, list.title),
        h('div', { class: 'meta' }, meta))),
    list.description ? h('p', { class: 'pre-line' }, list.description) : null,
    h('div', { class: 'notice' },
      h('img', { src: '/img/icon-info.svg', alt: '' }),
      h('p', {}, 'Was schon reserviert ist, zeigen wir dir absichtlich nicht – sonst wär die Überraschung ja weg.')),
    wishes,
  );
  setStatus(plural(items.length, 'Wunsch', 'Wünsche'));
}

// ---------- Listen ----------

function openListDialog(list = null) {
  const form = $('list-form');
  form.reset();
  form.dataset.id = list?.id ?? '';
  $('list-dialog-title').textContent = list ? 'Liste bearbeiten' : 'Neue Liste';
  const f = form.elements;
  if (list) {
    f.title.value = list.title;
    f.occasion.value = list.occasion ?? '';
    f.eventDate.value = list.eventDate ?? '';
    f.description.value = list.description ?? '';
  }
  $('list-dialog').showModal();
  f.title.focus();
}

async function saveList(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.dataset.id;
  try {
    const { list } = await busy(form, () => api(id ? 'PUT' : 'POST', id ? `/api/lists/${id}` : '/api/lists', formValues(form)));
    $('list-dialog').close();
    await loadLists();
    await selectList(list.id);
    setStatus(id ? 'Liste gespeichert.' : 'Liste angelegt.');
  } catch (err) {
    showError(err);
  }
}

async function deleteList(list) {
  const ok = await confirmBox(
    `Soll die Liste „${list.title}“ wirklich gelöscht werden?\n\nAlle Wünsche und Reservierungen sind dann weg, und der geteilte Link funktioniert nicht mehr.`,
    { title: 'Liste löschen', ok: 'Ja, löschen' },
  );
  if (!ok) return;
  try {
    await api('DELETE', `/api/lists/${list.id}`);
    await loadLists();
    if (state.lists[0]) await selectList(state.lists[0].id);
    else renderEmpty();
    setStatus('Liste gelöscht.');
  } catch (err) {
    showError(err);
  }
}

// ---------- Wünsche ----------

function openItemDialog(item = null) {
  const form = $('item-form');
  form.reset();
  form.dataset.id = item?.id ?? '';
  $('item-dialog-title').textContent = item ? 'Wunsch bearbeiten' : 'Neuer Wunsch';
  const f = form.elements;
  if (item) {
    f.title.value = item.title;
    f.description.value = item.description ?? '';
    f.url.value = item.url ?? '';
    f.imageUrl.value = item.imageUrl ?? '';
    f.price.value = priceInput(item.priceCents);
    f.priority.value = String(item.priority);
  }
  autoFetch.lastUrl = item?.url ?? '';
  autoFetch.filled = {};
  setFetchStatus('Wir holen Name, Preis und Bild automatisch aus der Shopseite.');
  updatePreview();
  $('item-dialog').showModal();
  (item ? f.title : f.url).focus();
}

// ---------- Produktdaten aus dem Link ----------

function setFetchStatus(text, kind = '') {
  const el = $('item-fetch-status');
  el.className = `fetch-status small ${kind}`;
  const icon = { busy: null, ok: '/img/icon-haken.svg', warn: '/img/icon-fehler.svg' }[kind];
  setChildren(el,
    kind === 'busy' ? h('span', { class: 'hourglass', 'aria-hidden': 'true' }, '⌛') : null,
    icon ? h('img', { src: icon, alt: '' }) : null,
    h('span', {}, text));
}

async function fetchProduct({ force = false } = {}) {
  clearTimeout(autoFetch.timer);
  const f = $('item-form').elements;
  const url = f.url.value.trim();
  if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url)) {
    if (force) setFetchStatus('Das sieht noch nicht nach einem Link aus. Er sollte mit https:// beginnen.', 'warn');
    return;
  }
  if (!force && url === autoFetch.lastUrl) return;
  autoFetch.lastUrl = url;

  const run = ++autoFetch.run;
  const button = $('item-fetch');
  button.disabled = true;
  setFetchStatus('Schaue im Shop nach…', 'busy');
  try {
    const { product } = await api('POST', '/api/product-info', { url });
    if (run !== autoFetch.run) return;
    applyProduct(product, force);
  } catch (err) {
    if (run !== autoFetch.run) return;
    setFetchStatus(err.message, 'warn');
  } finally {
    if (run === autoFetch.run) button.disabled = false;
  }
}

function applyProduct(product, force) {
  const f = $('item-form').elements;
  const isEuro = !product.currency || product.currency === 'EUR';
  const values = {
    title: product.title,
    description: product.description,
    imageUrl: product.imageUrl,
    price: product.price != null && isEuro ? priceInput(Math.round(product.price * 100)) : null,
  };
  const found = [];
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    const field = f[name];
    const untouched = !field.value.trim() || field.value === autoFetch.filled[name];
    if (force || untouched) {
      field.value = value;
      autoFetch.filled[name] = value;
    }
    found.push({ title: 'Name', description: 'Beschreibung', imageUrl: 'Bild', price: 'Preis' }[name]);
  }
  updatePreview();

  if (product.partial) {
    setFetchStatus(product.notice, 'warn');
    return;
  }
  const missing = ['Name', 'Preis', 'Bild'].filter((x) => !found.includes(x));
  let text = `Gefunden bei ${product.siteName}: ${found.join(', ')}.`;
  if (!isEuro && product.price != null) text += ` Der Preis ist in ${product.currency} angegeben – bitte selbst in Euro eintragen.`;
  else if (missing.length) text += ` ${missing.join(' und ')} bitte selbst ergänzen.`;
  setFetchStatus(text, missing.length ? 'warn' : 'ok');
}

function updatePreview() {
  const value = $('item-image').value.trim();
  const preview = $('item-preview');
  preview.replaceChildren();
  if (/^https?:\/\/\S+$/i.test(value)) {
    const img = h('img', { src: value, alt: '', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove(), { once: true });
    preview.append(img);
  }
}

async function saveItem(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.dataset.id;
  const listId = state.current.list.id;
  try {
    await busy(form, () => api(id ? 'PUT' : 'POST', id ? `/api/items/${id}` : `/api/lists/${listId}/items`, formValues(form)));
    $('item-dialog').close();
    await loadLists();
    await selectList(listId);
    setStatus(id ? 'Wunsch gespeichert.' : 'Wunsch hinzugefügt.');
  } catch (err) {
    showError(err);
  }
}

async function deleteItem(item) {
  const ok = await confirmBox(`„${item.title}“ von der Liste nehmen?`, { title: 'Wunsch löschen', ok: 'Ja, löschen' });
  if (!ok) return;
  try {
    await api('DELETE', `/api/items/${item.id}`);
    await loadLists();
    await selectList(state.current.list.id);
    setStatus('Wunsch gelöscht.');
  } catch (err) {
    showError(err);
  }
}

// ---------- Teilen ----------

function openShare(list) {
  const url = `${location.origin}/l/${list.slug}`;
  const qr = `/api/public/${encodeURIComponent(list.slug)}/qr.svg`;
  $('share-url').value = url;
  $('share-qr').src = qr;
  $('share-open').href = url;
  $('share-download').href = qr;
  $('share-dialog').showModal();
  $('share-url').select();
}
