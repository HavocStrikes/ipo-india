/**
 * Tests for lib/livesubs.js — live subscription parser + fetch wrapper.
 * Run: npm test  (node --test test/)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseLiveSubscription,
  fetchLiveSubscription,
  attachLiveSubscriptions,
  subPageUrl,
} = require('../lib/livesubs');

// Realistic server-rendered fragments (from Chittorgarh subscription pages).
const MAINBOARD_PAGE = `
<html><head><script>window.__RSC = {"row":"Total Subscription|999.99x"};</script></head>
<body>
  <table>
    <tr><td>Category</td><td>Shares Offered</td><td>Size (%)</td></tr>
    <tr><td>QIB</td><td>1,13,23,392</td><td>40.00%</td></tr>
    <tr><td>&nbsp;&nbsp;Anchor Investor</td><td>67,94,034</td><td>24.00%</td></tr>
    <tr><td>Retail</td><td>1,27,38,816</td><td>45.00%</td></tr>
    <tr><td>Total</td><td>2,83,08,480</td><td>100%</td></tr>
  </table>
  <table>
    <tr><td>Investor Category</td><td>Subscription (times)</td></tr>
    <tr><td>Qualified Institutional</td><td>268.54x</td></tr>
    <tr><td>Non Institutional</td><td>217.29x</td></tr>
    <tr><td>Retail Individual</td><td>43.31x</td></tr>
    <tr><td>Total Subscription</td><td>125.06x</td></tr>
  </table>
</body></html>`;

const SME_PAGE = `
<html><body>
  <table>
    <tr><td>Investor Category</td><td>Subscription (times)</td></tr>
    <tr><td>Non Institutional</td><td>0.28x</td></tr>
    <tr><td>Retail Individual</td><td>2.17x</td></tr>
    <tr><td>Total Subscription</td><td>1.23x</td></tr>
  </table>
</body></html>`;

const UPCOMING_PAGE = `<html><body><p>Bidding opens on Sep 15, 2026.</p></body></html>`;

const COMMA_PAGE = `
<table><tr><td>Total Subscription</td><td>1,234.56x</td></tr>
<tr><td>Qualified Institutional</td><td>2,005.10x</td></tr>
<tr><td>Non Institutional</td><td>987.65x</td></tr>
<tr><td>Retail Individual</td><td>310.02x</td></tr></table>`;

test('parses the live table on a mainboard subscription page', () => {
  const sub = parseLiveSubscription(MAINBOARD_PAGE);
  assert.deepStrictEqual(sub, { qib: 268.54, nii: 217.29, retail: 43.31, total: 125.06 });
});

test('ignores subscription-like data inside <script> payloads', () => {
  // MAINBOARD_PAGE embeds "Total Subscription|999.99x" in a script tag; the
  // parser must strip scripts and read the visible table (125.06x), not 999.99x.
  const sub = parseLiveSubscription(MAINBOARD_PAGE);
  assert.strictEqual(sub.total, 125.06);
});

test('ignores the allocation table (share counts / %, no "x" suffix)', () => {
  const sub = parseLiveSubscription(MAINBOARD_PAGE);
  // 40.00% / 1,13,23,392 style allocation rows must not bleed into qib/retail.
  assert.strictEqual(sub.qib, 268.54);
  assert.strictEqual(sub.retail, 43.31);
});

test('parses an SME page (no QIB row) with nulls for absent categories', () => {
  const sub = parseLiveSubscription(SME_PAGE);
  assert.deepStrictEqual(sub, { qib: null, nii: 0.28, retail: 2.17, total: 1.23 });
});

test('returns null when there is no subscription table (upcoming issue)', () => {
  assert.strictEqual(parseLiveSubscription(UPCOMING_PAGE), null);
  assert.strictEqual(parseLiveSubscription(''), null);
  assert.strictEqual(parseLiveSubscription(null), null);
});

test('strips commas from Indian-format numbers', () => {
  const sub = parseLiveSubscription(COMMA_PAGE);
  assert.strictEqual(sub.total, 1234.56);
  assert.strictEqual(sub.qib, 2005.1);
  assert.strictEqual(sub.nii, 987.65);
  assert.strictEqual(sub.retail, 310.02);
});

test('subPageUrl builds the per-IPO subscription page URL', () => {
  assert.strictEqual(
    subPageUrl({ id: 2127, slug: 'pranav-constructions-ipo' }),
    'https://www.chittorgarh.com/ipo_subscription/pranav-constructions-ipo/2127/'
  );
});

test('fetchLiveSubscription fetches the right page and stamps fetchedAt', async () => {
  const seen = [];
  const fakeFetch = async (url) => {
    seen.push(url);
    return SME_PAGE;
  };
  const live = await fetchLiveSubscription({ id: 2762, slug: 'apana-logistics-ipo' }, { fetchPageImpl: fakeFetch });
  assert.deepStrictEqual(seen, ['https://www.chittorgarh.com/ipo_subscription/apana-logistics-ipo/2762/']);
  assert.strictEqual(live.total, 1.23);
  assert.strictEqual(live.nii, 0.28);
  assert.ok(live.fetchedAt && !Number.isNaN(Date.parse(live.fetchedAt)));
});

test('fetchLiveSubscription returns null without slug/id and for pageless IPOs', async () => {
  const fakeFetch = async () => {
    throw new Error('must not be called');
  };
  assert.strictEqual(await fetchLiveSubscription({ id: 1 }, { fetchPageImpl: fakeFetch }), null);
  assert.strictEqual(await fetchLiveSubscription(null, { fetchPageImpl: fakeFetch }), null);
  assert.strictEqual(
    await fetchLiveSubscription({ id: 1, slug: 'x-ipo' }, { fetchPageImpl: async () => UPCOMING_PAGE }),
    null
  );
});

test('attachLiveSubscriptions only touches open IPOs and reports failures', async () => {
  const errors = [];
  const ipos = [
    { id: 1, slug: 'open-ipo', status: 'open' },
    { id: 2, slug: 'upcoming-ipo', status: 'upcoming' },
    { id: 3, slug: null, status: 'open' }, // no slug — skipped
    { id: 4, slug: 'broken-ipo', status: 'open' },
  ];
  const fetched = [];
  const fetchLive = async (ipo) => {
    fetched.push(ipo.id);
    if (ipo.slug === 'broken-ipo') throw new Error('HTTP 503');
    return { qib: null, nii: 1.5, retail: 0.9, total: 1.2, fetchedAt: '2026-09-09T10:00:00.000Z' };
  };
  const touched = await attachLiveSubscriptions(ipos, { onError: (e) => errors.push(e), fetchLive });
  // upcoming IPO and the slug-less open IPO are never fetched
  assert.deepStrictEqual(fetched.sort(), [1, 4]);
  assert.strictEqual(touched, 2);
  assert.deepStrictEqual(ipos[0].liveSub.total, 1.2);
  assert.strictEqual(ipos[1].liveSub, undefined);
  assert.strictEqual(ipos[2].liveSub, undefined);
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].includes('HTTP 503'));
});

test('attachLiveSubscriptions respects the max cap', async () => {
  const ipos = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, slug: `ipo-${i + 1}`, status: 'open' }));
  let calls = 0;
  const fetchLive = async () => {
    calls++;
    return { qib: null, nii: null, retail: null, total: 1, fetchedAt: 'now' };
  };
  await attachLiveSubscriptions(ipos, { fetchLive, max: 8 });
  assert.strictEqual(calls, 8);
});
