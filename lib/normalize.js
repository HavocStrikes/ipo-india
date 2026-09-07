/**
 * Normalizes raw upstream rows into a unified IPO model and derives status.
 */
const { REPORTS, fetchReportYear } = require('./fetcher');

const num = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v)
    .replace(/<[^>]*>/g, '') // display cells may wrap values in spans
    .replace(/[,₹%\s]/g, '')
    .replace(/[()]/g, '');
  if (s === '' || s === 'NA' || s.toLowerCase() === 'n.a.') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** Strip anchors/html from company link cells, extract ipo numeric id + slug. */
function parseCompanyCell(cell) {
  const raw = str(cell);
  const href = raw.match(/\/ipo\/([a-z0-9-]+)\/(\d+)\//i);
  const name = raw
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return { name, slug: href ? href[1] : null, ipoId: href ? Number(href[2]) : null };
}

const dateOf = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** Parse display dates like "10-Sep-2026". */
const dispDate = (v) => {
  const s = str(v);
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mo = months[m[2].toLowerCase()];
  if (mo === undefined) return null;
  return `${m[3]}-${String(mo + 1).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
};

function indexBy(rows, key = '~id') {
  const map = new Map();
  for (const r of rows || []) {
    const id = r[key];
    if (id !== undefined && id !== null) map.set(Number(id), r);
  }
  return map;
}

function categoryOf(row) {
  const cat = str(row['Issue Category'] || row['Issue Type'] || '').toLowerCase();
  if (cat.includes('sme')) return 'SME';
  if (cat) return 'Mainboard';
  return null;
}

/**
 * Merge all yearly report rows into unified IPO objects.
 */
function mergeYear(rowsByReport) {
  const schedule = indexBy(rowsByReport[REPORTS.SCHEDULE]);
  const perf = indexBy(rowsByReport[REPORTS.PERFORMANCE]);
  const subs = indexBy(rowsByReport[REPORTS.SUBSCRIPTION]);
  const fins = indexBy(rowsByReport[REPORTS.FINANCIALS]);
  const kpis = indexBy(rowsByReport[REPORTS.KPI]);
  const revs = indexBy(rowsByReport[REPORTS.REVIEWS]);
  const anchors = indexBy(rowsByReport[REPORTS.ANCHORS]);

  const allIds = new Set();
  [schedule, perf, subs, fins, kpis, revs, anchors].forEach((m) => m.forEach((_v, k) => allIds.add(k)));

  const ipos = [];
  for (const id of allIds) {
    const s = schedule.get(id) || {};
    const p = perf.get(id) || {};
    const sb = subs.get(id) || {};
    const f = fins.get(id) || {};
    const k = kpis.get(id) || {};
    const r = revs.get(id) || {};
    const a = anchors.get(id) || {};

    const companyCell = s['Company'] || p['Company'] || sb['Company'] || f['Company'] || k['Company'] || r['Company'];
    const parsed = parseCompanyCell(companyCell) || {};
    if (!parsed.name) continue;

    const openDate =
      dateOf(s['~Issue_Open_Date']) ||
      dateOf(p['~issue_open_date']) ||
      dateOf(sb['~Issue_Open_Date']) ||
      dateOf(p['~issue_open_date_plan']) ||
      dateOf(sb['~issue_open_date_plan']) ||
      dateOf(f['~issue_open_date_plan']) ||
      dateOf(k['~issue_open_date_plan']) ||
      dispDate(p['Opening Date']) ||
      dispDate(sb['Opening Date']);
    const closeDate = dateOf(s['~Issue_Close_Date']);
    const allotment = dateOf(s['Allotment Date']) || null;
    const listingDate =
      dateOf(p['~IL_IPO_Listing_date']) || dateOf(p['~IPO_Listing_Date']) || dateOf(sb['~IPO_Listing_Date']) || null;

    const issuePrice = num(k['Issue Price (Rs.)']) ?? num(p['Issue Price (Rs.)']);
    const issueAmount =
      num(p['Issue Amount (Rs.cr.)']) ?? num(f['Issue Amount (Rs.cr.)']) ?? num(k['Issue Amount (Rs.cr.)']);

    const subscription = num(p['Subscription (x)']) ?? num(sb['Total (x)']) ?? num(sb['Subscription (x)']);
    const gainListing =
      num(p['% Gain (Issue price v/s Close price on Listing)']) ??
      num(p['% Gain / Loss (Issue price v/s Close price on Listing)']) ??
      num(sb['% Gain / Loss (Issue price v/s Close price on Listing)']);

    const slug =
      parsed.slug || s['~urlrewrite_folder_name'] || p['~URLRewrite_Folder_Name'] || sb['~URLRewrite_Folder_Name'] || null;

    const ipo = {
      id,
      name: parsed.name.replace(/\s*IPO\s*$/i, '').trim(),
      slug,
      category: categoryOf(s) || categoryOf(p) || categoryOf(sb) || categoryOf(k),
      exchange: str(s['Exchange']) || null,
      openDate,
      closeDate,
      allotmentDate: allotment,
      listingDate,
      issuePrice,
      issueAmountCr: issueAmount,
      subscriptionX: subscription,
      subscription: {
        total: subscription,
        qib: num(sb['QIB (x)']),
        nii: num(sb['NII (x)']),
        retail: num(sb['Retail (x)']),
        employees: num(sb['Employees (x)']),
        others: num(sb['Others (x)']),
        shareholders: num(sb['Shareholders (x)']),
      },
      listing: {
        openPrice: num(p['Open Price on Listing (Rs.)']) ?? num(sb['Open Price on Listing (Rs.)']),
        closePrice: num(p['Close Price on Listing (Rs.)']) ?? num(sb['Close Price on Listing (Rs.)']),
        gainPct: gainListing,
      },
      market: {
        price: num(p['Market Price (Rs.)']),
        week52High: num(p['52 Week High']),
        week52Low: num(p['52 Week Low']),
      },
      financials: {
        period: str(f['Period Ended']) || null,
        assetsCr: num(f['Assets (Rs.cr.)']),
        revenueCr: num(f['Revenue (Rs.cr.)']),
        patCr: num(f['Profit After Tax (Rs.cr.)']),
        ebitdaCr: num(f['EBITDA (Rs.cr.)']),
        netWorthCr: num(f['Net Worth (Rs.cr.)']),
        reservesCr: num(f['Reserves and Surplus (Rs.cr.)']),
        borrowingsCr: num(f['Total Borrowing (Rs.cr.)']),
      },
      kpi: {
        date: str(k['KPI Date']) || null,
        roe: num(k['ROE %']),
        roce: num(k['ROCE %']),
        ronw: num(k['RoNW %']),
        patMargin: num(k['PAT Margin %']),
        ebitdaMargin: num(k['EBITDA %']),
        priceToBook: num(k['Price to Book Value']),
        epsPre: num(k['EPS (Rs.) Pre-IPO']),
        epsPost: num(k['EPS (Rs.) Post-IPO']),
        pePre: num(k['P/E (x) Pre-IPO']),
        pePost: num(k['P/E (x) Post-IPO']),
      },
      reviews: {
        subscribe: Math.max(0, num(r['Subscribe']) || 0),
        neutral: Math.max(0, num(r['Neutral']) || 0),
        avoid: Math.max(0, num(r['Avoid']) || 0),
      },
      anchors: {
        allotmentDate: dateOf(a['~Timetable_BOA_dt']),
        shares: num(a['Total No. of shares allotted to Anchor Investors']),
        amountCr: num(a['Total Investment by Anchor Investors (Rs.cr.)']),
        pctOfIssue: num(a['% of Issue Amount']),
      },
      isin: str(s['~isin']) || str(p['~isin']) || null,
      bseCode: str(s['~bse_script_code']) || str(p['~bse_script_code']) || null,
      nseSymbol: str(s['~nse_symbol']) || str(p['~nse_symbol']) || null,
      detailUrl: slug && id ? `https://www.chittorgarh.com/ipo/${slug}/${id}/` : null,
      source: 'chittorgarh',
    };
    ipos.push(ipo);
  }
  return ipos;
}

