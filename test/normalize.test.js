import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeClaude, normalizeChatgpt, normalizeGrok } from '../lib/normalize.js';

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

test('Claude retains model scope, numeric zero, and usage above 100%', async () => {
  const result = normalizeClaude(await fixture('claude'), { plan: 'Max 20x' });
  assert.equal(result.plan, 'Max 20x');
  assert.deepEqual(result.windows.map((window) => window.id), ['session', 'weekly', 'weekly-sonnet', 'weekly-fable']);
  assert.equal(result.windows[2].usedPercent, 0);
  assert.equal(result.windows[3].usedPercent, 102.5);
  assert.equal(result.windows[3].scope, 'Fable');
  assert.equal(result.windows[0].resetsAt, '2026-09-08T19:00:00.000Z');
  assert.deepEqual(result.extras, [
    { label: 'Usage credits', value: 'Enabled' },
    { label: 'Extra usage spent', value: '$12.34' },
    { label: 'Monthly spending limit', value: '$50.00' },
  ]);
  assert.equal(Object.hasOwn(result, 'unknown'), false);
});

test('Claude missing values never become zero and reset does not control utilization', () => {
  const result = normalizeClaude({
    five_hour: { utilization: null }, seven_day: { utilization: 0, resets_at: 'yesterday' },
    seven_day_opus: { utilization: '5' }, seven_day_sonnet: { utilization: -1 },
  });
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].id, 'weekly');
  assert.equal(result.windows[0].usedPercent, 0);
  assert.equal(result.windows[0].resetsAt, null);
  assert.equal(result.plan, null);
});

test('Claude reports disabled credits and real zero spending from typed money', () => {
  const result = normalizeClaude({
    five_hour: { utilization: 10 },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
    spend: { enabled: false, used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, balance: null },
  });
  assert.deepEqual(result.extras, [
    { label: 'Usage credits', value: 'Disabled' }, { label: 'Extra usage spent', value: '$0.00' },
  ]);
});

test('Claude formats currency minor units and recognizes explicit legacy unlimited cap', () => {
  const data = { five_hour: { utilization: 10 }, extra_usage: { is_enabled: true, used_credits: 1234, currency: 'JPY', monthly_limit: null } };
  assert.deepEqual(normalizeClaude(data).extras, [
    { label: 'Usage credits', value: 'Enabled' }, { label: 'Extra usage spent', value: '¥1,234' }, { label: 'Monthly spending limit', value: 'Unlimited' },
  ]);
  delete data.extra_usage.monthly_limit;
  assert.equal(normalizeClaude(data).extras.some(extra => extra.value === 'Unlimited'), false);
});

test('Claude prefers typed money without duplicating legacy details and ignores unknown shapes', () => {
  const result = normalizeClaude({
    seven_day: { utilization: 15 }, extra_usage: { is_enabled: true, used_credits: 999, monthly_limit: 5000, spend_limit_reached: true },
    spend: {
      enabled: true, used: { amount_minor: 1250, currency: 'EUR', exponent: 2 },
      limit: { amount_minor: 6000, currency: 'EUR', exponent: 2 },
      balance: { amount_minor: 2500, currency: 'EUR', exponent: 2 }, cap: { private: 'SYNTHETIC_SECRET' },
    },
  });
  assert.deepEqual(result.extras, [
    { label: 'Usage credits', value: 'Enabled' }, { label: 'Extra usage spent', value: '€12.50' },
    { label: 'Spending limit', value: '€60.00' }, { label: 'Usage credit balance', value: '€25.00' },
    { label: 'Spending limit status', value: 'Reached' },
  ]);
  for (const used of [null, {}, { amount_minor: null, currency: 'USD', exponent: 2 }, { amount_minor: 10, currency: 'secret', exponent: 2 }, { amount_minor: 10, currency: 'USD', exponent: -1 }]) {
    assert.deepEqual(normalizeClaude({ five_hour: { utilization: 1 }, spend: { enabled: 'false', used } }).extras, []);
  }
});

test('weekly-only Codex primary is weekly, never a session', async () => {
  const result = normalizeChatgpt(await fixture('chatgpt-weekly-only'));
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].id, 'weekly');
  assert.equal(result.windows[0].durationSeconds, 604800);
  assert.equal(result.windows[0].resetsAt, new Date(1789387200 * 1000).toISOString());
  assert.deepEqual(result.extras, [{ label: 'Credits', value: '0' }]);
});

