/**
 * Worker-port of lib/subscriptions.js — subscriber store backed by Workers KV
 * instead of a JSONL file (Workers have no filesystem).
 *
 * Layout in the DATA namespace:
 *   sub:<email>          -> one JSON record { email, preferences, subscribedAt }
 *   subs:index           -> JSON array of subscriber emails (for count + broadcast)
 *
 * The unsubscribe token is a SHA-256(email|secret) prefix computed with
 * WebCrypto (async — the Node version used node:crypto).
 */

const DEV_FALLBACK_SECRET = 'ipo-india-local-secret';

// Single-blob copy of all subscriber records. The alert/digest pipeline reads
// ONE KV key instead of one read per subscriber — that keeps cron runs well
// under the free-plan subrequest cap as the list grows. Maintained alongside
// the per-email keys + index on every add/remove; migrated lazily on read.
const RECORDS_KEY = 'subs:records';

async function readRecords(env) {
  const raw = await env.DATA.get(RECORDS_KEY);
  const arr = raw ? JSON.parse(raw) : null;
  return Array.isArray(arr) ? arr : null;
}

async function writeRecords(env, records) {
  await env.DATA.put(RECORDS_KEY, JSON.stringify(records));
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

async function unsubscribeToken(env, email) {
  const secret = env.SUBSCRIBE_SECRET || DEV_FALLBACK_SECRET;
  const data = new TextEncoder().encode(`${String(email || '').trim().toLowerCase()}|${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function readIndex(env) {
  const raw = await env.DATA.get('subs:index');
  const arr = raw ? JSON.parse(raw) : [];
  return Array.isArray(arr) ? arr : [];
}

/** Add a subscriber. Returns { already, total }. Throws INVALID_EMAIL on bad input. */
async function addSubscriber(env, email, preferences = {}) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!isValidEmail(cleanEmail)) {
    const err = new Error('Invalid email address');
    err.code = 'INVALID_EMAIL';
    throw err;
  }
  const existing = await env.DATA.get(`sub:${cleanEmail}`);
  const index = await readIndex(env);
  if (existing) return { already: true, total: index.length };

  const record = {
    email: cleanEmail,
    preferences: {
      upcoming: preferences.upcoming !== false,
      weeklyDigest: preferences.weeklyDigest !== false,
      analysis: preferences.analysis !== false,
      ...preferences,
    },
    subscribedAt: new Date().toISOString(),
  };
  await env.DATA.put(`sub:${cleanEmail}`, JSON.stringify(record));
  if (!index.includes(cleanEmail)) index.push(cleanEmail);
  await env.DATA.put('subs:index', JSON.stringify(index));
  const records = (await readRecords(env)) || [];
  const ri = records.findIndex((r) => r && r.email === cleanEmail);
  if (ri >= 0) records[ri] = record;
  else records.push(record);
  await writeRecords(env, records);
  return { already: false, total: index.length };
}

/** Remove a subscriber. Returns { removed, total }. */
async function removeSubscriber(env, email) {
  const clean = String(email || '').trim().toLowerCase();
  const index = await readIndex(env);
  const kept = index.filter((e) => e !== clean);
  if (kept.length === index.length) return { removed: false, total: index.length };
  await env.DATA.delete(`sub:${clean}`);
  await env.DATA.put('subs:index', JSON.stringify(kept));
  const records = (await readRecords(env)) || [];
  const filtered = records.filter((r) => r && r.email !== clean);
  if (filtered.length !== records.length) await writeRecords(env, filtered);
  return { removed: true, total: kept.length };
}

async function count(env) {
  return (await readIndex(env)).length;
}

/** All subscriber records (for broadcast tooling / future digest cron). */
async function getAll(env) {
  const index = await readIndex(env);
  const out = [];
  for (const email of index) {
    const raw = await env.DATA.get(`sub:${email}`);
    if (raw) {
      try {
        out.push(JSON.parse(raw));
      } catch {
        /* skip corrupt record */
      }
    }
  }
  return out;
}

/** All subscriber records from the blob store (lazily migrated from per-email keys). */
async function getAllRecords(env) {
  const records = await readRecords(env);
  if (records) return records;
  const rebuilt = await getAll(env);
  await writeRecords(env, rebuilt);
  return rebuilt;
}

export { addSubscriber, removeSubscriber, count, getAll, getAllRecords, isValidEmail, unsubscribeToken };
