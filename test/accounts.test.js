import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAccounts, listClaudeAccounts } from '../lib/accounts.js';
import { discoverAccounts } from '../lib/discover.js';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const claudeAuth = (extra = {}) => JSON.stringify({
  claudeAiOauth: {
    accessToken: 'fixture-claude-access-secret', refreshToken: 'fixture-claude-refresh-secret',
    expiresAt: NOW + 3_600_000, scopes: ['user:profile', 'user:inference'], subscriptionType: 'max', ...extra,
  },
});

async function home(t) {
  const homeDir = await mkdtemp(join(tmpdir(), 'usage-accounts-test-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return {
    homeDir,
    async login(directory, { credentials = claudeAuth(), email, metadataPath } = {}) {
      const dir = join(homeDir, directory);
      await mkdir(dir, { recursive: true });
      if (credentials !== null) await writeFile(join(dir, '.credentials.json'), credentials, { mode: 0o600 });
      if (email) await writeFile(metadataPath ?? join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email }, projects: {} }));
      return dir;
    },
  };
}

test('one Claude login keeps the plain Claude card', async t => {
  const f = await home(t);
  await f.login('.claude', { email: 'person@example.invalid' });
  const accounts = await listClaudeAccounts({ homeDir: f.homeDir, env: {} });
  assert.equal(accounts.length, 1);
  assert.deepEqual(
    accounts.map(({ id, name, type, credentialFile }) => ({ id, name, type, credentialFile })),
    [{ id: 'claude', name: 'Claude', type: 'claude', credentialFile: join(f.homeDir, '.claude', '.credentials.json') }],
  );
});

test('a second Claude config directory becomes its own account, labelled by CLI email', async t => {
  const f = await home(t);
  await f.login('.claude');
  // Claude Code keeps the default account's metadata beside the home directory.
  await writeFile(join(f.homeDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'work@example.invalid' } }));
  await f.login('.claude-personal', { email: 'personal@example.invalid' });
  const accounts = await listClaudeAccounts({ homeDir: f.homeDir, env: {} });
  assert.deepEqual(accounts.map(account => [account.id, account.name, account.email]), [
    ['claude', 'Claude · work', 'work@example.invalid'],
    ['claude-personal', 'Claude · personal', 'personal@example.invalid'],
  ]);
  assert.equal(accounts[1].credentialFile, join(f.homeDir, '.claude-personal', '.credentials.json'));
});

test('extra directories need a login, a Claude-shaped name, and fall back to the directory label', async t => {
  const f = await home(t);
  await f.login('.claude');
  await f.login('.claude-two');
  await f.login('.claude-empty', { credentials: null });
  await f.login('.claudex');
  await f.login('.codex');
  await writeFile(join(f.homeDir, '.claude-file'), 'not a directory');
  const accounts = await listClaudeAccounts({ homeDir: f.homeDir, env: {} });
  assert.deepEqual(accounts.map(account => account.id), ['claude', 'claude-two']);
  assert.deepEqual(accounts.map(account => account.name), ['Claude · main', 'Claude · two']);
});

test('CLAUDE_CONFIG_DIR moves the canonical account without duplicating it', async t => {
  const f = await home(t);
  const moved = await f.login('.claude-main', { email: 'main@example.invalid' });
  await f.login('.claude-other', { email: 'other@example.invalid' });
  const accounts = await listClaudeAccounts({ homeDir: f.homeDir, env: { CLAUDE_CONFIG_DIR: moved } });
  assert.deepEqual(accounts.map(account => [account.id, account.name]), [
    ['claude', 'Claude · main'],
    ['claude-other', 'Claude · other'],
  ]);
  assert.equal(accounts[0].credentialFile, join(moved, '.credentials.json'));
});

test('a symlinked config directory is followed, and duplicate labels keep full emails', async t => {
  const f = await home(t);
  await f.login('.claude', { email: 'mike@work.invalid' });
  const target = await f.login('.claude-target', { email: 'mike@home.invalid' });
  await rm(join(f.homeDir, '.claude-target', '.claude.json'));
  await writeFile(join(target, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'mike@home.invalid' } }));
  await symlink(target, join(f.homeDir, '.claude-link'));
  const accounts = await listClaudeAccounts({ homeDir: f.homeDir, env: {} });
  assert.deepEqual(accounts.map(account => account.id), ['claude', 'claude-link', 'claude-target']);
  assert.deepEqual(accounts.map(account => account.name), ['Claude · mike@work.invalid', 'Claude · mike@home.invalid', 'Claude · mike@home.invalid']);
});

test('accounts are ordered Claude first, then ChatGPT and Grok', async t => {
  const f = await home(t);
  await f.login('.claude');
  await f.login('.claude-second');
  const accounts = await listAccounts({ homeDir: f.homeDir, env: {} });
  assert.deepEqual(accounts.map(account => account.id), ['claude', 'claude-second', 'chatgpt', 'grok']);
  assert.deepEqual(accounts.map(account => account.type), ['claude', 'claude', 'chatgpt', 'grok']);
});

test('discovery reports each Claude login separately and never exposes tokens', async t => {
  const f = await home(t);
  await f.login('.claude', { credentials: claudeAuth({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }) });
  await f.login('.claude-side', { credentials: claudeAuth({ subscriptionType: 'pro' }), email: 'side@example.invalid' });
  const discovered = await discoverAccounts({ homeDir: f.homeDir, env: {} });
  const claude = discovered.filter(account => account.type === 'claude');
  assert.deepEqual(claude.map(account => [account.id, account.plan, account.found, account.status]), [
    ['claude', 'Max 20x', true, 'found'],
    ['claude-side', 'Pro', true, 'found'],
  ]);
  assert.equal(discovered.find(account => account.id === 'chatgpt').status, 'missing');
  assert.ok(!JSON.stringify(discovered).includes('secret'));
});

test('an unreadable second login does not hide the canonical Claude account', async t => {
  const f = await home(t);
  await f.login('.claude');
  await f.login('.claude-broken', { credentials: '{ not json' });
  const discovered = await discoverAccounts({ homeDir: f.homeDir, env: {} });
  assert.equal(discovered.find(account => account.id === 'claude').found, true);
  const broken = discovered.find(account => account.id === 'claude-broken');
  assert.equal(broken.found, false);
  assert.equal(broken.status, 'malformed');
  assert.equal(broken.loginCommand, 'claude auth login');
});
