const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const db = require('./db');
const {
  sha256, hashPassword, verifyPassword, createSession, destroySession, loadUser, requireUser,
} = require('./auth');
const v = require('./validate');
const { fetchProductInfo } = require('./product-info');

const { HttpError } = v;
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(PUBLIC_DIR, { index: false }));

const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
app.get('/', page('index.html'));
app.get('/meine-listen', page('app.html'));
app.get('/l/:slug', page('liste.html'));

const api = express.Router();
app.use('/api', express.json({ limit: '32kb' }), (req, res, next) => {
  if (!req.body || typeof req.body !== 'object') req.body = {};
  next();
}, loadUser, api);

// ---------- Konten ----------

const authLimit = v.rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });

const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName ?? u.display_name });

function readPassword(value) {
  if (typeof value !== 'string' || value.length < 8) {
    throw new HttpError(400, 'Das Passwort muss mindestens 8 Zeichen lang sein.');
  }
  if (value.length > 200) throw new HttpError(400, 'Das Passwort ist zu lang.');
  return value;
}

api.post('/register', authLimit, (req, res) => {
  const username = v.text(req.body.username, 'Der Benutzername', { min: 3, max: 30 }).toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(username)) {
    throw new HttpError(400, 'Der Benutzername darf nur Buchstaben (a–z), Zahlen und . _ - enthalten.');
  }
  const displayName = v.optionalText(req.body.displayName, 'Der Anzeigename', 40) || username;
  const password = readPassword(req.body.password);

  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    throw new HttpError(409, 'Diesen Benutzernamen gibt es schon. Such dir einen anderen aus.');
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)')
    .run(username, displayName, hashPassword(password));

  createSession(req, res, lastInsertRowid);
  res.status(201).json({ user: { id: lastInsertRowid, username, displayName } });
});

api.post('/login', authLimit, (req, res) => {
  const username = String(req.body.username ?? '').trim().toLowerCase();
  const password = String(req.body.password ?? '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'Benutzername oder Passwort stimmt nicht.');
  }
  createSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

api.post('/logout', (req, res) => {
  destroySession(req, res);
  res.status(204).end();
});

api.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

// ---------- Eigene Listen (nur mit Konto) ----------

const listJson = (l) => ({
  id: l.id,
  slug: l.slug,
  title: l.title,
  description: l.description,
  occasion: l.occasion,
  eventDate: l.event_date,
  createdAt: l.created_at,
  ...(l.item_count !== undefined && { itemCount: l.item_count }),
});

const itemJson = (i) => ({
  id: i.id,
  title: i.title,
  description: i.description,
  url: i.url,
  imageUrl: i.image_url,
  priceCents: i.price_cents,
  priority: i.priority,
  createdAt: i.created_at,
});
function readList(body) {
  return {
    title: v.text(body.title, 'Der Name der Liste', { max: 80 }),
    description: v.optionalText(body.description, 'Die Beschreibung', 500),
    occasion: v.optionalText(body.occasion, 'Der Anlass', 40),
    eventDate: v.isoDate(body.eventDate, 'Das Datum'),
  };
}

function readItem(body) {
  return {
    title: v.text(body.title, 'Der Wunsch', { max: 100 }),
    description: v.optionalText(body.description, 'Die Beschreibung', 1000),
    url: v.url(body.url, 'Der Link'),
    imageUrl: v.url(body.imageUrl, 'Die Bild-Adresse'),
    priceCents: v.priceCents(body.price),
    priority: v.priority(body.priority),
  };
}

function ownedList(req) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ? AND user_id = ?').get(v.id(req.params.id), req.user.id);
  if (!list) throw new HttpError(404, 'Diese Liste gibt es nicht.');
  return list;
}

function ownedItem(req) {
  const item = db.prepare(`
    SELECT i.* FROM items i JOIN lists l ON l.id = i.list_id
    WHERE i.id = ? AND l.user_id = ?
  `).get(v.id(req.params.id), req.user.id);
  if (!item) throw new HttpError(404, 'Diesen Wunsch gibt es nicht.');
  return item;
}

const newSlug = () => crypto.randomBytes(6).toString('base64url');

const getItems = db.prepare('SELECT * FROM items WHERE list_id = ? ORDER BY priority DESC, id ASC');

api.get('/lists', requireUser, (req, res) => {
  const lists = db.prepare(`
    SELECT l.*, (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id) AS item_count
    FROM lists l WHERE l.user_id = ? ORDER BY l.id DESC
  `).all(req.user.id);
  res.json({ lists: lists.map(listJson) });
});

api.post('/lists', requireUser, (req, res) => {
  const data = readList(req.body);
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO lists (user_id, slug, title, description, occasion, event_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.user.id, newSlug(), data.title, data.description, data.occasion, data.eventDate);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(lastInsertRowid);
  res.status(201).json({ list: listJson(list) });
});

api.get('/lists/:id', requireUser, (req, res) => {
  const list = ownedList(req);
  res.json({
    list: listJson(list),
    items: getItems.all(list.id).map(itemJson),
  });
});

api.put('/lists/:id', requireUser, (req, res) => {
  const list = ownedList(req);
  const data = readList(req.body);
  db.prepare('UPDATE lists SET title = ?, description = ?, occasion = ?, event_date = ? WHERE id = ?')
    .run(data.title, data.description, data.occasion, data.eventDate, list.id);
  res.json({ list: listJson(db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id)) });
});

api.delete('/lists/:id', requireUser, (req, res) => {
  const list = ownedList(req);
  db.prepare('DELETE FROM lists WHERE id = ?').run(list.id);
  res.status(204).end();
});

