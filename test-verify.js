/**
 * Unit tests for lib/verify.js — BSE cross-verification.
 * Stubs global.fetch (no network) and covers: band parsing, name
 * normalization, issue/listed matching + field comparison, the
 * "no counterpart" case, and the independent BSE circuit breaker.
 * Run: node test-verify.js
 */
'use strict';
const assert = require('assert');
const {
  parsePriceBand,
  normName,
  fetchBseData,
  verifyIpo,
  verifyState,
  _resetVerifyBreakerForTests,
} = require('./lib/verify');

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

// ---- parsePriceBand ---------------------------------------------------------

ok('parsePriceBand: book-built range', () => {
  assert.deepStrictEqual(parsePriceBand('118.00 - 124.00'), { low: 118, high: 124 });
});
ok('parsePriceBand: en-dash + spacing variants', () => {
  assert.deepStrictEqual(parsePriceBand(' 258.00–273.00 '), { low: 258, high: 273 });
  assert.deepStrictEqual(parsePriceBand('486 to 512'), { low: 486, high: 512 });
});
ok('parsePriceBand: fixed price single value', () => {
  assert.deepStrictEqual(parsePriceBand('60.00'), { low: null, high: 60 });
});
ok('parsePriceBand: garbage -> nulls', () => {
  assert.deepStrictEqual(parsePriceBand('N.A.'), { low: null, high: null });
  assert.deepStrictEqual(parsePriceBand(null), { low: null, high: null });
});

// ---- normName ---------------------------------------------------------------

ok('normName: Ltd. vs LIMITED vs case', () => {
  assert.strictEqual(normName('Pranav Constructions Ltd.'), normName('PRANAV CONSTRUCTIONS LIMITED'));
});
ok('normName: parentheticals are dropped', () => {
  // "(One97 Communications)" is the legal-name aside — the brand key is what
  // remains. Exact matching against BSE's "One97 Communications Limited" is
  // NOT expected (different keys); the token-subset fallback may still link.
  assert.strictEqual(normName('Paytm (One97 Communications) Ltd.'), 'paytm');
});

ok('normName: & vs and', () => {
  assert.strictEqual(normName('Modern Diagnostic & Research Centre Ltd.'), normName('MODERN DIAGNOSTIC AND RESEARCH CENTRE LIMITED'));
});

// ---- fixtures for verifyIpo -------------------------------------------------

const DOC = {
  source: 'bse',
  fetchedAt: '2026-09-09T06:00:00.000Z',
  issues: [
    {
      bseCode: '4795', name: 'Pranav Constructions Limited', nameKey: normName('Pranav Constructions Limited'),
      openDate: '2026-09-07', closeDate: '2026-09-09', bandLow: 118, bandHigh: 124, faceValue: 10, status: 'L',
    },
    {
      bseCode: '4809', name: 'Raksan Transformers Limited', nameKey: normName('Raksan Transformers Limited'),
      openDate: '2026-09-10', closeDate: '2026-09-15', bandLow: 258, bandHigh: 273, faceValue: 10, status: 'F',
    },
  ],
  listed: [
    {
      bseCode: null, name: 'Rays of Belief Limited', nameKey: normName('Rays of Belief Limited'),
      issuePrice: 239, listedOn: '2026-09-08', listingDayClose: 228.25, listingDayGain: -10.75,
    },
  ],
};

const OPEN_IPO = {
  id: 2127, name: 'Pranav Constructions Ltd.', status: 'open', bseCode: '4795',
  openDate: '2026-09-07', closeDate: '2026-09-09', issuePrice: 124,
  detail: { priceBandLow: 118, priceBandHigh: 124, faceValue: 10 },
};


const UPCOMING_IPO = {
  id: 9002, name: 'Raksan Transformers Limited', status: 'upcoming',
  openDate: '2026-09-10', closeDate: '2026-09-15', issuePrice: 273, detail: {},
};

const LISTED_IPO = {
  id: 9003, name: 'Rays of Belief Limited', status: 'listed',
  issuePrice: 239, listingDate: '2026-09-08', listingGainPct: -4.5, detail: {},
};

const NSE_ONLY = { id: 9004, name: 'Some NSE SME Limited', status: 'open', openDate: '2026-09-08', closeDate: '2026-09-10' };

