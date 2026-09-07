/**
 * IPO lifecycle alerts + weekly digest — the email pipeline for subscribers.
 *
 * Runs from the cron handler on ODD 10-minute slots only (minutes 10/30/50):
 * even slots carry the heavy deep-history upstream refresh, and the free plan
 * caps a single invocation at 50 subrequests (KV ops + email API calls both
 * count). Keeping alerts on odd slots leaves comfortable headroom.
 *
 * Per run (all KV reads — never scrapes upstream):
 *   1. Merge current + previous year summaries from KV.
 *   2. Diff each IPO's status against alerts:state.seen to find events:
 *        open     — status flipped to `open`   (openDate within the last day)
 *        closing  — closeDate is tomorrow      (one reminder per issue)
 *        listed   — status flipped to `listed` (listingDate within the last day)
 *        deep     — a NOTABLE watchlist IPO opened (analysis subscribers)
 *        digest   — first run of an ISO week with content (digest subscribers)
 *   3. Enqueue one email per (event × matching subscriber) into alerts:queue,
 *      recording event keys in state.sentKeys so nothing ever double-sends.
 *   4. Drip-send up to ALERT_SEND_BUDGET emails per run. Failures stay queued
 *      and retry on later runs; jobs are dropped after MAX_TRIES.
 *
 * Safety rails:
 *   - The very first run only initializes `seen` — a cold deploy never blasts
 *     599 historical IPOs at anyone, and events older than ~1 day are skipped.
 *   - With no mail provider configured nothing sends; events still flow, so
 *     turning a provider on later just works.
 *   - Every email carries a signed one-click unsubscribe link.
 */

import { getAllRecords, unsubscribeToken } from './subscribers.js';
import { isMailConfigured, sendMail } from './mail.js';
import { isNotableName as nameMatches } from './notable.js';

const STATE_KEY = 'alerts:state';
const QUEUE_KEY = 'alerts:queue';
const MAX_TRIES = 10;               // drop a job after this many failed sends
const SENT_TTL_MS = 45 * 86400000;  // prune sentKeys older than this
const DAY = 86400000;

// ---- tiny KV/JSON helpers (same semantics as index.js) ----------------------

