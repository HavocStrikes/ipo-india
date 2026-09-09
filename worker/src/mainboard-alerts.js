/**
 * Mainboard IPO Alert Pipeline
 *
 * Watches for Mainboard IPOs transitioning to 'open' or 'listed' and sends a
 * detailed, informational score-analysis email via Brevo. Completely ignores
 * SME / NSE Emerge / BSE SME issues so the daily mail quota is never wasted
 * on segments subscribers did not ask for.
 *
 * The emails are written as neutral, professional analysis — they state the
 * facts of the issue (price band, lot size, dates, financials, valuation)
 * and the model's investability score with its pillar rationale. They do NOT
 * advise the reader to buy or apply.
 *
 * Data source: the full enriched records stored under `records:<year>` (the
 * same records the API detail endpoint serves), NOT the stripped `list:`
 * summaries — kpi, financials, score pillars and listing data live only in
 * the full records. Each event IPO is further enriched with the scraped
 * detail page (price band, lot size, timetable, promoters) via the shared
 * `detail:<id>` KV cache, so retries never refetch.
 */
import { deriveStatus } from '../../lib/normalize.js';
import { loadDetail, mergeDetailIntoIpo } from '../../lib/detail.js';
import { getAllRecords, unsubscribeToken } from './subscribers.js';
import { sendMail, isMailConfigured, providerName } from './mail.js';

const OPEN_KEY = 'notified_open_ipos';
const LISTED_KEY = 'notified_listed_ipos';
const DETAIL_TTL_SECONDS = 30 * 60;

