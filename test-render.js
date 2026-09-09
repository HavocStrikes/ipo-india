/**
 * Render smoke-test: shims a minimal DOM, loads public/app.js against a
 * fixture IPO record and asserts that the "Company in charts" section and
 * the subscribe card render with no NaN/undefined leaks.
 *
 * Usage: node test-render.js [detail|list|sparse|bare|stale]
 */
const path = require('path');
const MODE = process.argv[2] || 'detail'; // detail | list | sparse | bare | stale
// fetchedAt is dynamic so the staleness banner logic is exercised correctly:
// 4 min old → fresh (no banner); 'stale' mode → 3 h old (banner must show).
const FRESH_TS = new Date(Date.now() - 4 * 60000).toISOString();
const STALE_TS = new Date(Date.now() - 3 * 3600000).toISOString();
const TS = MODE === 'stale' ? STALE_TS : FRESH_TS;
const SPARSE = MODE === 'sparse';

const FIXTURE = {
  id: 1895,
  name: 'Zomato Ltd.',
  slug: 'zomato-ipo',
  category: 'Mainboard',
  exchange: 'NSE',
  status: 'listed',
  openDate: '2021-07-14',
  closeDate: '2021-07-16',
  allotmentDate: '2021-07-22',
  listingDate: '2021-07-23',
  issuePrice: 76,
  issueAmountCr: 9375,
  subscriptionX: 38.25,
  subscription: { total: 38.25, qib: 51.79, nii: 34.66, retail: 18.27, employees: 0.74, others: null, shareholders: 11.09 },
  listing: { openPrice: 115, closePrice: 126, gainPct: 65.79 },
  market: { price: 260.4, week52High: 304.5, week52Low: 123.1 },
  financials: {
    period: '2021-03-31', assetsCr: 5124.3, revenueCr: 4348.3, patCr: 812.3,
    ebitdaCr: 210.5, netWorthCr: 2500.1, reservesCr: 2400.0, borrowingsCr: 420.2,
  },
  kpi: {
    date: '2021-03-31', roe: 18.2, roce: 22.4, ronw: 18.2, patMargin: 9.4, ebitdaMargin: 21.6,
    priceToBook: 12.4, epsPre: 2.1, epsPost: 1.9, pePre: 36.2, pePost: 40.1,
  },
  reviews: { subscribe: 214, neutral: 63, avoid: 39 },
  anchors: { allotmentDate: '2021-07-13', shares: 40000000, amountCr: 2840, pctOfIssue: 33.1 },
  isin: 'INE758T01015',
  bseCode: '543320',
  nseSymbol: 'ZOMATO',
  detailUrl: 'https://www.chittorgarh.com/ipo/zomato-ipo/1895/',
  source: 'chittorgarh',
  verification: { source: 'BSE', verified: true, matchedBy: 'name', mismatches: [], checkedAt: TS },
  score: {
    score: 62.5, verdict: 'Apply', tone: 'good', confidence: 'high',
    pillars: {
      demand: { pts: 22.5, note: '38.25× subscribed' },
      fundamentals: { pts: 15, note: 'solid margins' },
      valuation: { pts: 8, note: 'P/E 40× post' },
      performance: { pts: 12, note: 'anchors took 33%' },
      sentiment: { pts: 5, note: 'mixed reviews' },
    },
  },
  detail: {
    priceBandLow: 72,
    priceBandHigh: 76,
    faceValue: 1,
    lotSize: 195,
    saleType: 'Book Building',
    issueType: 'Fresh + OFS',
    listingAt: 'NSE/BSE',
    listedOn: '2021-07-23',
    totalIssueShares: 1233000000,
    freshIssueShares: 825000000,
    ofsShares: 408000000,
    timetable: {
      open: 'Jul 14, 2021', close: 'Jul 16, 2021', allotment: 'Jul 22, 2021',
      refund: 'Jul 23, 2021', credit: 'Jul 23, 2021', listing: 'Jul 23, 2021',
    },
    objects: [
      { object: 'Funding working capital requirements', amountCr: 675 },
      { object: 'Purchase of machinery and equipment', amountCr: 576 },
      { object: 'Repayment of borrowings', amountCr: 325 },
      { object: 'General corporate purposes', amountCr: 120 },
    ],
    promoters: { preIssuePct: 54.5, postIssuePct: 44.3, names: 'Deepinder Goyal, Pankaj Chaddah' },
    registrar: 'KFin Technologies',
    leadManagers: ['Kotak Mahindra Capital', 'Morgan Stanley India'],
    listingDayTrading: {
      finalIssuePrice: 76, open: 115, low: 109.2, high: 132.6, lastTrade: 126, byExchange: {},
    },
  },
};

