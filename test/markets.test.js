/**
 * Unit tests for lib/markets.js — market strip quotes (Yahoo Finance v8
 * chart endpoint). Stubs fetchImpl (no network).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { QUOTES, chartUrl, parseQuote, fetchMarketSnapshot } = require('../lib/markets');

const SENSEX_META = {
  chart: {
    result: [
      {
        meta: {
          symbol: '^BSESN',
          currency: 'INR',
          regularMarketPrice: 74764.23,
          // Yahoo chart meta: fulldayChange/regularMarketChangePercent are the
          // canonical daily change; chartPreviousClose is only a range anchor
          // (here deliberately wrong as a "previous close" — real payload).
          fulldayChange: -813.352,
          fulldayChangePercent: -1.076,
          regularMarketChangePercent: -1.076,
          chartPreviousClose: 76132.8,
          regularMarketTime: 1788948148,
        },
      },
    ],
    error: null,
  },
};

const USDINR_META = {
  chart: {
    result: [{ meta: { symbol: 'USDINR=X', currency: 'INR', regularMarketPrice: 83.52, chartPreviousClose: 83.61 } }],
    error: null,
  },
};

/** Build a fetchImpl stub keyed by decoded symbol (null = reject with 429). */
const impl = (payloadBySymbol) => (url) => {
  const symbol = decodeURIComponent(new URL(url).pathname.split('/').pop());
  if (payloadBySymbol[symbol] === null) return Promise.reject(new Error('HTTP 429'));
  const payload = payloadBySymbol[symbol] || USDINR_META;
  return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) });
};

test('chartUrl encodes Yahoo symbols safely (^ and =)', () => {
  assert.strictEqual(
    chartUrl('^BSESN'),
    'https://query1.finance.yahoo.com/v8/finance/chart/%5EBSESN?interval=1d&range=1d'
  );
  assert.strictEqual(
    chartUrl('GC=F'),
    'https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d'
  );
});

test('parseQuote prefers the canonical daily change, treating chartPreviousClose as a fallback anchor', () => {
  assert.deepStrictEqual(parseQuote(QUOTES[0], SENSEX_META), {
    symbol: '^BSESN',
    name: 'Sensex',
    currency: 'INR',
    price: 74764.23,
    prevClose: 75577.582,
    change: -813.35,
    changePct: -1.08,
    ts: new Date(1788948148 * 1000).toISOString(),
  });
});

test('parseQuote falls back to chartPreviousClose, then derives prev from pct', () => {
  const noPrev = parseQuote(QUOTES[4], {
    chart: { result: [{ meta: { symbol: 'USDINR=X', regularMarketPrice: 83.52, chartPreviousClose: 83.61 } }] },
  });
  assert.strictEqual(noPrev.prevClose, 83.61);
  assert.strictEqual(noPrev.change, -0.09);
  assert.strictEqual(noPrev.changePct, -0.11);

  const derived = parseQuote(QUOTES[4], {
    chart: { result: [{ meta: { symbol: 'USDINR=X', regularMarketPrice: 100, regularMarketChangePercent: 10 } }] },
  });
  assert.strictEqual(derived.changePct, 10);
  assert.strictEqual(Math.round(derived.change * 100) / 100, 9.09);
  assert.strictEqual(Math.round(derived.prevClose * 100) / 100, 90.91); // derived from pct
});

test('parseQuote returns null for junk payloads', () => {
  assert.strictEqual(parseQuote(QUOTES[0], null), null);
  assert.strictEqual(parseQuote(QUOTES[0], {}), null);
  assert.strictEqual(parseQuote(QUOTES[0], { chart: { result: [{ meta: {} }] } }), null);
  assert.strictEqual(parseQuote(QUOTES[0], { chart: { error: { code: 'Bad Request' } } }), null);
});

test('fetchMarketSnapshot tolerates a failing symbol and keeps the rest in order', async () => {
  const snap = await fetchMarketSnapshot({
    fetchImpl: impl({ '^BSESN': SENSEX_META, 'GC=F': null }),
    staggerMs: 0,
    timeoutMs: 1000,
  });
  assert.strictEqual(snap.quotes.length, QUOTES.length - 1); // gold failed
  assert.deepStrictEqual(
    snap.quotes.map((q) => q.symbol),
    QUOTES.filter((e) => e.symbol !== 'GC=F').map((e) => e.symbol)
  );
  assert.strictEqual(snap.errors.length, 1);
  assert.match(snap.errors[0], /GC=F: HTTP 429/);
  assert.ok(snap.fetchedAt);
});

test('fetchMarketSnapshot reports an empty snapshot when every symbol fails', async () => {
  const fail = () => Promise.reject(new Error('HTTP 429'));
  const snap = await fetchMarketSnapshot({ fetchImpl: fail, staggerMs: 0, timeoutMs: 1000 });
  assert.deepStrictEqual(snap.quotes, []);
  assert.strictEqual(snap.errors.length, QUOTES.length);
});

test('fetchMarketSnapshot sends the honest tracker UA and fetches in config order', async () => {
  const seen = [];
  const snap = await fetchMarketSnapshot({
    fetchImpl: (url, opts) => {
      seen.push({ url, ua: opts.headers['User-Agent'] });
      const payload = seen.length === 1 ? SENSEX_META : USDINR_META;
      return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) });
    },
    staggerMs: 0,
    timeoutMs: 1000,
  });
  assert.strictEqual(seen.length, QUOTES.length);
  assert.ok(seen.every((s) => s.ua.startsWith('ipo-india-tracker/')));
  assert.ok(seen[0].url.includes('%5EBSESN'));
  assert.strictEqual(snap.quotes[0].symbol, '^BSESN');
  assert.strictEqual(snap.quotes[1].symbol, '^NSEI');
});

test('strip config covers the parameters users expect', () => {
  assert.ok(QUOTES.some((q) => q.symbol === '^BSESN')); // Sensex
  assert.ok(QUOTES.some((q) => q.symbol === '^NSEI')); // Nifty 50
  assert.ok(QUOTES.some((q) => q.symbol === 'USDINR=X')); // dollar/rupee
  assert.ok(QUOTES.some((q) => q.symbol === 'GC=F')); // gold
  assert.ok(QUOTES.some((q) => q.symbol === '^GSPC')); // US market
});