ok('verifyIpo: open IPO matches on dates + band + face value', () => {
  const v = verifyIpo(OPEN_IPO, DOC);
  assert.strictEqual(v.verified, true);
  assert.strictEqual(v.matchedBy, 'bse-code');
  assert.strictEqual(v.comparable >= 4, true);
  assert.strictEqual(v.mismatches.length, 0);
});
ok('verifyIpo: upcoming IPO matches by name without detail', () => {
  const v = verifyIpo(UPCOMING_IPO, DOC);
  assert.strictEqual(v.verified, true);
  assert.strictEqual(v.matchedBy, 'name');
});
ok('verifyIpo: wrong close date is a mismatch', () => {
  const bad = { ...OPEN_IPO, closeDate: '2026-09-10' };
  const v = verifyIpo(bad, DOC);
  assert.strictEqual(v.verified, false);
  assert.strictEqual(v.mismatches.length, 1);
  assert.strictEqual(v.mismatches[0].field, 'closeDate');
  assert.strictEqual(v.mismatches[0].ours, '2026-09-10');
  assert.strictEqual(v.mismatches[0].bse, '2026-09-09');
});
ok('verifyIpo: wrong price band is a mismatch', () => {
  const bad = { ...OPEN_IPO, detail: { ...OPEN_IPO.detail, priceBandHigh: 126 } };
  const v = verifyIpo(bad, DOC);
  assert.strictEqual(v.verified, false);
  assert.ok(v.mismatches.some((m) => m.field === 'priceBandHigh'));
});
ok('verifyIpo: listed IPO matches price + listing date + gain', () => {
  const v = verifyIpo(LISTED_IPO, DOC);
  assert.strictEqual(v.verified, true);
  assert.strictEqual(v.matchedBy, 'name');
});
ok('verifyIpo: listed IPO with wrong issue price is a mismatch', () => {
  const bad = { ...LISTED_IPO, issuePrice: 245 };
  const v = verifyIpo(bad, DOC);
  assert.strictEqual(v.verified, false);
  assert.ok(v.mismatches.some((m) => m.field === 'issuePrice'));
});
ok('verifyIpo: listing gain beyond ±2.5pp tolerance mismatches', () => {
  const bad = { ...LISTED_IPO, listingGainPct: -12 };
  const v = verifyIpo(bad, DOC);
  assert.strictEqual(v.verified, false);
  assert.ok(v.mismatches.some((m) => m.field === 'listingGainPct'));
});
ok('verifyIpo: no BSE counterpart -> null (never a false claim)', () => {
  assert.strictEqual(verifyIpo(NSE_ONLY, DOC), null);
  assert.strictEqual(verifyIpo(NSE_ONLY, DOC, { compact: true }), null);
});
ok('verifyIpo: compact shape trims mismatch values', () => {
  const bad = { ...OPEN_IPO, closeDate: '2026-09-10' };
  const v = verifyIpo(bad, DOC, { compact: true });
  assert.deepStrictEqual(Object.keys(v).sort(), ['checkedAt', 'mismatches', 'source', 'verified']);
  assert.strictEqual(v.verified, false);
  assert.strictEqual(v.mismatches, 1);
});
ok('verifyIpo: null/undefined doc -> null', () => {
  assert.strictEqual(verifyIpo(OPEN_IPO, null), null);
});

// ---- fetchBseData + breaker (stubbed fetch) ---------------------------------

const BSE_OK_ISSUES = JSON.stringify({
  Table: [
    { Scrip_cd: 4795, Scrip_Name: 'Pranav Constructions Limited', Start_Dt: '2026-09-07T00:00:00', End_Dt: '2026-09-09T00:00:00', Price_Band: '118.00 - 124.00', Face_Val: 10, IR_flag: 'IPO', Status: 'L', eXCHANGE_PLATFORM: 'MainBoard' },
    { Scrip_cd: 1, Scrip_Name: 'Some Rights Issue', Start_Dt: '2026-09-07T00:00:00', End_Dt: '2026-09-09T00:00:00', Price_Band: '10', Face_Val: 10, IR_flag: 'RI', Status: 'L' },
  ],
});
const BSE_OK_LISTED = JSON.stringify({
  Table: [
    { CompanyName: 'Rays of Belief Limited', IssuePrice: 239.0, ListedOn: '2026-09-08T00:00:00', ListingDayClose: 228.25, ListingDayGain: -10.75 },
  ],
});

function withFetch(stub, fn) {
  const realFetch = global.fetch;
  global.fetch = stub;
  _resetVerifyBreakerForTests();
  return Promise.resolve(fn()).finally(() => {
    global.fetch = realFetch;
    _resetVerifyBreakerForTests();
  });
}

(async () => {
  await withFetch(
    () => Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(BSE_OK_ISSUES) }),
    async () => {
      // Naive stub: all three endpoints get the issues payload. The issues
      // feed parses (with rights-issues filtered out); the listed feeds
      // return rows without CompanyName, which are dropped as shape-drift.
      const doc = await fetchBseData({ year: 2026 });
      assert.strictEqual(doc.issues.length, 1, 'RI rows filtered out');
      assert.strictEqual(doc.issues[0].bseCode, '4795');
      assert.strictEqual(doc.listed.length, 0);
      assert.strictEqual(doc.partial, false);
    }
  );

  await withFetch(
    (url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => JSON.parse(String(url).includes('GetPublicIssue') ? BSE_OK_ISSUES : BSE_OK_LISTED),
      }),
    async () => {
      const doc = await fetchBseData({ year: 2026 });
      assert.strictEqual(doc.issues.length, 1);
      assert.strictEqual(doc.listed.length, 1);
      assert.strictEqual(doc.partial, false);
      // End-to-end: the live board row verifies our open IPO record.
      const v = verifyIpo(OPEN_IPO, doc);
      assert.strictEqual(v.verified, true);
    }
  );

  await withFetch(
    () => Promise.resolve({ ok: false, status: 403, json: async () => ({}) }),
    async () => {
      await assert.rejects(() => fetchBseData({ year: 2026 }), /HTTP 403/);
      // Breaker opened: subsequent calls fail fast WITHOUT hitting the network.
      let calls = 0;
      global.fetch = () => {
        calls++;
        return Promise.resolve({ ok: false, status: 403, json: async () => ({}) });
      };
      await assert.rejects(() => fetchBseData({ year: 2026 }), /cooldown active/i);
      assert.strictEqual(calls, 0, 'no network calls while cooling down');
      assert.strictEqual(verifyState().inCooldown, true);
      assert.strictEqual(verifyState().strikes, 1);
    }
  );

  console.log(`\n${pass} passed`);
  if (process.exitCode) process.exit(1);
})().catch((err) => {
  console.error('TEST CRASHED:', err);
  process.exit(1);
});


