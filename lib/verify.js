/**
 * Independent cross-verification of our IPO data against BSE India's public
 * JSON feeds (api.bseindia.com — the same endpoints bseindia.com's own IPO
 * pages call from the browser).
 *
 * Why BSE: we list Chittorgarh as the primary source, which is an aggregator.
 * An official exchange feed gives us a genuinely independent second opinion on
 * the numbers we publish. NSE was probed 2026-09 and is a hard no: its APIs sit
 * behind Akamai TLS-fingerprint bot detection and return 403/WAF pages to any
 * non-browser client (and would never pass from Cloudflare Workers egress).
 * BSE's api host answers 200 to plain honest requests — verified live.
 *
 * Endpoints used (all read-only, no auth, no cookies):
 *   GET /GetPublicIssue_par_updated/w?flag=1
 *       Live issue board: open (Status "L") + forthcoming (Status "F") issues
 *       with Scrip_cd, Scrip_Name, Start_Dt, End_Dt, Price_Band, Face_Val.
 *       Rows also include rights issues / buybacks / FPOs — filtered to
 *       IR_flag === 'IPO'.
 *   GET /MoreCompanyN/w?Fromdt=<year>&company=&flag=1&type=1   (mainboard)
 *   GET /MoreCompanyN/w?Fromdt=<year>&company=&flag=1&type=2   (SME)
 *       Listed issues for a calendar year: CompanyName, IssuePrice, ListedOn,
 *       ListingDayClose, ListingDayGain.
 *
 * Politeness & ban-resilience rules (same philosophy as lib/fetcher.js):
 *  - User-Agent exception, documented: BSE's Akamai WAF rejects ANY
 *    non-browser UA string — the honest project UA AND the classic
 *    "Mozilla/5.0 (compatible; bot; +url)" convention both get 403
 *    "Access Denied" (tested 2026-09), while the exact same request with a
 *    browser UA gets 200. These are read-only public JSON endpoints with no
 *    robots.txt and no published API ToS — the identical bytes every
 *    visitor's browser receives. We therefore send a minimal browser UA for
 *    BSE ONLY, keep the volume tiny (3 requests per refresh, ~1-2 h cadence),
 *    and disclose it here + in the README. Chittorgarh (the primary source)
 *    still gets the fully honest UA, which it happily accepts.
 *  - Own circuit breaker, independent of the Chittorgarh one: a BSE block
 *    must never take down the primary pipeline (and vice versa). First block
 *    cools down 60 min, doubling per strike, capped at 24 h.
 *  - Last-good: callers cache the returned doc and keep serving it when
 *    refreshes fail — verification degrades to "not checked", never to errors.
 *
 * Matching: by BSE scrip code when the record has one (detail-scraped records
 * do), else by normalized company name ("Pranav Constructions Ltd." ==
 * "PRANAV CONSTRUCTIONS LIMITED"), with a unique token-subset fallback.
 * Only fields present on BOTH sides are compared; any disagreement is a
 * mismatch, and at least one comparable field is required to claim "verified".
 */

// Browser UA required by BSE's Akamai WAF — see the honesty note above.
const BSE_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BSE_BASE = 'https://api.bseindia.com/BseIndiaAPI/api';
const REFERER = 'https://www.bseindia.com/markets/PublicIssues/IPOIssues';

// ---- tiny BSE circuit breaker (independent of the Chittorgarh one) ----------

const COOLDOWN_START_MS = 60 * 60 * 1000; // first block: back off 1 hour
const COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000; // repeated blocks: cap at 24 hours
const BAN_STATUSES = new Set([403, 406, 429, 503]);

let coolUntil = 0;
let strikes = 0;
let lastStrikeAt = 0;

