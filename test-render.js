/**
 * Render smoke-test: shims a minimal DOM, loads public/app.js against a
 * fixture IPO record and asserts that the "Company in charts" section and
 * the subscribe card render with no NaN/undefined leaks.
 *
 * Usage: node test-render.js [detail|list|sparse]
 */
const path = require('path');
const TS = '2026-09-05T10:00:00.000Z';
const MODE = process.argv[2] || 'detail'; // detail | list | sparse
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

/* ---- minimal DOM shim ---- */
function makeEl() {
  return {
    dataset: {}, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => makeEl(), querySelectorAll: () => [],
    appendChild() {}, focus() {}, setAttribute() {}, getAttribute: () => null,
  };
}
const appEl = makeEl();

global.document = {
  querySelector: (sel) => (sel === '#app' ? appEl : makeEl()),
  documentElement: { dataset: { theme: 'dark' } },
  title: '',
  body: makeEl(),
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
    const ipo = SPARSE
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
  return Promise.resolve({ ok: true, status: 200, json: async () => data });
};

require(path.join(__dirname, 'public', 'app.js'));

setTimeout(() => {
  const html = appEl.innerHTML || '';
  const must =
    MODE === 'detail'
      ? [
          'Company in charts',
          'Financials at a glance',
          'Profitability &amp; returns',
          'Price journey',
          'Issue structure',
          'donut-wrap',
          'aria-label="Bar chart:',
          '52w high',
          'Never miss an IPO',
          'id="subForm"',
          'sub-prefs',
          'You&rsquo;re on the list!',
        ]
      : MODE === 'sparse'
        ? ['Never miss an IPO', 'id="subForm"']
        : ['Never miss an IPO', 'id="subForm"', 'sub-prefs', 'Weekly digest'];
  const missing = must.filter((s) => !html.includes(s));
  const leaks = ['NaN', 'undefined'].filter((s) => html.includes(s));
  const chartCards = (html.match(/class="chart-card"/g) || []).length;

  if (MODE === 'detail' && chartCards !== 4) missing.push(`chart-card count ${chartCards} !== 4`);
  if (MODE === 'sparse') {
    // upcoming IPO with no financials/market data: charts section should not render at all
    if (chartCards !== 0) missing.push(`chart-card count ${chartCards} !== 0`);
    if (html.includes('Company in charts')) missing.push('charts section should be absent');
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
