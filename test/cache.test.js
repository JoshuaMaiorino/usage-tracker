import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageCache, MIN_REFRESH_INTERVAL_MS } from '../lib/cache.js';

const START = Date.parse('2026-09-08T12:00:00Z');
const reading = (usedPercent = 25) => ({
  plan: 'Synthetic plan', windows: [{ id: 'session', label: 'Session', usedPercent, resetsAt: '2026-09-08T17:00:00.000Z' }], extras: [],
});
function harness(providers, intervalMs = 180_000, options = {}) {
  let current = START;
  const cache = new UsageCache({ providers, intervalMs, now: () => current, random: () => 0.5, ...options });
  return { cache, advance: (milliseconds) => { current += milliseconds; } };
}

test('only enabled providers run; order is fixed and readers never fetch', async () => {
  const calls = [];
  const { cache } = harness({ grok: async () => { calls.push('grok'); return reading(); }, claude: async () => { calls.push('claude'); return reading(); }, chatgpt: async () => { calls.push('chatgpt'); return reading(); } });
  await cache.setEnabled(['grok', 'claude']);
  assert.deepEqual(cache.snapshot().map((row) => row.id), ['claude', 'grok']);
  assert.equal(cache.snapshot()[0].status, 'loading');
  assert.deepEqual(calls, []);
  await cache.refresh();
  cache.snapshot();
  cache.snapshot();
  assert.deepEqual(calls, ['claude', 'grok']);
  assert.equal(cache.snapshot()[0].status, 'ok');
  assert.equal(cache.snapshot()[0].lastSuccessAt, '2026-09-08T12:00:00.000Z');
  assert.equal(cache.snapshot()[0].loginCommand, 'claude auth login');
});

test('first refresh includes every provider when the clock advances between decisions', async () => {
  let current = START;
  const calls = [];
  const providers = Object.fromEntries(['claude', 'chatgpt', 'grok'].map(id => [id, async () => {
    calls.push(id);
    return reading();
  }]));
  const cache = new UsageCache({ providers, now: () => current++ });
  await cache.setEnabled(['claude', 'chatgpt', 'grok']);
  await cache.refresh({ force: true });
  assert.deepEqual(calls, ['claude', 'chatgpt', 'grok']);
  assert.ok(cache.snapshot().every(provider => provider.status === 'ok'));
});

test('manual refresh obeys the two minute floor while auto refresh uses settings', async () => {
  let calls = 0;
  const { cache, advance } = harness({ claude: async () => { calls += 1; return reading(); } });
  await cache.setEnabled(['claude']);
  await cache.refresh();
  advance(MIN_REFRESH_INTERVAL_MS - 1);
  const denied = await cache.refresh({ force: true });
  assert.equal(denied.refreshed, false);
  assert.equal(denied.suppressed, true);
  assert.equal(denied.nextAllowedAt, '2026-09-08T12:02:00.000Z');
  assert.equal(cache.snapshot()[0].lastSuccessAt, '2026-09-08T12:00:00.000Z');
  advance(1);
  assert.equal((await cache.refresh()).refreshed, false);
  assert.equal((await cache.refresh({ force: true })).refreshed, true);
  assert.equal(calls, 2);
});

test('concurrent viewers share one in-flight request per provider', async () => {
  let complete;
  let calls = 0;
  const { cache } = harness({ claude: () => { calls += 1; return new Promise((resolve) => { complete = resolve; }); } });
  await cache.setEnabled(['claude']);
  const first = cache.refresh();
  const second = cache.refresh({ force: true });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(cache.snapshot()[0].refreshing, true);
  complete(reading());
  const results = await Promise.all([first, second]);
  assert.equal(results[0].refreshed, true);
  assert.equal(results[1].refreshed, false);
  assert.equal(cache.snapshot()[0].refreshing, false);
});

test('failure keeps last-good meters, original success time, and a sanitized error', async () => {
  let fail = false;
  const { cache, advance } = harness({ claude: async () => {
    if (fail) throw Object.assign(new Error('Bearer SYNTHETIC_SECRET'), { code: 'format' });
    return { ...reading(95), access_token: 'SYNTHETIC_SECRET' };
  } });
  await cache.setEnabled(['claude']);
  await cache.refresh();
  advance(180_000);
  fail = true;
  await cache.refresh();
  const snapshot = cache.snapshot()[0];
  assert.equal(snapshot.status, 'stale');
  assert.equal(snapshot.windows[0].usedPercent, 95);
  assert.equal(snapshot.lastSuccessAt, '2026-09-08T12:00:00.000Z');
  assert.equal(snapshot.lastAttemptAt, '2026-09-08T12:03:00.000Z');
  assert.equal(snapshot.error.code, 'format');
  assert.equal(JSON.stringify(snapshot).includes('SYNTHETIC_SECRET'), false);
});