test('Codex classifies shuffled windows by duration and preserves scopes', async () => {
  const result = normalizeChatgpt(await fixture('chatgpt-scoped'), {
    resetCredits: { expires_at: '2026-12-01T00:00:00Z' },
  });
  assert.deepEqual(result.windows.slice(0, 2).map((window) => window.id), ['session', 'weekly']);
  assert.deepEqual(result.windows.slice(2).map((window) => window.scope), ['Codex Spark', 'Code review']);
  assert.equal(new Set(result.windows.map((window) => window.id)).size, 4);
  assert.deepEqual(result.extras, [
    { label: 'Credits', value: '15.5' }, { label: 'Banked resets', value: '2' },
    { label: 'Reset credits expire', value: '2026-12-01T00:00:00.000Z' },
  ]);
});

test('Codex unknown duration is labeled accurately and absent duration is omitted', () => {
  const result = normalizeChatgpt({ rate_limit: {
    primary_window: { used_percent: 12, limit_window_seconds: 3600 },
    secondary_window: { used_percent: 50 },
  } });
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].label, '1-hour window');
});

test('Codex named-window identities remain stable when the provider reorders scopes', () => {
  const additional = ['Model A', 'Model B'].map(limit_name => ({
    limit_name, rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } },
  }));
  const first = normalizeChatgpt({ additional_rate_limits: additional });
  const second = normalizeChatgpt({ additional_rate_limits: additional.toReversed() });
  const ids = (result) => Object.fromEntries(result.windows.map(window => [window.scope, window.id]));
  assert.deepEqual(ids(first), ids(second));
});

test('optional credit metadata cannot discard valid Codex usage', async () => {
  const raw = await fixture('chatgpt-weekly-only');
  raw.credits = { balance: 'unrecognized' };
  raw.rate_limit_reset_credits = { available_count: null };
  const result = normalizeChatgpt(raw, { resetCredits: { expires_at: {} } });
  assert.equal(result.windows.length, 1);
  assert.deepEqual(result.extras, []);
});

test('Codex permits validated decimal credit strings without coercing usage strings', async () => {
  const raw = await fixture('chatgpt-weekly-only');
  for (const balance of ['0', '23.00', '0.005']) {
    raw.credits.balance = balance;
    assert.deepEqual(normalizeChatgpt(raw).extras, [{ label: 'Credits', value: balance }]);
  }
  for (const balance of ['Infinity', '-1', '', '1e3', 'secret', ' '.repeat(20)]) {
    raw.credits.balance = balance;
    assert.deepEqual(normalizeChatgpt(raw).extras, []);
  }
  raw.rate_limit.primary_window.used_percent = '0';
  assert.throws(() => normalizeChatgpt(raw), { code: 'format' });
});

test('Grok reads explicit percentage, known optional breakdown, and plan metadata', async () => {
  const result = normalizeGrok(await fixture('grok'), { settings: { subscription_tier_display: 'SuperGrok' } });
  assert.equal(result.windows[0].usedPercent, 26.75);
  assert.equal(result.windows[0].resetsAt, '2026-09-14T12:00:00.000Z');
  assert.equal(result.plan, 'SuperGrok');
  assert.equal(result.extras.find((extra) => extra.label === 'Voice').value, '0% used');
});

test('Grok exposes purchased credits and real product array without legacy billing clutter', () => {
  const result = normalizeGrok({ config: {
    creditUsagePercent: 40, isUnifiedBillingUser: true, prepaidBalance: { val: -1234 },
    onDemandUsed: { val: 0 }, onDemandCap: { val: 0 }, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
    productUsage: [{ product: 'PRODUCT_GROK_BUILD', usagePercent: 30 }, { product: 'grok-chat', usagePercent: 10 }, { product: 'Voice', usagePercent: 0 }, { product: 'unknown', usagePercent: 50 }],
  } });
  assert.deepEqual(result.extras, [
    { label: 'Extra Usage Credits', value: '$12.34' }, { label: 'Allowance period', value: 'Weekly' },
    { label: 'Build usage', value: '30% of total allowance' }, { label: 'Chat usage', value: '10% of total allowance' },
    { label: 'Voice usage', value: '0% of total allowance' },
  ]);
});

