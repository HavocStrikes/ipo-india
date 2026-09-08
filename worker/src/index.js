/**
 * IPO India Tracker — Cloudflare Worker port of server.js.
 *
 * Same API surface as the Node server:
 *   GET  /                      -> static SPA (public/, via Workers Static Assets)
 *   GET  /ipo/:id               -> SPA deep link (assets not_found_handling)
 *   GET  /api/ipos              -> live IPO list (merged + scored, filters)
 *   GET  /api/ipos/:id          -> one IPO with deep detail (scraped, cached)
 *   GET  /api/meta              -> data freshness info
 *   GET  /api/notable           -> famous/notable IPOs (deep-history search)
 *   POST /api/subscribe         -> { email, preferences } (welcome email)
 *   GET  /api/subscribers/count -> subscriber count
 *   GET  /api/unsubscribe       -> one-click unsubscribe (signed link)
 *   GET  /api/alerts/status     -> ops view of the Mainboard alert pipeline (no PII)
 *   GET  /healthz
 *
 * Architecture notes (free-plan friendly):
 *  - A cron trigger runs every 10 minutes and rebuilds the CURRENT year
 *    dataset + dashboard timetable, storing it in KV (records:<year>, list:<year>).
 *  - The previous year is refreshed every ~6h (it barely changes).
 *  - Deep-history "notable" years rotate: one year per cron run, so we never
 *    exceed the 50-subrequest free-tier limit in a single invocation.
 *  - Request handlers only read the small pre-summarized KV entries, keeping
 *    per-request CPU well inside the free-tier budget.
 *  - The in-memory TTL cache from server.js becomes KV (with TTLs); the
 *    per-IP subscribe rate limiter stays best-effort in isolate memory.
 *
 * Shared parsing/scoring logic is imported from ../lib (bundled by wrangler).
 */
import { loadYear, deriveStatus } from '../../lib/normalize.js';
import { loadDashboardSchedule, toIpoRecord } from '../../lib/dashboard.js';
import { computeScore } from '../../lib/scoring.js';
import { loadDetail, mergeDetailIntoIpo } from '../../lib/detail.js';
import {
  addSubscriber,
  removeSubscriber,
  count as countSubscribers,
  isValidEmail,
  unsubscribeToken,
} from './subscribers.js';
import { sendMail, welcomeEmail, isMailConfigured, providerName } from './mail.js';
import { isNotableName } from './notable.js';
import { runMainboardAlerts, mainboardAlertStatus } from './mainboard-alerts.js';

const DETAIL_TTL_SECONDS = 30 * 60; // scraped detail + merged record cache

const nameMatches = isNotableName; // shared watchlist (worker/src/notable.js)

function windowDays(env) {
  return Number(env.WINDOW_DAYS || 31);
}

/** True if the IPO's key date falls inside the curated window for its status. */
function inWindow(ipo, status, env, now = new Date()) {
  const wd = windowDays(env);
  const day = 86400000;
  const t = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - wd * day).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + wd * day).toISOString().slice(0, 10);
  if (status === 'upcoming') return !!ipo.openDate && ipo.openDate >= t && ipo.openDate <= to;
  if (status === 'listed') return !!ipo.listingDate && ipo.listingDate <= t && ipo.listingDate >= from;
  if (status === 'closed') return !!ipo.closeDate && ipo.closeDate < t && ipo.closeDate >= from;
  return true;
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

/**
 * Project an IPO (full record OR an already-summarized list entry) down to the
 * wire shape used by /api/ipos and /api/notable. Tolerant of both shapes so it
 * can be applied idempotently.
 */
function summarize(ipo) {
  return {
    id: ipo.id,
    name: ipo.name,
    slug: ipo.slug ?? null,
    category: ipo.category ?? null,
    exchange: ipo.exchange ?? null,
    status: ipo.status,
    openDate: ipo.openDate ?? null,
    closeDate: ipo.closeDate ?? null,
    allotmentDate: ipo.allotmentDate ?? null,
    listingDate: ipo.listingDate ?? null,
    issuePrice: ipo.issuePrice ?? null,
    issueAmountCr: ipo.issueAmountCr ?? null,
    subscriptionX: ipo.subscriptionX ?? null,
    listingGainPct: ipo.listingGainPct ?? (ipo.listing && ipo.listing.gainPct) ?? null,
    listingOpenPrice: ipo.listingOpenPrice ?? (ipo.listing && ipo.listing.openPrice) ?? null,
    marketPrice: ipo.marketPrice ?? (ipo.market && ipo.market.price) ?? null,
    pePost: ipo.pePost ?? (ipo.kpi && ipo.kpi.pePost) ?? null,
    ronw: ipo.ronw ?? (ipo.kpi && (ipo.kpi.ronw ?? ipo.kpi.roe)) ?? null,
    score: ipo.score
      ? { score: ipo.score.score, verdict: ipo.score.verdict, tone: ipo.score.tone, confidence: ipo.score.confidence, pillars: ipo.score.pillars || null }
      : null,
    detailUrl: ipo.detailUrl ?? null,
    nseSymbol: ipo.nseSymbol ?? null,
    known: ipo.known ?? countKnown(ipo),
  };
}