test('first failure shows no meters; one failed provider does not discard another result', async () => {
  const { cache } = harness({
    claude: () => { throw new Error('token=SYNTHETIC_SECRET'); },
    grok: async () => reading(0),
  });
  await cache.setEnabled(['grok', 'claude']);
  await cache.refresh();
  const [claude, grok] = cache.snapshot();
  assert.equal(claude.status, 'error');
  assert.deepEqual(claude.windows, []);
  assert.equal(claude.lastSuccessAt, null);
  assert.equal(claude.error.code, 'network');
  assert.equal(claude.refreshing, false);
  assert.equal(JSON.stringify(claude).includes('SYNTHETIC_SECRET'), false);
  assert.equal(grok.status, 'ok');
  assert.equal(grok.windows[0].usedPercent, 0);
});

test('429 honors Retry-After even beyond the fallback cap and across toggles', async () => {
  let calls = 0;
  const { cache, advance } = harness({ claude: async () => {
    calls += 1;
    throw Object.assign(new Error('rate limit'), { status: 429, retryAfterMs: 7_200_000 });
  } });
  await cache.setEnabled(['claude']);
  await cache.refresh();
  assert.equal(cache.snapshot()[0].nextRetryAt, '2026-09-08T14:00:00.000Z');
  await cache.setEnabled([]);
  assert.deepEqual(cache.snapshot(), []);
  advance(3_600_000);
  await cache.setEnabled(['claude']);
  assert.equal((await cache.refresh({ force: true })).refreshed, false);
  assert.equal(calls, 1);
  advance(3_600_000);
  assert.equal((await cache.refresh({ force: true })).refreshed, true);
  assert.equal(calls, 2);
});

test('429 fallback grows exponentially and caps at one hour', async () => {
  const { cache, advance } = harness({ claude: async () => { throw Object.assign(new Error(), { code: 'rate_limited' }); } });
  await cache.setEnabled(['claude']);
  const delays = [180_000, 360_000, 720_000, 1_440_000, 2_880_000, 3_600_000, 3_600_000];
  let current = START;
  for (const delay of delays) {
    await cache.refresh({ force: true });
    assert.equal(Date.parse(cache.snapshot()[0].nextRetryAt) - current, delay);
    advance(delay);
    current += delay;
  }
});

test('unrepresentable Retry-After values fall back without breaking snapshots', async () => {
  for (const retryAfterMs of [Number.MAX_VALUE, Infinity, NaN, -1, 'secret']) {
    const { cache } = harness({ claude: async () => {
      throw Object.assign(new Error('Bearer SYNTHETIC_SECRET'), { code: 'rate_limited', retryAfterMs });
    } });
    await cache.setEnabled(['claude']);
    await cache.refresh();
    assert.equal(cache.snapshot()[0].nextRetryAt, '2026-09-08T12:03:00.000Z');
    assert.equal(JSON.stringify(cache.snapshot()).includes('SYNTHETIC_SECRET'), false);
  }
});

test('successful recovery clears errors and backoff without changing past reset data', async () => {
  let failure = true;
  const { cache, advance } = harness({ claude: async () => {
    if (failure) throw Object.assign(new Error(), { code: 'rate_limited', retryAfterMs: 120_000 });
    return reading(102);
  } });
  await cache.setEnabled(['claude']);
  await cache.refresh();
  advance(120_000);
  failure = false;
  await cache.refresh({ force: true });
  const result = cache.snapshot()[0];
  assert.equal(result.status, 'ok');
  assert.equal(result.error, null);
  assert.equal(result.nextRetryAt, null);
  assert.equal(result.windows[0].usedPercent, 102);
});

test('scheduler starts once, obeys minimum settings, and does not restart after stop', async () => {
  let calls = 0;
  const { cache, advance } = harness({ claude: async () => { calls += 1; return reading(); } }, 1);
  await cache.setEnabled(['claude']);
  assert.equal(cache.intervalMs, 120_000);
  await cache.start();
  await cache.start();
  assert.equal(calls, 1);
  assert.ok(cache.timer);
  cache.setInterval(60_000);
  assert.equal(cache.intervalMs, 120_000);
  cache.stop();
  assert.equal(cache.timer, null);
  advance(120_000);
  await cache.setEnabled([]);
  await cache.setEnabled(['claude']);
  assert.equal(calls, 1);
  assert.equal(cache.timer, null);
});

