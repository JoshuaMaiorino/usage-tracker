import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactChip,
  hottestWindow,
  meterColor,
  splitWindows,
  windowShortLabel,
} from '../public/usage-view.js';

const info = { id: 'claude', name: 'Claude', icon: '✳', loginCommand: 'claude auth login' };
const now = Date.parse('2026-09-14T12:00:00Z');

test('meter colors match the dashboard thresholds and never color a missing percent', () => {
  assert.equal(meterColor(0), 'green');
  assert.equal(meterColor(69.9), 'green');
  assert.equal(meterColor(70), 'amber');
  assert.equal(meterColor(89.9), 'amber');
  assert.equal(meterColor(90), 'red');
  assert.equal(meterColor(Number.NaN), 'neutral');
  assert.equal(meterColor(undefined), 'neutral');
});

test('compact chips use the hottest primary window, not array order', () => {
  const windows = [
    { id: 'session', label: 'Session · 5 hours', usedPercent: 18, durationSeconds: 18000, resetsAt: '2026-09-14T14:00:00Z' },
    { id: 'weekly', label: 'Weekly · 7 days', usedPercent: 91, durationSeconds: 604800, resetsAt: '2026-09-20T12:00:00Z' },
  ];
  assert.equal(hottestWindow(windows).id, 'weekly');
  const chip = compactChip(info, { found: true }, { status: 'ok', windows, lastSuccessAt: '2026-09-14T11:57:00Z' }, now);
  assert.equal(chip.state, 'ok');
  assert.equal(chip.percent, 91);
  assert.equal(chip.color, 'red');
  assert.equal(chip.displayPercent, '91');
  assert.equal(chip.windowLabel, '7d');
  assert.match(chip.title, /Session · 5 hours: 18%/);
  assert.match(chip.title, /Weekly · 7 days: 91%/);
});

test('equal percents prefer the shorter session window', () => {
  const windows = [
    { id: 'weekly', label: 'Weekly', usedPercent: 40, durationSeconds: 604800 },
    { id: 'session', label: 'Session', usedPercent: 40, durationSeconds: 18000 },
  ];
  assert.equal(hottestWindow(windows).id, 'session');
  assert.equal(windowShortLabel(windows[1]), '5h');
});

test('generic scopes stay on the chip; named model limits stay secondary unless they are the only windows', () => {
  const mixed = splitWindows([
    { id: 'weekly', usedPercent: 22, scope: 'shared' },
    { id: 'weekly-fable', usedPercent: 100, scope: 'Fable', durationSeconds: 604800 },
  ]);
  assert.equal(mixed.primary[0].id, 'weekly');
  assert.equal(mixed.scoped[0].id, 'weekly-fable');
  const onlyScoped = splitWindows([{ id: 'weekly-fable', usedPercent: 80, scope: 'Fable' }]);
  assert.equal(onlyScoped.primary[0].id, 'weekly-fable');
  assert.equal(onlyScoped.scoped.length, 0);
});

test('a hot model limit does not replace the primary percent, but is flagged', () => {
  const chip = compactChip(info, { found: true }, {
    status: 'ok',
    windows: [
      { id: 'session', label: 'Session', usedPercent: 42, durationSeconds: 18000 },
      { id: 'weekly-fable', label: 'Fable', usedPercent: 100, scope: 'Fable' },
    ],
    lastSuccessAt: '2026-09-14T11:50:00Z',
  }, now);
  assert.equal(chip.percent, 42);
  assert.equal(chip.color, 'green');
  assert.equal(chip.urgentModelCount, 1);
  assert.match(chip.title, /1 model limit, 1 at 90% or more/);
});

test('missing logins and first failures never invent a usage percent', () => {
  const missing = compactChip(info, { found: false, message: 'Not logged in on this PC' }, null, now);
  assert.equal(missing.state, 'missing');
  assert.equal(missing.percent, null);
  assert.equal(missing.displayPercent, null);
  assert.equal(missing.color, 'neutral');
  const failed = compactChip(info, { found: true }, {
    status: 'error',
    windows: [],
    error: { code: 'network', message: 'Could not reach the provider.' },
  }, now);
  assert.equal(failed.state, 'error');
  assert.equal(failed.percent, null);
  const loading = compactChip(info, { found: true }, { status: 'loading', windows: [] }, now);
  assert.equal(loading.state, 'loading');
  assert.equal(loading.percent, null);
});

test('stale last-good readings keep their percent and mark the chip stale', () => {
  const chip = compactChip(info, { found: true }, {
    status: 'error',
    error: { code: 'rate_limited', message: 'Rate limited — backing off.' },
    windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 73, durationSeconds: 604800 }],
    lastSuccessAt: '2026-09-14T11:00:00Z',
  }, now);
  assert.equal(chip.state, 'stale');
  assert.equal(chip.percent, 73);
  assert.equal(chip.color, 'amber');
  assert.match(chip.title, /last successful reading/i);
});
