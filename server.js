/**
 * IPO India Tracker — zero-dependency Node.js server.
 *
 * Serves:
 *   /                      -> static SPA (public/)
 *   /api/ipos              -> live IPO list (merged + scored)
 *   /api/ipos/:id          -> one IPO with deep detail (scraped, cached)
 *   /api/meta              -> data freshness info
 *   /api/subscribe         -> POST { email, preferences } to subscribe
 *   /api/subscribers/count -> subscriber count (no emails exposed)
 *   /api/unsubscribe       -> GET one-click unsubscribe (signed link from emails)
 *
 * Upstream data is refreshed in the background every REFRESH_MINUTES.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TTLCache } = require('./lib/cache');
const { loadYear, deriveStatus } = require('./lib/normalize');
const { loadDashboardSchedule, toIpoRecord } = require('./lib/dashboard');
const { computeScore } = require('./lib/scoring');
const { loadDetail, mergeDetailIntoIpo } = require('./lib/detail');
const { upstreamState } = require('./lib/fetcher');
const {
  addSubscriber,
  removeSubscriber,
  count: countSubscribers,
  isValidEmail,
  unsubscribeToken,
} = require('./lib/subscriptions');
const { sendMail, welcomeEmail, isMailConfigured, providerName } = require('./lib/mailer');

const PORT = process.env.PORT || 8787;
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES || 10);
const LIST_TTL = REFRESH_MINUTES * 60 * 1000;
const DETAIL_TTL = 30 * 60 * 1000;
const HISTORY_YEARS = Number(process.env.HISTORY_YEARS || 1); // years of listed history
// Curated windows (like Groww): upcoming = opens within the next N days,
// listed = listed within the last N days. `?all=1` bypasses the window.
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 31);

// Famous/Notable IPOs that people search for — we search deeper history for these.
const NOTABLE_NAMES = [
  'zomato', 'swiggy', 'paytm', 'one97', 'lic', 'life insurance',
  'oyo', 'phonepe', 'flipkart', 'jio', 'reliance jio',
  'delhivery', 'nykaa', 'fsn e-ventures', 'idea',
  'sbi cards', 'policybazaar', 'pb fintech',
  'hdfc bank', 'hdfc life', 'icici lombard',
  'tata motors', 'tata technologies', 'hyundai',
  'coal india', 'rec limited', 'pfc',
];
const NOTABLE_TTL = 60 * 60 * 1000; // refresh notable list every hour
const NOTABLE_HISTORY_YEARS = 6; // go back to 2020 for notable IPOs

/** True if the IPO's key date falls inside the curated window for its status. */
function inWindow(ipo, status, now = new Date()) {
  const day = 86400000;
  const t = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - WINDOW_DAYS * day).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + WINDOW_DAYS * day).toISOString().slice(0, 10);
  if (status === 'upcoming') return !!ipo.openDate && ipo.openDate >= t && ipo.openDate <= to;
  if (status === 'listed') return !!ipo.listingDate && ipo.listingDate <= t && ipo.listingDate >= from;
  if (status === 'closed') return !!ipo.closeDate && ipo.closeDate < t && ipo.closeDate >= from;
  return true;
}

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
  '.webmanifest': 'application/manifest+json',
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
  return { fetchedAt: new Date().toISOString(), yearsLoaded, count: final.length, errors, ipos: final };
}