/** Derive lifecycle status from today's date. */
function deriveStatus(ipo, today = new Date()) {
  const t = today.toISOString().slice(0, 10);
  const open = ipo.openDate;
  const close = ipo.closeDate;
  const listed = ipo.listingDate;

  if (listed && listed <= t) return 'listed';
  if (open && close) {
    if (t < open) return 'upcoming';
    if (t >= open && t <= close) return 'open';
    return 'closed';
  }
  if (open) return t < open ? 'upcoming' : 'closed';
  if (ipo.subscriptionX !== null && ipo.subscriptionX !== undefined) return 'closed';
  return 'upcoming';
}

function enrich(ipo, today = new Date()) {
  const status = deriveStatus(ipo, today);
  return { ...ipo, status };
}

/**
 * Load a full year of IPO data (merged from all reports) with graceful
 * per-report degradation — if one report fails we still serve the rest.
 */
async function loadYear(year, fetchReportYearFn = fetchReportYear) {
  const ids = [
    REPORTS.SCHEDULE,
    REPORTS.PERFORMANCE,
    REPORTS.SUBSCRIPTION,
    REPORTS.FINANCIALS,
    REPORTS.KPI,
    REPORTS.REVIEWS,
    REPORTS.ANCHORS,
  ];
  const results = await Promise.allSettled(ids.map((rid) => fetchReportYearFn(rid, year)));
  const rowsByReport = {};
  const errors = [];
  ids.forEach((rid, i) => {
    if (results[i].status === 'fulfilled') rowsByReport[rid] = results[i].value;
    else errors.push({ reportId: rid, error: String(results[i].reason && results[i].reason.message) });
  });
  const merged = mergeYear(rowsByReport).map((ipo) => enrich(ipo));
  merged.sort((a, b) => (b.openDate || '0000').localeCompare(a.openDate || '0000'));
  return { year, count: merged.length, ipos: merged, errors };
}

module.exports = { mergeYear, deriveStatus, enrich, loadYear, num, parseCompanyCell, dateOf };