async function getJson(env, key) {
  const raw = await env.DATA.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function putJson(env, key, value, ttlSeconds) {
  const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
  await env.DATA.put(key, JSON.stringify(value), opts);
}

function isMainboard(ipo) {
  return String(ipo.category || '').toLowerCase() === 'mainboard';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Indian-locale formatting: 351.03 -> 351.03; 12550000 -> 1.25 Cr. */
function fmt(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  try { return n.toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
  catch { return String(n); }
}

function money(v) {
  return v == null ? '—' : '₹' + fmt(v);
}

function moneyCr(v) {
  return v == null ? '—' : '₹' + fmt(v) + ' Cr';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length === 10 ? iso + 'T00:00:00Z' : iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${WDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "₹118 – ₹124 per share" (or "₹124 per share" for a fixed price). */
function bandText(ipo) {
  const d = ipo.detail || {};
  if (d.priceBandLow != null && d.priceBandHigh != null) {
    if (d.priceBandLow === d.priceBandHigh) return '₹' + fmt(d.priceBandLow) + ' per share';
    return '₹' + fmt(d.priceBandLow) + ' – ₹' + fmt(d.priceBandHigh) + ' per share';
  }
  if (ipo.issuePrice != null) return '₹' + fmt(ipo.issuePrice) + ' per share';
  return null;
}

/** { lot, amount } for one application lot, or null when unknown. */
function minTicket(ipo) {
  const d = ipo.detail || {};
  const lot = d.lotSize;
  const price = d.priceBandHigh ?? ipo.issuePrice;
  if (lot == null || price == null) return null;
  const amount = Math.round(lot * price);
  return { lot, amount };
}

/** "53.5 / 100" plus model confidence — with a coloured tone (no advice). */
function scoreCard(score) {
  const val = score.score != null ? fmt(score.score) : '—';
  const conf = score.confidence || null;
  const color = score.tone === 'positive' ? '#16a34a' : score.tone === 'negative' ? '#dc2626' : '#b45309';
  let head = `<p style="margin:0 0 6px;font-size:13px;color:#4a546e">Investability Score</p>
<p style="margin:0 0 6px;font-size:34px;font-weight:bold;line-height:1;color:${color}">${val}<span style="font-size:15px;color:#8a94ad"> / 100</span></p>`;
  if (conf) head += `<p style="margin:4px 0 0;font-size:12px;color:#8a94ad">Model confidence: ${escapeHtml(conf)}</p>`;
  return head;
}

/** Two-column facts table (label / value) from the enriched record. */
function factsTable(ipo) {
  const d = ipo.detail || {};
  const rows = [];
  const band = bandText(ipo);
  if (band) rows.push(['Price band', band]);
  if (d.faceValue != null) rows.push(['Face value', '₹' + fmt(d.faceValue)]);
  if (d.lotSize != null) rows.push(['Lot size', fmt(d.lotSize) + ' shares']);
  const ticket = minTicket(ipo);
  if (ticket) rows.push(['Minimum investment', '≈ ₹' + fmt(ticket.amount) + ' (one lot of ' + fmt(ticket.lot) + ' shares)']);
  if (ipo.issueAmountCr != null) rows.push(['Issue size', moneyCr(ipo.issueAmountCr)]);
  if (ipo.exchange) rows.push(['Listing on', escapeHtml(String(ipo.exchange))]);
  if (ipo.subscriptionX != null) rows.push(['Subscription', fmt(ipo.subscriptionX) + '×']);
  if (ipo.openDate) rows.push(['Opens', fmtDate(ipo.openDate)]);
  if (ipo.closeDate) rows.push(['Closes', fmtDate(ipo.closeDate)]);
  if (ipo.allotmentDate) rows.push(['Allotment', fmtDate(ipo.allotmentDate)]);
  if (ipo.listingDate) rows.push(['Listing day', fmtDate(ipo.listingDate)]);
  if (!rows.length) return '';
  const trs = rows
    .map(([k, v]) =>
      '<tr><td style="padding:5px 16px 5px 0;font-size:13px;color:#4a546e;white-space:nowrap">' + escapeHtml(k) + '</td>' +
      '<td style="padding:5px 0;font-size:13px;color:#0e1428;font-weight:bold">' + v + '</td></tr>')
    .join('');
  return '<p style="margin:0 0 4px;font-size:12px;color:#8a94ad;text-transform:uppercase;letter-spacing:1px">Issue at a glance</p>' +
    '<table style="margin:6px 0 22px;border-collapse:collapse">' + trs + '</table>';
}

const PILLAR_DEFS = [
  ['demand', 'Demand', 25],
  ['fundamentals', 'Fundamentals', 25],
  ['valuation', 'Valuation', 20],
  ['performance', 'Performance', 15],
  ['sentiment', 'Sentiment', 15],
];

/** Five-pillar breakdown with each pillar's rationale note (the analysis). */
function pillarsTable(score) {
  const pillars = score.pillars || {};
  const rows = [];
  for (const [key, label, max] of PILLAR_DEFS) {
    const p = pillars[key] || {};
    const pts = p.pts != null ? fmt(p.pts) : '—';
    const color = (p.pts || 0) >= 0.7 * max ? '#16a34a' : (p.pts || 0) >= 0.4 * max ? '#b45309' : '#dc2626';
    const note = p.note ? '<span style="color:#6b7280;font-size:12px">— ' + escapeHtml(String(p.note)) + '</span>' : '';
    rows.push(
      '<tr><td style="padding:6px 14px 6px 0;font-size:13px;color:#334155">' + label + '</td>' +
      '<td style="padding:6px 0;font-size:13px;font-weight:bold;color:' + color + '">' + pts + '<span style="color:#94a3b8;font-size:11px"> / ' + max + '</span></td>' +
      '<td style="padding:6px 0;font-size:12px;color:#6b7280">' + note + '</td></tr>'
    );
  }
  return '<p style="margin:0 0 4px;font-size:12px;color:#8a94ad;text-transform:uppercase;letter-spacing:1px">Score breakdown — why the model scores it this way</p>' +
    '<table style="margin:6px 0 22px;border-collapse:collapse">' + rows.join('') + '</table>';
}

/** Financial & valuation snapshot — only rows with real data, so no stray dashes. */
function financialsTable(ipo) {
  const f = ipo.financials || {};
  const k = ipo.kpi || {};
  const rows = [];
  if (f.revenueCr != null) rows.push(['Revenue', moneyCr(f.revenueCr), f.period ? '(period ended ' + escapeHtml(String(f.period)) + ')' : '']);
  if (f.patCr != null) rows.push(['Profit after tax', moneyCr(f.patCr), '']);
  if (f.netWorthCr != null) rows.push(['Net worth', moneyCr(f.netWorthCr), '']);
  if (k.pePost != null) rows.push(['P/E (post-issue)', fmt(k.pePost) + '×', k.pePre != null ? 'pre-issue ' + fmt(k.pePre) + '×' : '']);
  if (k.ronw != null) rows.push(['RoNW', fmt(k.ronw) + '%', '']);
  if (k.patMargin != null) rows.push(['PAT margin', fmt(k.patMargin) + '%', '']);
  if (k.epsPre != null || k.epsPost != null) {
    const eps = [k.epsPre != null ? 'pre-issue ₹' + fmt(k.epsPre) : null, k.epsPost != null ? 'post-issue ₹' + fmt(k.epsPost) : null]
      .filter(Boolean).join(' · ');
    rows.push(['EPS', eps, '']);
  }
  if (k.date) rows.push(['KPI as of', fmt(k.date), '']);
  if (!rows.length) return '';
  const trs = rows
    .map(([kname, v, sub]) =>
      '<tr><td style="padding:5px 16px 5px 0;font-size:13px;color:#4a546e;white-space:nowrap">' + escapeHtml(kname) + '</td>' +
      '<td style="padding:5px 0;font-size:13px;color:#0e1428;font-weight:bold">' + v + '</td>' +
      (sub ? '<td style="padding:5px 0;font-size:12px;color:#8a94ad">' + sub + '</td>' : '') +
      '</tr>')
    .join('');
  return '<p style="margin:0 0 4px;font-size:12px;color:#8a94ad;text-transform:uppercase;letter-spacing:1px">Financial &amp; valuation snapshot</p>' +
    '<table style="margin:6px 0 22px;border-collapse:collapse">' + trs + '</table>';
}

/** Listing-day outcome table (listed emails only). */
function listingOutcomeTable(ipo) {
  const rows = [];
  const list = ipo.listing || {};
  const market = ipo.market || {};
  const price = list.openPrice ?? market.price ?? null;
  if (price != null) rows.push(['Listing price', money(price), list.closePrice != null ? 'last traded ' + money(list.closePrice) : '']);
  if (ipo.issuePrice != null) rows.push(['Issue price', money(ipo.issuePrice), '']);
  const gain = list.gainPct != null ? list.gainPct : ipo.listingGainPct;
  if (gain != null) {
    const arrow = gain >= 0 ? '▲' : '▼';
    const color = gain >= 0 ? '#16a34a' : '#dc2626';
    rows.push(['Movement on listing', '<span style="color:' + color + ';font-weight:bold">' + arrow + ' ' + (gain >= 0 ? '+' : '') + fmt(gain) + '%</span>', '']);
  }
  if (ipo.subscriptionX != null) rows.push(['Issue subscription', fmt(ipo.subscriptionX) + '×', '']);
  if (!rows.length) return '';
  const trs = rows
    .map(([k, v, sub]) =>
      '<tr><td style="padding:5px 16px 5px 0;font-size:13px;color:#4a546e;white-space:nowrap">' + escapeHtml(k) + '</td>' +
      '<td style="padding:5px 0;font-size:13px;color:#0e1428;font-weight:bold">' + v + '</td>' +
      (sub ? '<td style="padding:5px 0;font-size:12px;color:#8a94ad">' + sub + '</td>' : '') +
      '</tr>')
    .join('');
  return '<p style="margin:0 0 4px;font-size:12px;color:#8a94ad;text-transform:uppercase;letter-spacing:1px">Listing-day outcome</p>' +
    '<table style="margin:6px 0 22px;border-collapse:collapse">' + trs + '</table>';
}

/** Strongest & weakest scored pillars (for the summary sentence). */
function pillarHighlight(ipo) {
  const pillars = (ipo.score || {}).pillars || {};
  let best = null, worst = null;
  for (const [key, label, max] of PILLAR_DEFS) {
    const p = pillars[key];
    if (!p || p.pts == null) continue;
    const ratio = p.pts / max;
    if (!best || ratio > best.ratio) best = { label, pts: p.pts, max, note: p.note };
    if (!worst || ratio < worst.ratio) worst = { label, pts: p.pts, max, note: p.note };
  }
  if (!best || !worst || best.label === worst.label) return null;
  return { best, worst };
}

/**
 * Neutral, factual analytical summary in professional English.
 * Returns plain text; the HTML wrapper escapes company names.
 */
function summaryText(type, ipo) {
  const score = ipo.score || {};
  const sc = score.score != null ? fmt(score.score) : null;
  const conf = score.confidence || null;
  const sentences = [];

  const scoreClause = (() => {
    let s = 'On our five-pillar investability model, the issue scored ' + sc + ' out of 100';
    if (conf) s += ', with ' + conf + ' confidence';
    return s + '.';
  })();

  if (type === 'open') {
    sentences.push(ipo.name + ' opened its mainboard public issue' +
      (ipo.openDate ? ' on ' + fmtDate(ipo.openDate) : '') + '.');
    const bits = [];
    if (ipo.issueAmountCr != null) bits.push('an issue size of ' + moneyCr(ipo.issueAmountCr));
    const band = bandText(ipo);
    if (band) bits.push('a price band of ' + band);
    if (bits.length) sentences.push('The offering carries ' + bits.join(' and ') + '.'); 
    if (ipo.closeDate) sentences.push('The issue will remain open until ' + fmtDate(ipo.closeDate) + '.');
    if (sc != null) sentences.push(scoreClause);
  } else {
    const list = ipo.listing || {};
    const price = list.openPrice ?? ipo.marketPrice ?? null;
    const gain = list.gainPct != null ? list.gainPct : ipo.listingGainPct;
    sentences.push(ipo.name + ' listed on ' +
      (ipo.exchange ? String(ipo.exchange) + ' ' : '') +
      (ipo.listingDate ? 'on ' + fmtDate(ipo.listingDate) : 'today') + '.');
    const bits = [];
    if (price != null && ipo.issuePrice != null) {
      bits.push('the scrip opened at ' + money(price) + ' per share against an issue price of ' + money(ipo.issuePrice));
    } else if (price != null) {
      bits.push('the scrip opened at ' + money(price) + ' per share');
    }
    if (gain != null) bits.push((gain >= 0 ? 'a gain of +' : 'a loss of ') + fmt(Math.abs(gain)) + '% on listing');
    if (bits.length) sentences.push('In the listing session, ' + bits.join(' and ') + '.');
    if (ipo.subscriptionX != null) sentences.push('The issue drew ' + fmt(ipo.subscriptionX) + '× subscription by the close of bidding.');
    if (sc != null) sentences.push(scoreClause);
  }

  const hl = pillarHighlight(ipo);
  if (hl) {
    const strong = hl.best.pts + '/' + hl.best.max;
    const weak = hl.worst.pts + '/' + hl.worst.max;
    const strongNote = hl.best.note ? ' (' + hl.best.note + ')' : '';
    const weakNote = hl.worst.note ? ' (' + hl.worst.note + ')' : '';
    sentences.push(
      'Within the model, ' + hl.best.label.toLowerCase() + ' is the strongest pillar (' + strong + ')' + strongNote +
      ', while ' + hl.worst.label.toLowerCase() + ' is the weakest (' + weak + ')' + weakNote + '.'
    );
  }

  return sentences.join(' ');
}

/** Assemble the informational alert email. Returns { subject, html, text }. */
function buildEmail(type, ipo, site, unsubUrl) {
  const score = ipo.score || {};
  const summary = summaryText(type, ipo);
  const isOpen = type === 'open';

  const subject = isOpen
    ? 'Mainboard IPO Alert — ' + ipo.name + ' opens for subscription'
    : (() => {
        const list = ipo.listing || {};
        const gain = list.gainPct != null ? list.gainPct : ipo.listingGainPct;
        return 'Mainboard IPO Alert — ' + ipo.name + ' listed' +
          (gain != null ? ' ' + (gain >= 0 ? '+' : '') + fmt(gain) + '%' : '');
      })();

  const heading = escapeHtml(ipo.name);
  const statusLine = isOpen
    ? (ipo.openDate ? 'Opened for subscription on ' + fmtDate(ipo.openDate) : 'Open for subscription')
    : (ipo.listingDate ? 'Listed on ' + fmtDate(ipo.listingDate) : 'Listed today');

  const card =
    '<div style="margin:0 0 20px;padding:18px 20px;background:#f4f6fd;border-radius:12px;border:1px solid #e6e9f7">' +
    scoreCard(score) +
    '</div>';

  const parts = [];
  parts.push(
    '<div style="margin:0;padding:24px;background:#0f172a;font-family:Arial,Helvetica,sans-serif">',
    '<div style="max-width:600px;margin:0 auto;border-radius:16px;overflow:hidden;border:1px solid #1e293b;background:#ffffff">',
    '<div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:26px 30px;color:#ffffff">',
    '<div style="font-size:12px;letter-spacing:2px;opacity:.85;font-weight:bold">IPO INDIA · MAINBOARD ALERT</div>',
    '<p style="margin:10px 0 0;font-size:15px;line-height:1.4">' + heading + '</p>',
    '<p style="margin:6px 0 0;font-size:13px;opacity:.9;line-height:1.4">' + statusLine + '</p>',
    '</div>',
    '<div style="padding:26px 30px;color:#0e1428;font-size:14px;line-height:1.7">',
    '<p style="margin:0 0 6px"><span style="display:inline-block;padding:3px 12px;border-radius:999px;background:#eef2ff;color:#4338ca;font-weight:bold;font-size:11px;letter-spacing:1px">MAINBOARD</span></p>',
    '<p style="margin:12px 0 20px;font-size:14px;color:#334155;line-height:1.7">' + escapeHtml(summary) + '</p>',
    factsTable(ipo)
  );

  if (!isOpen) {
    const lo = listingOutcomeTable(ipo);
    if (lo) parts.push(lo);
  }

  parts.push(card, pillarsTable(score), financialsTable(ipo));

  const detailUrl = site + '/ipo/' + ipo.id;
  parts.push(
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px">' +
    '<tr><td style="border-radius:12px;background:linear-gradient(135deg,#4f46e5,#7c3aed)">' +
    '<a href="' + escapeHtml(detailUrl) + '" style="display:inline-block;padding:13px 24px;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px">Read the full analysis →</a>' +
    '</td></tr></table>',
    '<p style="margin:0 0 8px;font-size:12px;color:#8a94ad">You are receiving this because you subscribe to Mainboard IPO alerts on IPO India. ' +
    'This update is provided for information only and does not constitute investment advice.</p>',
    '<p style="margin:0;font-size:12px;color:#8a94ad">To stop receiving these alerts, <a href="' + escapeHtml(unsubUrl) + '" style="color:#4f46e5">unsubscribe here</a>.</p>',
    '</div></div></div>'
  );

  const html = parts.join('');
  let text = summary + '\n\n';
  const fp = factsPlain(ipo);
  if (fp) text += 'Issue at a glance:\n' + fp + '\n\n';
  if (!isOpen) {
    const lo = listingOutcomePlain(ipo);
    if (lo) text += 'Listing outcome:\n' + lo + '\n\n';
  }
  text += 'Score: ' + (score.score != null ? fmt(score.score) + '/100' : '—') + (score.confidence ? ', confidence: ' + score.confidence : '') + '\n\n';
  text += 'Score breakdown:\n' + pillarsPlain(score) + '\n\n';
  const fins = financialsPlain(ipo);
  if (fins) text += 'Financials:\n' + fins + '\n\n';
  text += 'Read the full analysis: ' + detailUrl + '\n' +
    'Unsubscribe: ' + unsubUrl;

  return { subject, html, text };
}

/** Plain-text companion tables (used for the email's textContent). */

function factsPlain(ipo) {
  const d = ipo.detail || {};
  const lines = [];
  const band = bandText(ipo);
  if (band) lines.push('Price band: ' + band);
  if (d.faceValue != null) lines.push('Face value: ₹' + fmt(d.faceValue));
  if (d.lotSize != null) lines.push('Lot size: ' + fmt(d.lotSize) + ' shares');
  const ticket = minTicket(ipo);
  if (ticket) lines.push('Minimum investment: ≈ ₹' + fmt(ticket.amount) + ' (one lot of ' + fmt(ticket.lot) + ' shares)');
  if (ipo.issueAmountCr != null) lines.push('Issue size: ' + moneyCr(ipo.issueAmountCr));
  if (ipo.exchange) lines.push('Listing on: ' + ipo.exchange);
  if (ipo.subscriptionX != null) lines.push('Subscription: ' + fmt(ipo.subscriptionX) + '×');
  if (ipo.openDate) lines.push('Opens: ' + fmtDate(ipo.openDate));
  if (ipo.closeDate) lines.push('Closes: ' + fmtDate(ipo.closeDate));
  if (ipo.allotmentDate) lines.push('Allotment: ' + fmtDate(ipo.allotmentDate));
  if (ipo.listingDate) lines.push('Listing day: ' + fmtDate(ipo.listingDate));
  return lines.join('\n');
}

function pillarsPlain(score) {
  const pillars = score.pillars || {};
  const lines = [];
  for (const [key, label, max] of PILLAR_DEFS) {
    const p = pillars[key] || {};
    const pts = p.pts != null ? fmt(p.pts) : '—';
    const note = p.note ? ' — ' + p.note : '';
    lines.push(label + ': ' + pts + '/' + max + note);
  }
  return lines.join('\n');
}

function listingOutcomePlain(ipo) {
  const list = ipo.listing || {};
  const market = ipo.market || {};
  const lines = [];
  const price = list.openPrice ?? market.price ?? null;
  if (price != null) lines.push('Listing price: ' + money(price));
  if (ipo.issuePrice != null) lines.push('Issue price: ' + money(ipo.issuePrice));
  const gain = list.gainPct != null ? list.gainPct : ipo.listingGainPct;
  if (gain != null) lines.push('Movement on listing: ' + (gain >= 0 ? '+' : '') + fmt(gain) + '%');
  if (ipo.subscriptionX != null) lines.push('Issue subscription: ' + fmt(ipo.subscriptionX) + '×');
  return lines.join('\n');
}

function financialsPlain(ipo) {
  const f = ipo.financials || {};
  const k = ipo.kpi || {};
  const lines = [];
  if (f.revenueCr != null) lines.push('Revenue: ' + moneyCr(f.revenueCr));
  if (f.patCr != null) lines.push('Profit after tax: ' + moneyCr(f.patCr));
  if (f.netWorthCr != null) lines.push('Net worth: ' + moneyCr(f.netWorthCr));
  if (k.pePost != null) lines.push('P/E (post-issue): ' + fmt(k.pePost) + '×');
  if (k.ronw != null) lines.push('RoNW: ' + fmt(k.ronw) + '%');
  if (k.patMargin != null) lines.push('PAT margin: ' + fmt(k.patMargin) + '%');
  if (k.epsPre != null || k.epsPost != null) {
    const eps = [k.epsPre != null ? 'pre-issue ₹' + fmt(k.epsPre) : null, k.epsPost != null ? 'post-issue ₹' + fmt(k.epsPost) : null].filter(Boolean).join(' · ');
    lines.push('EPS: ' + eps);
  }
  return lines.join('\n');
}

export async function runMainboardAlerts(env) {
  if (!isMailConfigured(env)) return { reason: 'no_provider', provider: providerName(env) };
  const subs = await getAllRecords(env);
  if (!subs.length) return { reason: 'no_subscribers' };
  const site = String(env.SITE_URL || 'https://ipo-india.ravi-ipodecode.workers.dev').replace(/\/+$/, '');

  // Full enriched records (`records:<year>` — kpi, financials, score pillars,
  // listing), NOT the stripped `list:` summaries which lack those fields.
  const y = new Date().getUTCFullYear();
  const [cur, prev] = await Promise.all([getJson(env, 'records:' + y), getJson(env, 'records:' + (y - 1))]);
  const byId = new Map();
  for (const rec of [cur, prev]) {
    if (!rec) continue;
    for (const ipo of rec.ipos) {
      const e = byId.get(ipo.id);
      if (!e || Object.keys(ipo).length > Object.keys(e).length) byId.set(ipo.id, ipo);
    }
  }
  const ipos = [...byId.values()].filter(isMainboard);

  const openNotified = (await getJson(env, OPEN_KEY)) || { ids: [] };
  const listedNotified = (await getJson(env, LISTED_KEY)) || { ids: [] };
  const openSet = new Set(openNotified.ids);
  const listedSet = new Set(listedNotified.ids);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const fresh = (d) => d === today || d === yesterday;

  // Detect events first, then enrich only those IPOs (never scrape otherwise).
  const events = [];
  for (const ipo of ipos) {
    if (ipo.status === 'open' && fresh(ipo.openDate) && !openSet.has(ipo.id)) events.push({ type: 'open', ipo });
    else if (ipo.status === 'listed' && fresh(ipo.listingDate) && !listedSet.has(ipo.id)) events.push({ type: 'listed', ipo });
  }
  if (!events.length) return { events: 0, sent: 0 };

  // Enrich each event IPO with the scraped detail (price band, lot size,
  // timetable, promoters) via the shared `detail:<id>` KV cache.
  for (const ev of events) {
    const id = ev.ipo.id;
    try {
      const cached = await getJson(env, 'detail:' + id);
      const freshDetail = cached && !cached.error;
      const detail = freshDetail ? cached : await loadDetail(ev.ipo);
      if (detail && !detail.error) {
        ev.ipo = mergeDetailIntoIpo(ev.ipo, detail, deriveStatus);
        if (!freshDetail) await putJson(env, 'detail:' + id, detail, DETAIL_TTL_SECONDS);
      }
    } catch (err) {
      console.error('[mainboard-alerts] detail enrich failed for ' + id + ':', err && (err.message || err));
    }
  }

  const unsubUrls = new Map();
  for (const sub of subs) {
    const token = await unsubscribeToken(env, sub.email);
    unsubUrls.set(sub.email, site + '/api/unsubscribe?email=' + encodeURIComponent(sub.email) + '&token=' + token);
  }

  let sent = 0, failed = 0;
  // pace to stay well under the 50-subrequest cron cap: KV reads + emails
  const budget = Math.min(8, Math.max(1, Math.floor(40 / Math.max(1, subs.length))));
  const newOpenIds = [], newListedIds = [];
  for (const ev of events) {
    let evSent = 0;
    for (const sub of subs) {
      if (sent + failed >= budget) break; // budget exhausted — remaining events retry next run
      const mail = buildEmail(ev.type, ev.ipo, site, unsubUrls.get(sub.email));
      const res = await sendMail(env, { to: sub.email, ...mail, unsubscribeUrl: unsubUrls.get(sub.email) });
      if (res.sent) { sent++; evSent++; } else failed++;
    }
    // Only mark as notified once at least one email dispatched successfully.
    // If all sends failed, the event stays unnotified and retries next run.
    if (evSent > 0) {
      if (ev.type === 'open') newOpenIds.push(ev.ipo.id); else newListedIds.push(ev.ipo.id);
    }
    if (sent + failed >= budget) break;
  }
  if (newOpenIds.length) await putJson(env, OPEN_KEY, { ids: [...openSet, ...newOpenIds], updatedAt: new Date().toISOString() });
  if (newListedIds.length) await putJson(env, LISTED_KEY, { ids: [...listedSet, ...newListedIds], updatedAt: new Date().toISOString() });
  return { events: events.length, sent, failed, provider: providerName(env) };
}

export async function mainboardAlertStatus(env) {
  const [openN, listedN, subs] = await Promise.all([getJson(env, OPEN_KEY), getJson(env, LISTED_KEY), getAllRecords(env).catch(() => null)]);
  return { mainboardOnly: true, notifiedOpen: openN ? openN.ids.length : 0, notifiedListed: listedN ? listedN.ids.length : 0, subscribers: subs ? subs.length : 0 };
}