function countKnown(ipo) {
  let n = 0;
  if (ipo.closeDate) n++;
  if (ipo.listingDate) n++;
  if (ipo.subscriptionX !== null && ipo.subscriptionX !== undefined) n++;
  if (ipo.financials && ipo.financials.patCr !== null) n++;
  if (ipo.kpi && ipo.kpi.pePost !== null) n++;
  return n;
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

// __FAMOUS1__
const FAMOUS_IPOS_PART1 = [
  {
    id: 10001, name: 'Zomato Ltd.', slug: 'zomato-ipo', category: 'Mainboard',
    status: 'listed', openDate: '2021-07-14', closeDate: '2021-07-16', listingDate: '2021-07-23',
    issuePrice: 76, issueAmountCr: 9375, subscriptionX: 38.25,
    listing: { openPrice: 115, closePrice: 126, gainPct: 65.79 },
    market: { price: 130.50, week52High: 169.25, week52Low: 98.50 },
    kpi: { pePost: null, ronw: null, priceToBook: null },
    reviews: { subscribe: 0, neutral: 0, avoid: 0 },
    isin: 'INE758T01015', bseCode: '543320', nseSymbol: 'ZOMATO',
    detailUrl: 'https://www.chittorgarh.com/ipo/zomato-ipo/1895/',
    source: 'curated', famous: true,
  },
  {
    id: 10002, name: 'Paytm (One97 Communications) Ltd.', slug: 'one97-communications-ipo', category: 'Mainboard',
    status: 'listed', openDate: '2021-11-08', closeDate: '2021-11-10', listingDate: '2021-11-18',
    issuePrice: 2150, issueAmountCr: 18300, subscriptionX: 1.82,
    listing: { openPrice: 1950, closePrice: 1560, gainPct: -27.44 },
    market: { price: 620, week52High: 998, week52Low: 385 },
    kpi: { pePost: null, ronw: null, priceToBook: null },
    reviews: { subscribe: 0, neutral: 0, avoid: 0 },
    isin: 'INE982J01020', bseCode: '543280', nseSymbol: 'PAYTM',
    detailUrl: 'https://www.chittorgarh.com/ipo/one97-communications-ipo/1857/',
    source: 'curated', famous: true,
  },
  {
    id: 10003, name: 'LIC (Life Insurance Corporation of India)', slug: 'lic-ipo', category: 'Mainboard',
    status: 'listed', openDate: '2022-05-04', closeDate: '2022-05-09', listingDate: '2022-05-17',
    issuePrice: 949, issueAmountCr: 20885, subscriptionX: 2.99,
    listing: { openPrice: 900, closePrice: 875, gainPct: -7.8 },
    market: { price: 625, week52High: 948, week52Low: 540 },
    kpi: { pePost: null, ronw: null, priceToBook: null },
    reviews: { subscribe: 0, neutral: 0, avoid: 0 },
    isin: 'INE0J1Y01017', bseCode: '543526', nseSymbol: 'LICI',
    detailUrl: 'https://www.chittorgarh.com/ipo/lic-ipo/1947/',
    source: 'curated', famous: true,
  },
  {
    id: 10004, name: 'Nykaa (FSN E-Commerce Ventures) Ltd.', slug: 'nykaa-ipo', category: 'Mainboard',
    status: 'listed', openDate: '2021-10-28', closeDate: '2021-11-01', listingDate: '2021-11-10',
    issuePrice: 1125, issueAmountCr: 5352, subscriptionX: 81.7,
    listing: { openPrice: 2004, closePrice: 2206, gainPct: 96.09 },
    market: { price: 145, week52High: 250, week52Low: 110 },
    kpi: { pePost: null, ronw: null, priceToBook: null },
    reviews: { subscribe: 0, neutral: 0, avoid: 0 },
    isin: 'INE388Y01029', bseCode: '543329', nseSymbol: 'NYKAA',
    detailUrl: 'https://www.chittorgarh.com/ipo/nykaa-ipo/1885/',
    source: 'curated', famous: true,
  },
  {
    id: 10005, name: 'Delhivery Ltd.', slug: 'delhivery-ipo', category: 'Mainboard',
    status: 'listed', openDate: '2022-05-11', closeDate: '2022-05-13', listingDate: '2022-05-24',
    issuePrice: 487, issueAmountCr: 5235, subscriptionX: 1.61,
    listing: { openPrice: 500, closePrice: 568, gainPct: 16.63 },
    market: { price: 385, week52High: 550, week52Low: 280 },
    kpi: { pePost: null, ronw: null, priceToBook: null },
    reviews: { subscribe: 0, neutral: 0, avoid: 0 },
    isin: 'INE148O01028', bseCode: '543529', nseSymbol: 'DELHIVERY',
    detailUrl: 'https://www.chittorgarh.com/ipo/delhivery-ipo/1952/',
    source: 'curated', famous: true,
  },
];
// __FAMOUS2__

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

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function summarize(ipo) {
  return {
    id: ipo.id,
    name: ipo.name,
    slug: ipo.slug,
    category: ipo.category,
    exchange: ipo.exchange,
    status: ipo.status,
    openDate: ipo.openDate,
    closeDate: ipo.closeDate,
    allotmentDate: ipo.allotmentDate,
    listingDate: ipo.listingDate,
    issuePrice: ipo.issuePrice,
    issueAmountCr: ipo.issueAmountCr,
    subscriptionX: ipo.subscriptionX,
    listingGainPct: ipo.listing && ipo.listing.gainPct,
    marketPrice: ipo.market && ipo.market.price,
    pePost: ipo.kpi && ipo.kpi.pePost,
    ronw: ipo.kpi && (ipo.kpi.ronw ?? ipo.kpi.roe),
    score: {
      score: ipo.score.score,
      tone: ipo.score.tone,
      confidence: ipo.score.confidence,
    },
    detailUrl: ipo.detailUrl,
    nseSymbol: ipo.nseSymbol,
  };
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
        rows = rows.filter((i) => inWindow(i, status));
      }
      if (category && category !== 'all') {
        rows = rows.filter((i) => (i.category || '').toLowerCase() === category.toLowerCase());
      }
      if (q) rows = rows.filter((i) => i.name.toLowerCase().includes(q));
      json(res, 200, {
        fetchedAt: ds.fetchedAt,
        yearsLoaded: ds.yearsLoaded,
        windowDays: WINDOW_DAYS,
        curated: !showAll,
        total: ds.count,
        returned: rows.length,
        errors: ds.errors,
        ipos: rows.map(summarize),
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
      json(res, 200, { fetchedAt: ds.fetchedAt, ipo: merged, detail });
      return;
    }

    if (p === '/api/meta') {
      const ds = await getDataset();
      const counts = { open: 0, upcoming: 0, closed: 0, listed: 0 };
      ds.ipos.forEach((i) => {
        if (counts[i.status] !== undefined && inWindow(i, i.status)) counts[i.status]++;
      });
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
      });
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
      const emailEsc = email.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      if (!valid) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><head><meta charset="utf-8"><title>IPO India</title></head><body style="font-family:Arial,sans-serif;background:#f4f6fd;color:#0e1428;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center;padding:24px"><h1>Invalid link</h1><p style="color:#4a546e">This unsubscribe link is broken or incomplete.</p></div></body></html>'
        );
        return;
      }
      const result = removeSubscriber(email);
      console.log(
        `[unsubscribe] ${result.removed ? 'removed' : 'not on list'} — ${email.replace(/^(.{2}).*(@.*)$/, '$1***$2')}`
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — IPO India</title></head>` +
          `<body style="font-family:Arial,sans-serif;background:#f4f6fd;color:#0e1428;display:grid;place-items:center;min-height:100vh;margin:0">` +
          `<div style="text-align:center;padding:24px"><div style="font-size:40px">✓</div><h1 style="margin:8px 0">You&rsquo;re unsubscribed</h1>` +
          `<p style="color:#4a546e">${result.removed ? `<b>${emailEsc}</b> has been removed from the IPO India mailing list.` : 'This address was not on the mailing list.'}</p>` +
          `<p style="font-size:12px;color:#8a94ad">Sorry to see you go — you can always resubscribe on the site.</p></div></body></html>`
      );
      return;
    }

    if (p === '/' || p === '/index.html' || p.startsWith('/ipo/')) {
      // /ipo/:id routes are client-side views of the SPA — always serve the shell.
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (p === '/app.js') return sendFile(res, path.join(PUBLIC_DIR, 'app.js'));
    if (p === '/styles.css') return sendFile(res, path.join(PUBLIC_DIR, 'styles.css'));
    if (p === '/manifest.webmanifest') return sendFile(res, path.join(PUBLIC_DIR, 'manifest.webmanifest'));
    if (p === '/sw.js') return sendFile(res, path.join(PUBLIC_DIR, 'sw.js'));
    if (p.startsWith('/icons/')) {
      // PWA icons — plain filenames only (the regex blocks ../ traversal).
      const name = p.slice('/icons/'.length);
      if (/^[A-Za-z0-9._-]+$/.test(name)) {
        return sendFile(res, path.join(PUBLIC_DIR, 'icons', name));
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


