/**
 * Unit tests for lib/fetcher.js politeness / ban-resilience logic.
 * Stubs global fetch — no network. Run: node test-fetcher.js
 */
const assert = require('assert');
const fetcher = require('./lib/fetcher');

let calls = [];
function stubFetch(handler) {
  calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
}
const jsonRes = (status, body = { reportTableData: [] }, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

const origErr = console.error;

(async () => {
  // 1. 404 fails fast: exactly one attempt, breaker untouched
  fetcher._resetBreakerForTests();
  stubFetch(() => jsonRes(404));
  await assert.rejects(() => fetcher.fetchJson('https://x.test/a', { retries: 2, backoffMs: 1 }));
  assert.strictEqual(calls.length, 1, '404 must not retry');
  assert.strictEqual(fetcher.upstreamState().inCooldown, false, '404 is not a block signal');

  // 2. 403 trips the breaker: no retry, then fail-fast without touching network
  fetcher._resetBreakerForTests();
  stubFetch(() => jsonRes(403, {}, { 'retry-after': '120' }));
  await assert.rejects(() => fetcher.fetchJson('https://x.test/b', { retries: 3, backoffMs: 1 }));
  assert.strictEqual(calls.length, 1, '403 must never be retried');
  const st = fetcher.upstreamState();
  assert.strictEqual(st.inCooldown, true, '403 opens a cooldown');
  assert.strictEqual(st.strikes, 1);
  assert.ok(
    new Date(st.cooldownUntil) - Date.now() >= 119 * 1000,
    'Retry-After (120s) must be honored'
  );
  await assert.rejects(
    () => fetcher.fetchJson('https://x.test/c', { backoffMs: 1 }),
    /cooldown/i,
    'calls during cooldown fail fast'
  );
  assert.strictEqual(calls.length, 1, 'cooldown must prevent network calls');

  // 3. 5xx retries gently, then succeeds; breaker stays closed
  fetcher._resetBreakerForTests();
  let n = 0;
  stubFetch(() => (++n < 3 ? jsonRes(500) : jsonRes(200, { ok: 1 })));
  const data = await fetcher.fetchJson('https://x.test/d', { retries: 2, backoffMs: 1 });
  assert.strictEqual(n, 3, '500s must be retried up to `retries`');
  assert.deepStrictEqual(data, { ok: 1 });
  assert.strictEqual(fetcher.upstreamState().inCooldown, false);

  // 4. noteOk (any 200) resets the breaker
  fetcher._resetBreakerForTests();
  fetcher.noteBan(0);
  assert.strictEqual(fetcher.upstreamState().inCooldown, true);
  fetcher.noteOk();
  assert.deepStrictEqual(fetcher.upstreamState(), {
    inCooldown: false,
    cooldownUntil: null,
    strikes: 0,
  });

  // 5. parallel block signals collapse into a single strike
  fetcher._resetBreakerForTests();
  stubFetch(() => jsonRes(429));
  await Promise.allSettled([
    fetcher.fetchJson('https://x.test/f1', { backoffMs: 1 }),
    fetcher.fetchJson('https://x.test/f2', { backoffMs: 1 }),
    fetcher.fetchJson('https://x.test/f3', { backoffMs: 1 }),
  ]);
  assert.strictEqual(fetcher.upstreamState().strikes, 1, 'parallel 429s = one strike');

  console.log('OK — fetcher politeness/ban-resilience tests passed');
  process.exit(0);
})().catch((err) => {
  console.error = origErr;
  console.error('FAIL test-fetcher:', err);
  process.exit(1);
});