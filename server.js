/**
 * IPO India Tracker — zero-dependency Node.js server.
 *
 * Serves:
 *   /                      -> static SPA (public/)
 *   /api/ipos              -> live IPO list (merged + scored)
 *   /api/ipos/:id          -> one IPO with deep detail (scraped, cached)
 *   /api/meta              -> data freshness info
 *   /api/markets           -> market strip (Sensex/Nifty/USD-INR/gold/...)
 *   /api/subscribe         -> POST { email, preferences } to subscribe
 *   /api/subscribers/count -> subscriber count (no emails exposed)
 *   /api/unsubscribe       -> GET one-click unsubscribe (signed link from emails)
 *
 * Upstream data is refreshed in the background every REFRESH_MINUTES.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { TTLCache } = require('./lib/cache');
const { loadYear, deriveStatus } = require('./lib/normalize');
const { loadDashboardSchedule, toIpoRecord } = require('./lib/dashboard');
const { computeScore } = require('./lib/scoring');
const { loadDetail, mergeDetailIntoIpo } = require('./lib/detail');
const { upstreamState } = require('./lib/fetcher');
const { attachLiveSubscriptions } = require('./lib/livesubs');
const { fetchBseData, verifyIpo, verifyState } = require('./lib/verify');
const { fetchMarketSnapshot } = require('./lib/markets');

const {
  addSubscriber,
  removeSubscriber,
  count: countSubscribers,
  isValidEmail,
  unsubscribeToken,
} = require('./lib/subscriptions');
const { sendMail, welcomeEmail, isMailConfigured, providerName } = require('./lib/mailer');
const { countKnown, summarize, inWindow } = require('./lib/wire');
const { NOTABLE_NAMES } = require('./lib/notable');
const { invalidLinkPage, unsubscribedPage } = require('./lib/unsubscribe-pages');

const PORT = process.env.PORT || 8787;
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES || 10);
const LIST_TTL = REFRESH_MINUTES * 60 * 1000;
const DETAIL_TTL = 30 * 60 * 1000;
const HISTORY_YEARS = Number(process.env.HISTORY_YEARS || 1); // years of listed history
// Curated windows (like Groww): upcoming = opens within the next N days,
// listed = listed within the last N days. `?all=1` bypasses the window.
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 31);
// Base path for %BASE% placeholders in index.html — '/' locally (the Worker
// substitutes the same); GitHub Pages rewrites it at deploy time (pages.yml).
const BASE_PATH = (() => {
  let b = process.env.BASE_PATH || '/';
  if (!b.startsWith('/')) b = '/' + b;
  if (!b.endsWith('/')) b += '/';
  return b;
})();

// NOTABLE_NAMES + isNotableName live in lib/notable.js (shared with the Worker).
const NOTABLE_TTL = 60 * 60 * 1000; // refresh notable list every hour
const NOTABLE_HISTORY_YEARS = 6; // go back to 2020 for notable IPOs
const VERIFY_TTL = 60 * 60 * 1000; // refresh BSE cross-verification every hour
const MARKETS_TTL = 5 * 60 * 1000; // refresh market strip quotes every 5 min

const cache = new TTLCache();
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
};

function currentYear() {
  return new Date().getUTCFullYear();
}

function yearsToLoad() {
  const y = currentYear();
  const years = [y];
  for (let i = 1; i <= HISTORY_YEARS; i++) years.push(y - i);
  return years;
}

async function buildDataset() {
  const results = await Promise.allSettled([
    ...yearsToLoad().map((y) => loadYear(y)),
    loadDashboardSchedule(), // fresh timetable (see lib/dashboard.js)
  ]);
  const dashResult = results[results.length - 1];
  const yearResults = results.slice(0, -1);
  const ipos = [];
  const errors = [];
  const yearsLoaded = [];
  for (const r of yearResults) {
    if (r.status === 'fulfilled') {
      ipos.push(...r.value.ipos);
      yearsLoaded.push(r.value.year);
      r.value.errors.forEach((e) => errors.push({ year: r.value.year, ...e }));
    } else {
      errors.push({ error: String(r.reason && r.reason.message) });
    }
  }
  // de-dupe by id (FY overlap), keeping the richer record
  const byId = new Map();
  for (const ipo of ipos) {
    const prev = byId.get(ipo.id);
    if (!prev || countKnown(ipo) > countKnown(prev)) byId.set(ipo.id, ipo);
  }
  // Freshen schedules from the live dashboard timetable — the JSON cloud
  // reports can lag by days for brand-new IPOs (missing "open right now"
  // issues), while the dashboard HTML is current. Backfill only: never
  // overwrite dates the reports already published.
  if (dashResult.status === 'fulfilled') {
    for (const entry of dashResult.value) {
      const existing = byId.get(entry.id);
      if (existing) {
        if (!existing.openDate && entry.openDate) existing.openDate = entry.openDate;
        if (!existing.closeDate && entry.closeDate) existing.closeDate = entry.closeDate;
        if (!existing.slug && entry.slug) existing.slug = entry.slug;
        if (!existing.category && entry.category) existing.category = entry.category;
      } else {
        byId.set(entry.id, toIpoRecord(entry));
      }
    }
  } else {
    errors.push({ source: 'dashboard', error: String(dashResult.reason && dashResult.reason.message) });
  }
  const final = [];
  for (const ipo of byId.values()) {
    const enriched = { ...ipo };
    enriched.status = deriveStatus(enriched); // re-derive: dashboard may have backfilled dates
    enriched.score = computeScore(enriched);
    final.push(enriched);
  }
  final.sort((a, b) => (b.openDate || '0000').localeCompare(a.openDate || '0000'));

  // Live subscription ("x times subscribed so far") for currently-open issues —
  // Chittorgarh's per-IPO subscription page (live BSE/NSE bidding data).
  await attachLiveSubscriptions(final, {
    onError: (e) => errors.push({ source: 'live-subs', error: e }),
  });

  return { fetchedAt: new Date().toISOString(), yearsLoaded, count: final.length, errors, ipos: final };
}

async function getDataset() {
  return cache.swr('dataset', LIST_TTL, buildDataset);
}

/**
 * Load notable/famous IPOs by searching deeper history for well-known company names.
 * This ensures we surface IPOs like Zomato, Swiggy, Paytm, LIC that listed years ago.
 */
