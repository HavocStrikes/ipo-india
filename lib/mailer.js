/**
 * Zero-dependency email sending over HTTP APIs (no SMTP library needed).
 *
 * Pick ONE provider via env vars:
 *   RESEND_API_KEY    — resend.com    (simplest to set up)
 *   SENDGRID_API_KEY  — sendgrid.com
 *   BREVO_API_KEY     — brevo.com
 * plus:
 *   MAIL_FROM         — "no-reply@yourdomain.com" or "IPO India <no-reply@yourdomain.com>"
 *                       (must be a sender/domain verified with the provider)
 *   MAIL_FROM_NAME    — optional display name (default "IPO India")
 *   SITE_URL          — public base URL used in links (default http://localhost:8787)
 *   SUBSCRIBE_SECRET  — signs one-click unsubscribe links (see lib/subscriptions.js)
 *
 * With no API key configured the app still runs; sendMail() simply reports
 * { sent: false, reason: 'not_configured' } and subscriptions keep working.
 */
const { unsubscribeToken } = require('./subscriptions');

const MAIL_TIMEOUT_MS = 8000;

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function fromHeader() {
  const raw = String(process.env.MAIL_FROM || '').trim();
  const m = raw.match(/^(.*?)\s*<\s*([^>]+)\s*>$/); // "Name <addr>"
  if (m) {
    return {
      name: m[1].trim().replace(/^"|"$/g, '') || process.env.MAIL_FROM_NAME || 'IPO India',
      email: m[2].trim(),
    };
  }
  return { name: process.env.MAIL_FROM_NAME || 'IPO India', email: raw };
}

function provider() {
  if (process.env.RESEND_API_KEY) return { name: 'resend', key: process.env.RESEND_API_KEY };
  if (process.env.SENDGRID_API_KEY) return { name: 'sendgrid', key: process.env.SENDGRID_API_KEY };
  if (process.env.BREVO_API_KEY) return { name: 'brevo', key: process.env.BREVO_API_KEY };
  return null;
}

function isMailConfigured() {
  const p = provider();
  return !!(p && fromHeader().email);
}

function providerName() {
  const p = provider();
  return p ? p.name : 'none';
}

/** Send one email. Never throws — returns { sent, provider?, reason?, detail? }. */
async function sendMail({ to, subject, html, text }) {
  const prov = provider();
  const from = fromHeader();
  if (!prov) return { sent: false, reason: 'not_configured' };
  if (!from.email) return { sent: false, reason: 'missing_mail_from' };

  let url;
  let init;
  if (prov.name === 'resend') {
    url = 'https://api.resend.com/emails';
    init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${prov.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: from.name ? `${from.name} <${from.email}>` : from.email,
        to: [to],
        subject,
        html,
        text,
      }),
    };
  } else if (prov.name === 'sendgrid') {
    url = 'https://api.sendgrid.com/v3/mail/send';
    init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${prov.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from.email, name: from.name },
        subject,
        content: [
          ...(text ? [{ type: 'text/plain', value: text }] : []),
          ...(html ? [{ type: 'text/html', value: html }] : []),
        ],
      }),
    };
  } else {
    url = 'https://api.brevo.com/v3/smtp/email';
    init = {
      method: 'POST',
      headers: { 'api-key': prov.key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: from.email, name: from.name },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
    };
  }

  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(MAIL_TIMEOUT_MS) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, reason: `http_${res.status}`, detail: body.slice(0, 300) };
    }
    return { sent: true, provider: prov.name };
  } catch (err) {
    return { sent: false, reason: 'network_error', detail: String((err && err.message) || err).slice(0, 200) };
  }
}

const PREF_LABELS = {
  upcoming: 'Upcoming IPO alerts',
  weeklyDigest: 'Weekly digest of the best & worst scores',
  analysis: 'Deep-dive analysis of notable issues',
};

/** Branded "you're signed up" confirmation email. Returns { subject, html, text }. */
function welcomeEmail(email, preferences = {}) {
  const site = String(process.env.SITE_URL || 'http://localhost:8787').replace(/\/+$/, '');
  const chosen = Object.keys(PREF_LABELS).filter((k) => preferences[k] !== false);
  const keys = chosen.length ? chosen : Object.keys(PREF_LABELS);
  const htmlItems = keys.map((k) => `<li style="margin:4px 0">${PREF_LABELS[k]}</li>`).join('');
  const textList = keys.map((k) => `• ${PREF_LABELS[k]}`).join('\n');
  const unsubUrl = `${site}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`;

  const html = `<div style="margin:0;padding:24px;background:#f4f6fd;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:560px;margin:0 auto;border-radius:16px;overflow:hidden;border:1px solid #e6e9f7;background:#ffffff">
    <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:26px 28px;color:#ffffff">
      <div style="font-size:12px;letter-spacing:2px;opacity:.85;font-weight:bold">IPO INDIA</div>
      <h1 style="margin:8px 0 0;font-size:22px;line-height:1.3">You&rsquo;re signed up &#127881;</h1>
    </div>
    <div style="padding:26px 28px;color:#0e1428;font-size:14px;line-height:1.65">
      <p style="margin:0 0 12px">Hi — thanks for subscribing with <b>${esc(email)}</b>.</p>
      <p style="margin:0 0 8px">Here&rsquo;s what you&rsquo;ll hear about:</p>
      <ul style="margin:0 0 16px;padding-left:20px">${htmlItems}</ul>
      <p style="margin:0 0 18px">Meanwhile, see what&rsquo;s open, upcoming and freshly listed right now:</p>
      <a href="${esc(site)}/" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:12px">Open the IPO tracker</a>
      <p style="margin:22px 0 0;font-size:12px;color:#8a94ad">
        You received this because of a subscription on IPO India. Not you?
        <a href="${esc(unsubUrl)}" style="color:#4f46e5">Unsubscribe instantly</a>.
      </p>
    </div>
  </div>
</div>`;

  const text = `You're signed up for IPO India!\n\nSubscription: ${email}\n\nWhat you'll get:\n${textList}\n\nOpen the tracker: ${site}\n\nUnsubscribe: ${unsubUrl}`;

  return { subject: "You're signed up — IPO India", html, text };
}

module.exports = { sendMail, welcomeEmail, isMailConfigured, providerName, fromHeader };
