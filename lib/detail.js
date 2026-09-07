/**
 * Scrapes an IPO's public detail page (server-rendered HTML) for the deep
 * information that is not available in the JSON reports: price band, lot
 * size, issue structure, timetable, objects of the issue, promoters,
 * registrar / lead managers and listing-day trading stats.
 */
const { fetchPage } = require('./fetcher');

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '|')
    .replace(/&#8377;|&rsquo;/g, '₹')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\|+/g, '|')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Find "Label|value" pairs inside a label-value pipe stream. */
function labelValue(text, label, { next = 120 } = {}) {
  const re = new RegExp(`${label}\\s*\\|([^|]{0,${next}})`, 'i');
  const m = text.match(re);
  return m ? m[1].trim().replace(/\|+$/, '').trim() : null;
}

function num(text) {
  if (!text) return null;
  const s = String(text).replace(/[,₹%\s]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse the "IPO Objects of the Issue" numbered table.
 * Rows look like: "| | |1| |Purchase and installation...| |576.00|"
 * (pipes/spaces between number, label and amount vary). */
function parseObjects(text) {
  const start = text.search(/Objects? of the Issue/i);
  if (start === -1) return [];
  const seg = text.slice(start, start + 4000);
  const objects = [];
  const rowRe = /\|\s*(\d{1,2})\s*\|[\s|]*([^|]{4,300}?)\|[\s|]*([\d,]+\.?\d*)\s*\|/g;
  let m;
  while ((m = rowRe.exec(seg))) {
    const amount = parseFloat(m[3].replace(/,/g, ''));
    const label = m[2].trim();
    if (/^total$|^aggregating/i.test(label)) continue;
    if (/^(issue objects|est amt|est\.? amount)/i.test(label)) continue;
    if (label.length < 8) continue;
    objects.push({ object: label, amountCr: Number.isFinite(amount) ? amount : null });
    if (objects.length >= 12) break;
  }
  return objects;
}

/** Parse promoter pre/post holding. */
function parsePromoters(text) {
  const start = text.search(/Promoter and Promoter Group/i);
  if (start === -1) return null;
  const seg = text.slice(Math.max(0, start - 400), start + 600);
  const pct = seg.match(/(\d{1,3}(?:\.\d+)?)%\s*\|+\s*\|*\s*(\d{1,3}(?:\.\d+)?)%/);
  const namesStart = text.search(/Company Promoters?:/i);
  let names = null;
  if (namesStart !== -1) {
    names = text
      .slice(namesStart, namesStart + 400)
      .split('|')[1];
    names = names ? names.trim() : null;
  }
  return {
    preIssuePct: pct ? parseFloat(pct[1]) : null,
    postIssuePct: pct ? parseFloat(pct[2]) : null,
    names,
  };
}

/** Parse "Tue, Sep 15, 2026" / "Thu, 15 Jan, 2026" style date strings -> ISO. */
function isoFromDisplay(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/^[A-Za-z]{3},\s*/, '').trim();
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Merge scraped detail back into the IPO record (fills schedule gaps). */
function mergeDetailIntoIpo(ipo, detail, deriveStatusFn) {
  if (!detail || detail.error) return ipo;
  const out = { ...ipo };
  const t = detail.timetable || {};
  out.openDate = out.openDate || isoFromDisplay(t.open);
  out.closeDate = out.closeDate || isoFromDisplay(t.close);
  out.listingDate = out.listingDate || isoFromDisplay(t.listing);
  out.allotmentDate = out.allotmentDate || isoFromDisplay(t.allotment);
  out.exchange = out.exchange || detail.listingAt || null;
  out.issuePrice = out.issuePrice ?? detail.issuePrice ?? detail.priceBandHigh ?? null;
  out.detail = detail;
  if (deriveStatusFn) {
    out.status = deriveStatusFn(out);
  }
  return out;
}

/** Main detail parser. */
function parseDetail(html) {
  const text = stripTags(html);
  const d = {};

  // ---- The main "IPO Details" table: starts at "...|IPO| Details|IPO Date|..." ----
  const mainIdx = text.search(/Details\|?\s*IPO Date/i) !== -1 ? text.search(/Details\|?\s*IPO Date/i) : text.search(/IPO\s*\|\s*Details\|/);
  const main = mainIdx !== -1 ? text.slice(mainIdx, mainIdx + 2600) : text;

  const band = main.match(/Price Band\s*\|\s*₹?\s*([\d,]+)\s*to\s*₹?\s*([\d,]+)/i);
  if (band) {
    d.priceBandLow = num(band[1]);
    d.priceBandHigh = num(band[2]);
  }
  d.issuePrice = num((main.match(/Issue Price\s*\|\s*₹?\s*\|?\s*([\d,.]+)/i) || [])[1]);
  d.faceValue = num((main.match(/Face Value\s*\|\s*₹?\s*\|?\s*([\d,.]+)/i) || [])[1]);
  d.lotSize = num((main.match(/Lot Size\s*\|\s*([\d,]+)/i) || [])[1]);
  d.saleType = (main.match(/Sale Type\s*\|\s*([^|]+)/i) || [])[1] || null;
  d.issueType = (main.match(/Issue Type\s*\|\s*([^|]+)/i) || [])[1] || null;
  d.listingAt = (main.match(/Listing At\s*\|\s*([^|]+)/i) || [])[1] || null;
  d.listedOn = (main.match(/Listed on\s*\|\s*([^|]+)/i) || [])[1] || null;
  const totalIssue = main.match(/Total Issue Size\s*\|\s*([\d,]+)\s*\|/i);
  if (totalIssue) d.totalIssueShares = num(totalIssue[1]);
  const fresh = main.match(/Fresh Issue\s*\|\s*([\d,]+)\s*\|/i);
  if (fresh) d.freshIssueShares = num(fresh[1]);
  const ofs = main.match(/Offer for Sale\s*\|\s*([\d,]+)\s*\|/i);
  if (ofs) d.ofsShares = num(ofs[1]);

  // ---- IPO Timetable block ----
  const ttIdx = text.search(/IPO\s*\|\s*Timetable/i);
  if (ttIdx !== -1) {
    const tt = text.slice(ttIdx, ttIdx + 900);
    d.timetable = {
      open: (tt.match(/IPO\s*\|\s*Open\s*\|\s*([^|]+)/i) || [])[1] || null,
      close: (tt.match(/IPO\s*\|\s*Close\s*\|\s*([^|]+)/i) || [])[1] || null,
      allotment: (tt.match(/Allotment\s*\|\s*([^|]+)/i) || [])[1] || null,
      refund: (tt.match(/Refund\s*\|\s*([^|]+)/i) || [])[1] || null,
      credit: (tt.match(/Credit of Shares\s*\|\s*([^|]+)/i) || [])[1] || null,
      listing: (tt.match(/Listing\s*\|\s*([^|]+)/i) || [])[1] || null,
    };
  }

  d.objects = parseObjects(text);
  d.promoters = parsePromoters(text);

  // ---- Registrar & lead managers ----
  const regIdx = text.search(/IPO\s*\|?\s*Registrar\s*\|/i);
  if (regIdx !== -1) {
    const seg = text.slice(regIdx, regIdx + 300).split('|').filter((s) => s.trim());
    const after = seg.slice(1).filter((s) => !/^Registrar$|^Visit the/i.test(s.trim()));
    d.registrar = after[0] ? after[0].trim() : null;
  }
  const lmIdx = text.search(/IPO\s*\|?\s*Lead Manager\(s\)\s*\|/i);
  if (lmIdx !== -1) {
    const seg = text.slice(lmIdx, lmIdx + 400).split('|').filter((s) => s.trim());
    d.leadManagers = seg
      .slice(1, 5)
      .map((s) => s.trim())
      .filter((s) => s && !/^Lead Manager|^Contact|^Visit/i.test(s));
  }

  // ---- Listing Day Trading Information (BSE + NSE price columns) ----
  const ldtIdx = text.search(/Listing Day Trading Information/i);
  if (ldtIdx !== -1) {
    const seg = text.slice(ldtIdx, ldtIdx + 800);
    const grab = (label) => {
      const m = seg.match(new RegExp(`${label}\\s*\\|\\s*₹?\\s*\\|?\\s*([\\d,.]+)(?:\\s*\\|\\s*₹?\\s*\\|?\\s*([\\d,.]+))?`, 'i'));
      if (!m) return null;
      return { bse: num(m[1]), nse: num(m[2]) ?? num(m[1]) };
    };
    const raw = {
      finalIssuePrice: grab('Final Issue Price'),
      open: grab('Open'),
      low: grab('Low'),
      high: grab('High'),
      lastTrade: grab('Last Trade'),
    };
    // scalars for the UI (NSE preferred, BSE fallback) + per-exchange breakdown
    const scalar = (v) => (v ? v.nse ?? v.bse ?? null : null);
    d.listingDayTrading = {
      finalIssuePrice: scalar(raw.finalIssuePrice),
      open: scalar(raw.open),
      low: scalar(raw.low),
      high: scalar(raw.high),
      lastTrade: scalar(raw.lastTrade),
      byExchange: raw,
    };
  }

  return d;
}

async function loadDetail(ipo) {
  if (!ipo.detailUrl) return null;
  const html = await fetchPage(ipo.detailUrl, { timeoutMs: 20000, retries: 1 });
  return parseDetail(html);
}

module.exports = { parseDetail, loadDetail, stripTags, mergeDetailIntoIpo, isoFromDisplay };
