/**
 * Upstream data fetcher for Chittorgarh's public JSON "cloud report" endpoints
 * (the same JSON their own website loads) and public HTML pages.
 *
 * Politeness & ban-resilience rules live here:
 *  - Honest User-Agent: we identify ourselves (project repo as contact) instead
 *    of spoofing a browser. Verified 2026-09: chittorgarh.com robots.txt says
 *    `User-agent: * → Allow: /` and every endpoint used here answers 200 to it.
 *  - Low volume: callers cache 10-30 min; nothing here retries in a tight loop.
 *  - Fail fast on expected misses: 404/410 (e.g. absent FY variants) throw
 *    immediately — no retry, no penalty.
 *  - Backoff: transient failures (timeouts, 5xx) retry with linear backoff.
 *  - Circuit breaker: 403/406/429/503 mean "we are being blocked" — they are
 *    never retried and open a cooldown (30 min doubling per strike, capped at
 *    24 h; parallel failures within 10 s collapse into one strike; Retry-After
 *    is honored). While the cooldown is open every fetch fails fast so caches
 *    keep serving last-good data and we never hammer a site that blocked us.
 */
const REPORT_BASE = 'https://webnodejs.chittorgarh.com/cloud/report/data-read';

const UA =
  'ipo-india-tracker/1.0 (+https://github.com/HavocStrikes/ipo-india; low-volume public IPO tracker; respects robots.txt)';

/** Report IDs (upstream "data-read" report numbers). */
const REPORTS = {
  SCHEDULE: 7, // open/close/allotment dates, exchange, ISIN, symbols
  PERFORMANCE: 125, // price, subscription, listing date, listing gain, market price, 52w
  SUBSCRIPTION: 98, // QIB/NII/Retail/Total subscription breakdown
  FINANCIALS: 161, // assets/revenue/PAT/EBITDA/net worth/borrowings
  KPI: 162, // ROE/ROCE/RoNW/margins/P-B/EPS/P-E
  REVIEWS: 104, // community review votes (subscribe/neutral/avoid)
  ANCHORS: 156, // anchor investor allocations
};

function reportUrl(reportId, year, fy) {
  // Segments observed on the upstream site:
  // /data-read/<reportId>/1/6/<year>/<fy>/0/all/0
  return `${REPORT_BASE}/${reportId}/1/6/${year}/${fy}/0/all/0`;
}

// ---- circuit breaker (upstream block detection) ------------------------------

const COOLDOWN_START_MS = 30 * 60 * 1000; // first block: back off 30 minutes
const COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000; // repeated blocks: cap at 24 hours
const BAN_STATUSES = new Set([403, 406, 429, 503]);

let banUntil = 0;
let banStrikes = 0;
let lastBanNoteAt = 0;

function noteBan(retryAfterSeconds = 0) {
  const now = Date.now();
  // 14 parallel fetches can all 403 at once — collapse them into one strike.
  if (now - lastBanNoteAt > 10_000) banStrikes += 1;
  lastBanNoteAt = now;
  let ms = Math.min(COOLDOWN_START_MS * 2 ** (banStrikes - 1), COOLDOWN_MAX_MS);
  if (retryAfterSeconds > 0) ms = Math.max(ms, Math.min(retryAfterSeconds * 1000, COOLDOWN_MAX_MS));
  banUntil = now + ms;
  console.error(
    `[fetcher] upstream block signal — cooling down ${Math.round(ms / 60000)} min (strike ${banStrikes})`
  );
}

function noteOk() {
  banUntil = 0;
  banStrikes = 0;
}

/** Observability: is the fetcher currently in an upstream-block cooldown? */
function upstreamState() {
  return {
    inCooldown: Date.now() < banUntil,
    cooldownUntil: banUntil ? new Date(banUntil).toISOString() : null,
    strikes: banStrikes,
  };
}

