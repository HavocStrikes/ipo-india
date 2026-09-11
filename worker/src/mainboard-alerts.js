/**
 * Mainboard IPO Alert Pipeline
 *
 * Watches for Mainboard IPOs transitioning to 'open' or 'listed' and sends a
 * short, scannable alert email via Brevo. Completely ignores
 * SME / NSE Emerge / BSE SME issues so the daily mail quota is never wasted
 * on segments subscribers did not ask for.
 *
 * The email is deliberately brief: it names the company, gives the dates that
 * drive the apply decision (opens / closes, listing day when known) and four
 * key numbers as compact chips, with one button to the /ipo/:id page where
 * the full analysis (investability score, pillar rationale, financials)
 * lives. It is neutral information only — it does NOT advise the reader to
 * buy or apply.
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

/* ── Compact alert builders ───────────────────────────────────────────────
 * The email is a glance, not a report: the dates that drive the apply
 * decision plus the four numbers a reader needs, laid out as fixed-width
 * chips so nothing reflows into cramped wraps on phones. Score, pillar
 * rationale and financials stay on the /ipo page the CTA points to. */

/** "₹40 – ₹43" — short price band for chips ("per share" implied). */
function bandShort(ipo) {
  const d = ipo.detail || {};
  if (d.priceBandLow != null && d.priceBandHigh != null) {
    if (d.priceBandLow === d.priceBandHigh) return '₹' + fmt(d.priceBandLow);
    return '₹' + fmt(d.priceBandLow) + ' – ₹' + fmt(d.priceBandHigh);
  }
  if (ipo.issuePrice != null) return '₹' + fmt(ipo.issuePrice);
  return null;
}

/** One row of equal-width chips: [label, valueHtml, subHtml?] cells. An
 *  empty label renders as a spacer so odd counts stay symmetric. */
function chipRow(cells) {
  const tds = cells
    .map(([label, value, sub]) => {
      if (!label) return '<td style="padding:0 5px"></td>';
      return (
        '<td style="padding:0 5px">' +
        '<div style="border:1px solid #e6e9f7;background:#f4f6fd;border-radius:10px;padding:10px 6px;text-align:center">' +
        '<div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#8a94ad;font-weight:bold">' + escapeHtml(label) + '</div>' +
        '<div style="margin-top:3px;font-size:14px;font-weight:bold;color:#0e1428;line-height:1.35">' + value + '</div>' +
        (sub ? '<div style="margin-top:2px;font-size:11px;color:#8a94ad;line-height:1.3">' + sub + '</div>' : '') +
        '</div></td>'
      );
    })
    .join('');
  return '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width:100%;table-layout:fixed;border-collapse:separate;margin:0 0 12px"><tr>' + tds + '</tr></table>';
}

/** Opens / Closes (+ Listing day when known) — the apply-decision dates. */
function datesChips(ipo) {
  const cells = [];
  if (ipo.openDate) cells.push(['Opens', escapeHtml(fmtDate(ipo.openDate))]);
  if (ipo.closeDate) cells.push(['Closes', escapeHtml(fmtDate(ipo.closeDate))]);
  if (ipo.listingDate) cells.push(['Listing day', escapeHtml(fmtDate(ipo.listingDate))]);
  return cells.length ? chipRow(cells) : '';
}

/** Listing-day outcome chips (listed emails): open price, move, subscription. */
function listingChips(ipo) {
  const list = ipo.listing || {};
  const market = ipo.market || {};
  const price = list.openPrice ?? market.price ?? null;
  const gain = list.gainPct != null ? list.gainPct : ipo.listingGainPct;
  const cells = [];
  if (price != null) {
    cells.push(['Open price', money(price), ipo.issuePrice != null ? 'vs ' + money(ipo.issuePrice) + ' issue' : '']);
  }
  if (gain != null) {
    const color = gain >= 0 ? '#16a34a' : '#dc2626';
    const arrow = gain >= 0 ? '▲' : '▼';
    cells.push(['On listing', '<span style="color:' + color + '">' + arrow + ' ' + (gain >= 0 ? '+' : '&minus;') + fmt(Math.abs(gain)) + '%</span>']);
  }
  if (ipo.subscriptionX != null) cells.push(['Subscription', fmt(ipo.subscriptionX) + '×']);
  return cells.length ? chipRow(cells) : '';
}