/** Absolutely nothing chartable — price band, promoters, objects, financials
 *  all missing. Exercises the "No charts for this IPO yet" empty state. */
const BARE = {
  id: 3002, name: 'Bare Bones Ltd.', slug: 'bare-ipo', category: 'SME', exchange: 'BSE',
  status: 'upcoming', openDate: '2026-09-28', closeDate: '2026-09-30', listingDate: null,
  issuePrice: null, issueAmountCr: null, subscriptionX: null,
  subscription: {}, listing: {}, market: {}, financials: {}, kpi: {},
  reviews: { subscribe: 0, neutral: 0, avoid: 0 }, anchors: {},
  isin: null, bseCode: null, nseSymbol: null,
  detailUrl: 'https://www.chittorgarh.com/ipo/bare-ipo/3002/', source: 'chittorgarh',
  score: { score: 30, verdict: 'Hold / Watch', tone: 'neutral', confidence: 'low', pillars: {} },
  detail: { timetable: { open: 'Sep 28, 2026', close: 'Sep 30, 2026' }, objects: [], promoters: null },
};

const SUMMARY = {
  id: FIXTURE.id, name: FIXTURE.name, slug: FIXTURE.slug, category: 'Mainboard', exchange: 'NSE',
  status: 'listed', openDate: FIXTURE.openDate, closeDate: FIXTURE.closeDate,
  allotmentDate: FIXTURE.allotmentDate, listingDate: FIXTURE.listingDate,
  issuePrice: 76, issueAmountCr: 9375, subscriptionX: 38.25, listingGainPct: 65.79,
  marketPrice: 260.4, pePost: 40.1, ronw: 18.2,
  score: { score: 62.5, verdict: 'Apply', tone: 'good', confidence: 'high' },
  detailUrl: FIXTURE.detailUrl, nseSymbol: 'ZOMATO',
};

const META = {
  fetchedAt: TS, refreshMinutes: 10, windowDays: 31, yearsLoaded: [2026, 2025],
  total: 1, counts: { open: 0, upcoming: 1, closed: 0, listed: 1 }, errors: [], cache: {},
};

/* Market strip snapshot — boot() always calls loadMarkets(), so every mode
 * exercises renderMarkets() against this (regression: a bad ternary in the
 * quote filter once made it throw and the strip silently stayed hidden). */
const MARKETS_SNAPSHOT = {
  fetchedAt: TS,
  quotes: [
    { symbol: '^BSESN', name: 'Sensex', currency: 'INR', price: 74764.23, prevClose: 75577.58, change: -813.35, changePct: -1.08, ts: TS },
    { symbol: 'GC=F', name: 'Gold (COMEX)', currency: 'USD', price: 4464, prevClose: 4439, change: 25, changePct: 0.56, ts: TS },
  ],
  errors: [],
};

/* ---- minimal DOM shim ---- */
const els = new Map();
function getEl(sel) {
  if (!els.has(sel)) els.set(sel, makeEl());
  return els.get(sel);
}
function makeEl() {
  return {
    dataset: {}, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => makeEl(), querySelectorAll: () => [],
    appendChild() {}, insertBefore() {}, remove() { this._removed = true; },
    focus() {}, setAttribute() {}, getAttribute: () => null,
  };
}
const appEl = getEl('#app');

