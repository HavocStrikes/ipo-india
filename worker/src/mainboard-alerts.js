/**
 * Mainboard-only IPO alert pipeline.
 *
 * Runs from the cron hook in index.js after refreshData(). Every invocation:
 *   1. Merges current + previous year list summaries from KV (no upstream calls).
 *   2. Finds Mainboard IPOs that freshly opened or listed (date within the last
 *      day) whose IDs are NOT yet in the notified lists.
 *   3. Sends a branded score-analysis email to subscribers (Brevo), capped to a
 *      safe subrequest budget per run; once an IPO's emails all go out, its ID is
 *      recorded in KV so it never re-sends.
 *
 * Strictly category-filtered: SME / NSE Emerge / BSE SME issues are skipped
 * entirely so the daily Brevo quota is never spent on them.
 *
 * Subrequest budgeting: only Brevo HTTP calls count toward Cloudflare's 50/
 * invocation cap. KV ops are separate. We cap Brevo sends (SEND_BUDGET) and a
 * hard ceiling (MAX_SUBREQUESTS) and drip the rest out over later cron ticks —
 * the notified-lists guarantee no subscriber ever gets the same event twice.
 */

import { getAllRecords, unsubscribeToken } from './subscribers.js';
import { sendMail, providerName, isMailConfigured } from './mail.js';

// ---- tunables ----------------------------------------------------------------
const SEND_BUDGET = 10;     // Brevo calls per run (keeps us well under 50)
const MAX_SUBREQUESTS = 16; // hard ceiling; refreshData also uses some
const MAX_RETRY = 5;        // give up after this many failed sends per IPO event
const DAY = 86400000;

// ---- KV helpers (same shape as the rest of the worker) -----------------------
async function getJson(env, key) {
  const raw = await env.DATA.get(key);
  return raw ? JSON.parse(raw) : null;
}
async function putJson(env, key, value) {
  await env.DATA.put(key, JSON.stringify(value));
}

