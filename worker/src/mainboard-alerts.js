/**
 * Mainboard IPO Alert Pipeline
 *
 * Watches for Mainboard IPOs transitioning to 'open' or 'listed' and sends
 * score-analysis emails via Brevo. Completely ignores SME / NSE Emerge / BSE SME.
 */
import { getAllRecords, unsubscribeToken } from './subscribers.js';
import { sendMail, isMailConfigured, providerName } from './mail.js';

const OPEN_KEY = 'notified_open_ipos';
const LISTED_KEY = 'notified_listed_ipos';

async function getJson(env, key) {
  const raw = await env.DATA.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function putJson(env, key, value) {
  await env.DATA.put(key, JSON.stringify(value));
}

function isMainboard(ipo) {
  return String(ipo.category || '').toLowerCase() === 'mainboard';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatMoney(v) {
  if (v == null) return '—';
  try { return '₹' + Number(v).toLocaleString('en-IN'); }
  catch { return '₹' + String(v); }
}

function pillarBar(name, score, max) {
  const pct = Math.max(0, Math.min(100, (score / max) * 100));
  const color = pct >= 70 ? '#16a34a' : pct >= 40 ? '#f59e0b' : '#dc2626';
  return '<tr style="vertical-align:middle"><td style="padding:4px 12px 4px 0;font-size:13px;color:#4a546e;white-space:nowrap">' + name + '</td><td style="padding:4px 0;font-size:13px;font-weight:bold;color:' + color + '">' + score + ' / ' + max + '</td></tr>';
}

function buildEmail(type, ipo, site, unsubUrl) {
  const score = ipo.score || {};
  const pillars = score.pillars || {};
  const verdict = score.verdict || '—';
  const scoreVal = score.score != null ? score.score : '—';
  const kpi = ipo.kpi || {};
  const listing = ipo.listing || {};
  const verdictColor = verdict.includes('Buy') ? '#16a34a' : verdict.includes('Apply') ? '#0ea5e9' : verdict.includes('Hold') ? '#f59e0b' : '#dc2626';
  let title, heading, extra;
  if (type === 'open') {
    title = ipo.name + ' IPO is OPEN';
    heading = escapeHtml(ipo.name) + ' is now open for bidding';
    extra = '<p style="margin:0 0 14px;color:#4a546e">Bidding is live — review the score below before applying.</p>';
  } else {
    title = ipo.name + ' IPO has LISTED';
    heading = escapeHtml(ipo.name) + ' listed today';
    const gain = listing.gainPct != null ? (listing.gainPct >= 0 ? '+' : '') + listing.gainPct.toFixed(1) + '%' : '—';
    const gc = listing.gainPct >= 0 ? '#16a34a' : '#dc2626';
    extra = '<p style="margin:0 0 14px;font-size:15px">Listed at <strong>' + formatMoney(listing.openPrice) + '</strong> vs issue ' + formatMoney(ipo.issuePrice) + ' — <strong style="color:' + gc + '">' + gain + '</strong></p>';
  }
  const pTable = pillarBar('Demand', pillars.demand || 0, 25) + pillarBar('Fundamentals', pillars.fundamentals || 0, 25) + pillarBar('Valuation', pillars.valuation || 0, 20) + pillarBar('Performance', pillars.performance || 0, 15) + pillarBar('Sentiment', pillars.sentiment || 0, 15);
  return '<div style="margin:0;padding:24px;background:#0f172a;font-family:Arial,Helvetica,sans-serif">'
    + '<div style="max-width:560px;margin:0 auto;border-radius:16px;overflow:hidden;border:1px solid #1e293b;background:#ffffff">'
    + '<div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:26px 28px;color:#ffffff">'
    + '<div style="font-size:12px;letter-spacing:2px;opacity:.85;font-weight:bold">IPO INDIA · MAINBOARD ALERT</div>'
    + '<h1 style="margin:8px 0 0;font-size:22px;line-height:1.3">' + title + '</h1>'
    + '</div>'
    + '<div style="padding:26px 28px;color:#0e1428;font-size:14px;line-height:1.65">'
    + '<p style="margin:0 0 6px"><span style="display:inline-block;padding:3px 10px;border-radius:999px;background:#eef2ff;color:#4338ca;font-weight:bold;font-size:11px;letter-spacing:1px">MAINBOARD</span></p>'
    + '<h2 style="margin:10px 0 12px;font-size:20px">' + heading + '</h2>'
    + extra
    + '<p style="margin:0 0 4px"><strong>Price band:</strong> ' + formatMoney(ipo.issuePrice) + '</p>'
    + '<p style="margin:0 0 14px"><strong>Issue size:</strong> ' + formatMoney(ipo.issueAmountCr) + ' Cr</p>'
    + '<div style="margin:0 0 18px;padding:16px;background:#f4f6fd;border-radius:12px">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#4a546e">Investability Score</p>'
    + '<p style="margin:0 0 10px;font-size:32px;font-weight:bold;line-height:1;color:' + verdictColor + '">' + scoreVal + '<span style="font-size:16px;color:#8a94ad"> / 100</span></p>'
    + '<p style="margin:0;font-size:14px;font-weight:bold;color:' + verdictColor + '">' + escapeHtml(verdict) + '</p>'
    + '</div>'
    + '<table style="margin:0 0 18px;border-collapse:collapse">' + pTable + '</table>'
    + '<p style="margin:0 0 6px;font-size:13px;color:#4a546e">Key Metrics</p>'
    + '<p style="margin:0 0 4px;font-size:13px"><strong>P/E (post-issue):</strong> ' + (kpi.pePost != null ? kpi.pePost : '—') + '</p>'
    + '<p style="margin:0 0 4px;font-size:13px"><strong>RoNW:</strong> ' + (kpi.ronw != null ? kpi.ronw + '%' : '—') + '</p>'
    + '<p style="margin:0 0 18px;font-size:13px"><strong>EPS (pre-IPO):</strong> ' + (kpi.epsPre != null ? '₹' + kpi.epsPre : '—') + '</p>'
    + '<a href="' + escapeHtml(site + '/ipo/' + ipo.id) + '" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:12px">View Full Analysis</a>'
    + '<p style="margin:22px 0 0;font-size:12px;color:#8a94ad">You receive this for subscribing to Mainboard IPO alerts on IPO India. <a href="' + escapeHtml(unsubUrl) + '" style="color:#4f46e5">Unsubscribe instantly</a>.</p>'
    + '</div></div>';
}

export async function runMainboardAlerts(env) {
  if (!isMailConfigured(env)) return { reason: 'no_provider', provider: providerName(env) };
  const subs = await getAllRecords(env);
  if (!subs.length) return { reason: 'no_subscribers' };
  const site = String(env.SITE_URL || 'https://ipo-india.ravi-ipodecode.workers.dev').replace(/\/+$/, '');
  const y = new Date().getUTCFullYear();
  const [cur, prev] = await Promise.all([getJson(env, 'list:' + y), getJson(env, 'list:' + (y - 1))]);
  const byId = new Map();
  for (const list of [cur, prev]) {
    if (!list) continue;
    for (const s of list.ipos) {
      const e = byId.get(s.id);
      if (!e || (s.known || 0) > (e.known || 0)) byId.set(s.id, s);
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
  const events = [];
  for (const ipo of ipos) {
    if (ipo.status === 'open' && fresh(ipo.openDate) && !openSet.has(ipo.id)) events.push({ type: 'open', ipo });
    else if (ipo.status === 'listed' && fresh(ipo.listingDate) && !listedSet.has(ipo.id)) events.push({ type: 'listed', ipo });
  }
  if (!events.length) return { events: 0, sent: 0 };
  const unsubUrls = new Map();
  for (const sub of subs) {
    const token = await unsubscribeToken(env, sub.email);
    unsubUrls.set(sub.email, site + '/api/unsubscribe?email=' + encodeURIComponent(sub.email) + '&token=' + token);
  }
  let sent = 0, failed = 0;
  // pace to stay well under the 50-subrequest cron cap: KV reads (~6) + emails
  const budget = Math.min(8, Math.max(1, Math.floor(40 / Math.max(1, subs.length))));
  const newOpenIds = [], newListedIds = [];
  for (const ev of events) {
    let evSent = 0;
    for (const sub of subs) {
      if (sent + failed >= budget) break; // budget exhausted — remaining events retry next run
      const html = buildEmail(ev.type, ev.ipo, site, unsubUrls.get(sub.email));
      const subject = ev.type === 'open' ? '📡 ' + ev.ipo.name + ' IPO is OPEN — Score Analysis' : '📊 ' + ev.ipo.name + ' LISTED Today — Result';
      const res = await sendMail(env, { to: sub.email, subject, html, text: ev.ipo.name + (ev.type === 'open' ? ' IPO open' : ' listed') + '. View: ' + site + '/ipo/' + ev.ipo.id });
      if (res.sent) { sent++; evSent++; } else failed++;
    }
    // Only mark as notified once at least one email dispatched successfully (req #6).
    // If all sends failed, the event stays unnotified and retries on the next cron.
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