global.document = {
  querySelector: (sel) => (sel === '#app' ? appEl : getEl(sel)),
  documentElement: { dataset: { theme: 'dark' } },
  title: '',
  body: getEl('body'),
  createElement: () => makeEl(),
  addEventListener() {},
};
global.window = { addEventListener() {}, matchMedia: () => ({ matches: true }), scrollTo() {} };
global.history = { pushState() {} };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.location = { pathname: MODE === 'list' ? '/' : '/ipo/1895' };
global.fetch = (url) => {
  const u = String(url);
  let data = {};
  if (/^\/api\/ipos\/\d+/.test(u)) {
    const ipo = MODE === 'bare' ? BARE : SPARSE
      ? {
          id: 3001, name: 'Upcoming Industries Ltd.', slug: 'upcoming-ipo', category: 'SME', exchange: 'NSE',
          status: 'upcoming', openDate: '2026-09-20', closeDate: '2026-09-24', listingDate: null,
          issuePrice: 429, issueAmountCr: 120, subscriptionX: null,
          subscription: {}, listing: {}, market: {},
          financials: {}, kpi: {}, reviews: { subscribe: 0, neutral: 0, avoid: 0 },
          anchors: {}, isin: null, bseCode: null, nseSymbol: null,
          detailUrl: 'https://www.chittorgarh.com/ipo/upcoming-ipo/3001/', source: 'chittorgarh',
          score: { score: 40, verdict: 'Hold / Watch', tone: 'neutral', confidence: 'low', pillars: {} },
          detail: {
            priceBandLow: 408, priceBandHigh: 429, faceValue: 10, lotSize: 350,
            saleType: 'Book Building', issueType: 'Fresh', listingAt: 'NSE', listedOn: null,
            timetable: { open: 'Sep 20, 2026', close: 'Sep 24, 2026', allotment: null, refund: null, credit: null, listing: null },
            objects: [], promoters: null, registrar: 'BigShare', leadManagers: [],
          },
        }
      : FIXTURE;
    data = { fetchedAt: TS, ipo, detail: ipo.detail };
  } else if (u === '/api/meta') data = META;
  else if (u.startsWith('/api/ipos')) {
    data = { fetchedAt: TS, yearsLoaded: [2026, 2025], windowDays: 31, curated: true, total: 1, returned: 1, errors: [], ipos: [SUMMARY] };
  } else if (u === '/api/subscribers/count') data = { count: 128 };
  else if (u === '/api/markets') data = MARKETS_SNAPSHOT;
  return Promise.resolve({ ok: true, status: 200, json: async () => data });
};

require(path.join(__dirname, 'public', 'app.js'));

