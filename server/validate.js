class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function text(value, label, { max = 200, min = 0, required = true } = {}) {
  const str = typeof value === 'string' ? value.trim() : '';
  if (!str) {
    if (required) throw new HttpError(400, `${label} fehlt.`);
    return null;
  }
  if (str.length < min) throw new HttpError(400, `${label} ist zu kurz (mind. ${min} Zeichen).`);
  if (str.length > max) throw new HttpError(400, `${label} ist zu lang (max. ${max} Zeichen).`);
  return str;
}

const optionalText = (value, label, max) => text(value, label, { max, required: false });

function url(value, label) {
  const str = optionalText(value, label, 2000);
  if (!str) return null;
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    throw new HttpError(400, `${label} ist keine gültige Adresse (sie sollte mit https:// beginnen).`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, `${label} muss mit http:// oder https:// beginnen.`);
  }
  return parsed.href;
}

function priceCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[€\s]/g, '').replace(',', '.'));
  if (!Number.isFinite(num) || num < 0 || num > 1_000_000) {
    throw new HttpError(400, 'Der Preis ist keine gültige Zahl.');
  }
  return Math.round(num * 100);
}

function priority(value) {
  const num = Number(value ?? 2);
  if (![1, 2, 3].includes(num)) throw new HttpError(400, 'Die Wichtigkeit muss 1, 2 oder 3 sein.');
  return num;
}

function isoDate(value, label) {
  const str = optionalText(value, label, 10);
  if (!str) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || Number.isNaN(Date.parse(str))) {
    throw new HttpError(400, `${label} ist kein gültiges Datum.`);
  }
  return str;
}

function id(value) {
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num <= 0) throw new HttpError(404, 'Nicht gefunden.');
  return num;
}

function rateLimit({ windowMs, max, message = 'Zu viele Versuche. Bitte warte kurz.' }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      }
      return next();
    }
    entry.count += 1;
    if (entry.count > max) return res.status(429).json({ error: message });
    next();
  };
}

module.exports = { HttpError, text, optionalText, url, priceCents, priority, isoDate, id, rateLimit };
