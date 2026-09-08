import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApplication } from '../server.js';
import { ConfigStore } from '../lib/config.js';

const accounts = [
  { id: 'claude', name: 'Claude', found: true, status: 'found', plan: 'Max', loginCommand: 'claude auth login', accessToken: 'must-not-leak' },
  { id: 'chatgpt', name: 'ChatGPT', found: true, status: 'found', plan: null, loginCommand: 'codex login' },
  { id: 'grok', name: 'Grok', found: false, status: 'missing', plan: null, loginCommand: 'grok login' },
];

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'usage-tracker-server-'));
  const configPath = join(dir, 'config.json');
  if (options.config) await writeFile(configPath, JSON.stringify(options.config));
  const counters = { claude: 0, chatgpt: 0, grok: 0 };
  const providers = Object.fromEntries(accounts.map(account => [account.id, async () => {
    counters[account.id]++;
    return { id: account.id, name: account.name, plan: account.plan, windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 0, resetsAt: null }], extras: [] };
  }]));
  const app = await createApplication({ port: 0, configPath, discovery: async () => accounts, providers, autoStart: false, addresses: ['192.168.1.99'] });
  const meta = await app.listen();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = meta.localUrl;
  const get = async path => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const token = (await get('/api/accounts')).data.csrfToken;
  const post = (path, data, headers = {}) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-usage-token': token, origin: base, ...headers }, body: JSON.stringify(data),
  });
  return { app, base, get, post, token, counters, configPath, dir };
}

test('server discovers without network, serves cache, and strips credential fields', async t => {
  const ctx = await setup(t);
  const response = await ctx.get('/api/accounts');
  assert.deepEqual(response.data.settings.enabled, { claude: true, chatgpt: true, grok: false });
  assert.equal(JSON.stringify(response.data).includes('must-not-leak'), false);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const usage = await ctx.get('/api/usage');
  assert.deepEqual(usage.data.providers.map(provider => provider.id), ['claude', 'chatgpt']);
  assert.deepEqual(ctx.counters, { claude: 0, chatgpt: 0, grok: 0 });
  assert.equal(usage.headers.get('cache-control'), 'no-store');
});

test('settings persist opt-outs and reject invalid intervals/providers', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.post('/api/accounts', { enabled: { claude: false }, refreshIntervalMs: 300_000 })).status, 200);
  assert.deepEqual((await ctx.get('/api/usage')).data.providers.map(p => p.id), ['chatgpt']);
  const saved = JSON.parse(await readFile(ctx.configPath, 'utf8'));
  assert.equal(saved.enabled.claude, false);
  assert.equal(saved.refreshIntervalMs, 300_000);
  assert.equal((await new ConfigStore(ctx.configPath).load(accounts)).enabled.claude, false);
  assert.equal((await ctx.post('/api/accounts', { refreshIntervalMs: 20 })).status, 400);
  assert.equal((await ctx.post('/api/accounts', { enabled: { gemini: true } })).status, 400);
  assert.equal((await ctx.post('/api/accounts', { homeDir: '/secrets' })).status, 400);
  assert.equal((await ctx.post('/api/accounts', { enableAll: true })).status, 200);
  assert.deepEqual((await ctx.get('/api/accounts')).data.settings.enabled, { claude: true, chatgpt: true, grok: false });
  assert.deepEqual(await readdir(ctx.dir), ['config.json']);
});

test('mutations require same origin, JSON, and anti-CSRF token', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.post('/api/accounts', {}, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await ctx.post('/api/accounts', {}, { 'x-usage-token': 'invalid' })).status, 403);
  assert.equal((await ctx.post('/api/accounts', {}, { 'x-usage-token': 'é'.repeat(64) })).status, 403);
  assert.equal((await ctx.post('/api/accounts', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await ctx.post('/api/accounts', {}, { 'content-type': 'text/plain' })).status, 415);
  const malformed = await fetch(`${ctx.base}/api/accounts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-usage-token': ctx.token }, body: '{' });
  assert.equal(malformed.status, 400);
  const excessive = await fetch(`${ctx.base}/api/accounts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-usage-token': ctx.token }, body: JSON.stringify({ huge: 'x'.repeat(9000) }) });
  assert.equal(excessive.status, 413);
});