setTimeout(() => {
  const html = appEl.innerHTML || '';
  const DETAILISH = MODE === 'detail' || MODE === 'stale';
  const must =
    DETAILISH
      ? [
          'Company in charts',
          'Financials at a glance',
          'Profitability &amp; returns',
          'Price journey',
          'Issue structure',
          'Price band',
          'Promoter holding',
          'donut-wrap',
          'aria-label="Bar chart:',
          '52w high',
          'Never miss an IPO',
          'id="subForm"',
          'sub-prefs',
          'You&rsquo;re on the list!',
          'Cross-checked with BSE',
        ]
      : MODE === 'sparse'
        ? // upcoming IPO with no chartable numbers: the explicit empty state
          // shows and the price band renders as plain issue-details rows.
          ['Never miss an IPO', 'id="subForm"', 'Price band', '₹408 – ₹429', '₹429 per share', 'No charts for this IPO yet']
        : MODE === 'bare'
          ? // nothing chartable: the explicit empty state must show.
            ['Company in charts', 'No charts for this IPO yet', 'Never miss an IPO', 'id="subForm"']
          : ['Never miss an IPO', 'id="subForm"', 'sub-prefs', 'Weekly digest'];
  const missing = must.filter((s) => !html.includes(s));
  const leaks = ['NaN', 'undefined'].filter((s) => html.includes(s));
  const chartCards = (html.match(/class="chart-card"/g) || []).length;
  const staleNote = els.get('#staleNote');
  if (MODE === 'stale') {
    if (!staleNote || !staleNote.innerHTML.includes('last-known data')) {
      missing.push('stale banner must show when fetchedAt is old');
    }
  } else if (staleNote && staleNote.innerHTML) {
    missing.push('stale banner must be hidden for fresh data');
  }

  // Market strip: boot loads /api/markets and must reveal + fill the strip.
  const strip = els.get('#marketStrip');
  if (!strip) missing.push('market strip element missing from shim');
  else {
    if (strip.hidden) missing.push('market strip must be visible after a good snapshot');
    const tiles = (strip.innerHTML.match(/class="mtile /g) || []).length;
    if (tiles !== MARKETS_SNAPSHOT.quotes.length) {
      missing.push(`market strip tile count ${tiles} !== ${MARKETS_SNAPSHOT.quotes.length}`);
    }
    if (!/Market (open|closed)/.test(strip.innerHTML)) missing.push('market strip open/closed pill missing');
    if (!strip.innerHTML.includes('as of')) missing.push('market strip as-of stamp missing');
    if (!strip.innerHTML.includes('Sensex') || !strip.innerHTML.includes('Gold')) {
      missing.push('market strip quote names missing');
    }
    // Yahoo-style change cell: solid ▲/▼ arrow + absolute change + (percent).
    if (!strip.innerHTML.includes('mt-arr')) missing.push('market strip arrow span missing');
    if (!strip.innerHTML.includes('▲') || !strip.innerHTML.includes('▼')) {
      missing.push('market strip up/down arrows missing');
    }
    if (!strip.innerHTML.includes('-813.35') || !strip.innerHTML.includes('+25')) {
      missing.push('market strip absolute change missing');
    }
    if (!strip.innerHTML.includes('(-1.08%)') || !strip.innerHTML.includes('(+0.56%)')) {
      missing.push('market strip percent-in-parens missing');
    }
    if (/\bNaN\b|\bundefined\b/.test(strip.innerHTML)) missing.push('market strip has NaN/undefined leak');
  }

  if (DETAILISH && chartCards !== 5) missing.push(`chart-card count ${chartCards} !== 5`);
  if (MODE === 'sparse') {
    // upcoming IPO with no chartable numbers: zero cards + the empty state note.
    if (chartCards !== 0) missing.push(`chart-card count ${chartCards} !== 0`);
    if (!html.includes('No charts for this IPO yet')) missing.push('charts empty-state note missing');
  }
  if (MODE === 'bare') {
    // nothing chartable at all: section renders with the explicit empty state.
    if (chartCards !== 0) missing.push(`chart-card count ${chartCards} !== 0`);
    if (!html.includes('No charts for this IPO yet')) missing.push('charts empty-state note missing');
  }

  if (missing.length || leaks.length) {
    for (const leak of leaks) {
      let idx = html.indexOf(leak);
      while (idx !== -1) {
        console.error(`  leak "${leak}" @${idx}: …${html.slice(Math.max(0, idx - 120), idx + 80).replace(/\n/g, ' ')}…`);
        idx = html.indexOf(leak, idx + 1);
      }
    }
    console.error(`FAIL (${MODE})`, { missing, leaks, length: html.length });
    process.exit(1);
  }
  console.log(`OK (${MODE}) — ${html.length} chars, ${(html.match(/<svg/g) || []).length} <svg> nodes, ${chartCards} chart cards`);
  process.exit(0);
}, 150);