/** The four numbers a reader needs, two per row. */
function factsChips(ipo) {
  const d = ipo.detail || {};
  const ticket = minTicket(ipo);
  const cells = [];
  const band = bandShort(ipo);
  if (band) cells.push([d.priceBandLow != null && d.priceBandLow !== d.priceBandHigh ? 'Price band' : 'Price', escapeHtml(band)]);
  if (d.lotSize != null) cells.push(['Lot size', fmt(d.lotSize) + ' shares']);
  if (ticket) cells.push(['Min. investment', '≈ ' + money(ticket.amount)]);
  if (ipo.issueAmountCr != null) cells.push(['Issue size', moneyCr(ipo.issueAmountCr)]);
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) {
    const pair = cells.slice(i, i + 2);
    if (pair.length === 1) pair.push(['', '', '']);
    rows.push(chipRow(pair));
  }
  return rows.join('');
}

/**
 * Short, neutral summary — one or two sentences. The dates and numbers render
 * as chips below; the score and its rationale live on the website, not here.
 * Returns plain text; the HTML wrapper escapes it.
 */
function summaryText(type, ipo) {
  const sentences = [];

  if (type === 'open') {
    sentences.push(ipo.name + ' opened its mainboard public issue' +
      (ipo.openDate ? ' on ' + fmtDate(ipo.openDate) : '') + '.');
    if (ipo.closeDate) sentences.push('The application window closes on ' + fmtDate(ipo.closeDate) + '.');
  } else {
    const list = ipo.listing || {};
    const price = list.openPrice ?? ipo.marketPrice ?? null;
    const gain = list.gainPct != null ? list.gainPct : ipo.listingGainPct;
    sentences.push(ipo.name + ' listed on ' +
      (ipo.exchange ? String(ipo.exchange) + ' ' : '') +
      (ipo.listingDate ? 'on ' + fmtDate(ipo.listingDate) : 'today') + '.');
    if (price != null) {
      let t = 'The scrip opened at ' + money(price) +
        (ipo.issuePrice != null ? ' against an issue price of ' + money(ipo.issuePrice) : '');
      if (gain != null) t += ', ' + (gain >= 0 ? 'a gain of +' : 'a fall of ') + fmt(Math.abs(gain)) + '%';
      sentences.push(t + '.');
    } else if (gain != null) {
      sentences.push('The stock ended the listing session ' + (gain >= 0 ? '+' : '-') + fmt(Math.abs(gain)) + '%.');
    }
  }

  return sentences.join(' ');
}

/**
 * Assemble the alert email — deliberately short: a two-sentence summary, the
 * apply-decision dates, four key numbers and one button to the /ipo page.
 * Returns { subject, html, text }.
 */