async function getJson(env, key) {
  const raw = await env.DATA.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function putJson(env, key, value) {
  await env.DATA.put(key, JSON.stringify(value));
}

// ---- formatting helpers ------------------------------------------------------

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function fmtDate(iso) {
  if (!iso) return '—';
  if (iso instanceof Date) iso = isoDate(iso); // tolerate Date objects
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${WDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** ISO-8601 week key like `2026-W37` (Monday-based, UTC). */
function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon = 0
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // this week's Thursday
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((t.getTime() - firstThu.getTime()) / (7 * DAY));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function mondayOf(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return isoDate(t); // 'YYYY-MM-DD' — fmtDate expects an ISO string
}

function money(v) {
  if (v == null) return '—';
  let s;
  try { s = Number(v).toLocaleString('en-IN'); } catch { s = String(v); }
  return `₹${s}`;
}

function cr(v) {
  return v == null ? '—' : `₹${v} Cr`;
}

function gainHtml(pct) {
  if (pct == null) return '<span style="color:#8a94ad">—</span>';
  const c = pct >= 0 ? '#16a34a' : '#dc2626';
  const sign = pct >= 0 ? '+' : '';
  return `<b style="color:${c}">${sign}${Number(pct).toFixed(1)}%</b>`;
}

function gainText(pct) {
  if (pct == null) return '—';
  return `${pct >= 0 ? '+' : ''}${Number(pct).toFixed(1)}%`;
}

function scoreText(ipo) {
  const s = ipo && ipo.score;
  if (!s || (s.score == null && !s.verdict)) return '';
  return `score ${s.score != null ? s.score : '—'} · ${s.verdict || '—'}`;
}

function chipHtml(ipo) {
  const s = ipo && ipo.score;
  if (!s || (s.score == null && !s.verdict)) return '';
  const tone = s.tone === 'positive' ? '#16a34a' : s.tone === 'negative' ? '#dc2626' : '#b45309';
  return `<p style="margin:0 0 14px"><span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${tone}1a;color:${tone};font-weight:bold;font-size:12px">Score ${s.score != null ? s.score : '—'} · ${esc(s.verdict || '—')}</span></p>`;
}

function metaTable(rows) {
  const trs = rows
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#8a94ad;white-space:nowrap;font-size:13px">${k}</td><td style="padding:3px 0;font-size:13px;color:#0e1428;font-weight:bold">${v}</td></tr>`)
    .join('');
  return `<table style="margin:0 0 18px;border-collapse:collapse">${trs}</table>`;
}

function ctaBtn(href, label) {
  return `<a href="${esc(href)}" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:12px">${esc(label)}</a>`;
}

function kicker(text) {
  return `<p style="margin:0 0 12px;color:#6d28d9;font-size:12px;letter-spacing:1px;text-transform:uppercase;font-weight:bold">${text}</p>`;
}

/** Branded outer shell — same visual language as the welcome email. */
function shell(title, inner, unsubUrl) {
  return `<div style="margin:0;padding:24px;background:#f4f6fd;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:560px;margin:0 auto;border-radius:16px;overflow:hidden;border:1px solid #e6e9f7;background:#ffffff">
    <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:26px 28px;color:#ffffff">
      <div style="font-size:12px;letter-spacing:2px;opacity:.85;font-weight:bold">IPO INDIA</div>
      <h1 style="margin:8px 0 0;font-size:22px;line-height:1.3">${title}</h1>
    </div>
    <div style="padding:26px 28px;color:#0e1428;font-size:14px;line-height:1.65">
      ${inner}
      <p style="margin:22px 0 0;font-size:12px;color:#8a94ad">
        You receive this because you subscribed on IPO India.
        <a href="${esc(unsubUrl)}" style="color:#4f46e5">Unsubscribe instantly</a>.
      </p>
    </div>
  </div>
</div>`;
}

// ---- event emails -------------------------------------------------------------

function openEmail(ipo, site, unsubUrl) {
  const inner =
    kicker('Open for subscription') +
    chipHtml(ipo) +
    metaTable([
      ['Price band', ipo.issuePrice != null ? money(ipo.issuePrice) : null],
      ['Issue size', ipo.issueAmountCr != null ? cr(ipo.issueAmountCr) : null],
      ['Opens', fmtDate(ipo.openDate)],
      ['Closes', fmtDate(ipo.closeDate)],
    ]) +
    ctaBtn(`${site}/ipo/${ipo.id}`, 'View the full analysis');
  const sc = scoreText(ipo);
  const text = `${ipo.name} IPO is now OPEN.\n\nPrice band: ${ipo.issuePrice != null ? money(ipo.issuePrice) : '—'}\nIssue size: ${ipo.issueAmountCr != null ? cr(ipo.issueAmountCr) : '—'}\nOpens: ${fmtDate(ipo.openDate)}\nCloses: ${fmtDate(ipo.closeDate)}${sc ? `\nOur score: ${sc}` : ''}\n\nFull analysis: ${site}/ipo/${ipo.id}`;
  return {
    subject: `🔔 ${ipo.name} IPO is open — closes ${fmtDate(ipo.closeDate)}`,
    html: shell(`${esc(ipo.name)} is OPEN`, inner, unsubUrl),
    text,
  };
}

function closingEmail(ipo, site, unsubUrl) {
  const subRow = ipo.subscriptionX != null ? [['Subscribed', `${Number(ipo.subscriptionX).toFixed(1)}×`]] : [];
  const inner =
    kicker('Last chance — closes tomorrow') +
    chipHtml(ipo) +
    metaTable([
      ['Price band', ipo.issuePrice != null ? money(ipo.issuePrice) : null],
      ['Issue size', ipo.issueAmountCr != null ? cr(ipo.issueAmountCr) : null],
      ['Closes', fmtDate(ipo.closeDate)],
      ...subRow,
    ]) +
    ctaBtn(`${site}/ipo/${ipo.id}`, 'Review before you apply');
  const sc = scoreText(ipo);
  const text = `${ipo.name} closes tomorrow (${fmtDate(ipo.closeDate)}).${ipo.subscriptionX != null ? `\nSubscribed: ${Number(ipo.subscriptionX).toFixed(1)}× so far` : ''}${sc ? `\nOur score: ${sc}` : ''}\n\nReview before you apply: ${site}/ipo/${ipo.id}`;
  return {
    subject: `⏳ Tomorrow is the last day: ${ipo.name} IPO`,
    html: shell(`${esc(ipo.name)} closes tomorrow`, inner, unsubUrl),
    text,
  };
}

function listedEmail(ipo, site, unsubUrl) {
  const inner =
    kicker('Listing-day result') +
    `<p style="margin:0 0 14px;font-size:15px">${esc(ipo.name)} listed at ${ipo.marketPrice != null ? `<b>${money(ipo.marketPrice)}</b>` : '—'} vs issue ${ipo.issuePrice != null ? money(ipo.issuePrice) : '—'} — ${gainHtml(ipo.listingGainPct)}</p>` +
    chipHtml(ipo) +
    metaTable([
      ['Issue price', ipo.issuePrice != null ? money(ipo.issuePrice) : null],
      ['Listing price', ipo.marketPrice != null ? money(ipo.marketPrice) : null],
      ['Listed', fmtDate(ipo.listingDate)],
    ]) +
    ctaBtn(`${site}/ipo/${ipo.id}`, 'See how it did');
  const pct = ipo.listingGainPct != null ? gainText(ipo.listingGainPct) : '';
  const text = `${ipo.name} listed ${pct || 'today'}.\nIssue price: ${ipo.issuePrice != null ? money(ipo.issuePrice) : '—'}\nListing price: ${ipo.marketPrice != null ? money(ipo.marketPrice) : '—'}\n\nDetails: ${site}/ipo/${ipo.id}`;
  return {
    subject: `📊 ${ipo.name} listed ${pct}`.trim(),
    html: shell(`${esc(ipo.name)} listed ${ipo.listingGainPct != null ? gainHtml(ipo.listingGainPct) : ''}`, inner, unsubUrl),
    text,
  };
}

function deepDiveEmail(ipo, site, unsubUrl) {
  const inner =
    kicker('Deep dive · notable IPO') +
    chipHtml(ipo) +
    `<p style="margin:0 0 14px;color:#4a546e">This one is on our notable watchlist, so we pulled the deeper numbers for you:</p>` +
    metaTable([
      ['Price band', ipo.issuePrice != null ? money(ipo.issuePrice) : null],
      ['Issue size', ipo.issueAmountCr != null ? cr(ipo.issueAmountCr) : null],
      ['Opens', fmtDate(ipo.openDate)],
      ['Closes', fmtDate(ipo.closeDate)],
      ['P/E (post-issue)', ipo.pePost != null ? esc(String(ipo.pePost)) : null],
      ['RoNW', ipo.ronw != null ? `${esc(String(ipo.ronw))}%` : null],
    ]) +
    ctaBtn(`${site}/ipo/${ipo.id}`, 'Open the deep-dive');
  const text = `Deep dive: ${ipo.name} opened ${fmtDate(ipo.openDate)}.\nP/E (post-issue): ${ipo.pePost != null ? ipo.pePost : '—'}\nRoNW: ${ipo.ronw != null ? `${ipo.ronw}%` : '—'}\nPrice band: ${ipo.issuePrice != null ? money(ipo.issuePrice) : '—'}\n\nFull analysis: ${site}/ipo/${ipo.id}`;
  return {
    subject: `🔬 Deep dive: ${ipo.name} opened today`,
    html: shell(`${esc(ipo.name)} opened`, inner, unsubUrl),
    text,
  };
}

function digestEmail(content, site, unsubUrl) {
  const { weekLabel, listed, openNow, opening, best, worst } = content;
  const li = (name, right) =>
    `<p style="margin:0 0 6px"><b>${esc(name)}</b>${right ? ` — ${right}` : ''}</p>`;

  let inner = kicker(weekLabel);
  if (openNow.length) {
    inner += `<p style="margin:0 0 6px;color:#6d28d9;font-weight:bold">🟢 Open right now</p>`;
    inner += openNow.map((i) => li(i.name, `closes ${fmtDate(i.closeDate)}${scoreText(i) ? ` · ${scoreText(i)}` : ''}`)).join('');
  }
  if (opening.length) {
    inner += `<p style="margin:14px 0 6px;color:#6d28d9;font-weight:bold">🔜 Opening in the next 7 days</p>`;
    inner += opening.map((i) => li(i.name, `opens ${fmtDate(i.openDate)}${scoreText(i) ? ` · ${scoreText(i)}` : ''}`)).join('');
  }
  if (listed.length) {
    inner += `<p style="margin:14px 0 6px;color:#6d28d9;font-weight:bold">📊 Listed this week</p>`;
    inner += listed.map((i) => li(i.name, gainHtml(i.listingGainPct))).join('');
  }
  if (best) {
    const same = worst && worst.id === best.id;
    inner +=
      `<div style="margin:18px 0;padding:14px 16px;background:#f4f6fd;border-radius:12px">` +
      `<p style="margin:0">🏆 <b>Best score:</b> ${esc(best.name)} — ${scoreText(best)}` +
      (!same && worst ? `<br>🪨 <b>Weakest score:</b> ${esc(worst.name)} — ${scoreText(worst)}` : '') +
      `</p></div>`;
  }
  inner += ctaBtn(`${site}/`, 'Open the tracker');

  const lines = [`Weekly IPO scorecard — ${weekLabel}`, ''];
  if (openNow.length) {
    lines.push('OPEN RIGHT NOW');
    openNow.forEach((i) => lines.push(`- ${i.name} — closes ${fmtDate(i.closeDate)}${scoreText(i) ? ` · ${scoreText(i)}` : ''}`));
  }
  if (opening.length) {
    lines.push('', 'OPENING IN THE NEXT 7 DAYS');
    opening.forEach((i) => lines.push(`- ${i.name} — opens ${fmtDate(i.openDate)}${scoreText(i) ? ` · ${scoreText(i)}` : ''}`));
  }
  if (listed.length) {
    lines.push('', 'LISTED THIS WEEK');
    listed.forEach((i) => lines.push(`- ${i.name} — ${gainText(i.listingGainPct)}`));
  }
  if (best) {
    lines.push('', `Best score: ${best.name} — ${scoreText(best)}`);
    if (worst && worst.id !== best.id) lines.push(`Weakest score: ${worst.name} — ${scoreText(worst)}`);
  }
  lines.push('', `Open the tracker: ${site}/`);

  return {
    subject: `Your weekly IPO scorecard — ${weekLabel}`,
    html: shell('Weekly IPO scorecard', inner, unsubUrl),
    text: lines.join('\n'),
  };
}

/** Digest content from list summaries; null when there is nothing to report. */
function digestContent(ipos, now) {
  const t = isoDate(now);
  const weekAgo = isoDate(new Date(now.getTime() - 7 * DAY));
  const weekAhead = isoDate(new Date(now.getTime() + 7 * DAY));
  const listed = ipos
    .filter((i) => i.status === 'listed' && i.listingDate && i.listingDate >= weekAgo && i.listingDate <= t)
    .sort((a, b) => (b.listingGainPct ?? -1e9) - (a.listingGainPct ?? -1e9));
  const openNow = ipos
    .filter((i) => i.status === 'open')
    .sort((a, b) => (a.closeDate || '9999').localeCompare(b.closeDate || '9999'));
  const opening = ipos
    .filter((i) => i.status === 'upcoming' && i.openDate && i.openDate > t && i.openDate <= weekAhead)
    .sort((a, b) => (a.openDate || '9999').localeCompare(b.openDate || '9999'));
  const scored = [...openNow, ...opening].filter((i) => i.score && i.score.score != null);
  const best = scored.length ? scored.reduce((a, b) => (b.score.score > a.score.score ? b : a)) : null;
  const worst = scored.length ? scored.reduce((a, b) => (b.score.score < a.score.score ? b : a)) : null;
  if (!listed.length && !openNow.length && !opening.length) return null;
  return { weekLabel: `Week of ${fmtDate(mondayOf(now))}`, listed, openNow, opening, best, worst };
}

// ---- event engine -------------------------------------------------------------

function buildJob(ev, email, unsubUrl, site) {
  let mail = null;
  if (ev.type === 'open') mail = openEmail(ev.ipo, site, unsubUrl);
  else if (ev.type === 'closing') mail = closingEmail(ev.ipo, site, unsubUrl);
  else if (ev.type === 'listed') mail = listedEmail(ev.ipo, site, unsubUrl);
  else if (ev.type === 'deep') mail = deepDiveEmail(ev.ipo, site, unsubUrl);
  else if (ev.type === 'digest') mail = digestEmail(ev.content, site, unsubUrl);
  if (!mail) return null;
  return { key: ev.key, to: email, subject: mail.subject, html: mail.html, text: mail.text, tries: 0 };
}

/**
 * Run one alert pass. Called from the cron handler on odd 10-minute slots
 * (see index.js). Returns stats for logging and the /api/alerts/status view.
 */
export async function runAlerts(env) {
  const now = new Date();
  const yesterday = isoDate(new Date(now.getTime() - DAY));
  const tomorrow = isoDate(new Date(now.getTime() + DAY));
  const site = String(env.SITE_URL || 'https://ipo-india.ravi-ipodecode.workers.dev').replace(/\/+$/, '');

  // 1. merged summaries (KV reads only — never scrape here)
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

  // 2. first run: snapshot statuses silently (no cold-start email blast)
  const state = await getJson(env, STATE_KEY);
  if (!state || !state.seen) {
    const seen = {};
    for (const i of ipos) seen[i.id] = i.status;
    await putJson(env, STATE_KEY, {
      v: 1,
      initializedAt: now.toISOString(),
      lastRunAt: now.toISOString(),
      seen,
      sentKeys: {},
    });
    return { initialized: true, tracked: ipos.length };
  }

  const seen = state.seen;
  const sentKeys = state.sentKeys || {};
  for (const k of Object.keys(sentKeys)) {
    if (now.getTime() - sentKeys[k] > SENT_TTL_MS) delete sentKeys[k];
  }

    // 3. lifecycle diff -> events
  const fresh = (iso) => !!iso && iso >= yesterday; // today or yesterday only
  const events = [];
  for (const ipo of ipos) {
    const before = seen[ipo.id];
    const after = ipo.status;
    if (after !== before) {
      if (after === 'open' && fresh(ipo.openDate)) {
        events.push({ key: `open:${ipo.id}:${ipo.openDate}`, type: 'open', ipo });
      }
      if (after === 'listed' && fresh(ipo.listingDate)) {
        events.push({ key: `listed:${ipo.id}:${ipo.listingDate}`, type: 'listed', ipo });
      }
    }
    if (after === 'open' && ipo.closeDate === tomorrow) {
      events.push({ key: `closing:${ipo.id}:${ipo.closeDate}`, type: 'closing', ipo });
    }
    if (after === 'open' && fresh(ipo.openDate) && nameMatches(ipo.name)) {
      events.push({ key: `deep:${ipo.id}:${ipo.openDate}`, type: 'deep', ipo });
    }
    seen[ipo.id] = after;
  }

  // 4. weekly digest (first run of a week that has any content)
  const weekKey = isoWeekKey(now);
  if (!sentKeys[`digest:${weekKey}`]) {
    const content = digestContent(ipos, now);
    if (content) events.push({ key: `digest:${weekKey}`, type: 'digest', content });
  }

  // 5. enqueue one job per (event × matching subscriber)
  const subs = await getAllRecords(env);
  const unsubUrls = new Map();
  for (const sub of subs) {
    const token = await unsubscribeToken(env, sub.email);
    unsubUrls.set(sub.email, `${site}/api/unsubscribe?email=${encodeURIComponent(sub.email)}&token=${token}`);
  }
  const queue = (await getJson(env, QUEUE_KEY)) || [];
  const inQueue = new Set(queue.map((j) => `${j.key}|${j.to}`));
  let enqueued = 0;
  for (const ev of events) {
    if (sentKeys[ev.key]) continue;
    sentKeys[ev.key] = now.getTime(); // marked even with 0 recipients — no re-checks
    for (const sub of subs) {
      const prefs = sub.preferences || {};
      const wants =
        ev.type === 'digest'
          ? prefs.weeklyDigest !== false
          : ev.type === 'deep'
            ? prefs.analysis !== false
            : prefs.upcoming !== false; // open / closing / listed
      if (!wants) continue;
      const job = buildJob(ev, sub.email, unsubUrls.get(sub.email), site);
      if (!job) continue;
      const jk = `${job.key}|${job.to}`;
      if (inQueue.has(jk)) continue;
      inQueue.add(jk);
      queue.push(job);
      enqueued++;
    }
  }

  // 6. drip-send (failures stay queued with tries++; poison jobs are dropped)
  let sent = 0, failed = 0, dropped = 0, queueLeft = queue.length;
  if (isMailConfigured(env) && queue.length) {
    const budget = Math.max(1, Number(env.ALERT_SEND_BUDGET || 10));
    const retry = [];
    for (const job of queue.slice(0, budget)) {
      const res = await sendMail(env, job);
      if (res.sent) { sent++; continue; }
      if ((job.tries || 0) + 1 >= MAX_TRIES) { dropped++; continue; }
      job.tries = (job.tries || 0) + 1;
      retry.push(job);
      failed++;
    }
    const remaining = [...retry, ...queue.slice(budget)];
    queueLeft = remaining.length;
    await putJson(env, QUEUE_KEY, remaining);
  } else if (enqueued > 0) {
    // no provider configured yet — persist the backlog so turning one on later works
    await putJson(env, QUEUE_KEY, queue);
  }

  // 7. persist state
  state.v = 1;
  state.lastRunAt = now.toISOString();
  state.seen = seen;
  state.sentKeys = sentKeys;
  await putJson(env, STATE_KEY, state);

  return { initialized: false, events: events.length, enqueued, sent, failed, dropped, queueLeft, subscribers: subs.length };
}

/** Ops snapshot for GET /api/alerts/status (counts only — no PII). */
export async function alertStatus(env) {
  const [state, queue, records] = await Promise.all([
    getJson(env, STATE_KEY),
    getJson(env, QUEUE_KEY),
    getAllRecords(env).catch(() => null),
  ]);
  return {
    initialized: !!(state && state.seen),
    lastRunAt: state ? state.lastRunAt : null,
    trackedIpos: state && state.seen ? Object.keys(state.seen).length : 0,
    sentEvents: state && state.sentKeys ? Object.keys(state.sentKeys).length : 0,
    queuedEmails: Array.isArray(queue) ? queue.length : 0,
    subscribers: Array.isArray(records) ? records.length : null,
  };
}
