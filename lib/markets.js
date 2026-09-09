/**
 * Market snapshot for the top-of-page strip: Sensex, Nifty 50, Bank Nifty,
 * India VIX, USD/INR, gold, crude oil and the US market (S&P 500).
 *
 * Source: Yahoo Finance's public chart endpoint — the same JSON their own web
 * client loads:
 *   https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?interval=1d&range=1d
 * Keyless, and (verified 2026-09) it answers an honest, descriptive
 * User-Agent while generic browser UAs get rate-limited (429) — so we
 * identify ourselves exactly like we do for Chittorgarh. The multi-symbol
 * "spark" endpoint 429s, so quotes are fetched sequentially with a small
 * gap; a failed or malformed symbol is skipped and the rest still render.
 *
 * IMPORTANT: this module deliberately does NOT reuse lib/fetcher.js. Yahoo's
 * rate limiter answers bursts with 429, and the shared circuit breaker reads
 * 429 as "Chittorgarh is blocking us" — a Yahoo hiccup must never open a
 * 30-minute cooldown on the IPO pipeline. This fetcher is self-contained:
 * one attempt per symbol, no retries, tiny volume (8 quotes every ~20 min).
 */

const UA =
  'ipo-india-tracker/1.0 (+https://github.com/HavocStrikes/ipo-india; low-volume public IPO tracker)';

const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

/** Strip order = display order (Indian indices, FX/commodities, US market). */
const QUOTES = [
  { symbol: '^BSESN', name: 'Sensex' },
  { symbol: '^NSEI', name: 'Nifty 50' },
  { symbol: '^NSEBANK', name: 'Bank Nifty' },
  { symbol: '^INDIAVIX', name: 'India VIX' },
  { symbol: 'USDINR=X', name: 'USD/INR' },
  { symbol: 'GC=F', name: 'Gold (COMEX)' },
  { symbol: 'CL=F', name: 'Crude (WTI)' },
  { symbol: '^GSPC', name: 'S&P 500' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chartUrl(symbol) {
  return `${CHART_BASE}${encodeURIComponent(symbol)}?interval=1d&range=1d`;
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Flatten a v8 chart payload into a strip quote.
 *
 * Field semantics (verified against live payloads 2026-09):
 *  - `fulldayChange` / `regularMarketChangePercent` are Yahoo's canonical
 *    daily change (what their own UI shows) — preferred when present.
 *  - `chartPreviousClose` is only the chart range anchor and is NOT always
 *    the previous session's close for indices, so it's the fallback.
 * Returns null when there is no usable price.
 */
function parseQuote(entry, payload) {
  const result = payload && payload.chart && Array.isArray(payload.chart.result) ? payload.chart.result[0] : null;
  const meta = result && result.meta ? result.meta : {};
  const price = num(meta.regularMarketPrice);
  if (price === null) return null;
  const pctDirect = num(meta.regularMarketChangePercent) ?? num(meta.fulldayChangePercent);
  const changeDirect = num(meta.fulldayChange);
  const chartPrev = num(meta.previousClose) ?? num(meta.chartPreviousClose);
  let change = null;
  let changePct = null;
  let prevClose = null;
  if (changeDirect !== null) {
    change = changeDirect;
    prevClose = price - changeDirect;
    changePct = pctDirect !== null ? pctDirect : prevClose !== 0 ? (changeDirect / prevClose) * 100 : null;
  } else if (chartPrev !== null && chartPrev !== 0) {
    prevClose = chartPrev;
    change = price - chartPrev;
    changePct = pctDirect !== null ? pctDirect : (change / chartPrev) * 100;
  } else if (pctDirect !== null && pctDirect !== -100) {
    changePct = pctDirect;
    change = (price * pctDirect) / (100 + pctDirect); // invert pct → absolute change
    prevClose = price - change;
  }
  return {
    symbol: entry.symbol,
    name: entry.name,
    currency: typeof meta.currency === 'string' ? meta.currency : null,
    price,
    prevClose,
    change: change !== null ? round2(change) : null,
    changePct: changePct !== null ? round2(changePct) : null,
    ts: num(meta.regularMarketTime) ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

/** Fetch one symbol's chart JSON. Single attempt — failures propagate. */
async function fetchQuoteJson(symbol, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(chartUrl(symbol), {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Snapshot of every strip quote: { fetchedAt, quotes[], errors[] }.
 * Sequential with a small stagger (Yahoo 429s bursts); partial failures are
 * tolerated — a symbol that fails is simply absent from `quotes`.
 */
async function fetchMarketSnapshot({
  fetchImpl = fetch,
  timeoutMs = 12000,
  staggerMs = 500,
  quotes: quoteList = QUOTES,
} = {}) {
  const out = [];
  const errors = [];
  for (let i = 0; i < quoteList.length; i++) {
    const entry = quoteList[i];
    if (i > 0 && staggerMs) await sleep(staggerMs);
    try {
      const payload = await fetchQuoteJson(entry.symbol, fetchImpl, timeoutMs);
      const quote = parseQuote(entry, payload);
      if (quote) out.push(quote);
      else errors.push(`${entry.symbol}: no usable price in payload`);
    } catch (err) {
      errors.push(`${entry.symbol}: ${String((err && err.message) || err)}`);
    }
  }
  return { fetchedAt: new Date().toISOString(), quotes: out, errors };
}

module.exports = { QUOTES, UA, chartUrl, parseQuote, fetchMarketSnapshot };