test('oversized declared and chunked bodies receive 413 before completing upload', async t => {
  const ctx = await setup(t);
  for (const declared of [true, false]) {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(`${ctx.base}/api/accounts`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-usage-token': ctx.token,
          ...(declared ? { 'content-length': '999999999' } : { 'transfer-encoding': 'chunked' }),
        },
      }, result => {
        result.resume();
        result.once('end', () => resolve({ status: result.statusCode, connection: result.headers.connection }));
      });
      request.setTimeout(3000, () => { request.destroy(); reject(new Error('Oversized request was not rejected promptly.')); });
      request.on('error', reject);
      request.flushHeaders();
      if (!declared) request.write('x'.repeat(8193));
      // Deliberately leave the upload unfinished; the server must reject it now.
    });
    assert.equal(response.status, 413);
    assert.equal(response.connection, 'close');
  }
});

test('concurrent settings updates preserve independent account and interval changes', async t => {
  const ctx = await setup(t);
  const responses = await Promise.all([
    ctx.post('/api/accounts', { enabled: { claude: false } }),
    ctx.post('/api/accounts', { enabled: { chatgpt: false } }),
    ctx.post('/api/accounts', { refreshIntervalMs: 420_000 }),
  ]);
  assert.ok(responses.every(response => response.status === 200));
  const saved = JSON.parse(await readFile(ctx.configPath, 'utf8'));
  assert.deepEqual(saved.enabled, { claude: false, chatgpt: false, grok: false });
  assert.equal(saved.refreshIntervalMs, 420_000);
  assert.deepEqual(await readdir(ctx.dir), ['config.json']);
});

test('host guard and public file allowlist prevent rebinding and arbitrary file reads', async t => {
  const ctx = await setup(t);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(ctx.base, { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(status, 403);
  for (const path of ['/data/config.json', '/lib/config.js', '/.git/config', '/%2e%2e%2fserver.js', '/api/qr.svg']) {
    assert.equal((await fetch(`${ctx.base}${path}`)).status, 404, path);
  }
});

test('manual refresh shares cache and respects two minute minimum', async t => {
  const ctx = await setup(t);
  const refreshed = await (await ctx.post('/api/usage/refresh', {})).json();
  assert.equal(refreshed.refreshed, true);
  assert.deepEqual(ctx.counters, { claude: 1, chatgpt: 1, grok: 0 });
  const success = refreshed.providers[0].lastSuccessAt;
  const second = await (await ctx.post('/api/usage/refresh', {})).json();
  assert.equal(second.refreshed, false);
  assert.equal(second.providers[0].lastSuccessAt, success);
  await Promise.all([ctx.get('/api/usage'), ctx.get('/api/usage')]);
  assert.equal(ctx.counters.claude, 1);
  assert.equal((await ctx.post('/api/usage/refresh', { arbitrary: true })).status, 400);
});

test('LAN setting states restart boundary and active LAN exposes generated QR', async t => {
  const local = await setup(t);
  await local.post('/api/accounts', { lanEnabled: true });
  const pending = (await local.get('/api/meta')).data;
  assert.equal(pending.bindMode, 'local');
  assert.equal(pending.restartRequired, true);
  assert.equal(pending.lanUrl, null);
  const lan = await setup(t, { config: { enabled: { claude: false, chatgpt: false, grok: false }, refreshIntervalMs: 180_000, lanEnabled: true } });
  const meta = (await lan.get('/api/meta')).data;
  assert.equal(meta.bindMode, 'lan');
  assert.match(meta.lanUrl, /^http:\/\/192\.168\.1\.99:/);
  const qr = await fetch(`${lan.base}/api/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await qr.text(), /<svg/);
});

test('malformed persisted config is preserved and explained', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-tracker-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, '{broken');
  await assert.rejects(new ConfigStore(path).load(accounts), /config.json is invalid/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});
