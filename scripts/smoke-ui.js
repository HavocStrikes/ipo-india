/* UI smoke test — renders the list & detail pages with stubbed DOM/fetch and
   asserts the de-cluttering rules on the produced HTML. No dependencies.
   Run: node scripts/smoke-ui.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const els = new Map();
function makeEl() {
  return {
    _html: '',
    textContent: '',
    className: '',
    hidden: false,
    style: {},
    dataset: {},
    title: '',
    disabled: false,
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {},
    querySelector(sel) { return getEl(sel); },
    querySelectorAll() { return []; },
    setAttribute() {},
    focus() {},
  };
}
function getEl(sel) {
  if (!els.has(sel)) els.set(sel, makeEl());
  return els.get(sel);
}

const documentStub = {
  title: '',
  documentElement: { dataset: { theme: 'dark' } },
  querySelector(sel) {
    if (sel === 'a.brand') return null;
    if (sel.startsWith('meta')) return { content: '' };
    return getEl(sel);
  },
};

const listIpo = {
  id: 2632, name: 'Farm Peace Ltd.', slug: 'farm-peace-ipo', category: 'SME', exchange: 'NSE SME',
  status: 'open', openDate: '2026-09-08', closeDate: '2026-09-10', allotmentDate: '2026-09-11', listingDate: null,
  issuePrice: 132, issueAmountCr: 54.6, subscriptionX: null, listingGainPct: null, marketPrice: null,
  pePost: 18.2, ronw: 22.5,
  score: { score: 61.4, verdict: 'Subscribe', tone: 'good', confidence: 'high' },
  detailUrl: 'https://example.com', nseSymbol: null, known: 4,
};

const detailResp = {
  fetchedAt: '2026-09-09T02:00:00Z',
  ipo: {
    ...listIpo,
    listingDate: '2026-09-15',
    detail: {
      priceBandLow: 125, priceBandHigh: 132, lotSize: 112, faceValue: 10,
      totalIssueShares: 4140000, freshIssueShares: 3100000, ofsShares: 1040000,
      saleType: 'Book Built', issueType: 'IPO', listingAt: 'NSE SME',
      bseCode: null, isin: null, // missing on purpose → rows must disappear
      timetable: {},
      objects: [
        { object: 'Working capital', amountCr: 30 },
        { object: 'Capex', amountCr: 12 },
        { object: 'General corporate purposes', amountCr: 8 },
      ],
      promoters: { preIssuePct: 61.2, postIssuePct: 45.3, dilution: 15.9, names: 'Ramesh & family' },
      listingDayTrading: {},
    },
    subscription: { total: 12.45, qib: 9.1, nii: 18.2, retail: 11.3 },
    subscriptionX: 12.45,
    financials: { period: '2026-03-31', revenueCr: 210.4, ebitdaCr: 30.2, patCr: 15.7, netWorthCr: 90.1, borrowingsCr: 40.2, assetsCr: 130.5 },
    kpi: { pePre: 20.1, pePost: 18.2, priceToBook: 2.4, epsPre: 6.6, epsPost: 7.2, patMargin: 7.5, ebitdaMargin: 14.4, ronw: 22.5, roce: 19.8 },
    listing: null,
    market: null,
    reviews: { subscribe: 12, neutral: 3, avoid: 2 },
    anchors: null,
  },
};

const fetchStub = (url) => {
  let body;
  if (/\/api\/ipos\/\d+/.test(url)) body = detailResp;
  else if (url.includes('/api/meta'))
    body = { counts: { upcoming: 5, open: 2, closed: 3, listed: 7 }, windowDays: 31, total: 604, fetchedAt: '2026-09-09T02:00:00Z' };
  else body = { fetchedAt: '2026-09-09T02:00:00Z', ipos: [listIpo] };
  return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(body))) });
};

const winHandlers = {};
const sandbox = {
  console,
  setTimeout, clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  document: documentStub,
  navigator: { clipboard: { writeText: () => Promise.resolve() }, serviceWorker: { register: () => Promise.resolve({}) } },
  localStorage: { getItem: () => null, setItem() {} },
  fetch: fetchStub,
  location: { pathname: '/', search: '', origin: 'http://localhost:8787' },
  history: { pushState() {} },
  URL, URLSearchParams,
};
sandbox.window = {
  IPO_CONFIG: { apiBase: '' },
  addEventListener(type, fn) { (winHandlers[type] = winHandlers[type] || []).push(fn); },
  scrollTo() {},
  matchMedia: () => ({ matches: false }),
  navigator: null,
};
sandbox.window.navigator = sandbox.navigator;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'app.js' });

const tick = () => new Promise((r) => setTimeout(r, 80));
let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
};

(async () => {
  await tick();
  const listHtml = els.get('#cards') ? els.get('#cards').innerHTML : '';
  const heroHtml = els.get('#app').innerHTML;

  console.log('\n- list view -');
  check('card rendered', listHtml.includes('Farm Peace Ltd.'));
  check('card hides "—" Subscription row when no sub data', !/>Subscription<\/span>/.test(listHtml));
  check('hero still renders', heroHtml.includes('India&rsquo;s IPOs'));

  console.log('\n- detail view -');
  sandbox.location.pathname = '/ipo/2632';
  (winHandlers.popstate || []).forEach((fn) => fn());
  await tick();
  const html = els.get('#app').innerHTML;

  check('detail rendered', html.includes('Farm Peace Ltd.'));
  check('verdict shown next to score ring', html.includes('verdict-big') && html.includes('Subscribe'));
  check('collapsed "More issue details" block present', html.includes('kv-more'));
  check('null rows dropped: no ISIN', !html.includes('ISIN'));
  check('null rows dropped: no BSE code', !html.includes('BSE code'));
  check('no wall of dashes in kv values', !/>—<\/span>/.test(html));
  check('financial bar chart rendered', html.includes('Financials at a glance'));
  check('duplicate "Financials" text panel removed', !/>Financials<\/h2>/.test(html));
  check('donut chart rendered', html.includes('Issue structure'));
  // Scope to the collapsed kv block — the donut legend legitimately says "Fresh issue".
  const moreBody = (html.split('<div class="kv-more-body">')[1] || '').split('</details>')[0] || '';
  check('Fresh/OFS rows not duplicated next to donut', moreBody !== '' && !moreBody.includes('Fresh issue') && !moreBody.includes('Offer for sale'));
  check('meter chart carries healthy-threshold tick', html.includes('meter-mark'));
  check('valuation panel keeps P/E multiples', html.includes('P/E pre-issue'));
  // Scope to the valuation panel — the meters card legitimately shows "PAT margin"/"ROCE".
  const valPanel = (html.split('Valuation &amp; ratios</h2>')[1] || '').split('</section>')[0] || '';
  check('valuation panel drops margin rows (now in meters)', valPanel.includes('P/E pre-issue') && !valPanel.includes('RoNW') && !valPanel.includes('ROCE') && !valPanel.includes('PAT margin'));
  check('subscription bars rendered', html.includes('sub-row') && html.includes('QIB'));
  check('objects panel present (no funds chart when donut shown)', html.includes('Issue objects'));
  check('bar chart has no numeric axis labels', !/axis-txt">\d/.test(html));
  // Scope to the first score-ring svg; '<line ' (with space) can't match <linearGradient.
  const ringSvg = (html.split('<div class="score-ring')[1] || '').split('</svg>')[0] || '';
  check('score ring simplified (no tick marks)', ringSvg !== '' && !ringSvg.includes('<line '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('SMOKE TEST CRASHED:', e);
  process.exit(1);
});