function _resetBreakerForTests() {
  banUntil = 0;
  banStrikes = 0;
  lastBanNoteAt = 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch JSON with timeout, linear backoff on transient errors, fail-fast on
 * 404/410, and hard no-retry + breaker trip on block signals (403/406/429/503).
 */
async function fetchJson(url, { timeoutMs = 15000, retries = 2, backoffMs = 700 } = {}) {
  if (Date.now() < banUntil) {
    const err = new Error(`Upstream cooldown active — skipping fetch of ${url}`);
    err.code = 'UPSTREAM_COOLDOWN';
    throw err;
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-IN,en;q=0.9',
          Origin: 'https://www.chittorgarh.com',
          Referer: 'https://www.chittorgarh.com/',
        },
      });
      clearTimeout(timer);
      if (res.ok) {
        noteOk();
        return await res.json();
      }
      if (BAN_STATUSES.has(res.status)) {
        // Block signal: never retried, opens the cooldown.
        noteBan(Number(res.headers.get('retry-after')) || 0);
        throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
      }
      if (res.status === 404 || res.status === 410) {
        // Expected miss (e.g. one FY variant has no rows): fail fast, no ban.
        throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
      }
      // 5xx / odd statuses are worth a couple of gentle retries.
      throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), {
        status: res.status,
        retryable: true,
      });
    } catch (err) {
      clearTimeout(timer);
      // Terminal statuses (block signals, expected misses) propagate untouched.
      if (err.status && !err.retryable) throw err;
      lastErr = err;
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

/** Fetch one report table for a given year (merges both fiscal-year segments). */
async function fetchReportYear(reportId, year, { timeoutMs, retries } = {}) {
  const fys = [`${year}-${String((year + 1) % 100).padStart(2, '0')}`, `${year - 1}-${String(year % 100).padStart(2, '0')}`];
  const results = await Promise.allSettled(
    fys.map((fy) => fetchJson(reportUrl(reportId, year, fy), { timeoutMs, retries }))
  );
  const byId = new Map();
  let anyOk = false;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    anyOk = true;
    const rows = Array.isArray(r.value && r.value.reportTableData) ? r.value.reportTableData : [];
    for (const row of rows) {
      const id = row && row['~id'];
      if (id === undefined || id === null) continue;
      // keep the richer row when the same id appears in both FY segments
      const prev = byId.get(Number(id));
      if (!prev || Object.keys(row).length > Object.keys(prev).length) byId.set(Number(id), row);
    }
  }
  if (!anyOk) throw new Error(`all FY variants failed for report ${reportId}/${year}`);
  return [...byId.values()];
}

/** Fetch an HTML page with the same timeout/backoff/block rules as fetchJson. */
async function fetchPage(htmlUrl, { timeoutMs = 20000, retries = 1, backoffMs = 800 } = {}) {
  if (Date.now() < banUntil) {
    const err = new Error(`Upstream cooldown active — skipping fetch of ${htmlUrl}`);
    err.code = 'UPSTREAM_COOLDOWN';
    throw err;
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(htmlUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-IN,en;q=0.9',
        },
      });
      clearTimeout(timer);
      if (res.ok) {
        noteOk();
        return await res.text();
      }
      if (BAN_STATUSES.has(res.status)) {
        noteBan(Number(res.headers.get('retry-after')) || 0);
        throw Object.assign(new Error(`HTTP ${res.status} for ${htmlUrl}`), { status: res.status });
      }
      if (res.status === 404 || res.status === 410) {
        throw Object.assign(new Error(`HTTP ${res.status} for ${htmlUrl}`), { status: res.status });
      }
      throw Object.assign(new Error(`HTTP ${res.status} for ${htmlUrl}`), {
        status: res.status,
        retryable: true,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.status && !err.retryable) throw err;
      lastErr = err;
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

module.exports = {
  REPORTS,
  UA,
  fetchJson,
  fetchReportYear,
  fetchPage,
  reportUrl,
  upstreamState,
  noteBan,
  noteOk,
  _resetBreakerForTests,
};
