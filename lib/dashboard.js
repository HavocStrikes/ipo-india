/**
 * Supplementary "fresh schedule" source: Chittorgarh's IPO dashboard pages
 * (server-rendered HTML: /ipo/ipo_dashboard.asp for Mainboard, ?a=sme for SME).
 *
 * The JSON cloud reports (lib/fetcher.js) can lag by days for brand-new IPOs —
 * new issues appear on the dashboard timetable while report 7 still ends at the
 * previous week. This parser extracts the timetable entries: company name,
 * slug, Chittorgarh numeric id, "DD - DD Mon" date ranges and the green
 * "Open" badge.
 *
 * Records are schedule-only (no financials/subscription); server.js merges them
 * into the feed dataset by numeric id — backfilling missing dates on existing
 * records and creating minimal records for IPOs the reports don't know yet.
 */
const { fetchPage } = require('./fetcher');

const DASHBOARD_PAGES = [
  { url: 'https://www.chittorgarh.com/ipo/ipo_dashboard.asp', category: 'Mainboard' },
  { url: 'https://www.chittorgarh.com/ipo/ipo_dashboard.asp?a=sme', category: 'SME' },
];

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (year, monthIdx, day) => `${year}-${pad2(monthIdx + 1)}-${pad2(day)}`;

/**
 * Pick the most plausible calendar year for a parsed month/day so the date is
 * closest to today, but never more than FUTURE_CAP days ahead (a timetable only
 * lists the recent past and near future) — this keeps past entries from being
 * pulled into next year and Dec/Jan entries on the right side of New Year.
 */
function pickYear(monthIdx, day, today, futureCapDays = 60) {
  const y = today.getUTCFullYear();
  let best = y;
  let bestDiff = Infinity;
  for (const cand of [y - 1, y, y + 1]) {
    const t = Date.UTC(cand, monthIdx, day);
    const diff = Math.abs(t - today.getTime());
    const tooFarAhead = t - today.getTime() > futureCapDays * 86400000;
    if (tooFarAhead) continue;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = cand;
    }
  }
  return best;
}

/**
 * Parse a timetable date range. Supported shapes:
 *   "07 - 09 Sep"     -> open 2026-09-07, close 2026-09-09
 *   "28 Aug - 01 Sep" -> open 2026-08-28, close 2026-09-01
 *   "11 Sep - 16 Sep" -> explicit month on both sides
 *   "07 Sep"          -> single-day window
 * Returns { openDate, closeDate } or null.
 */
function parseDateRange(text, today = new Date()) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  // "DD [- Mon] - DD Mon" (open month optional, close month required)
  let m = s.match(/^(\d{1,2})(?:\s+([A-Za-z]{3}))?\s*[-–—]\s*(\d{1,2})\s+([A-Za-z]{3})$/);
  if (m) {
    const closeMo = MONTHS[m[4].toLowerCase()];
    const openMo = m[2] ? MONTHS[m[2].toLowerCase()] : closeMo;
    if (closeMo === undefined || openMo === undefined) return null;
    const closeDay = Number(m[3]);
    const openDay = Number(m[1]);
    const closeYear = pickYear(closeMo, closeDay, today);
    // Dec -> Jan rollover: open in a later month than close means previous year
    let openYear = closeYear;
    if (openMo > closeMo) openYear = closeYear - 1;
    return { openDate: isoOf(openYear, openMo, openDay), closeDate: isoOf(closeYear, closeMo, closeDay) };
  }

  // single day "DD Mon"
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo === undefined) return null;
    const day = Number(m[1]);
    const year = pickYear(mo, day, today);
    const iso = isoOf(year, mo, day);
    return { openDate: iso, closeDate: iso };
  }

  return null;
}

