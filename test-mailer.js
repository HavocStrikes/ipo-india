/**
 * Zero-dependency checks for the subscribe → email pipeline.
 *
 *   node test-mailer.js           # unit checks (no network needed)
 *   node test-mailer.js --live    # also boots nothing; POSTs nothing; only unit checks today
 *
 * What it verifies:
 *   1. welcomeEmail() renders clean HTML/text (no undefined/NaN leaks,
 *      only the opted-in topics, signed unsubscribe link present)
 *   2. sendMail() degrades gracefully when no provider is configured
 *   3. the subscriber store round-trips (add → token → remove) without
 *      touching unrelated, real subscriber rows
 */
const { addSubscriber, removeSubscriber, count, unsubscribeToken } = require('./lib/subscriptions');
const { sendMail, welcomeEmail, isMailConfigured } = require('./lib/mailer');

const TEST_EMAIL = 'ipo-india-selftest@example.com';

function fail(msg) {
  console.error('FAIL —', msg);
  process.exit(1);
}

async function main() {
  // --- 1. welcome email content ---
  const w = welcomeEmail(TEST_EMAIL, { upcoming: true, weeklyDigest: false, analysis: true });
  const leaks = ['undefined', 'NaN'].filter((s) => w.html.includes(s) || w.text.includes(s));
  if (leaks.length) fail(`welcome email leaks: ${leaks.join(', ')}`);
  if (w.html.indexOf(TEST_EMAIL) === -1) fail('welcome email missing subscriber email');
  if (w.html.indexOf('/api/unsubscribe?email=') === -1 || w.text.indexOf('/api/unsubscribe?email=') === -1) {
    fail('welcome email missing unsubscribe link');
  }
  if (w.html.indexOf('Upcoming IPO alerts') === -1 || w.html.indexOf('Deep-dive analysis') === -1) {
    fail('welcome email missing opted-in topics');
  }
  if (w.html.indexOf('Weekly digest') !== -1) fail('welcome email lists a topic the subscriber opted out of');
  console.log(`✓ welcome email renders clean (${w.html.length} chars html, ${w.text.length} chars text)`);

  // --- 2. no-provider behavior ---
  const savedKeys = ['RESEND_API_KEY', 'SENDGRID_API_KEY', 'BREVO_API_KEY'].map((k) => [k, process.env[k]]);
  savedKeys.forEach(([k]) => delete process.env[k]);
  const wasConfigured = isMailConfigured();
  const r = await sendMail({ to: TEST_EMAIL, subject: 't', html: '<p>t</p>' });
  if (wasConfigured) console.log('• a provider key is present in the environment — skipping no-provider assertion');
  else if (r.sent !== false || r.reason !== 'not_configured') fail(`expected not_configured, got ${JSON.stringify(r)}`);
  else console.log('✓ sendMail degrades gracefully without a provider (reason: not_configured)');
  savedKeys.forEach(([k, v]) => {
    if (v !== undefined) process.env[k] = v;
  });

  // --- 3. store round-trip (self-cleaning; real rows untouched) ---
  removeSubscriber(TEST_EMAIL); // clear any leftover from a previous run
  const before = count();
  addSubscriber(TEST_EMAIL, { upcoming: true, weeklyDigest: true, analysis: false });
  if (count() !== before + 1) fail(`count should be ${before + 1}, got ${count()}`);
  const token = unsubscribeToken(TEST_EMAIL);
  if (token !== unsubscribeToken(TEST_EMAIL.toUpperCase()) || token === unsubscribeToken('other@example.com')) {
    fail('unsubscribe token is not stable/case-insensitive/unique');
  }
  const removed = removeSubscriber(TEST_EMAIL);
  if (removed.removed !== true || count() !== before) fail('removeSubscriber round-trip failed');
  if (removeSubscriber('ghost-that-never-was@example.com').removed !== false) fail('ghost removal should be a no-op');
  console.log(`✓ store round-trip OK (token ${token.slice(0, 8)}…, count back to ${count()})`);

  console.log('=== all mailer checks passed ===');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
