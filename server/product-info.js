const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { HttpError } = require('./validate');

const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 5;

// Viele Shops sperren unbekannte Abrufe, lassen aber Link-Vorschauen von Messengern durch.
const USER_AGENTS = [
  'WhatsApp/2.24.20.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
];

const BLOCKED_STATUS = new Set([400, 401, 403, 405, 406, 429, 503]);

function shopError(message, retry = false) {
  const err = new HttpError(422, message);
  err.retry = retry;
  return err;
}

// Adressen im eigenen Netz dürfen nicht abgerufen werden, sonst könnte man über
// diese Funktion z. B. den Router oder andere Dienste auf dem Server ansprechen.
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(addr, prefix, 'ipv6');

function isBlocked(address) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const allowed = addresses.filter((a) => !isBlocked(a.address));
    if (!allowed.length || allowed.length !== addresses.length) {
      return callback(new HttpError(400, 'Diese Adresse darf nicht abgerufen werden.'));
    }
    if (options.all) return callback(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
}

function checkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'Das ist kein gültiger Link.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'Der Link muss mit http:// oder https:// beginnen.');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new HttpError(400, 'Dieser Link kann nicht abgerufen werden.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || (net.isIP(host) && isBlocked(host))) {
    throw new HttpError(400, 'Diese Adresse darf nicht abgerufen werden.');
  }
  return url;
}

function request(url, userAgent) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      lookup: safeLookup,
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.6',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, url) });
      }
      if (res.statusCode >= 400) {
        res.resume();
        if (res.statusCode === 404 || res.statusCode === 410) {
          return reject(shopError('Diese Produktseite gibt es im Shop nicht (mehr). Stimmt der Link?'));
        }
        return reject(shopError(
          'Der Shop lässt keine automatischen Abrufe zu. Bitte trag Preis und Bild selbst ein.',
          BLOCKED_STATUS.has(res.statusCode),
        ));
      }
      const type = String(res.headers['content-type'] || '');
      if (type && !/html|xml/i.test(type)) {
        res.resume();
        return reject(new HttpError(422, 'Der Link zeigt nicht auf eine Webseite.'));
      }

      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          stream.destroy();
          resolve({ body: Buffer.concat(chunks), type });
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve({ body: Buffer.concat(chunks), type }));
      stream.on('error', () => reject(new HttpError(422, 'Die Seite konnte nicht gelesen werden.')));
    });
    req.on('timeout', () => req.destroy(shopError('Der Shop hat zu lange nicht geantwortet.', true)));
    req.on('error', (err) => {
      if (err instanceof HttpError) return reject(err);
      const unknownHost = err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN';
      reject(shopError(unknownHost
        ? 'Diese Internetadresse gibt es nicht. Stimmt der Link?'
        : 'Der Shop hat die Verbindung abgelehnt. Bitte trag Preis und Bild selbst ein.', !unknownHost));
    });
  });
}

function decode(body, contentType) {
  const head = body.subarray(0, 4096).toString('latin1');
  const charset = (contentType.match(/charset=["']?([\w-]+)/i)
    || head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

// ---------- HTML auslesen ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', ndash: '–', mdash: '—' };

function decodeEntities(str) {
  return str.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

// Zweimal dekodieren, weil manche Shops (z. B. Amazon) Entities doppelt kodieren („&amp;uuml;“).
const clean = (str) => (str == null ? null
  : decodeEntities(decodeEntities(String(str))).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null);

function parseAttributes(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
  }
  return attrs;
}

function readMeta(html) {
  const meta = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = parseAttributes(tag);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content != null && meta[key] === undefined) meta[key] = a.content;
  }
  return meta;
}

function findProducts(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => findProducts(n, out));
  } else if (node && typeof node === 'object') {
    const type = [].concat(node['@type'] || []).map(String);
    if (type.some((t) => /Product|ProductGroup|Book|Offer/i.test(t)) && (node.name || node.offers)) out.push(node);
    for (const key of ['@graph', 'mainEntity', 'itemListElement', 'hasVariant']) {
      if (node[key]) findProducts(node[key], out);
    }
  }
  return out;
}

function readJsonLd(html) {
  const products = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      findProducts(JSON.parse(m[1].trim()), products);
    } catch {
      // Manche Shops liefern kaputtes JSON-LD – dann eben die anderen Quellen.
    }
  }
  return products.find((p) => p.offers) || products[0] || null;
}

function firstImage(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return firstImage(value[0]);
  return value.url || value.contentUrl || null;
}

function readOffer(offers) {
  const list = [].concat(offers || []);
  for (const offer of list) {
    if (!offer || typeof offer !== 'object') continue;
    const price = offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price
      ?? [].concat(offer.priceSpecification || [])[0]?.price;
    if (price != null) return { price, currency: offer.priceCurrency || offer.priceSpecification?.priceCurrency };
    if (offer.offers) {
      const inner = readOffer(offer.offers);
      if (inner) return inner;
    }
  }
  return null;
}