/** Extract all timetable entries from one dashboard page's HTML. */
function parseDashboardHtml(html, category, today = new Date()) {
  const byId = new Map();
  const rows = String(html || '').match(/<tr[\s\S]*?<\/tr>/g) || [];

  for (const row of rows) {
    const anchor = row.match(/<a[^>]*href="\/ipo\/([a-z0-9-]+)\/(\d+)\/"[^>]*>/i);
    if (!anchor) continue;
    const slug = anchor[1];
    const id = Number(anchor[2]);
    if (!Number.isFinite(id)) continue;

    const titleM = anchor[0].match(/title="([^"]*)"/);
    let name = titleM ? titleM[1] : '';
    if (!name) {
      // fall back to the anchor's inner text
      const inner = row.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
      name = inner ? inner[1].replace(/<[^>]*>/g, '') : '';
    }
    name = name.replace(/\s+/g, ' ').replace(/\s*IPO\s*$/i, '').trim();
    if (!name) continue;

    const spanM = row.match(/float-end[^>]*>([^<]{0,32})</);
    const range = spanM ? parseDateRange(spanM[1], today) : null;

    const openNow =
      /<span[^>]*badge[^>]*title="Open"/i.test(row) || /<span[^>]*title="Open"[^>]*badge/i.test(row);

    const entry = {
      id,
      name,
      slug,
      category,
      openDate: range ? range.openDate : null,
      closeDate: range ? range.closeDate : null,
      openNow,
      source: 'dashboard',
    };

    // de-dupe repeated rows for the same IPO, preferring richer entries
    const prev = byId.get(id);
    if (!prev || richness(entry) > richness(prev)) byId.set(id, entry);
  }
  return [...byId.values()];
}

function richness(e) {
  let n = 0;
  if (e.openDate) n++;
  if (e.closeDate) n++;
  if (e.openNow) n++;
  return n;
}

/** Fetch both dashboard pages and merge their entries (per-page failures tolerated). */
async function loadDashboardSchedule({ timeoutMs } = {}) {
  const results = await Promise.allSettled(
    DASHBOARD_PAGES.map((p) => fetchPage(p.url, { timeoutMs: timeoutMs || 20000 }))
  );
  const entries = [];
  let anyOk = false;
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      anyOk = true;
      entries.push(...parseDashboardHtml(r.value, DASHBOARD_PAGES[i].category));
    } else {
      errors.push(String(r.reason && r.reason.message));
    }
  });
  if (!anyOk) throw new Error(`all dashboard pages failed: ${errors.join(' | ')}`);
  return entries;
}

/**
 * Build a minimal IPO record (same shape as lib/normalize.js output) from a
 * dashboard entry, so it flows through scoring/summarization untouched. Deep
 * data (financials, subscription, price band...) arrives later either via the
 * JSON reports or the per-IPO detail scraper.
 */
function toIpoRecord(entry) {
  return {
    id: entry.id,
    name: entry.name,
    slug: entry.slug,
    category: entry.category || null,
    exchange: null,
    openDate: entry.openDate || null,
    closeDate: entry.closeDate || null,
    allotmentDate: null,
    listingDate: null,
    issuePrice: null,
    issueAmountCr: null,
    subscriptionX: null,
    subscription: {
      total: null, qib: null, nii: null, retail: null,
      employees: null, others: null, shareholders: null,
    },
    listing: { openPrice: null, closePrice: null, gainPct: null },
    market: { price: null, week52High: null, week52Low: null },
    financials: {
      period: null, assetsCr: null, revenueCr: null, patCr: null,
      ebitdaCr: null, netWorthCr: null, reservesCr: null, borrowingsCr: null,
    },
    kpi: {
      date: null, roe: null, roce: null, ronw: null, patMargin: null,
      ebitdaMargin: null, priceToBook: null, epsPre: null, epsPost: null,
      pePre: null, pePost: null,
    },
    reviews: { subscribe: 0, neutral: 0, avoid: 0 },
    anchors: { allotmentDate: null, shares: null, amountCr: null, pctOfIssue: null },
    isin: null,
    bseCode: null,
    nseSymbol: null,
    detailUrl: entry.slug ? `https://www.chittorgarh.com/ipo/${entry.slug}/${entry.id}/` : null,
    source: 'dashboard',
  };
}

module.exports = { loadDashboardSchedule, parseDashboardHtml, parseDateRange, toIpoRecord, pickYear };