test('re-enabling while running refreshes only when the existing gate allows', async () => {
  let calls = 0;
  const { cache, advance } = harness({ claude: async () => { calls += 1; return reading(); } });
  await cache.setEnabled(['claude']);
  await cache.start();
  try {
    await cache.setEnabled([]);
    await cache.setEnabled(['claude']);
    assert.equal(calls, 1);
    advance(180_000);
    await cache.setEnabled([]);
    await cache.setEnabled(['claude']);
    assert.equal(calls, 2);
  } finally {
    cache.stop();
  }
});

test('consumer mutation cannot corrupt last-good data', async () => {
  const { cache } = harness({ claude: async () => reading(25) });
  await cache.setEnabled(['claude']);
  await cache.refresh();
  cache.snapshot()[0].windows[0].usedPercent = 0;
  assert.equal(cache.snapshot()[0].windows[0].usedPercent, 25);
});

test('errors needing login or parser changes keep a five-minute floor across settings and toggles', async () => {
  for (const code of ['missing', 'unreadable', 'malformed', 'unsupported', 'auth', 'format', 'credentials_write', 'refresh_unsupported', 'forbidden']) {
    let calls = 0;
    const { cache, advance } = harness({ claude: async () => {
      calls += 1;
      throw Object.assign(new Error('SYNTHETIC_SECRET'), { code });
    } });
    await cache.setEnabled(['claude']);
    await cache.refresh();
    assert.equal(cache.snapshot()[0].nextRetryAt, '2026-09-08T12:05:00.000Z', code);
    cache.setInterval(120_000);
    advance(299_999);
    await cache.setEnabled([]);
    await cache.setEnabled(['claude']);
    assert.equal((await cache.refresh({ force: true })).refreshed, false, code);
    assert.equal(calls, 1, code);
    advance(1);
    assert.equal((await cache.refresh({ force: true })).refreshed, true, code);
    assert.equal(calls, 2, code);
  }
});

test('transient failures back off exponentially across error types and stop at one hour', async () => {
  const codes = ['network', 'timeout', 'provider', 'credentials_busy'];
  let failures = 0;
  const { cache, advance } = harness({ claude: async () => {
    throw Object.assign(new Error(), { code: codes[failures++ % codes.length] });
  } });
  await cache.setEnabled(['claude']);
  let current = START;
  for (const delay of [180_000, 360_000, 720_000, 1_440_000, 2_880_000, 3_600_000, 3_600_000]) {
    await cache.refresh({ force: true });
    assert.equal(Date.parse(cache.snapshot()[0].nextRetryAt) - current, delay);
    advance(delay - 1);
    assert.equal((await cache.refresh({ force: true })).refreshed, false);
    advance(1);
    current += delay;
  }
  assert.equal(failures, 7);
});

test('recovering from a transient outage resets its backoff and retains stale readings until success', async () => {
  let failure = false;
  const { cache, advance } = harness({ claude: async () => {
    if (failure) throw Object.assign(new Error(), { code: 'network' });
    return reading(64);
  } });
  await cache.setEnabled(['claude']);
  await cache.refresh();
  failure = true;
  advance(180_000);
  await cache.refresh();
  advance(180_000);
  await cache.refresh();
  assert.equal(cache.snapshot()[0].nextRetryAt, '2026-09-08T12:12:00.000Z');
  assert.equal(cache.snapshot()[0].lastSuccessAt, '2026-09-08T12:00:00.000Z');
  assert.equal(cache.snapshot()[0].status, 'stale');
  assert.equal(cache.snapshot()[0].windows[0].usedPercent, 64);
  failure = false;
  advance(360_000);
  await cache.refresh();
  assert.equal(cache.snapshot()[0].status, 'ok');
  assert.equal(cache.snapshot()[0].nextRetryAt, null);
  failure = true;
  advance(180_000);
  await cache.refresh();
  assert.equal(cache.snapshot()[0].nextRetryAt, '2026-09-08T12:18:00.000Z');
});

