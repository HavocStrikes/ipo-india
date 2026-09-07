/**
 * Simple file-based subscriber store. Each subscriber is just an email +
 * optional preferences, appended to a JSONL file. No DB needed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data', 'subscribers.jsonl');

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readAll() {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  const lines = fs.readFileSync(DATA_FILE, 'utf-8').split('\n').filter(Boolean);
  return lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function addSubscriber(email, preferences = {}) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!isValidEmail(cleanEmail)) {
    const err = new Error('Invalid email address');
    err.code = 'INVALID_EMAIL';
    throw err;
  }
  ensureDir();
  const existing = readAll();
  if (existing.some((s) => s.email === cleanEmail)) {
    return { already: true, total: existing.length };
  }
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
  fs.appendFileSync(DATA_FILE, JSON.stringify(record) + '\n');
  return { already: false, total: existing.length + 1 };
}

function count() {
  return readAll().length;
}

function getAll() {
  return readAll();
}

/** Signed token for one-click unsubscribe links (email + server secret). */
function unsubscribeToken(email) {
  const SECRET = process.env.SUBSCRIBE_SECRET || 'ipo-india-local-secret';
  return crypto
    .createHash('sha256')
    .update(`${String(email || '').trim().toLowerCase()}|${SECRET}`)
    .digest('hex')
    .slice(0, 32);
}

/** Remove a subscriber (rewrites the JSONL store). */
function removeSubscriber(email) {
  const clean = String(email || '').trim().toLowerCase();
  ensureDir();
  const rows = readAll();
  const kept = rows.filter((r) => r.email !== clean);
  if (kept.length === rows.length) return { removed: false, total: rows.length };
  fs.writeFileSync(DATA_FILE, kept.length ? kept.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
  return { removed: true, total: kept.length };
}

module.exports = { addSubscriber, removeSubscriber, count, getAll, isValidEmail, unsubscribeToken };
