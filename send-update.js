/**
 * Broadcast an email to all subscribers — zero dependencies.
 *
 * First configure a provider (see README → "Email delivery"), then:
 *
 *   node send-update.js --dry-run                                      # preview recipients
 *   node send-update.js --subject "3 IPOs open now" --file mail.html   # HTML email
 *   node send-update.js --subject "Hello" --text "Plain update"        # text email
 *   node send-update.js --subject "Test" --text "Hi" --only you@x.com  # single test send
 *
 * Every email automatically carries a signed one-click unsubscribe link.
 */
const fs = require('fs');
const { getAll } = require('./lib/subscriptions');
const { sendMail, isMailConfigured, providerName, fromHeader } = require('./lib/mailer');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function main() {
  const dryRun = !!arg('dry-run');
  const only = arg('only');
  const subjectArg = arg('subject');
  const subject = typeof subjectArg === 'string' && subjectArg.trim() ? subjectArg.trim() : 'IPO India update';
  const file = typeof arg('file') === 'string' ? arg('file') : null;
  const textArg = arg('text');
  const text = typeof textArg === 'string' ? textArg : undefined;

  if (!isMailConfigured()) {
    console.error(
      '✗ Mailer not configured. Set RESEND_API_KEY / SENDGRID_API_KEY / BREVO_API_KEY + MAIL_FROM\n  (see README → "Email delivery"). Subscriptions are unaffected — only sending needs this.'
    );
    process.exit(1);
  }

  let html = null;
  if (file) {
    if (!fs.existsSync(file)) {
      console.error(`✗ File not found: ${file}`);
      process.exit(1);
    }
    html = fs.readFileSync(file, 'utf-8');
  }
  if (!dryRun && !html && typeof text !== 'string') {
    console.error('✗ Nothing to send — pass --file <html> or --text "..." (or use --dry-run to preview).');
    process.exit(1);
  }

  const subscribers = only ? [{ email: String(only).trim().toLowerCase() }] : getAll();
  console.log(
    `provider: ${providerName()} · from: ${fromHeader().email} · recipients: ${subscribers.length}${only ? ' (--only)' : ''}`
  );

  if (dryRun) {
    subscribers.slice(0, 10).forEach((s) => console.log(`  - ${s.email} (prefs: ${JSON.stringify(s.preferences || {})})`));
    if (subscribers.length > 10) console.log(`  … and ${subscribers.length - 10} more`);
    console.log(`subject: "${subject}" · body: ${html ? `file ${file}` : typeof text === 'string' ? 'text' : '(none)'}`);
    console.log('dry run — nothing was sent.');
    return;
  }

  let sent = 0;
  let failed = 0;
  for (const s of subscribers) {
    const r = await sendMail({ to: s.email, subject, html, text });
    if (r.sent) {
      sent++;
      console.log(`  ✓ ${s.email}`);
    } else {
      failed++;
      console.error(`  ✗ ${s.email} — ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
    }
    await new Promise((res) => setTimeout(res, 300)); // gentle pacing between sends
  }
  console.log(`done — sent: ${sent}, failed: ${failed}, total: ${subscribers.length}`);
  if (failed && !sent) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
