/**
 * Live subscription data for OPEN IPOs ("how many times subscribed so far" —
 * the number Groww and broker apps show while bidding is in progress).
 *
 * Source: Chittorgarh's per-IPO subscription page
 *   https://www.chittorgarh.com/ipo_subscription/<slug>/<id>/
 * It republishes the combined live bidding data from BSE and NSE (the same
 * numbers the exchanges show on their public-issue pages) as a server-rendered
 * table, verified 2026-09 to update intraday while an issue is open:
 *   | Qualified Institutional | 268.54x |
 *   | Non Institutional       | 217.29x |
 *   | Retail Individual       |  43.31x |
 *   | Total Subscription      | 125.06x |
 * SME issues have no QIB row. Upcoming/closed issues render no live table.
 *
 * Politeness: same rules as lib/fetcher.js (honest UA, circuit breaker) and we
 * only fetch pages for issues that are open right now (typically 1-5 per day),
 * a few times per hour — the worker skips live-sub refresh on heavy cron slots
 * to stay inside its subrequest budget.
 */
const { fetchPage } = require('./fetcher');

const SUB_PAGE_BASE = 'https://www.chittorgarh.com/ipo_subscription';

/** Never fetch more than this many per-IPO pages per refresh. */
const MAX_OPEN_PAGES = 16;

/**
 * Parse the live subscription table out of a subscription page.
 * Returns { qib, nii, retail, total } (nulls where absent) or null when the
 * page has no live/final subscription table (e.g. upcoming issues).
 */
function parseLiveSubscription(html) {
  if (!html) return null;
  // Flatten to the same "label|value" pipe stream lib/detail.js parses.
  const body = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\|+/g, '|')
    .replace(/\s+/g, ' ');

  // Value looks like "268.54x" (commas tolerated). The allocation/anchor
  // tables use share counts and percentages — never "N.NNx" — so the
  // trailing x anchors us to the right table.
  const grab = (label) => {
    const m = body.match(new RegExp(`${label}\\s*\\|\\s*([0-9][\\d,]*(?:\\.\\d+)?)\\s*x`, 'i'));
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  };

  const qib = grab('Qualified\\s+Institutional');
  const nii = grab('Non[- ]?Institutional');
  const retail = grab('Retail\\s+Individual');
  const total = grab('Total\\s+Subscription');

  if (total === null) return null;
  return { qib, nii, retail, total };
}

/** Per-IPO subscription page URL from a record (needs slug + numeric id). */
function subPageUrl(ipo) {
  return `${SUB_PAGE_BASE}/${ipo.slug}/${ipo.id}/`;
}

/**
 * Fetch + parse live subscription for one OPEN IPO.
 * Returns { qib, nii, retail, total, fetchedAt } or null when unavailable
 * (no slug, upcoming issue, or upstream miss). Throws on fetch errors so the
 * caller's allSettled/error accounting can see real failures.
 */
async function fetchLiveSubscription(ipo, { fetchPageImpl = fetchPage, timeoutMs = 20000 } = {}) {
  if (!ipo || !ipo.id || !ipo.slug) return null;
  const html = await fetchPageImpl(subPageUrl(ipo), { timeoutMs });
  const parsed = parseLiveSubscription(html);
  if (!parsed) return null;
  return { ...parsed, fetchedAt: new Date().toISOString() };
}

/**
 * Attach `liveSub` to every currently-open IPO in a freshly built dataset.
 * Mutates the records in place; failures are reported to `onError` and never
 * block the rest of the refresh.
 */
async function attachLiveSubscriptions(
  ipos,
  { onError = () => {}, max = MAX_OPEN_PAGES, fetchLive = fetchLiveSubscription } = {}
) {
  const open = ipos
    .filter((p) => p.status === 'open' && p.id != null && p.slug)
    .slice(0, max);
  const settled = await Promise.allSettled(
    open.map(async (p) => {
      const live = await fetchLive(p);
      if (live) p.liveSub = live;
    })
  );
  for (const r of settled) {
    if (r.status === 'rejected') {
      onError(String(r.reason && (r.reason.message || r.reason)));
    }
  }
  return open.length;
}

module.exports = {
  parseLiveSubscription,
  fetchLiveSubscription,
  attachLiveSubscriptions,
  subPageUrl,
  MAX_OPEN_PAGES,
};