const productLimit = v.rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Zu viele Abrufe auf einmal. Warte kurz.' });

api.post('/product-info', requireUser, productLimit, async (req, res) => {
  const url = v.text(req.body.url, 'Der Link', { max: 2000 });
  res.json({ product: await fetchProductInfo(url) });
});

api.post('/lists/:id/items', requireUser, (req, res) => {
  const list = ownedList(req);
  const d = readItem(req.body);
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO items (list_id, title, description, url, image_url, price_cents, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(list.id, d.title, d.description, d.url, d.imageUrl, d.priceCents, d.priority);
  res.status(201).json({ item: itemJson(db.prepare('SELECT * FROM items WHERE id = ?').get(lastInsertRowid)) });
});

api.put('/items/:id', requireUser, (req, res) => {
  const item = ownedItem(req);
  const d = readItem(req.body);
  db.prepare(`
    UPDATE items SET title = ?, description = ?, url = ?, image_url = ?, price_cents = ?, priority = ?
    WHERE id = ?
  `).run(d.title, d.description, d.url, d.imageUrl, d.priceCents, d.priority, item.id);
  res.json({ item: itemJson(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id)) });
});

api.delete('/items/:id', requireUser, (req, res) => {
  const item = ownedItem(req);
  db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
  res.status(204).end();
});
// ---------- Geteilte Listen (ohne Konto) ----------

const guestLimit = v.rateLimit({ windowMs: 60 * 1000, max: 15 });

function publicList(req) {
  const list = db.prepare(`
    SELECT l.*, u.display_name AS owner_name
    FROM lists l JOIN users u ON u.id = l.user_id
    WHERE l.slug = ?
  `).get(String(req.params.slug));
  if (!list) throw new HttpError(404, 'Diese Wunschliste gibt es nicht (mehr).');
  return list;
}

function guestTokenHash(req, { required = false } = {}) {
  const token = req.get('X-Guest-Token');
  if (typeof token === 'string' && /^[a-f0-9]{32,128}$/.test(token)) return sha256(token);
  if (required) throw new HttpError(400, 'Dein Browser hat keine Gast-Kennung geschickt. Lade die Seite bitte neu.');
  return null;
}

api.get('/public/:slug', (req, res) => {
  const list = publicList(req);
  const isOwner = req.user?.id === list.user_id;
  const guestHash = guestTokenHash(req);

  const items = db.prepare(`
    SELECT i.*, r.guest_name, r.guest_token_hash, r.item_id AS reserved_id
    FROM items i LEFT JOIN reservations r ON r.item_id = i.id
    WHERE i.list_id = ? ORDER BY i.priority DESC, i.id ASC
  `).all(list.id).map((row) => {
    const item = itemJson(row);
    if (isOwner) return item;
    const mine = Boolean(row.reserved_id) && guestHash !== null && row.guest_token_hash === guestHash;
    return { ...item, reserved: Boolean(row.reserved_id), reservedByMe: mine, reservedBy: row.guest_name ?? null };
  });

  res.json({
    list: { ...listJson(list), ownerName: list.owner_name },
    isOwner,
    items,
  });
});

function publicItem(req, list) {
  const item = db.prepare('SELECT id FROM items WHERE id = ? AND list_id = ?').get(v.id(req.params.itemId), list.id);
  if (!item) throw new HttpError(404, 'Diesen Wunsch gibt es nicht mehr.');
  return item;
}

api.post('/public/:slug/items/:itemId/reservation', guestLimit, (req, res) => {
  const list = publicList(req);
  if (req.user?.id === list.user_id) throw new HttpError(403, 'Deine eigenen Wünsche kannst du nicht reservieren.');
  const item = publicItem(req, list);
  const tokenHash = guestTokenHash(req, { required: true });
  const name = v.text(req.body.name, 'Dein Name', { max: 40 });

  const result = db.prepare(`
    INSERT INTO reservations (item_id, guest_name, guest_token_hash) VALUES (?, ?, ?)
    ON CONFLICT(item_id) DO NOTHING
  `).run(item.id, name, tokenHash);
  if (result.changes === 0) throw new HttpError(409, 'Das hat gerade schon jemand anderes reserviert.');
  res.status(201).json({ ok: true });
});

api.delete('/public/:slug/items/:itemId/reservation', (req, res) => {
  const list = publicList(req);
  const item = publicItem(req, list);
  const tokenHash = guestTokenHash(req, { required: true });
  const result = db.prepare('DELETE FROM reservations WHERE item_id = ? AND guest_token_hash = ?').run(item.id, tokenHash);
  if (result.changes === 0) {
    throw new HttpError(403, 'Diese Reservierung wurde nicht in diesem Browser gemacht und kann hier nicht aufgehoben werden.');
  }
  res.status(204).end();
});

api.get('/public/:slug/qr.svg', async (req, res) => {
  const list = publicList(req);
  const shareUrl = `${req.protocol}://${req.get('host')}/l/${list.slug}`;
  const svg = await QRCode.toString(shareUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
});

// ---------- Fehler ----------

api.use((req, res) => res.status(404).json({ error: 'Diese Adresse gibt es nicht.' }));

app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Die Anfrage war kaputt.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Das ist zu viel Text auf einmal.' });
  console.error(err);
  res.status(500).json({ error: 'Da ist auf dem Server etwas schiefgelaufen. Bitte versuch es gleich nochmal.' });
});

app.listen(PORT, () => {
  console.log(`Wunschsite läuft auf http://localhost:${PORT}`);
});