async function buildNotableDataset() {
  const y = currentYear();
  const years = [y];
  for (let i = 1; i <= NOTABLE_HISTORY_YEARS; i++) years.push(y - i);

  const results = await Promise.allSettled(years.map((yr) => loadYear(yr)));
  const ipos = [];
  for (const r of results) {
    if (r.status === 'fulfilled') ipos.push(...r.value.ipos);
  }

  // de-dupe by id
  const byId = new Map();
  for (const ipo of ipos) {
    const prev = byId.get(ipo.id);
    if (!prev || countKnown(ipo) > countKnown(prev)) byId.set(ipo.id, ipo);
  }

  // search for notable names
  const notable = [];
  for (const ipo of byId.values()) {
    const nameLower = ipo.name.toLowerCase();
    for (const notableName of NOTABLE_NAMES) {
      if (nameLower.includes(notableName)) {
        const enriched = { ...ipo };
        enriched.score = computeScore(enriched);
        notable.push(enriched);
        break;
      }
    }
  }

  // sort by listing date (most recent first), then by score
  notable.sort((a, b) => {
    const dateDiff = (b.listingDate || '').localeCompare(a.listingDate || '');
    if (dateDiff !== 0) return dateDiff;
    return b.score.score - a.score.score;
  });

  return { fetchedAt: new Date().toISOString(), count: notable.length, ipos: notable };
}

async function getNotableDataset() {
  return cache.swr('notable', NOTABLE_TTL, buildNotableDataset);
}

/**
 * BSE cross-verification doc (lib/verify.js) — SWR-cached like the datasets,
 * so a failed refresh keeps serving the last good doc (verification simply
 * shows an older "checked" time instead of erroring).
 */
function getVerifyDoc() {
  return cache.swr('verify:bse', VERIFY_TTL, () => fetchBseData({})).catch((err) => {
    console.error('[verify] BSE refresh failed:', err && err.message);
    return null;
  });
}

/**
 * Market strip quotes (lib/markets.js) — SWR-cached like the datasets, so a
 * failed refresh keeps serving the last good snapshot (the strip shows an
 * older "as of" time instead of disappearing).
 */
function getMarkets() {
  return cache.swr('markets', MARKETS_TTL, () => fetchMarketSnapshot()).catch((err) => {
    console.error('[markets] refresh failed:', err && err.message);
    return null;
  });
}

// ---- subscriptions: body parsing + light anti-spam rate limiting ----
function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('Request body too large');
        err.code = 'BODY_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const SUB_RATE_WINDOW_MS = 60 * 60 * 1000;
const SUB_RATE_MAX = 8; // subscription attempts per IP per hour
const subHits = new Map(); // ip -> [timestamps]