function parsePrice(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value >= 0 ? value : null;
  let str = String(value).replace(/[^\d.,]/g, '');
  if (!str) return null;
  const lastComma = str.lastIndexOf(',');
  const lastDot = str.lastIndexOf('.');
  if (lastComma > lastDot) str = str.replace(/\./g, '').replace(',', '.');
  else str = str.replace(/,/g, '');
  const num = Number(str);
  return Number.isFinite(num) && num >= 0 && num < 1_000_000 ? num : null;
}

function absolute(src, base) {
  if (!src) return null;
  try {
    const url = new URL(decodeEntities(src.trim()), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function extract(html, pageUrl) {
  const meta = readMeta(html);
  const product = readJsonLd(html);
  const offer = product ? readOffer(product.offers) : null;
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];

  // Amazon & Co. haben oft keine Metadaten, aber feste Element-IDs.
  const amazonTitle = html.match(/id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
  const amazonImage = html.match(/data-old-hires=["']([^"']+)["']/i)?.[1]
    || html.match(/"hiRes"\s*:\s*"([^"]+)"/)?.[1];
  const amazonPrice = html.match(/class=["']a-offscreen["'][^>]*>([^<]+)</i)?.[1];

  const title = clean(product?.name) || clean(meta['og:title']) || clean(meta['twitter:title'])
    || clean(amazonTitle) || clean(titleTag);

  const image = absolute(firstImage(product?.image), pageUrl) || absolute(meta['og:image'], pageUrl)
    || absolute(meta['og:image:url'], pageUrl) || absolute(meta['og:image:secure_url'], pageUrl)
    || absolute(meta['twitter:image'], pageUrl) || absolute(meta['twitter:image:src'], pageUrl)
    || absolute(amazonImage, pageUrl) || absolute(meta.image, pageUrl);

  const rawPrice = offer?.price ?? meta['product:price:amount'] ?? meta['og:price:amount']
    ?? meta.price ?? amazonPrice;
  const currency = String(offer?.currency || meta['product:price:currency'] || meta['og:price:currency']
    || meta.pricecurrency || (/€|EUR/.test(String(rawPrice ?? '')) ? 'EUR' : '') || '').toUpperCase() || null;

  let description = clean(product?.description) || clean(meta['og:description']) || clean(meta.description);
  if (description && description.length > 300) description = `${description.slice(0, 297).trimEnd()}…`;

  return {
    title: title ? title.slice(0, 100) : null,
    description,
    imageUrl: image,
    price: parsePrice(rawPrice),
    currency,
    siteName: clean(meta['og:site_name']) || new URL(pageUrl).hostname.replace(/^www\./, ''),
  };
}

async function fetchPage(startUrl, userAgent) {
  let url = startUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const result = await request(url, userAgent);
    if (!result.redirect) return { url, html: decode(result.body, result.type) };
    url = checkUrl(result.redirect.href);
  }
  throw shopError('Der Link leitet zu oft weiter.');
}

/** Errät den Produktnamen aus dem Link, z. B. /p/inline-skates-play-5-kinder/ → „Inline Skates Play 5 Kinder“. */
function titleFromUrl(url) {
  const words = (segment) => segment.split(/[-_+]+/).filter(Boolean);
  const candidates = url.pathname.split('/')
    .map((s) => { try { return decodeURIComponent(s); } catch { return s; } })
    .map((s) => s.replace(/\.(html?|php|aspx?)$/i, ''))
    .filter((s) => words(s).length >= 2 && /[a-zäöüß]{3}/i.test(s) && !/^[A-Z0-9]{8,}$/.test(s));
  if (!candidates.length) return null;
  const best = candidates.sort((a, b) => words(b).length - words(a).length)[0];
  return words(best)
    .filter((w, i, all) => !(i === all.length - 1 && /^\d{6,}$/.test(w)))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, 100);
}

async function fetchProductInfo(rawUrl) {
  const url = checkUrl(rawUrl);
  let lastError;
  for (const userAgent of USER_AGENTS) {
    try {
      const page = await fetchPage(url, userAgent);
      const info = extract(page.html, page.url.href);
      if (info.title || info.imageUrl || info.price != null) return { ...info, partial: false };
      lastError = shopError('Auf dieser Seite haben wir keine Produktdaten gefunden.', true);
    } catch (err) {
      if (!err.retry) throw err;
      lastError = err;
    }
  }

  const guess = titleFromUrl(url);
  if (guess) {
    return {
      title: guess,
      description: null,
      imageUrl: null,
      price: null,
      currency: null,
      siteName: url.hostname.replace(/^www\./, ''),
      partial: true,
      notice: `${lastError.message} Den Namen haben wir aus dem Link erraten.`,
    };
  }
  throw lastError;
}

module.exports = { fetchProductInfo, extract, titleFromUrl };