// ---- tiny JSON/KV helpers -------------------------------------------------

async function getJson(env, key) {
  const raw = await env.DATA.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function putJson(env, key, value, ttlSeconds) {
  const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
  await env.DATA.put(key, JSON.stringify(value), opts);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function htmlPage(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ---- dataset build (cron side) ---------------------------------------------

/** Build the current-year dataset: JSON reports + live dashboard timetable. */
async function buildCurrentYearDataset(env) {
  const y = new Date().getUTCFullYear();
  const results = await Promise.allSettled([loadYear(y), loadDashboardSchedule()]);
  const yearResult = results[0];
  const dashResult = results[1];
  const errors = [];
  const byId = new Map();

  if (yearResult.status === 'fulfilled') {
    for (const ipo of yearResult.value.ipos) {
      const prev = byId.get(ipo.id);
      if (!prev || countKnown(ipo) > countKnown(prev)) byId.set(ipo.id, ipo);
    }
    if (yearResult.value.errors) {
      yearResult.value.errors.forEach((e) => errors.push({ year: y, ...e }));
    }
  } else {
    errors.push({ year: y, error: String(yearResult.reason && yearResult.reason.message) });
  }

  // Backfill schedules from the live dashboard timetable (never overwrite
  // dates the reports already published — same policy as server.js).
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
    enriched.status = deriveStatus(enriched);
    enriched.score = computeScore(enriched);
    final.push(enriched);
  }
  final.sort((a, b) => (b.openDate || '0000').localeCompare(a.openDate || '0000'));
  return {
    year: y,
    fetchedAt: new Date().toISOString(),
    yearsLoaded: [y],
    count: final.length,
    errors,
    ipos: final,
  };
}

/** Build a past-year dataset (JSON reports only — no dashboard entries). */
async function buildPastYearDataset(year) {
  const result = await loadYear(year);
  const final = result.ipos.map((ipo) => {
    const enriched = { ...ipo };
    enriched.status = deriveStatus(enriched);
    enriched.score = computeScore(enriched);
    return enriched;
  });
  final.sort((a, b) => (b.openDate || '0000').localeCompare(a.openDate || '0000'));
  return {
    year,
    fetchedAt: new Date().toISOString(),
    yearsLoaded: [year],
    count: final.length,
    errors: result.errors || [],
    ipos: final,
  };
}

/** Small per-year wire version stored under list:<year>. */
function listVersion(recordsDoc) {
  return {
    year: recordsDoc.year,
    fetchedAt: recordsDoc.fetchedAt,
    yearsLoaded: recordsDoc.yearsLoaded,
    total: recordsDoc.count,
    errors: recordsDoc.errors,
    ipos: recordsDoc.ipos.map(summarize),
  };
}

// ---- cron orchestration -----------------------------------------------------

/**
 * Refresh KV data. Runs every 10 minutes; each run does:
 *   1. current year + dashboard rebuild            (16 upstream fetches)
 *   2. previous year — every 6h, or if missing     (14 fetches)
 *   3. ONE rotating deep-history year (even slots) (14 fetches)
 *   4. rebuild the `notable` list from stored pieces (KV reads only)
 * Keeping the per-run fetch count <= ~44 stays under the free-tier
 * 50-subrequest limit, and rotating keeps deep history fresh within ~1-2h.
 */
async function refreshData(env) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const py = y - 1;
  const minute = now.getUTCMinutes();
  const slot = Math.floor(minute / 10); // 0..5

  // 1. current year + dashboard
  const cur = await buildCurrentYearDataset(env);
  await putJson(env, `records:${y}`, cur);
  await putJson(env, `list:${y}`, listVersion(cur));

  // 2. previous year (every 6h, or immediately when missing)
  let prevList = await getJson(env, `list:${py}`);
  if (!prevList || (slot === 0 && now.getUTCHours() % 6 === 0)) {
    try {
      const prev = await buildPastYearDataset(py);
      await putJson(env, `records:${py}`, prev);
      await putJson(env, `list:${py}`, listVersion(prev));
      prevList = listVersion(prev);
    } catch (err) {
      console.error(`[refresh] past year ${py} failed:`, err && err.message);
    }
  }

  // 3. rotating deep-history years (y-2 .. y-1-NOTABLE_HISTORY_YEARS)
  const olds = [];
  const notableYears = Number(env.NOTABLE_HISTORY_YEARS || 5);
  for (let i = 2; i <= 1 + notableYears; i++) olds.push(y - i);
  if (olds.length && slot % 2 === 0) {
    const rotYear = olds[(slot / 2) % olds.length];
    try {
      const built = await buildPastYearDataset(rotYear);
      const matches = built.ipos.filter((ipo) => nameMatches(ipo.name));
      await putJson(env, `notableold:${rotYear}`, {
        year: rotYear,
        fetchedAt: built.fetchedAt,
        count: matches.length,
        ipos: matches,
      });
    } catch (err) {
      console.error(`[refresh] notable year ${rotYear} failed:`, err && err.message);
    }
  }

  // 4. rebuild `notable` = current-year matches + prev-year + stored old years
  const notable = [];
  for (const ipo of cur.ipos) if (nameMatches(ipo.name)) notable.push(ipo);
  if (prevList) for (const s of prevList.ipos) if (nameMatches(s.name)) notable.push(s);
  for (const oy of olds) {
    const stored = await getJson(env, `notableold:${oy}`);
    if (stored) for (const r of stored.ipos) notable.push(r);
  }

  // de-dupe by id, keeping the richer record
  const byId = new Map();
  for (const ipo of notable) {
    const prev = byId.get(ipo.id);
    if (!prev || countKnown(ipo) > countKnown(prev)) byId.set(ipo.id, ipo);
  }
  const ranked = [...byId.values()].map(summarize);
  ranked.sort((a, b) => {
    const dateDiff = (b.listingDate || '').localeCompare(a.listingDate || '');
    if (dateDiff !== 0) return dateDiff;
    return (b.score && b.score.score) - (a.score && a.score.score);
  });
  await putJson(env, 'notable', {
    fetchedAt: cur.fetchedAt,
    count: ranked.length,
    ipos: ranked,
  });
}

// ---- request side -----------------------------------------------------------

/** Per-isolate best-effort rate limiter for /api/subscribe (like server.js). */
const SUB_RATE_WINDOW_MS = 60 * 60 * 1000;
const subHits = new Map(); // ip -> [timestamps]

function subRateLimited(ip, max) {
  const now = Date.now();
  const hits = (subHits.get(ip) || []).filter((t) => now - t < SUB_RATE_WINDOW_MS);
  hits.push(now);
  subHits.set(ip, hits);
  if (subHits.size > 5000) {
    for (const [key, ts] of subHits) {
      if (ts.every((t) => now - t >= SUB_RATE_WINDOW_MS)) subHits.delete(key);
    }
  }
  return hits.length > (max || 8);
}

/** Merged, de-duped summaries from both years (current year wins ties). */
async function mergedSummaries(env) {
  const y = new Date().getUTCFullYear();
  const [cur, prev] = await Promise.all([getJson(env, `list:${y}`), getJson(env, `list:${y - 1}`)]);
  const merged = new Map();
  for (const list of [cur, prev]) {
    if (!list) continue;
    for (const s of list.ipos) {
      const existing = merged.get(s.id);
      if (!existing || (s.known || 0) > (existing.known || 0)) merged.set(s.id, s);
    }
  }
  const ipos = [...merged.values()];
  ipos.sort((a, b) => (b.openDate || '0000').localeCompare(a.openDate || '0000'));
  return {
    yearsLoaded: [cur, prev].filter(Boolean).flatMap((l) => l.yearsLoaded || []),
    fetchedAt: cur ? cur.fetchedAt : prev ? prev.fetchedAt : null,
    total: [cur, prev].reduce((n, l) => n + (l ? l.total || 0 : 0), 0),
    errors: [cur, prev].filter(Boolean).flatMap((l) => l.errors || []),
    ipos,
  };
}

/** If KV is cold (fresh deploy), kick off a refresh and report warming. */
async function ensureWarm(env, ctx) {
  const cur = await getJson(env, `list:${new Date().getUTCFullYear()}`);
  if (cur) return true;
  ctx.waitUntil(refreshData(env).catch((e) => console.error('[warm] failed:', e && e.message)));
  return false;
}

const WARMING = () =>
  json({ error: 'warming_up', message: 'First run in progress — retry in ~15 seconds.' }, 503);

async function handleSubscribe(request, env, ctx, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Use POST with a JSON body: { email, preferences }' }, 405);
  }
  const ip =
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown';
  if (subRateLimited(ip, Number(env.SUB_RATE_MAX || 8))) {
    return json({ error: 'Too many subscription attempts — please try again later.' }, 429);
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 10 * 1024) return json({ error: 'Request body too large' }, 413);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Expected a JSON object' }, 400);
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!email || email.length > 254) return json({ error: 'Invalid email address' }, 400);
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
    const result = await addSubscriber(env, email, preferences);
    let confirmationSent = false;
    if (!result.already) {
      const token = await unsubscribeToken(env, email);
      const siteUrl = url.origin;
      const unsubUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
      const mail = welcomeEmail(email, preferences, siteUrl, unsubUrl);
      const sent = await sendMail(env, { to: email, ...mail });
      confirmationSent = sent.sent;
      const masked = email.replace(/^(.{2}).*(@.*)$/, '$1***$2');
      if (sent.sent) console.log(`[subscribe] welcome email sent via ${sent.provider} -> ${masked}`);
      else console.warn(`[subscribe] welcome email NOT sent (${sent.reason}) -> ${masked}`);
    }
    return json({ ok: true, already: result.already, total: result.total, confirmationSent });
  } catch (err) {
    if (err && err.code === 'INVALID_EMAIL') return json({ error: err.message }, 400);
    console.error('[subscribe] failed:', err);
    return json({ error: 'Could not save the subscription — please try again.' }, 500);
  }
}