function subRateLimited(ip) {
  const now = Date.now();
  const hits = (subHits.get(ip) || []).filter((t) => now - t < SUB_RATE_WINDOW_MS);
  hits.push(now);
  subHits.set(ip, hits);
  if (subHits.size > 5000) {
    for (const [key, ts] of subHits) {
      if (ts.every((t) => now - t >= SUB_RATE_WINDOW_MS)) subHits.delete(key);
    }
  }
  return hits.length > SUB_RATE_MAX;
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// ---- static file serving: read cache + compressed-variant cache -------------
// public/ files change only on edit/deploy, so cache the raw buffer and each
// compressed variant keyed by mtime — compression runs once per file version
// instead of on every request (the old code recompressed per request).
const fileCache = new Map(); // path -> { mtimeMs, buf, variants: Map }

function loadFile(filePath, transform, cb) {
  fs.stat(filePath, (err, st) => {
    if (err) return cb(err);
    const hit = fileCache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs) return cb(null, hit);
    fs.readFile(filePath, (err2, raw) => {
      if (err2) return cb(err2);
      let buf = raw;
      try {
        if (transform) buf = transform(raw);
      } catch (e) {
        return cb(e);
      }
      const entry = { mtimeMs: st.mtimeMs, buf, variants: new Map() };
      fileCache.set(filePath, entry);
      cb(null, entry);
    });
  });
}

/** Promise-cached compressed variant (null = not worth compressing). */
function compressed(entry, enc) {
  if (!entry.variants.has(enc)) {
    entry.variants.set(
      enc,
      new Promise((resolve) => {
        const fn = enc === 'br' ? zlib.brotliCompress : zlib.gzip;
        fn(entry.buf, (err, out) => resolve(err || out.length >= entry.buf.length ? null : out));
      })
    );
  }
  return entry.variants.get(enc);
}

const COMPRESSIBLE = [
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
  'application/manifest+json',
];

/** Serve a cached entry: conditional GET (304) + brotli/gzip when beneficial. */
function sendEntry(res, entry, contentType, opts = {}) {
  const cache = opts.cache || 'public, max-age=3600';
  const baseHeaders = {
    'Content-Type': contentType,
    'Cache-Control': cache,
    'Last-Modified': new Date(entry.mtimeMs).toUTCString(),
  };

  const ims = Date.parse(opts.ifModifiedSince || '');
  if (Number.isFinite(ims) && ims >= Math.floor(entry.mtimeMs / 1000) * 1000) {
    res.writeHead(304, { ...baseHeaders, Vary: 'Accept-Encoding' });
    res.end();
    return;
  }

  const send = (body, encoding) => {
    const headers = { ...baseHeaders, 'Content-Length': body.length };
    if (encoding) {
      headers['Content-Encoding'] = encoding;
      headers['Vary'] = 'Accept-Encoding';
    }
    res.writeHead(200, headers);
    res.end(body);
  };

  const accept = String(opts.acceptEncoding || '');
  const wants =
    COMPRESSIBLE.some((t) => contentType.includes(t)) &&
    entry.buf.length > 1024 &&
    (accept.includes('br') || accept.includes('gzip'));
  if (!wants) return send(entry.buf);

  const enc = accept.includes('br') ? 'br' : 'gzip';
  compressed(entry, enc).then((out) => (out ? send(out, enc) : send(entry.buf)));
}

function sendFile(res, req, filePath, opts = {}) {
  loadFile(filePath, null, (err, entry) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    sendEntry(res, entry, MIME[path.extname(filePath)] || 'application/octet-stream', {
      ...opts,
      acceptEncoding: req.headers['accept-encoding'] || '',
      ifModifiedSince: req.headers['if-modified-since'],
    });
  });
}