export function buildEmail(type, ipo, site, unsubUrl) {
  const isOpen = type === 'open';
  const summary = summaryText(type, ipo);

  const subject = isOpen
    ? 'Mainboard IPO Alert — ' + ipo.name + ' opens for subscription'
    : (() => {
        const list = ipo.listing || {};
        const gain = list.gainPct != null ? list.gainPct : ipo.listingGainPct;
        return 'Mainboard IPO Alert — ' + ipo.name + ' listed' +
          (gain != null ? ' ' + (gain >= 0 ? '+' : '') + fmt(gain) + '%' : '');
      })();

  const statusLine = isOpen
    ? (ipo.openDate ? 'Opened for subscription on ' + fmtDate(ipo.openDate) : 'Open for subscription')
    : (ipo.listingDate ? 'Listed on ' + fmtDate(ipo.listingDate) : 'Listed today');

  const pillRow =
    '<p style="margin:0 0 14px"><span style="display:inline-block;padding:3px 12px;border-radius:999px;background:#eef2ff;color:#4338ca;font-weight:bold;font-size:11px;letter-spacing:1px">MAINBOARD</span>' +
    (ipo.exchange ? '<span style="font-size:12px;color:#8a94ad">&nbsp;&nbsp;' + escapeHtml(String(ipo.exchange)) + '</span>' : '') +
    '</p>';

  const parts = [];
  parts.push(
    '<div style="margin:0;padding:24px;background:#0f172a;font-family:Arial,Helvetica,sans-serif">',
    '<div style="max-width:600px;margin:0 auto;border-radius:16px;overflow:hidden;border:1px solid #1e293b;background:#ffffff">',
    '<div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:24px 30px;color:#ffffff">',
    '<div style="font-size:12px;letter-spacing:2px;opacity:.85;font-weight:bold">IPO INDIA · MAINBOARD ALERT</div>',
    '<p style="margin:10px 0 0;font-size:17px;line-height:1.4;font-weight:bold">' + escapeHtml(ipo.name) + '</p>',
    '<p style="margin:6px 0 0;font-size:13px;opacity:.9;line-height:1.4">' + statusLine + '</p>',
    '</div>',
    '<div style="padding:22px 24px;color:#0e1428;font-size:14px;line-height:1.6">',
    pillRow,
    '<p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6">' + escapeHtml(summary) + '</p>'
  );

  parts.push(isOpen ? datesChips(ipo) : listingChips(ipo));
  parts.push(factsChips(ipo));

  const detailUrl = site + '/ipo/' + ipo.id;
  parts.push(
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 20px">' +
    '<tr><td style="border-radius:12px;background:linear-gradient(135deg,#4f46e5,#7c3aed)">' +
    '<a href="' + escapeHtml(detailUrl) + '" style="display:inline-block;padding:13px 26px;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px">View the full analysis →</a>' +
    '</td></tr></table>',
    '<p style="margin:0 0 8px;font-size:12px;color:#8a94ad;line-height:1.5">You are receiving this because you subscribe to Mainboard IPO alerts on IPO India. ' +
    'This update is for information only and is not investment advice.</p>',
    '<p style="margin:0;font-size:12px;color:#8a94ad">To stop receiving these alerts, <a href="' + escapeHtml(unsubUrl) + '" style="color:#4f46e5">unsubscribe here</a>.</p>',
    '</div></div></div>'
  );

  const html = parts.join('');
  const text =
    summary + '\n\n' +
    keyFactsPlain(type, ipo) + '\n\n' +
    'Full analysis: ' + detailUrl + '\n' +
    'Unsubscribe: ' + unsubUrl;

  return { subject, html, text };
}

/** Plain-text mirror of the chips (the email's textContent version). */
function keyFactsPlain(type, ipo) {
  const d = ipo.detail || {};
  const lines = [];

  if (type === 'open') {
    if (ipo.openDate) lines.push('Opens: ' + fmtDate(ipo.openDate));
    if (ipo.closeDate) lines.push('Closes: ' + fmtDate(ipo.closeDate));
    if (ipo.listingDate) lines.push('Listing day: ' + fmtDate(ipo.listingDate));
  } else {
    const list = ipo.listing || {};
    const market = ipo.market || {};
    const price = list.openPrice ?? market.price ?? null;
    const gain = list.gainPct != null ? list.gainPct : ipo.listingGainPct;
    if (price != null) lines.push('Open price: ' + money(price) + (ipo.issuePrice != null ? ' (vs ' + money(ipo.issuePrice) + ' issue)' : ''));
    if (gain != null) lines.push('On listing: ' + (gain >= 0 ? '+' : '-') + fmt(Math.abs(gain)) + '%');
    if (ipo.subscriptionX != null) lines.push('Subscription: ' + fmt(ipo.subscriptionX) + '×');
  }

  const band = bandText(ipo);
  if (band) lines.push('Price band: ' + band);
  if (d.lotSize != null) lines.push('Lot size: ' + fmt(d.lotSize) + ' shares');
  const ticket = minTicket(ipo);
  if (ticket) lines.push('Minimum investment: ≈ ' + money(ticket.amount));
  if (ipo.issueAmountCr != null) lines.push('Issue size: ' + moneyCr(ipo.issueAmountCr));

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
