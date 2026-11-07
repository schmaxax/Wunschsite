'use strict';

const $ = (id) => document.getElementById(id);
const slug = decodeURIComponent(location.pathname.split('/').pop() || '');
const view = { data: null, hideReserved: false, reserveItem: null, taskbar: null };

(async () => {
  const user = await loadMe();
  view.taskbar = initTaskbar({ title: 'Wunschliste', user });

  $('reserve-name').value = localStorage.getItem(GUEST_NAME_KEY) || '';
  $('reserve-form').addEventListener('submit', reserve);

  await load();
})();

async function load() {
  try {
    view.data = await api('GET', `/api/public/${encodeURIComponent(slug)}`);
  } catch (err) {
    renderMissing(err);
    return;
  }
  render();
}

function renderMissing(err) {
  $('window-title').textContent = 'Fehler';
  $('status').textContent = 'Nicht gefunden';
  $('list-body').replaceChildren(h('div', { class: 'empty-state' },
    h('img', { src: '/img/icon-fehler.svg', alt: '' }),
    h('h2', {}, 'Hier ist keine Wunschliste'),
    h('p', {}, err.status === 404
      ? 'Entweder ist der Link falsch abgetippt, oder die Liste wurde gelöscht. Frag am besten nochmal nach dem richtigen Link.'
      : err.message),
    h('a', { href: '/', class: 'btn' }, 'Zur Startseite')));
}

function render() {
  const { list, isOwner, items } = view.data;
  const title = `${list.title} – Wunschliste von ${list.ownerName}`;
  document.title = `${list.title} – Wunschsite`;
  $('window-title').textContent = title;
  view.taskbar.setTitle(list.title);

  const free = items.filter((i) => !i.reserved).length;
  const shown = view.hideReserved ? items.filter((i) => !i.reserved || i.reservedByMe) : items;

  const meta = [
    list.occasion ? h('span', {}, list.occasion) : null,
    list.eventDate ? h('span', {}, formatDate(list.eventDate), ' ', h('span', { class: 'badge' }, countdown(list.eventDate))) : null,
  ];

  const intro = isOwner
    ? h('div', { class: 'notice' },
      h('img', { src: '/img/icon-info.svg', alt: '' }),
      h('p', {}, 'Das ist deine eigene Liste, so wie deine Gäste sie sehen – nur ohne Reservierungen. ',
        h('a', { href: `/meine-listen#liste-${list.id}` }, 'Liste bearbeiten')))
    : h('div', { class: 'notice' },
      h('img', { src: '/img/icon-info.svg', alt: '' }),
      h('p', {}, `Such dir etwas aus und klick auf „Reservieren“. Dann wissen die anderen, dass es schon vergeben ist. ${list.ownerName} sieht davon nichts.`));

  const filter = !isOwner && items.some((i) => i.reserved)
    ? h('label', { class: 'checkbox' },
      h('input', {
        type: 'checkbox',
        checked: view.hideReserved,
        onchange: (e) => { view.hideReserved = e.target.checked; render(); },
      }),
      'Reservierte ausblenden')
    : null;

  const grid = shown.length
    ? h('div', { class: 'wishes' }, shown.map((item) => (isOwner ? wishCard(item) : guestCard(item))))
    : h('div', { class: 'empty-state sunken gap-below' },
      h('p', { class: 'flush' }, items.length ? 'Alles schon reserviert. Da war jemand schnell!' : 'Auf dieser Liste steht noch nichts.'));

  setChildren($('list-body'),
    h('div', { class: 'share-head' },
      h('img', { src: '/favicon.svg', alt: '' }),
      h('div', {},
        h('h1', { id: 'list-title' }, list.title),
        h('div', { class: 'meta' }, h('span', {}, 'Wunschliste von ', h('strong', {}, list.ownerName)), meta))),
    list.description ? h('p', { class: 'pre-line' }, list.description) : null,
    intro,
    h('div', { class: 'filter-row' },
      h('strong', {}, plural(items.length, 'Wunsch', 'Wünsche')),
      filter),
    grid,
  );

  $('status').textContent = isOwner ? 'Vorschau für dich' : `${free} von ${items.length} noch frei`;
  $('status-right').textContent = `Erstellt am ${formatDate(list.createdAt)}`;
}

function guestCard(item) {
  if (item.reservedByMe) {
    return wishCard(item, {
      reserved: true,
      stamp: h('span', { class: 'stamp mine' }, 'Von dir!'),
      actions: [
        h('span', { class: 'small' }, `Reserviert als ${item.reservedBy}.`),
        h('button', { type: 'button', class: 'btn-small', onclick: () => unreserve(item) }, 'Freigeben'),
      ],
    });
  }
  if (item.reserved) {
    return wishCard(item, {
      reserved: true,
      stamp: h('span', { class: 'stamp' }, 'Reserviert'),
      actions: [h('span', { class: 'small muted' }, `von ${item.reservedBy}`)],
    });
  }
  return wishCard(item, {
    actions: [h('button', { type: 'button', class: 'btn-small btn-yellow', onclick: () => openReserve(item) }, 'Reservieren')],
  });
}

function openReserve(item) {
  view.reserveItem = item;
  $('reserve-item').textContent = `„${item.title}“`;
  $('reserve-owner').textContent = view.data.list.ownerName;
  $('reserve-dialog').showModal();
  $('reserve-name').focus();
}

async function reserve(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const { name } = formValues(form);
  try {
    await busy(form, () => api('POST', `/api/public/${encodeURIComponent(slug)}/items/${view.reserveItem.id}/reservation`, { name }));
    localStorage.setItem(GUEST_NAME_KEY, name.trim());
    $('reserve-dialog').close();
    await load();
    messageBox(`Erledigt! „${view.reserveItem.title}“ ist jetzt für dich reserviert.`, { title: 'Reserviert', icon: 'info' });
  } catch (err) {
    await showError(err);
    if (err.status === 409) {
      $('reserve-dialog').close();
      await load();
    }
  }
}

async function unreserve(item) {
  const ok = await confirmBox(`Reservierung für „${item.title}“ aufheben? Dann können andere es wieder reservieren.`, { title: 'Freigeben', ok: 'Ja, freigeben' });
  if (!ok) return;
  try {
    await api('DELETE', `/api/public/${encodeURIComponent(slug)}/items/${item.id}/reservation`);
    await load();
  } catch (err) {
    showError(err);
  }
}