// ---- small formatting helpers -----------------------------------------------
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const money = (v) => (v == null ? '—' : `₹${Number(v).toLocaleString('en-IN')}`);
const cr = (v) => (v == null ? '—' : `₹${v} Cr`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${WDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const gainHtml = (pct) => {
  if (pct == null) return '<span style="color:#94a3b8">—</span>';
  const c = pct >= 0 ? '#22c55e' : '#ef4444';
  const sign = pct >= 0 ? '+' : '';
  return `<b style="color:${c}">${sign}${Number(pct).toFixed(1)}%</b>`;
};
const gainText = (pct) => (pct == null ? '—' : `${pct >= 0 ? '+' : ''}${Number(pct).toFixed(1)}%`);

// ---- main entry point --------------------------------------------------------
export async function runMainboardAlerts(env) {
  if (!isMailConfigured(env)) {
    return { sent: 0, reason: 'mail_not_configured', provider: providerName(env) };
  }

  const site = String(env.SITE_URL || 'https://ipo-india.ravi-ipodecode.workers.dev').replace(/\/+$/, '');
  const now = new Date();
  const yesterday = new Date(now.getTime() - DAY).toISOString().slice(0, 10);

  // 1. merge current + previous year summaries from KV
  const y = now.getUTCFullYear();
  const [cur, prev] = await Promise.all([getJson(env, `list:${y}`), getJson(env, `list:${y - 1}`)]);
  const byId = new Map();
  for (const list of [cur, prev]) {
    if (!list) continue;
    for (const s of list.ipos) {
      const e = byId.get(s.id);
      if (!e || (s.known || 0) > (e.known || 0)) byId.set(s.id, s);
    }
  }
  const ipos = [...byId.values()];

  // 2. notified lists (cold-start seeding below)
  let openNotified = await getJson(env, 'notified_open_ipos');
  let listedNotified = await getJson(env, 'notified_listed_ipos');

  // cold start: seed both lists so a fresh deploy never blasts history
  if (!openNotified || !openNotified.ids) {
    openNotified = { ids: ipos.filter((i) => i.status === 'open').map((i) => i.id), seededAt: now.toISOString(), retries: {} };
    await putJson(env, 'notified_open_ipos', openNotified);
  }
  if (!listedNotified || !listedNotified.ids) {
    listedNotified = {
      ids: ipos.filter((i) => i.status === 'listed' && i.listingDate && i.listingDate >= yesterday).map((i) => i.id),
      seededAt: now.toISOString(),
      retries: {},
    };
    await putJson(env, 'notified_listed_ipos', listedNotified);
  }
  const openSet = new Set(openNotified.ids || []);
  const listedSet = new Set(listedNotified.ids || []);
  const openRetries = openNotified.retries || {};
  const listedRetries = listedNotified.retries || {};

  // 3. collect fresh Mainboard-only events (recency-gated + dedup + retry limit)
  const events = [];
  for (const ipo of ipos) {
    if (String(ipo.category).toLowerCase() !== 'mainboard') continue; // STRICT filter
    if (!ipo.id) continue;
    if (ipo.status === 'open' && ipo.openDate && ipo.openDate >= yesterday && !openSet.has(ipo.id)) {
      if ((openRetries[ipo.id] || 0) >= MAX_RETRY) continue; // gave up after N failures
      events.push({ kind: 'open', ipo });
    } else if (ipo.status === 'listed' && ipo.listingDate && ipo.listingDate >= yesterday && !listedSet.has(ipo.id)) {
      if ((listedRetries[ipo.id] || 0) >= MAX_RETRY) continue;
      events.push({ kind: 'listed', ipo });
    }
  }

  if (!events.length) {
    return { sent: 0, events: 0, provider: providerName(env), budget: SEND_BUDGET };
  }

  // 4. subscribers whose preferences allow alerts
  const subs = await getAllRecords(env);
  const eligible = subs.filter((s) => {
    const p = s.preferences || {};
    return p.upcoming !== false && p.weeklyDigest !== false; // default-on for both
  });
  if (!eligible.length) {
    return { sent: 0, events: events.length, reason: 'no_subscribers', provider: providerName(env) };
  }

  // 5. precompute one unsubscribe URL per subscriber (Brevo call == subrequest)
  const unsubByEmail = new Map();
  for (const s of eligible) {
    const token = await unsubscribeToken(env, s.email);
    unsubByEmail.set(s.email, `${site}/api/unsubscribe?email=${encodeURIComponent(s.email)}&token=${token}`);
  }

  // 6. send, capped by budget; track which IPO events completed fully
  let sent = 0;
  let subrequests = 0;
  const newlyOpen = [];
  const newlyListed = [];
  const newOpenRetries = { ...openRetries };
  const newListedRetries = { ...listedRetries };

  for (const ev of events) {
    let eventComplete = true;
    const retries = ev.kind === 'open' ? newOpenRetries : newListedRetries;
    for (const sub of eligible) {
      if (subrequests >= MAX_SUBREQUESTS || sent >= SEND_BUDGET) {
        eventComplete = false;
        break;
      }
      const mail = buildEmail(ev.kind, ev.ipo, site, unsubByEmail.get(sub.email));
      const res = await sendMail(env, mail);
      subrequests++;
      if (res.sent) {
        sent++;
      } else {
        eventComplete = false; // retry this event next tick
        retries[ev.ipo.id] = (retries[ev.ipo.id] || 0) + 1;
        break;
      }
    }
    if (eventComplete) {
      if (ev.kind === 'open') newlyOpen.push(ev.ipo.id);
      else newlyListed.push(ev.ipo.id);
    } else if ((retries[ev.ipo.id] || 0) >= MAX_RETRY) {
      // gave up — mark as notified so we stop retrying, and log
      console.warn(`[mainboard-alerts] giving up on ${ev.kind}:${ev.ipo.id} after ${MAX_RETRY} failed sends`);
      if (ev.kind === 'open') newlyOpen.push(ev.ipo.id);
      else newlyListed.push(ev.ipo.id);
    }
  }

  // 7. persist notified IDs + retry counts
  if (newlyOpen.length || newOpenRetries !== openRetries) {
    openNotified.ids = [...new Set([...openSet, ...newlyOpen])];
    openNotified.retries = newOpenRetries;
    await putJson(env, 'notified_open_ipos', openNotified);
  }
  if (newlyListed.length || newListedRetries !== listedRetries) {
    listedNotified.ids = [...new Set([...listedSet, ...newlyListed])];
    listedNotified.retries = newListedRetries;
    await putJson(env, 'notified_listed_ipos', listedNotified);
  }

  return {
    sent,
    events: events.length,
    dispatched: { open: newlyOpen.length, listed: newlyListed.length },
    pending: events.length - newlyOpen.length - newlyListed.length,
    subscribers: eligible.length,
    provider: providerName(env),
    subrequests,
  };
}

// ---- ops snapshot (counts only, no PII) --------------------------------------
export async function mainboardAlertStatus(env) {
  const [openN, listedN, records] = await Promise.all([
    getJson(env, 'notified_open_ipos'),
    getJson(env, 'notified_listed_ipos'),
    getAllRecords(env).catch(() => null),
  ]);
  const openRetries = openN && openN.retries ? Object.values(openN.retries).filter((n) => n > 0 && n < MAX_RETRY).length : 0;
  const listedRetries = listedN && listedN.retries ? Object.values(listedN.retries).filter((n) => n > 0 && n < MAX_RETRY).length : 0;
  return {
    mailConfigured: isMailConfigured(env),
    provider: providerName(env),
    notifiedOpen: openN && openN.ids ? openN.ids.length : 0,
    notifiedListed: listedN && listedN.ids ? listedN.ids.length : 0,
    retrying: openRetries + listedRetries,
    subscribers: Array.isArray(records) ? records.length : null,
  };
}

// ---- email template ----------------------------------------------------------
// Dark fintech branding to match the website. Mobile-responsive, single-column.

const PILLAR_META = {
  demand: { label: 'Demand', max: 25 },
  fundamentals: { label: 'Fundamentals', max: 25 },
  valuation: { label: 'Valuation', max: 20 },
  performance: { label: 'Performance', max: 15 },
  sentiment: { label: 'Sentiment', max: 15 },
};

function pillarRows(pillars) {
  if (!pillars) return '';
  const order = ['demand', 'fundamentals', 'valuation', 'performance', 'sentiment'];
  return order
    .map((k) => {
      const p = pillars[k];
      const meta = PILLAR_META[k];
      if (!p) return '';
      const pct = meta.max > 0 ? Math.round((p.pts / meta.max) * 100) : 0;
      const bar = `<span style="display:block;height:6px;border-radius:3px;background:#1e293b;overflow:hidden"><span style="display:block;height:6px;width:${pct}%;border-radius:3px;background:linear-gradient(90deg,#6366f1,#8b5cf6)"></span></span>`;
      return `<tr>
        <td style="padding:8px 0;color:#cbd5e1;font-size:13px">${esc(meta.label)}</td>
        <td style="padding:8px 10px;width:54%;color:#0f172a">${bar}</td>
        <td style="padding:8px 0;text-align:right;color:#e2e8f0;font-size:13px;font-weight:bold">${Math.round(p.pts * 10) / 10}<span style="color:#64748b;font-weight:normal">/${meta.max}</span></td>
        <td style="padding:8px 0 8px 8px;color:#64748b;font-size:11px">${esc(p.note || '')}</td>
      </tr>`;
    })
    .join('');
}

function verdictTone(tone) {
  switch (tone) {
    case 'great': return ['#16a34a', '#bbf7d0'];
    case 'good': return ['#22c55e', '#dcfce7'];
    case 'neutral': return ['#d97706', '#fef3c7'];
    case 'weak': return ['#f97316', '#ffedd5'];
    case 'bad': return ['#ef4444', '#fee2e2'];
    default: return ['#6366f1', '#e0e7ff'];
  }
}

function shell(title, inner, unsubUrl) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0b0f1a;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:580px;margin:0 auto;padding:20px 12px">
  <div style="border-radius:18px;overflow:hidden;border:1px solid #1e293b;background:#111827">
    <div style="padding:26px 28px;background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 60%,#db2777 100%)">
      <div style="font-size:11px;letter-spacing:2.5px;color:#e0e7ff;font-weight:bold;text-transform:uppercase">IPO India</div>
      <h1 style="margin:8px 0 0;font-size:22px;line-height:1.3;color:#ffffff">${title}</h1>
    </div>
    <div style="padding:26px 28px;color:#e2e8f0;font-size:14px;line-height:1.65">
      ${inner}
      <p style="margin:24px 0 0;padding-top:18px;border-top:1px solid #1e293b;font-size:12px;color:#64748b">
        You received this because you subscribed to IPO India alerts.
        <a href="${esc(unsubUrl)}" style="color:#818cf8">Unsubscribe instantly</a>.
      </p>
    </div>
  </div>
  <p style="margin:14px 0 0;text-align:center;font-size:11px;color:#475569">© ${new Date().getFullYear()} IPO India · Price data from Chittorgarh</p>
</div>
</body></html>`;
}

function ctaBtn(href, label) {
  return `<a href="${esc(href)}" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 24px;border-radius:12px;font-size:14px">${esc(label)}</a>`;
}

function buildEmail(kind, ipo, site, unsubUrl) {
  const s = ipo.score || {};
  const pillars = s.pillars || {};
  const tone = verdictTone(s.tone);
  const detailUrl = `${site}/ipo/${ipo.id}`;
  const badge = `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:#1e293b;color:#e2e8f0;font-size:11px;font-weight:bold;letter-spacing:0.5px">MAINBOARD</span>`;

  // Price/lot: upstream exposes issuePrice + issueAmountCr but NOT price band or
  // lot size. Render what exists and point to the detail page for the rest.
  const priceBlock = `<table style="margin:0 0 18px;border-collapse:collapse">
    <tr><td style="padding:3px 18px 3px 0;color:#94a3b8;font-size:13px">Issue price</td><td style="padding:3px 0;font-size:14px;color:#f1f5f9;font-weight:bold">${money(ipo.issuePrice)}</td></tr>
    <tr><td style="padding:3px 18px 3px 0;color:#94a3b8;font-size:13px">Issue size</td><td style="padding:3px 0;font-size:14px;color:#f1f5f9;font-weight:bold">${cr(ipo.issueAmountCr)}</td></tr>
    <tr><td style="padding:3px 18px 3px 0;color:#94a3b8;font-size:13px">Closes</td><td style="padding:3px 0;font-size:14px;color:#f1f5f9;font-weight:bold">${fmtDate(ipo.closeDate)}</td></tr>
  </table>`;

  const scoreBlock = `<div style="margin:0 0 20px;padding:18px;border-radius:12px;background:#0b1220;border:1px solid #1e293b">
    <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:14px">
      <span style="font-size:36px;font-weight:bold;color:#ffffff;line-height:1">${s.score != null ? s.score : '—'}</span>
      <span style="font-size:13px;color:#64748b">/100</span>
      <span style="margin-left:auto;display:inline-block;padding:5px 14px;border-radius:8px;background:${tone[1]};color:${tone[0]};font-weight:bold;font-size:13px">${esc(s.verdict || '—')}</span>
    </div>
    <table style="width:100%;border-collapse:collapse">${pillarRows(pillars)}</table>
  </div>`;

  let title, heading, body;
  if (kind === 'open') {
    title = `${ipo.name} IPO is now OPEN — score ${s.score ?? '—'}/100`;
    heading = `${esc(ipo.name)} is open for bidding`;
    body =
      `<p style="margin:0 0 14px">${badge} <span style="color:#94a3b8;font-size:13px">Bidding is live · closes ${fmtDate(ipo.closeDate)}</span></p>` +
      scoreBlock +
      priceBlock +
      `<p style="margin:0 0 18px;color:#94a3b8;font-size:12px">Lot size &amp; price band details are on the issue page.</p>` +
      `<p style="margin:0 0 20px">${ctaBtn(detailUrl, 'View full analysis &amp; apply')}</p>` +
      `<p style="margin:0;color:#64748b;font-size:12px">Subscription, fundamentals, valuation and community sentiment — all in one page.</p>`;
  } else {
    const op = ipo.listing ? ipo.listing.openPrice : null;
    title = `${ipo.name} listed at ${gainText(ipo.listing && ipo.listing.gainPct)} — IPO India`;
    heading = `${esc(ipo.name)} listed today`;
    body =
      `<p style="margin:0 0 14px">${badge} <span style="color:#94a3b8;font-size:13px">Listed ${fmtDate(ipo.listingDate)}</span></p>` +
      `<p style="margin:0 0 16px;font-size:16px">Issued at ${money(ipo.issuePrice)} · listed at <b style="color:#f1f5f9">${op ? money(op) : '—'}</b> — ${gainHtml(ipo.listing && ipo.listing.gainPct)}</p>` +
      scoreBlock +
      `<p style="margin:0 0 20px">${ctaBtn(detailUrl, 'See the full breakdown')}</p>`;
  }

  const html = shell(heading, body, unsubUrl);

  // plain-text fallback
  const lines = [
    `IPO India — ${heading}`,
    '',
    `MAINBOARD · ${kind === 'open' ? 'Open for bidding' : 'Listed'}`,
    `Score: ${s.score ?? '—'}/100 · ${s.verdict || '—'}`,
    `Issue price: ${money(ipo.issuePrice)}`,
    `Issue size: ${cr(ipo.issueAmountCr)}`,
  ];
  if (kind === 'open') lines.push(`Closes: ${fmtDate(ipo.closeDate)}`);
  else lines.push(`Listed: ${fmtDate(ipo.listingDate)} at ${gainText(ipo.listing && ipo.listing.gainPct)}`);
  lines.push('', `Demand ${pillars.demand ? pillars.demand.pts : '—'}/25 · Fundamentals ${pillars.fundamentals ? pillars.fundamentals.pts : '—'}/25 · Valuation ${pillars.valuation ? pillars.valuation.pts : '—'}/20 · Performance ${pillars.performance ? pillars.performance.pts : '—'}/15 · Sentiment ${pillars.sentiment ? pillars.sentiment.pts : '—'}/15`);
  lines.push('', `Details: ${detailUrl}`, '', `Unsubscribe: ${unsubUrl}`);

  return { subject: title, html, text: lines.join('\n') };
}