test('Grok preserves absent versus protobuf zero credit amounts', () => {
  assert.deepEqual(normalizeGrok({ config: { creditUsagePercent: 0, prepaidBalance: {} } }).extras, [{ label: 'Extra Usage Credits', value: '$0.00' }]);
  for (const prepaidBalance of [null, undefined, { val: null }, { val: 'secret' }, { unknown: 0 }, { val: Infinity }]) {
    assert.deepEqual(normalizeGrok({ config: { creditUsagePercent: 0, prepaidBalance } }).extras, []);
  }
});

test('Grok parses signed cent wrappers for legacy usage and monthly period', () => {
  const result = normalizeGrok({ config: {
    onDemandUsed: { val: '-2500' }, onDemandCap: { val: '-10000' }, isUnifiedBillingUser: false,
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2026-10-01T00:00:00Z' },
  } });
  assert.equal(result.windows[0].usedPercent, 25);
  assert.equal(result.windows[0].id, 'monthly');
  assert.equal(Object.hasOwn(result.windows[0], 'durationSeconds'), false);
  assert.deepEqual(result.extras, [
    { label: 'On-demand spending', value: '$25.00' }, { label: 'On-demand spending limit', value: '$100.00' },
    { label: 'Allowance period', value: 'Monthly' },
  ]);
});

test('Grok ignores missing product percentages, unsupported product names, and duplicates', () => {
  const result = normalizeGrok({ config: { creditUsagePercent: 30, productUsage: [
    { product: 'Grok Build', usagePercent: 20 }, { product: 'PRODUCT_GROK_BUILD', usagePercent: 20 },
    { product: 'grok_chat', usagePercent: null }, { product: 'grok-voice', usagePercent: '10' },
    { product: 'SYNTHETIC_SECRET', usagePercent: 5 },
  ] } });
  assert.deepEqual(result.extras, [{ label: 'Build usage', value: '20% of total allowance' }]);
});

test('Grok fallback ratio accepts a real zero and does not mix scopes', () => {
  assert.equal(normalizeGrok({ onDemandUsed: 0, onDemandCap: 40 }).windows[0].usedPercent, 0);
  assert.equal(normalizeGrok({ config: { onDemandUsed: 50, onDemandCap: 40 } }).windows[0].usedPercent, 125);
  assert.throws(() => normalizeGrok({ config: { onDemandUsed: 50 }, onDemandCap: 100 }), { code: 'format' });
});

test('Grok rejects invalid ratio denominators and non-finite math', () => {
  for (const cap of [0, -5, null, undefined, '50', Infinity]) {
    assert.throws(() => normalizeGrok({ onDemandUsed: 20, onDemandCap: cap }), { code: 'format' });
  }
  assert.throws(() => normalizeGrok({ onDemandUsed: Number.MAX_VALUE, onDemandCap: Number.MIN_VALUE }), { code: 'format' });
});

test('all normalizers distinguish unsupported format from valid zero', () => {
  for (const normalize of [normalizeClaude, normalizeChatgpt, normalizeGrok]) {
    for (const payload of [null, undefined, [], 'invalid', {}, { unknown: 0 }]) {
      assert.throws(() => normalize(payload), { code: 'format' });
    }
  }
  for (const invalid of [null, undefined, '', '0', NaN, Infinity, -1, false]) {
    assert.throws(() => normalizeClaude({ five_hour: { utilization: invalid } }), { code: 'format' });
    assert.throws(() => normalizeChatgpt({ rate_limit: { primary_window: { used_percent: invalid, limit_window_seconds: 18000 } } }), { code: 'format' });
    assert.throws(() => normalizeGrok({ config: { creditUsagePercent: invalid } }), { code: 'format' });
  }
});

test('normalization never spreads credential-like or unknown payload fields', () => {
  const secret = 'SYNTHETIC_SECRET_MUST_NOT_ESCAPE';
  const values = [
    normalizeClaude({ access_token: secret, five_hour: { utilization: 5, token: secret } }),
    normalizeChatgpt({ tokens: { access_token: secret }, rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } } }),
    normalizeGrok({ key: secret, config: { creditUsagePercent: 5, email: secret } }),
  ];
  assert.equal(JSON.stringify(values).includes(secret), false);
});