test('one provider waiting for login does not delay another provider or shorten the configured interval', async () => {
  const calls = { claude: 0, grok: 0 };
  const { cache, advance } = harness({
    claude: async () => { calls.claude += 1; throw Object.assign(new Error(), { code: 'auth' }); },
    grok: async () => { calls.grok += 1; return reading(); },
  });
  await cache.setEnabled(['claude', 'grok']);
  await cache.refresh();
  assert.equal(cache.nextRefreshAt, '2026-09-08T12:03:00.000Z');
  advance(180_000);
  await cache.refresh();
  assert.deepEqual(calls, { claude: 1, grok: 2 });
  assert.equal(cache.nextRefreshAt, '2026-09-08T12:05:00.000Z');
  cache.setInterval(600_000);
  assert.equal(cache.nextRefreshAt, '2026-09-08T12:10:00.000Z');
});

test('a pending provider does not prevent another due provider from refreshing', async () => {
  let complete;
  let grokCalls = 0;
  const { cache, advance } = harness({
    claude: () => new Promise((resolve) => { complete = resolve; }),
    grok: async () => { grokCalls += 1; return reading(); },
  });
  await cache.setEnabled(['claude', 'grok']);
  const first = cache.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(grokCalls, 1);
  advance(180_000);
  const second = cache.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(grokCalls, 2);
  assert.equal(cache.snapshot()[0].refreshing, true);
  complete(reading());
  await Promise.all([first, second]);
});

test('diagnostics contain only frozen timing and status fields for actual provider attempts', async () => {
  const events = [];
  let fail = false;
  const { cache, advance } = harness({ claude: async () => {
    advance(25);
    if (fail) throw Object.assign(new Error('Bearer SYNTHETIC_SECRET'), {
      code: 'SYNTHETIC_SECRET', path: 'SYNTHETIC_SECRET', body: 'SYNTHETIC_SECRET',
    });
    return { ...reading(), access_token: 'SYNTHETIC_SECRET' };
  } }, 180_000, { onDiagnostic: (event) => events.push(event) });
  await cache.setEnabled(['claude']);
  await cache.refresh();
  await cache.refresh({ force: true });
  assert.equal(events.length, 2);
  fail = true;
  advance(180_000);
  await cache.refresh();
  assert.deepEqual(events, [
    { providerId: 'claude', event: 'refresh_started', at: '2026-09-08T12:00:00.000Z' },
    { providerId: 'claude', event: 'refresh_succeeded', at: '2026-09-08T12:00:00.025Z', durationMs: 25 },
    { providerId: 'claude', event: 'refresh_started', at: '2026-09-08T12:03:00.025Z' },
    { providerId: 'claude', event: 'refresh_failed', at: '2026-09-08T12:03:00.050Z', durationMs: 25, errorCode: 'network', nextRetryAt: '2026-09-08T12:06:00.050Z' },
  ]);
  assert.ok(events.every(Object.isFrozen));
  assert.equal(JSON.stringify(events).includes('SYNTHETIC_SECRET'), false);
});

test('concurrent readers share one start and completion diagnostic', async () => {
  const events = [];
  let complete;
  const { cache } = harness({ claude: () => new Promise((resolve) => { complete = resolve; }) }, 180_000, {
    onDiagnostic: (event) => events.push(event),
  });
  await cache.setEnabled(['claude']);
  const first = cache.refresh();
  const second = cache.refresh({ force: true });
  await Promise.resolve();
  assert.deepEqual(events.map(({ event }) => event), ['refresh_started']);
  complete(reading());
  await Promise.all([first, second]);
  assert.deepEqual(events.map(({ event }) => event), ['refresh_started', 'refresh_succeeded']);
});

test('throwing or rejecting diagnostic observers cannot affect refresh, errors, or recovery', async () => {
  for (const onDiagnostic of [
    () => { throw new Error('observer failed'); },
    async () => { throw new Error('observer rejected'); },
    () => new Promise(() => {}),
    (event) => { event.providerId = 'SYNTHETIC_SECRET'; },
  ]) {
    let failure = false;
    const { cache, advance } = harness({ claude: async () => {
      if (failure) throw Object.assign(new Error(), { code: 'auth' });
      return reading();
    } }, 180_000, { onDiagnostic });
    await cache.setEnabled(['claude']);
    await cache.refresh();
    assert.equal(cache.snapshot()[0].status, 'ok');
    failure = true;
    advance(180_000);
    await cache.refresh();
    assert.equal(cache.snapshot()[0].error.code, 'auth');
    assert.equal(cache.snapshot()[0].nextRetryAt, '2026-09-08T12:08:00.000Z');
    failure = false;
    advance(300_000);
    await cache.refresh();
    assert.equal(cache.snapshot()[0].status, 'ok');
    assert.equal(cache.snapshot()[0].refreshing, false);
  }
});