// Serve index.html with %BASE% substituted for BASE_PATH. GitHub Pages rewrites
// the placeholder at deploy time instead (pages.yml); the Worker rewrites it
// while serving assets. No host sniffing — one env var decides locally.
function sendIndexHtml(res, req) {
  const filePath = path.join(PUBLIC_DIR, 'index.html');
  loadFile(
    filePath,
    (raw) => Buffer.from(raw.toString('utf8').replace(/%BASE%/g, BASE_PATH), 'utf8'),
    (err, entry) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      sendEntry(res, entry, 'text/html; charset=utf-8', {
        cache: 'no-cache',
        acceptEncoding: req.headers['accept-encoding'] || '',
        ifModifiedSince: req.headers['if-modified-since'],
      });
    }
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/api/ipos') {
      const ds = await getDataset();
      const status = url.searchParams.get('status');
      const category = url.searchParams.get('category');
      const q = (url.searchParams.get('q') || '').toLowerCase().trim();
      const showAll = url.searchParams.get('all') === '1';
      let rows = ds.ipos;
      if (status && status !== 'all') rows = rows.filter((i) => i.status === status);
      if (!showAll && status && status !== 'all' && status !== 'open') {
        rows = rows.filter((i) => inWindow(i, status, WINDOW_DAYS));
      }
      if (category && category !== 'all') {
        rows = rows.filter((i) => (i.category || '').toLowerCase() === category.toLowerCase());
      }
      if (q) rows = rows.filter((i) => i.name.toLowerCase().includes(q));
      // Independent BSE cross-check, attached per row (compact: no field values).
      const vdoc = await getVerifyDoc();
      const ipos = rows.map((i) => {
        const s = summarize(i);
        const v = verifyIpo(s, vdoc, { compact: true });
        return v ? { ...s, verification: v } : s;
      });
      json(res, 200, {
        fetchedAt: ds.fetchedAt,
        yearsLoaded: ds.yearsLoaded,
        windowDays: WINDOW_DAYS,
        curated: !showAll,
        total: ds.count,
        returned: rows.length,
        errors: ds.errors,
        ipos,
      });
      return;
    }

    const detailMatch = p.match(/^\/api\/ipos\/(\d+)$/);
    if (detailMatch) {
      const id = Number(detailMatch[1]);
      const ds = await getDataset();
      const ipo = ds.ipos.find((i) => i.id === id);
      if (!ipo) {
        json(res, 404, { error: 'IPO not found', id });
        return;
      }
      // SWR serves last-good detail when upstream fails or fast-fails (fetcher
      // cooldown). Only a cold miss with a dead upstream yields the error
      // object — and it is never cached, so no 30-min poison entry.
      const detail = await cache
        .swr(`detail:${id}`, DETAIL_TTL, () => loadDetail(ipo))
        .catch(() => ({ error: 'Detail temporarily unavailable — upstream feed is down.' }));
      const merged = mergeDetailIntoIpo(ipo, detail, deriveStatus);
      const vdoc = await getVerifyDoc();
      const v = verifyIpo(merged, vdoc);
      json(res, 200, { fetchedAt: ds.fetchedAt, ipo: v ? { ...merged, verification: v } : merged, detail });
      return;
    }

    if (p === '/api/meta') {
      const ds = await getDataset();
      const counts = { open: 0, upcoming: 0, closed: 0, listed: 0 };
      ds.ipos.forEach((i) => {
        if (counts[i.status] !== undefined && inWindow(i, i.status, WINDOW_DAYS)) counts[i.status]++;
      });
      const vdoc = await getVerifyDoc();
      json(res, 200, {
        fetchedAt: ds.fetchedAt,
        refreshMinutes: REFRESH_MINUTES,
        windowDays: WINDOW_DAYS,
        yearsLoaded: ds.yearsLoaded,
        total: ds.count,
        counts,
        errors: ds.errors,
        cache: cache.stats(),
        upstream: upstreamState(),
        verify: {
          source: 'BSE',
          fetchedAt: vdoc ? vdoc.fetchedAt : null,
          counts: vdoc ? { issues: vdoc.issues.length, listed: vdoc.listed.length } : null,
          breaker: verifyState(),
        },
      });
      return;
    }

    if (p === '/api/markets') {
      const snap = await getMarkets();
      json(res, 200, snap || { fetchedAt: null, quotes: [] });
      return;
    }

    if (p === '/api/notable') {
      const nd = await getNotableDataset();
      json(res, 200, {
        fetchedAt: nd.fetchedAt,
        count: nd.count,
        ipos: nd.ipos.map(summarize),
      });
      return;
    }

    if (p === '/api/subscribe') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'Use POST with a JSON body: { email, preferences }' });
        return;
      }
      const ip =
        String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket.remoteAddress ||
        'unknown';
      if (subRateLimited(ip)) {
        json(res, 429, { error: 'Too many subscription attempts — please try again later.' });
        return;
      }
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        json(res, err && err.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid JSON body' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        json(res, 400, { error: 'Expected a JSON object' });
        return;
      }
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (!email || email.length > 254) {
        json(res, 400, { error: 'Invalid email address' });
        return;
      }
      const rawPrefs =
        body.preferences && typeof body.preferences === 'object' && !Array.isArray(body.preferences)
          ? body.preferences
          : {};
      const preferences = {
        upcoming: rawPrefs.upcoming !== false,
        weeklyDigest: rawPrefs.weeklyDigest !== false,
        analysis: rawPrefs.analysis !== false,
      };
      try {
        const result = addSubscriber(email, preferences);
        console.log(
          `[subscribe] ${result.already ? 'repeat' : 'new'} — ${email.replace(/^(.{2}).*(@.*)$/, '$1***$2')} (total: ${result.total})`
        );
        let confirmationSent = false;
        if (!result.already) {
          const mail = welcomeEmail(email, preferences);
          const sent = await sendMail({ to: email, ...mail });
          confirmationSent = sent.sent;
          const masked = email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
          if (sent.sent) console.log(`[subscribe] welcome email sent via ${sent.provider} → ${masked}`);
          else
            console.warn(
              `[subscribe] welcome email NOT sent (${sent.reason})${sent.detail ? ` — ${sent.detail}` : ''} → ${masked}`
            );
        }
        json(res, 200, { ok: true, already: result.already, total: result.total, confirmationSent });
      } catch (err) {
        if (err && err.code === 'INVALID_EMAIL') {
          json(res, 400, { error: err.message });
        } else {
          console.error('[subscribe] failed:', err);
          json(res, 500, { error: 'Could not save the subscription — please try again.' });
        }
      }
      return;
    }

    if (p === '/api/subscribers/count') {
      json(res, 200, { count: countSubscribers() });
      return;
    }

    if (p === '/api/unsubscribe') {
      const email = (url.searchParams.get('email') || '').trim().toLowerCase();
      const token = url.searchParams.get('token') || '';
      const valid = isValidEmail(email) && token && token === unsubscribeToken(email);
      if (!valid) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(invalidLinkPage());
        return;
      }
      const result = removeSubscriber(email);
      console.log(
        `[unsubscribe] ${result.removed ? 'removed' : 'not on list'} — ${email.replace(/^(.{2}).*(@.*)$/, '$1***$2')}`
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(unsubscribedPage({ removed: result.removed, email }));
      return;
    }

    if (p === '/' || p === '/index.html' || p.startsWith('/ipo/')) {
      // /ipo/:id routes are client-side views of the SPA — always serve the shell.
      return sendIndexHtml(res, req);
    }
    // Code assets: no-cache + If-Modified-Since 304s — a deploy can never leave
    // a stale app.js/styles.css pair in the browser (the old max-age did).
    if (p === '/app.js') return sendFile(res, req, path.join(PUBLIC_DIR, 'app.js'), { cache: 'no-cache' });
    if (p === '/config.js') return sendFile(res, req, path.join(PUBLIC_DIR, 'config.js'), { cache: 'no-cache' });
    if (p === '/styles.css') return sendFile(res, req, path.join(PUBLIC_DIR, 'styles.css'), { cache: 'no-cache' });
    if (p === '/sw.js') return sendFile(res, req, path.join(PUBLIC_DIR, 'sw.js'), { cache: 'no-cache' });
    if (p === '/manifest.webmanifest') return sendFile(res, req, path.join(PUBLIC_DIR, 'manifest.webmanifest'), { cache: 'public, max-age=86400' });
    if (p === '/favicon.png') return sendFile(res, req, path.join(PUBLIC_DIR, 'favicon.png'), { cache: 'public, max-age=86400' });
    if (p.startsWith('/icons/')) {
      // PWA icons — plain filenames only (the regex blocks ../ traversal).
      const name = p.slice('/icons/'.length);
      if (/^[A-Za-z0-9._-]+$/.test(name)) {
        return sendFile(res, req, path.join(PUBLIC_DIR, 'icons', name), { cache: 'public, max-age=604800' });
      }
    }
    if (p === '/healthz') return json(res, 200, { ok: true });

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error('[error]', p, err);
    json(res, 500, { error: String((err && err.message) || err) });
  }
});

getDataset()
  .then((ds) => console.log(`[boot] loaded ${ds.count} IPOs (years: ${ds.yearsLoaded.join(', ')})`))
  .catch((err) => console.error('[boot] initial load failed:', err.message));

console.log(
  `[mail] ${
    isMailConfigured()
      ? `provider "${providerName()}" — welcome emails enabled`
      : 'no email provider configured — welcome emails disabled (set RESEND_API_KEY / SENDGRID_API_KEY / BREVO_API_KEY + MAIL_FROM)'
  }`
);

setInterval(() => {
  getDataset()
    .then((ds) => console.log(`[refresh] ${new Date().toISOString()} — ${ds.count} IPOs`))
    .catch((err) => console.error('[refresh] failed:', err.message));
}, LIST_TTL);

server.listen(PORT, () => {
  console.log(`IPO India Tracker running → http://localhost:${PORT}`);
});


