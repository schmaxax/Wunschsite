const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'wunschsite.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lists (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    description TEXT,
    occasion    TEXT,
    event_date  TEXT,
    created_at  TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY,
    list_id     INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT,
    url         TEXT,
    image_url   TEXT,
    price_cents INTEGER,
    priority    INTEGER NOT NULL DEFAULT 2,
    created_at  TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE IF NOT EXISTS reservations (
    item_id          INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    guest_name       TEXT NOT NULL,
    guest_token_hash TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE INDEX IF NOT EXISTS idx_lists_user ON lists(user_id);
  CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id);

  DROP TABLE IF EXISTS comments;
`);

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

module.exports = db;
