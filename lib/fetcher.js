/**
 * Upstream data fetcher for Chittorgarh's public JSON "cloud report" endpoints
 * (the same JSON their own website loads). All endpoints are read-only public
 * URLs; we add a browser-like UA and keep concurrency low.
 */
const REPORT_BASE = 'https://webnodejs.chittorgarh.com/cloud/report/data-read';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Report IDs (upstream "data-read" report numbers). */
const REPORTS = {
  SCHEDULE: 7, // open/close/allotment dates, exchange, ISIN, symbols
  PERFORMANCE: 125, // price, subscription, listing date, listing gain, market price, 52w
  SUBSCRIPTION: 98, // QIB/NII/Retail/Total subscription breakdown
  FINANCIALS: 161, // assets/revenue/PAT/EBITDA/net worth/borrowings
  KPI: 162, // ROE/ROCE/RoNW/margins/P-B/EPS/P-E
  REVIEWS: 104, // community review votes (subscribe/neutral/avoid)
  ANCHORS: 156, // anchor investor allocations
};

function reportUrl(reportId, year, fy) {
  // Segments observed on the upstream site:
  // /data-read/<reportId>/1/6/<year>/<fy>/0/all/0
  return `${REPORT_BASE}/${reportId}/1/6/${year}/${fy}/0/all/0`;
}

async function fetchJson(url, { timeoutMs = 15000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-IN,en;q=0.9',
          Origin: 'https://www.chittorgarh.com',
          Referer: 'https://www.chittorgarh.com/',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const json = await res.json();
      clearTimeout(timer);
      return json;
    } catch (err) {
      lastErr = err;
      clearTimeout(timer);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/** Fetch one report table for a given year (merges both fiscal-year segments). */
async function fetchReportYear(reportId, year, { timeoutMs, retries } = {}) {
  const fys = [`${year}-${String((year + 1) % 100).padStart(2, '0')}`, `${year - 1}-${String(year % 100).padStart(2, '0')}`];
  const results = await Promise.allSettled(
    fys.map((fy) => fetchJson(reportUrl(reportId, year, fy), { timeoutMs, retries }))
  );
  const byId = new Map();
  let anyOk = false;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    anyOk = true;
    const rows = Array.isArray(r.value && r.value.reportTableData) ? r.value.reportTableData : [];
    for (const row of rows) {
      const id = row && row['~id'];
      if (id === undefined || id === null) continue;
      // keep the richer row when the same id appears in both FY segments
      const prev = byId.get(Number(id));
      if (!prev || Object.keys(row).length > Object.keys(prev).length) byId.set(Number(id), row);
    }
  }
  if (!anyOk) throw new Error(`all FY variants failed for report ${reportId}/${year}`);
  return [...byId.values()];
}

async function fetchPage(htmlUrl, { timeoutMs = 20000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(htmlUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-IN,en;q=0.9',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${htmlUrl}`);
      const text = await res.text();
      clearTimeout(timer);
      return text;
    } catch (err) {
      lastErr = err;
      clearTimeout(timer);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

module.exports = { REPORTS, fetchJson, fetchReportYear, fetchPage, reportUrl };