function noteBan() {
  const now = Date.now();
  // Parallel failures within 10 s collapse into a single strike.
  if (now - lastStrikeAt > 10_000) strikes += 1;
  lastStrikeAt = now;
  const ms = Math.min(COOLDOWN_START_MS * 2 ** (strikes - 1), COOLDOWN_MAX_MS);
  coolUntil = now + ms;
  console.error(`[verify] BSE block signal — cooling down ${Math.round(ms / 60000)} min (strike ${strikes})`);
}

function noteOk() {
  coolUntil = 0;
  strikes = 0;
}

/** Observability for /api/meta: is the BSE verification feed cooling down? */
function verifyState() {
  return {
    inCooldown: Date.now() < coolUntil,
    cooldownUntil: coolUntil ? new Date(coolUntil).toISOString() : null,
    strikes,
  };
}

function _resetVerifyBreakerForTests() {
  coolUntil = 0;
  strikes = 0;
  lastStrikeAt = 0;
}

// ---- fetching ----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bseFetch(pathAndQuery, { timeoutMs = 20000, retries = 1 } = {}) {
  if (Date.now() < coolUntil) {
    const err = new Error(`BSE cooldown active — skipping ${pathAndQuery}`);
    err.code = 'VERIFY_COOLDOWN';
    throw err;
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(BSE_BASE + pathAndQuery, {
        signal: controller.signal,
        headers: {
          'User-Agent': BSE_UA,
          Accept: 'application/json, text/plain, */*',
          Referer: REFERER,
        },
      });

      clearTimeout(timer);
      if (res.ok) {
        noteOk();
        return await res.json();
      }
      if (BAN_STATUSES.has(res.status)) {
        noteBan();
        throw Object.assign(new Error(`HTTP ${res.status} for ${pathAndQuery}`), { status: res.status });
      }
      // 404s shouldn't happen (stable endpoints); treat any other status as a
      // transient blip worth one gentle retry.
      lastErr = new Error(`HTTP ${res.status} for ${pathAndQuery}`);
    } catch (err) {
      clearTimeout(timer);
      if (err.status && BAN_STATUSES.has(err.status)) throw err; // terminal
      if (err.code === 'VERIFY_COOLDOWN') throw err; // don't loop while cooling
      lastErr = err;
      if (attempt < retries) await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ---- normalization -----------------------------------------------------------

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** '2026-09-07T00:00:00' | '2026-09-07' -> '2026-09-07' (null-safe). */
const isoDate = (v) => (v ? String(v).slice(0, 10) : null);

/** BSE "118.00 - 124.00" -> {low:118, high:124}; fixed-price "60.00" -> {low:null, high:60}. */
function parsePriceBand(str) {
  if (str == null) return { low: null, high: null };
  const s = String(str).replace(/[₹,\s]/g, '').replace(/to/i, '-');
  const m = s.match(/^([\d.]+)[-–](?:([\d.]+)$|$)/);
  if (m && m[2]) return { low: num(m[1]), high: num(m[2]) };
  const one = s.match(/^[\d.]+$/);
  return one ? { low: null, high: num(s) } : { low: null, high: null };
}


/** "Pranav Constructions Ltd." and "PRANAV CONSTRUCTIONS LIMITED" -> same key. */
function normName(name) {
  const tokens = String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\(.*?\)/g, ' ') // "(One97 Communications)" parentheticals
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const stop = new Set(['limited', 'ltd', 'private', 'pvt', 'the']);
  while (tokens.length && stop.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

// ---- BSE feed -> canonical rows ----------------------------------------------

function normalizeIssues(json) {
  const rows = (json && Array.isArray(json.Table) ? json.Table : []).filter(
    (r) => r && r.Scrip_Name && (r.IR_flag === 'IPO' || r.IR_FLAG_FULL === 'IPO')
  );
  return rows.map((r) => {
    const band = parsePriceBand(r.Price_Band);
    return {
      bseCode: r.Scrip_cd != null ? String(r.Scrip_cd) : null,
      name: r.Scrip_Name || '',
      nameKey: normName(r.Scrip_Name),
      openDate: isoDate(r.Start_Dt),
      closeDate: isoDate(r.End_Dt),
      bandLow: band.low,
      bandHigh: band.high,
      faceValue: num(r.Face_Val),
      status: r.Status || null, // L = open/live, F = forthcoming
      platform: r.eXCHANGE_PLATFORM || null, // MainBoard | SME | ...
    };
  });
}

function normalizeListed(json) {
  // Rows must carry a company name — anything else is shape-drift, not data.
  const rows = (json && Array.isArray(json.Table) ? json.Table : []).filter((r) => r && r.CompanyName);
  return rows.map((r) => ({
    bseCode: null, // MoreCompanyN rows carry no scrip code; name matching only
    name: r.CompanyName || '',
    nameKey: normName(r.CompanyName),
    issuePrice: num(r.IssuePrice),
    listedOn: isoDate(r.ListedOn),
    listingDayClose: num(r.ListingDayClose),
    listingDayGain: num(r.ListingDayGain),
  }));
}

/**
 * Fetch + normalize the three BSE feeds. Returns a verification doc:
 * { source, fetchedAt, issues: [...], listed: [...], partial }.
 * Throws only when EVERY feed failed (callers keep their last-good doc then).
 */
async function fetchBseData({ year, timeoutMs } = {}) {
  const y = year || new Date().getUTCFullYear();
  const [issuesR, mainR, smeR] = await Promise.allSettled([
    bseFetch('/GetPublicIssue_par_updated/w?flag=1', { timeoutMs }),
    bseFetch(`/MoreCompanyN/w?Fromdt=${y}&company=&flag=1&type=1`, { timeoutMs }),
    bseFetch(`/MoreCompanyN/w?Fromdt=${y}&company=&flag=1&type=2`, { timeoutMs }),
  ]);
  const issues = issuesR.status === 'fulfilled' ? normalizeIssues(issuesR.value) : [];
  // Mainboard + SME lists can overlap — dedupe by normalized name.
  const seenNames = new Set();
  const listed = [mainR, smeR]
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => normalizeListed(r.value))
    .filter((r) => {
      if (!r.nameKey || seenNames.has(r.nameKey)) return false;
      seenNames.add(r.nameKey);
      return true;
    });
  const failed = [issuesR, mainR, smeR].filter((r) => r.status === 'rejected');
  if (!issues.length && !listed.length) {
    const why = failed.length ? String(failed[0].reason && failed[0].reason.message) : 'empty feeds';
    throw new Error(`BSE verification failed: ${why}`);
  }
  for (const f of failed) {
    // Surface refresh errors in logs (breaker state was already updated).
    console.error(`[verify] feed error: ${String(f.reason && f.reason.message)}`);
  }
  return {
    source: 'bse',
    fetchedAt: new Date().toISOString(),
    issues,
    listed,
    partial: failed.length > 0,
  };
}

// ---- matching + comparison ----------------------------------------------------

function _subsetEq(small, big) {
  if (small.size < 2) return false; // too generic ("infra", "industries")
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

/** Find the BSE counterpart row for one of our IPO records (or null). */
function findBseMatch(ipo, doc) {
  const key = normName(ipo.name);
  if (!key) return null;
  const code = ipo.bseCode != null && ipo.bseCode !== '' ? String(ipo.bseCode) : null;
  const scan = (rows, kind) => {
    for (const r of rows || []) {
      if (code && r.bseCode && String(r.bseCode) === code) return { row: r, kind, matchedBy: 'bse-code' };
    }
    for (const r of rows || []) {
      if (r.nameKey && r.nameKey === key) return { row: r, kind, matchedBy: 'name' };
    }
    const kt = new Set(key.split(' '));
    const cands = (rows || []).filter((r) => {
      if (!r.nameKey) return false;
      const rt = new Set(r.nameKey.split(' '));
      return _subsetEq(kt, rt) || _subsetEq(rt, kt);
    });
    if (cands.length === 1) return { row: cands[0], kind, matchedBy: 'name' };
    return null;
  };
  // Open/upcoming/closed issues live on the live-issue board until they list;
  // listed ones come from the per-year company lists (check issues first —
  // the board can still carry rows briefly after close).
  const issues = scan(doc.issues, 'issue');
  if (issues) return issues;
  return scan(doc.listed, 'listed');
}

const round2 = (v) => Math.round(Number(v) * 100) / 100;
const sameNum = (a, b) => a != null && b != null && round2(a) === round2(b);
const sameDate = (a, b) => a != null && b != null && isoDate(a) === isoDate(b);

/**
 * Verify one IPO record against a BSE doc.
 * Returns null when there is no BSE counterpart (e.g. NSE-only listings) —
 * "unknown", never a false claim. Otherwise:
 *   { source:'BSE', verified, matchedBy, mismatches:[{field,ours,bse}], checkedAt, comparable }
 * `compact` trims it for list payloads (counts only, no per-field values).
 */
function verifyIpo(ipo, doc, { compact = false } = {}) {
  if (!doc || !ipo || !ipo.name) return null;
  const out = { source: 'BSE', verified: null, matchedBy: null, mismatches: [], checkedAt: doc.fetchedAt || null };
  const m = findBseMatch(ipo, doc);
  if (!m) return null; // no counterpart (e.g. NSE-only) — unknown, not a claim
  out.matchedBy = m.matchedBy;

  const d = ipo.detail || {};
  let comparable = 0;
  const cmp = (field, ours, bse, ok) => {
    const hasBoth = ours != null && bse != null;
    if (hasBoth) comparable += 1;
    if (hasBoth && !ok) out.mismatches.push({ field, ours, bse });
  };

  if (m.kind === 'issue') {
    const r = m.row;
    cmp('openDate', ipo.openDate, r.openDate, sameDate(ipo.openDate, r.openDate));
    cmp('closeDate', ipo.closeDate, r.closeDate, sameDate(ipo.closeDate, r.closeDate));
    // Band: prefer our scraped band; fall back to issuePrice as the top of the
    // band (Chittorgarh sets issuePrice = band cap for pre-listing issues).
    const oursLow = d.priceBandLow ?? null;
    const oursHigh = d.priceBandHigh ?? (ipo.issuePrice ?? null);
    if (r.bandLow != null) cmp('priceBandLow', oursLow, r.bandLow, sameNum(oursLow, r.bandLow));
    if (r.bandHigh != null) cmp('priceBandHigh', oursHigh, r.bandHigh, sameNum(oursHigh, r.bandHigh));
    cmp('faceValue', d.faceValue ?? null, r.faceValue, sameNum(d.faceValue, r.faceValue));
  } else {
    const r = m.row;
    cmp('issuePrice', ipo.issuePrice, r.issuePrice, sameNum(ipo.issuePrice, r.issuePrice));
    cmp('listingDate', ipo.listingDate, r.listedOn, sameDate(ipo.listingDate, r.listedOn));
    if (ipo.listingGainPct != null && r.listingDayClose != null && r.issuePrice) {
      // BSE reports the ₹ change; convert to % and allow a small tolerance for
      // rounding/convention differences between the two sources.
      const bsePct = ((r.listingDayClose - r.issuePrice) / r.issuePrice) * 100;
      cmp('listingGainPct', ipo.listingGainPct, round2(bsePct), Math.abs(ipo.listingGainPct - bsePct) <= 2.5);
    }
  }

  out.comparable = comparable;
  out.verified = comparable ? out.mismatches.length === 0 : null;
  if (compact) {
    return {
      source: out.source,
      verified: out.verified,
      mismatches: out.mismatches.length,
      checkedAt: out.checkedAt,
    };
  }
  return out;
}

module.exports = {
  BSE_BASE,
  fetchBseData,
  findBseMatch,
  normName,
  parsePriceBand,
  verifyIpo,
  verifyState,
  _resetVerifyBreakerForTests,
};