async function handleApi(request, env, ctx, url) {
  const p = url.pathname;
  const y = new Date().getUTCFullYear();

  if (p === '/api/ipos') {
    if (!(await ensureWarm(env, ctx))) return WARMING();
    const ds = await mergedSummaries(env);
    const status = url.searchParams.get('status');
    const category = url.searchParams.get('category');
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const showAll = url.searchParams.get('all') === '1';
    let rows = ds.ipos;
    if (status && status !== 'all') rows = rows.filter((i) => i.status === status);
    if (!showAll && status && status !== 'all' && status !== 'open') {
      rows = rows.filter((i) => inWindow(i, status, env));
    }
    if (category && category !== 'all') {
      rows = rows.filter((i) => (i.category || '').toLowerCase() === category.toLowerCase());
    }
    if (q) rows = rows.filter((i) => i.name.toLowerCase().includes(q));
    return json({
      fetchedAt: ds.fetchedAt,
      yearsLoaded: ds.yearsLoaded,
      windowDays: windowDays(env),
      curated: !showAll,
      total: ds.total,
      returned: rows.length,
      errors: ds.errors,
      ipos: rows,
    });
  }

  const detailMatch = p.match(/^\/api\/ipos\/(\d+)$/);
  if (detailMatch) {
    const id = Number(detailMatch[1]);
    // fast path: merged record cached from a recent view
    const cachedIpo = await getJson(env, `ipo:${id}`);
    const cachedDetail = await getJson(env, `detail:${id}`);
    if (cachedIpo && cachedDetail) {
      return json({ fetchedAt: cachedIpo.fetchedAt, ipo: cachedIpo.ipo, detail: cachedDetail });
    }

    const cur = await getJson(env, `list:${y}`);
    const prev = await getJson(env, `list:${y - 1}`);
    let year = null;
    let fetchedAt = null;
    if (cur && cur.ipos.some((i) => i.id === id)) {
      year = y;
      fetchedAt = cur.fetchedAt;
    } else if (prev && prev.ipos.some((i) => i.id === id)) {
      year = y - 1;
      fetchedAt = prev.fetchedAt;
    }
    if (!year) return json({ error: 'IPO not found', id }, 404);

    const records = await getJson(env, `records:${year}`);
    const ipo = records && records.ipos.find((i) => i.id === id);
    if (!ipo) return json({ error: 'IPO not found', id }, 404);

    let detail;
    try {
      detail = await loadDetail(ipo);
    } catch (err) {
      detail = { error: String((err && err.message) || err) };
    }
    const merged = mergeDetailIntoIpo(ipo, detail, deriveStatus);
    await putJson(env, `ipo:${id}`, { fetchedAt, ipo: merged }, DETAIL_TTL_SECONDS);
    await putJson(env, `detail:${id}`, detail, DETAIL_TTL_SECONDS);
    return json({ fetchedAt, ipo: merged, detail });
  }

  if (p === '/api/meta') {
    if (!(await ensureWarm(env, ctx))) return WARMING();
    const ds = await mergedSummaries(env);
    const counts = { open: 0, upcoming: 0, closed: 0, listed: 0 };
    ds.ipos.forEach((i) => {
      if (counts[i.status] !== undefined && inWindow(i, i.status, env)) counts[i.status]++;
    });
    return json({
      fetchedAt: ds.fetchedAt,
      refreshMinutes: Number(env.REFRESH_MINUTES || 10),
      windowDays: windowDays(env),
      yearsLoaded: ds.yearsLoaded,
      total: ds.total,
      counts,
      errors: ds.errors,
      cache: { store: 'kv' },
    });
  }

  if (p === '/api/notable') {
    if (!(await ensureWarm(env, ctx))) return WARMING();
    const nd = await getJson(env, 'notable');
    if (!nd) return WARMING();
    return json({ fetchedAt: nd.fetchedAt, count: nd.count, ipos: nd.ipos });
  }

  if (p === '/api/subscribe') return handleSubscribe(request, env, ctx, url);

  if (p === '/api/subscribers/count') {
    return json({ count: await countSubscribers(env) });
  }

  if (p === '/api/alerts/status') {
    return json({
      mailConfigured: isMailConfigured(env),
      provider: providerName(env),
      ...(await mainboardAlertStatus(env)),
    });
  }

  if (p === '/api/unsubscribe') {
    const email = (url.searchParams.get('email') || '').trim().toLowerCase();
    const token = url.searchParams.get('token') || '';
    const expected = await unsubscribeToken(env, email);
    const valid = isValidEmail(email) && token && token === expected;
    const emailEsc = email.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    if (!valid) {
      return htmlPage(
        '<!doctype html><html><head><meta charset="utf-8"><title>IPO India</title></head><body style="font-family:Arial,sans-serif;background:#f4f6fd;color:#0e1428;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center;padding:24px"><h1>Invalid link</h1><p style="color:#4a546e">This unsubscribe link is broken or incomplete.</p></div></body></html>',
        400
      );
    }
    const result = await removeSubscriber(env, email);
    return htmlPage(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — IPO India</title></head>` +
        `<body style="font-family:Arial,sans-serif;background:#f4f6fd;color:#0e1428;display:grid;place-items:center;min-height:100vh;margin:0">` +
        `<div style="text-align:center;padding:24px"><div style="font-size:40px">✓</div><h1 style="margin:8px 0">You&rsquo;re unsubscribed</h1>` +
        `<p style="color:#4a546e">${result.removed ? `<b>${emailEsc}</b> has been removed from the IPO India mailing list.` : 'This address was not on the mailing list.'}</p>` +
        `<p style="font-size:12px;color:#8a94ad">Sorry to see you go — you can always resubscribe on the site.</p></div></body></html>`
    );
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/healthz') return json({ ok: true });
      if (p === '/api' || p.startsWith('/api/')) return await handleApi(request, env, ctx, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error('[error]', p, err);
      return json({ error: String((err && err.message) || err) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    await refreshData(env);

    // Mainboard-only IPO alert pipeline (replaces the older all-category
    // alerts.js hook, which would double-send and leak SME emails).
    // MAINBOARD_ALERTS_EVERY_RUN=1 in .dev.vars overrides for local testing.
    const slot = Math.floor(new Date().getUTCMinutes() / 10);
    if (slot % 2 === 1 || String(env.MAINBOARD_ALERTS_EVERY_RUN || '') === '1') {
      try {
        const stats = await runMainboardAlerts(env);
        if (stats && (stats.sent || stats.pending || stats.reason === 'no_subscribers' || stats.events)) {
          console.log('[mainboard-alerts]', JSON.stringify(stats));
        }
      } catch (err) {
        console.error('[mainboard-alerts] run failed:', err && (err.stack || err.message || err));
      }
    }
  },
};
