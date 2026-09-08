import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverAccounts } from '../lib/discover.js';
import { credentialPath, readCredentials, replaceCredentials, withClaudeRefreshLock } from '../lib/credentials.js';
import { createProviders } from '../lib/providers/index.js';
import { parseRetryAfter } from '../lib/providers/shared.js';

const NOW = Date.parse('2026-09-08T12:00:00Z');
const CLAUDE_USAGE = { five_hour: { utilization: 32, resets_at: '2026-09-08T15:00:00Z' }, seven_day: { utilization: 70, resets_at: '2026-09-10T12:00:00Z' } };
const CODEX_USAGE = { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 41, limit_window_seconds: 604800, reset_at: 1789473600 } } };
const GROK_USAGE = { config: { creditUsagePercent: 26, currentPeriod: { end: '2026-09-10T12:00:00Z' } } };
const GROK_SCOPE = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const claudeAuth = (extra = {}) => ({ unrelated: { keep: true }, claudeAiOauth: { accessToken: 'fixture-claude-access-secret', refreshToken: 'fixture-claude-refresh-secret', expiresAt: NOW + 3600000, scopes: ['user:profile', 'user:inference'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', unknown: 'keep', ...extra } });
const codexAuth = () => ({ auth_mode: 'chatgpt', unrelated: { keep: true }, tokens: { access_token: 'fixture-codex-access-secret', refresh_token: 'fixture-codex-refresh-secret', id_token: 'fixture-id-token', account_id: 'fixture-account', unknown: 'keep' } });
const grokAuth = (extra = {}) => ({ [GROK_SCOPE]: { key: 'fixture-grok-access-secret', refresh_token: 'fixture-grok-refresh-secret', expires_at: '2026-09-09T12:00:00Z', email: 'example@example.invalid', oidc_issuer: 'https://auth.x.ai', ...extra } });
const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

async function fixture(t) {
  const homeDir = await mkdtemp(join(tmpdir(), 'usage-provider-test-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return {
    homeDir,
    async write(id, value) {
      const path = credentialPath(id, homeDir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
      return path;
    },
    async read(id) { return JSON.parse(await readFile(credentialPath(id, homeDir), 'utf8')); },
  };
}

test('discovery is ordered, metadata only, and distinguishes supported logins from missing/malformed/API keys', async t => {
  const f = await fixture(t);
  await f.write('claude', claudeAuth());
  await f.write('chatgpt', { OPENAI_API_KEY: 'fixture-private-api-key' });
  let accounts = await discoverAccounts(f);
  assert.deepEqual(accounts.map(item => item.id), ['claude', 'chatgpt', 'grok']);
  assert.equal(accounts[0].found, true);
  assert.equal(accounts[0].plan, 'Max 20x');
  assert.equal(accounts[1].status, 'unsupported');
  assert.equal(accounts[2].status, 'missing');
  assert.doesNotMatch(JSON.stringify(accounts), /fixture-|accessToken|refreshToken|api_key/);
  await f.write('chatgpt', '{ malformed fixture-codex-access-secret');
  accounts = await discoverAccounts(f);
  assert.equal(accounts[1].status, 'malformed');
  assert.doesNotMatch(JSON.stringify(accounts), /fixture-/);
});

test('Grok discovery prefers an xAI OAuth scope and never assumes a plan', async t => {
  const f = await fixture(t);
  await f.write('grok', { ...grokAuth(), 'https://accounts.x.ai/sign-in': { key: 'legacy-secret', email: 'old@example.invalid' } });
  const [,, account] = await discoverAccounts(f);
  assert.equal(account.email, 'example@example.invalid');
  assert.equal(account.plan, null);
  assert.equal(account.found, true);
});

test('discovery rejects API-mode stores even when obsolete subscription tokens remain', async t => {
  const f = await fixture(t);
  const codex = codexAuth(); delete codex.auth_mode; codex.OPENAI_API_KEY = 'fixture-api-key';
  await f.write('chatgpt', codex);
  await f.write('claude', claudeAuth({ subscriptionType: null, scopes: ['org:create_api_key'] }));
  const accounts = await discoverAccounts(f);
  assert.equal(accounts[0].status, 'unsupported');
  assert.equal(accounts[1].status, 'unsupported');
});

test('providers fail missing credentials without a request', async t => {
  const f = await fixture(t);
  const providers = createProviders({ ...f, fetchImpl() { assert.fail('unexpected request'); } });
  for (const provider of Object.values(providers)) await assert.rejects(provider(), error => error.code === 'missing');
});

test('all usage adapters return real fixture values, constant destinations, safe headers and no credentials', async t => {
  const f = await fixture(t);
  await f.write('claude', claudeAuth());
  await f.write('chatgpt', codexAuth());
  await f.write('grok', grokAuth());
  const requests = [];
  const providers = createProviders({ ...f, now: () => NOW, fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.includes('anthropic.com')) { assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20'); return jsonResponse(CLAUDE_USAGE); }
    if (url.includes('chatgpt.com')) { assert.equal(options.headers['ChatGPT-Account-Id'], 'fixture-account'); return jsonResponse(CODEX_USAGE); }
    assert.equal(options.headers['x-xai-token-auth'], 'xai-grok-cli');
    return jsonResponse(url.endsWith('settings') ? { subscription_tier_display: 'SuperGrok' } : GROK_USAGE);
  } });
  const payloads = await Promise.all(Object.values(providers).map(provider => provider()));
  assert.deepEqual(payloads.map(item => item.windows[0].usedPercent), [32, 41, 26]);
  assert.equal(payloads[1].windows[0].durationSeconds, 604800);
  assert.doesNotMatch(JSON.stringify(payloads), /fixture-|refresh_token|accessToken|Authorization/);
  assert.equal(requests.length, 4);
});

test('Claude refreshes with margin, preserves unknown fields, and removes both official locks and temp files', async t => {
  const f = await fixture(t);
  await f.write('claude', claudeAuth({ expiresAt: NOW + 240000 }));
  let refreshCount = 0;
  const providers = createProviders({ ...f, now: () => NOW, fetchImpl: async (url, options) => {
    if (url.endsWith('/oauth/token')) {
      refreshCount++;
      assert.equal((await stat(join(f.homeDir, '.claude', '.oauth_refresh.lock'))).isDirectory(), true);
      assert.equal((await stat(join(f.homeDir, '.claude.lock'))).isDirectory(), true);
      const body = JSON.parse(options.body);
      assert.equal(body.client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      assert.equal(body.scope, 'user:profile user:inference');
      return jsonResponse({ access_token: 'new-claude-access', refresh_token: 'new-claude-refresh', expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, 'Bearer new-claude-access');
    return jsonResponse(CLAUDE_USAGE);
  } });
  await Promise.all([providers.claude(), providers.claude()]);
  const saved = await f.read('claude');
  assert.equal(refreshCount, 1);
  assert.equal(saved.claudeAiOauth.expiresAt, NOW + 3600000);
  assert.equal(saved.claudeAiOauth.refreshToken, 'new-claude-refresh');
  assert.equal(saved.claudeAiOauth.unknown, 'keep');
  assert.equal(saved.unrelated.keep, true);
  assert.deepEqual(await readdir(join(f.homeDir, '.claude')), ['.credentials.json']);
  assert.deepEqual(await readdir(f.homeDir), ['.claude']);
});

test('Claude never steals locks and cleans the first lock when the legacy lock is held', async t => {
  const f = await fixture(t);
  await f.write('claude', claudeAuth({ expiresAt: NOW - 1 }));
  await mkdir(join(f.homeDir, '.claude.lock'));
  const providers = createProviders({ ...f, now: () => NOW, fetchImpl() { assert.fail('must not use refresh token without both locks'); } });
  await assert.rejects(providers.claude(), error => error.code === 'credentials_busy');
  assert.equal((await stat(join(f.homeDir, '.claude.lock'))).isDirectory(), true);
  assert.deepEqual(await readdir(join(f.homeDir, '.claude')), ['.credentials.json']);
});

test('Claude preserves the CLI winner when credentials rotate during its refresh', async t => {
  const f = await fixture(t);
  await f.write('claude', claudeAuth({ expiresAt: NOW - 1 }));
  const providers = createProviders({ ...f, now: () => NOW, fetchImpl: async (url, options) => {
    if (url.endsWith('/oauth/token')) {
      await f.write('claude', claudeAuth({ accessToken: 'cli-winner', refreshToken: 'cli-refresh-winner' }));
      return jsonResponse({ access_token: 'loser-access', refresh_token: 'loser-refresh', expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, 'Bearer cli-winner');
    return jsonResponse(CLAUDE_USAGE);
  } });
  await providers.claude();
  assert.equal((await f.read('claude')).claudeAiOauth.refreshToken, 'cli-refresh-winner');
});

test('metadata edits during Claude refresh are retained alongside rotated tokens', async t => {
  const f = await fixture(t);
  await f.write('claude', claudeAuth({ expiresAt: NOW - 1 }));
  const providers = createProviders({ ...f, now: () => NOW, fetchImpl: async url => {
    if (url.endsWith('/oauth/token')) {
      const changed = await f.read('claude');
      changed.unrelated.cliUpdate = 'preserve';
      await f.write('claude', changed);
      return jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    }
    return jsonResponse(CLAUDE_USAGE);
  } });
  await providers.claude();
  const saved = await f.read('claude');
  assert.equal(saved.unrelated.cliUpdate, 'preserve');
  assert.equal(saved.claudeAiOauth.refreshToken, 'new-refresh');
});

test('Codex retries a 401 once with rotated credentials and retains account and unknown fields', async t => {
  const f = await fixture(t);
  await f.write('chatgpt', codexAuth());
  let usageCount = 0;
  let refreshCount = 0;
  const providers = createProviders({ ...f, now: () => NOW, fetchImpl: async (url, options) => {
    if (url.endsWith('/oauth/token')) {
      refreshCount++;
      assert.equal(JSON.parse(options.body).client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
      return jsonResponse({ access_token: 'new-codex-access', refresh_token: 'new-codex-refresh', id_token: 'new-id' });
    }
    usageCount++;
    if (usageCount === 1) return jsonResponse({ error: 'fixture-codex-access-secret' }, 401);
    assert.equal(options.headers.Authorization, 'Bearer new-codex-access');
    return jsonResponse(CODEX_USAGE);
  } });
  await providers.chatgpt();
  const saved = await f.read('chatgpt');
  assert.equal(usageCount, 2);
  assert.equal(refreshCount, 1);
  assert.equal(saved.tokens.refresh_token, 'new-codex-refresh');
  assert.equal(saved.tokens.account_id, 'fixture-account');
  assert.equal(saved.tokens.unknown, 'keep');
  assert.equal(saved.unrelated.keep, true);
  assert.equal(saved.last_refresh, new Date(NOW).toISOString());
});

test('Codex rereads on 401 and does not refresh a token already replaced by the CLI', async t => {
  const f = await fixture(t);
  await f.write('chatgpt', codexAuth());
  let count = 0;
  const providers = createProviders({ ...f, fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/usage'));
    if (++count === 1) {
      const changed = codexAuth(); changed.tokens.access_token = 'cli-codex-winner';
      await f.write('chatgpt', changed);
      return jsonResponse({}, 401);
    }
    assert.equal(options.headers.Authorization, 'Bearer cli-codex-winner');
    return jsonResponse(CODEX_USAGE);
  } });
  await providers.chatgpt();
  assert.equal(count, 2);
});

test('Codex does not loop when renewed credentials still return 401', async t => {
  const f = await fixture(t);
  await f.write('chatgpt', codexAuth());
  let count = 0;
  const providers = createProviders({ ...f, now: () => NOW, fetchImpl: async url => {
    count++;
    return url.endsWith('/oauth/token')
      ? jsonResponse({ access_token: 'refreshed-fixture', refresh_token: 'refreshed-refresh-fixture' })
      : jsonResponse({ error: 'fixture-codex-access-secret' }, 401);
  } });
  await assert.rejects(providers.chatgpt(), error => error.code === 'auth' && !error.message.includes('fixture'));
  assert.equal(count, 3);
});

test('malformed successful response and network exceptions have safe errors', async t => {
  const f = await fixture(t);
  await f.write('chatgpt', codexAuth());
  const malformed = createProviders({ ...f, fetchImpl: async () => new Response('fixture-codex-access-secret invalid JSON') });
  await assert.rejects(malformed.chatgpt(), error => error.code === 'format' && !error.message.includes('fixture'));
  const network = createProviders({ ...f, fetchImpl: async () => { throw new Error('Authorization: Bearer fixture-codex-access-secret'); } });
  await assert.rejects(network.chatgpt(), error => error.code === 'network' && !error.message.includes('fixture'));
});

test('failed refresh and 429 produce safe typed errors without upstream secrets', async t => {
  const f = await fixture(t);
  await f.write('claude', claudeAuth({ expiresAt: NOW - 1 }));
  const providers = createProviders({ ...f, now: () => NOW, fetchImpl: async () => jsonResponse({ error: 'fixture-claude-refresh-secret' }, 429, { 'Retry-After': '1200' }) });
  await assert.rejects(providers.claude(), error => {
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.retryAfterMs, 1200000);
    assert.doesNotMatch(error.message + JSON.stringify(error), /fixture-/);
    return true;
  });
  assert.equal((await f.read('claude')).claudeAiOauth.refreshToken, 'fixture-claude-refresh-secret');
  assert.deepEqual(await readdir(f.homeDir), ['.claude']);
});

test('Grok expired credentials leave its OS lock and auth file untouched', async t => {
  const f = await fixture(t);
  const original = grokAuth({ expires_at: '2026-09-07T12:00:00Z' });
  await f.write('grok', original);
  await writeFile(join(f.homeDir, '.grok', 'auth.json.lock'), '1234:fixture-lock');
  const providers = createProviders({ ...f, now: () => NOW, fetchImpl() { assert.fail('never send a Grok refresh token'); } });
  await assert.rejects(providers.grok(), error => error.code === 'refresh_unsupported' && /grok login/.test(error.message));
  assert.deepEqual(await f.read('grok'), original);
  assert.equal(await readFile(join(f.homeDir, '.grok', 'auth.json.lock'), 'utf8'), '1234:fixture-lock');
});

test('Grok refuses untrusted issuer entries without network calls', async t => {
  const f = await fixture(t);
  await f.write('grok', grokAuth({ oidc_issuer: 'https://untrusted.example' }));
  const providers = createProviders({ ...f, fetchImpl() { assert.fail('untrusted issuer'); } });
  await assert.rejects(providers.grok(), error => error.code === 'unsupported');
});

test('optional settings and credits errors do not discard valid usage', async t => {
  const f = await fixture(t);
  await f.write('grok', grokAuth());
  await f.write('chatgpt', codexAuth());
  const providers = createProviders({ ...f, now: () => NOW, fetchImpl: async url => {
    if (url.endsWith('settings') || url.endsWith('rate-limit-reset-credits')) return jsonResponse({}, 500);
    if (url.includes('grok.com')) return jsonResponse(GROK_USAGE);
    return jsonResponse({ ...CODEX_USAGE, rate_limit_reset_credits: { available_count: 2 } });
  } });
  assert.equal((await providers.grok()).windows[0].usedPercent, 26);
  assert.equal((await providers.chatgpt()).windows[0].usedPercent, 41);
});

test('atomic replacement refuses changed contents and cleans temporary files', async t => {
  const f = await fixture(t);
  await f.write('chatgpt', codexAuth());
  const snapshot = await readCredentials('chatgpt', f);
  const changed = codexAuth(); changed.tokens.access_token = 'keep-cli-change';
  await f.write('chatgpt', changed);
  assert.equal(await replaceCredentials(snapshot, codexAuth()), false);
  assert.deepEqual(await f.read('chatgpt'), changed);
  assert.deepEqual(await readdir(join(f.homeDir, '.codex')), ['auth.json']);
});

test('lock guard detects removal and does not silently permit a refresh', async t => {
  const f = await fixture(t);
  const path = await f.write('claude', claudeAuth());
  await assert.rejects(withClaudeRefreshLock(path, async validate => {
    await rm(join(f.homeDir, '.claude', '.oauth_refresh.lock'), { recursive: true });
    await validate();
  }), error => error.code === 'credentials_busy');
  assert.deepEqual(await readdir(f.homeDir), ['.claude']);
});

test('Retry-After parsing handles seconds, dates and invalid values', () => {
  assert.equal(parseRetryAfter('120', NOW), 120000);
  assert.equal(parseRetryAfter(new Date(NOW + 240000).toUTCString(), NOW), 240000);
  assert.equal(parseRetryAfter('nonsense', NOW), undefined);
  assert.equal(parseRetryAfter('', NOW), undefined);
});
