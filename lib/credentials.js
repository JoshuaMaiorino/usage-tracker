import { lstat, mkdir, open, readFile, realpath, rename, rmdir, stat, unlink, utimes } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LOGIN_COMMANDS, ProviderError, isObject, tokenString } from './providers/shared.js';

const FILES = Object.freeze({ claude: ['.claude', '.credentials.json'], chatgpt: ['.codex', 'auth.json'], grok: ['.grok', 'auth.json'] });
const queues = new Map();
const execFileAsync = promisify(execFile);

export function credentialPath(id, homeDir = homedir()) {
  if (!Object.hasOwn(FILES, id)) throw new TypeError('Unknown provider');
  return resolve(homeDir, ...FILES[id]);
}

export async function readCredentials(id, { homeDir } = {}) {
  const path = credentialPath(id, homeDir);
  let raw;
  let info;
  try {
    info = await lstat(path);
    if (!info.isFile()) throw new ProviderError('unsupported', 'This credential store is not a supported regular file.');
    if (info.size > 1_048_576) throw new ProviderError('malformed', 'CLI credential file has an unsupported format.');
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error.code === 'ENOENT') throw new ProviderError('missing', `Not logged in on this PC — run ${LOGIN_COMMANDS[id]}.`);
    throw new ProviderError('unreadable', 'Could not read the local CLI credential file. Check its permissions.');
  }
  let data;
  try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new ProviderError('malformed', 'CLI credential file is malformed. Sign in again with the CLI.'); }
  if (!isObject(data)) throw new ProviderError('malformed', 'CLI credential file has an unsupported format.');
  return { id, path, data, raw, mode: info.mode & 0o777, ino: info.ino, mtimeMs: info.mtimeMs };
}

export function decodeClaims(token) {
  if (!tokenString(token)) return {};
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return {};
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return isObject(value) ? value : {};
  } catch { return {}; }
}

function knownPlan(value) {
  if (typeof value !== 'string') return null;
  const key = value.toLowerCase().replace(/[_-]/g, ' ');
  return ({ free: 'Free', pro: 'Pro', plus: 'Plus', max: 'Max', 'max 5x': 'Max 5x', 'max 20x': 'Max 20x', team: 'Team', business: 'Business', enterprise: 'Enterprise', supergrok: 'SuperGrok', 'supergrok heavy': 'SuperGrok Heavy', 'pro lite': 'Pro Lite', go: 'Go', edu: 'Edu' })[key] ?? null;
}

export function selectCredential(id, data) {
  if (id === 'claude') {
    const entry = data.claudeAiOauth;
    if (!isObject(entry) || !tokenString(entry.accessToken)) throw new ProviderError('unsupported', 'No Claude subscription login in this credential file. Run claude auth login.');
    if (!entry.subscriptionType && Array.isArray(entry.scopes) && !entry.scopes.some(scope => scope === 'user:profile' || scope === 'user:inference')) {
      throw new ProviderError('unsupported', 'No Claude subscription login in this credential file. Run claude auth login.');
    }
    let plan = knownPlan(entry.subscriptionType);
    if (entry.subscriptionType === 'max') {
      if (entry.rateLimitTier === 'default_claude_max_20x') plan = 'Max 20x';
      if (entry.rateLimitTier === 'default_claude_max_5x') plan = 'Max 5x';
    }
    return { entry, accessToken: entry.accessToken, refreshToken: entry.refreshToken, expiresAt: expiry(entry.expiresAt), plan };
  }
  if (id === 'chatgpt') {
    const entry = data.tokens;
    if ((!data.auth_mode && tokenString(data.OPENAI_API_KEY)) || (data.auth_mode && !['chatgpt', 'chatgptAuthTokens', 'chatgpt_auth_tokens'].includes(data.auth_mode)) || !isObject(entry) || !tokenString(entry.access_token)) {
      throw new ProviderError('unsupported', 'No ChatGPT subscription login in this credential file. Run codex login.');
    }
    const claims = decodeClaims(entry.id_token || entry.access_token);
    const authClaims = claims['https://api.openai.com/auth'] ?? {};
    const profile = claims['https://api.openai.com/profile'] ?? {};
    return { entry, accessToken: entry.access_token, refreshToken: entry.refresh_token, accountId: entry.account_id, plan: knownPlan(authClaims.chatgpt_plan_type), email: safeEmail(claims.email ?? profile.email) };
  }
  const candidates = Object.keys(data).filter(key => /^https:\/\/auth\.x\.ai::[a-zA-Z0-9_-]+$/.test(key));
  candidates.push('https://accounts.x.ai/sign-in');
  for (const scope of candidates) {
    const entry = data[scope];
    if (!isObject(entry) || !tokenString(entry.key) || entry.auth_mode === 'api_key') continue;
    if (entry.oidc_issuer && entry.oidc_issuer !== 'https://auth.x.ai' && entry.oidc_issuer !== 'https://auth.x.ai/') continue;
    return { entry, scope, accessToken: entry.key, refreshToken: entry.refresh_token, expiresAt: expiry(entry.expires_at), plan: knownPlan(entry.subscription_tier_display ?? entry.subscription_tier), email: safeEmail(entry.email) };
  }
  throw new ProviderError('unsupported', 'No supported Grok subscription login in this credential file. Run grok login.');
}

function safeEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) ? value : undefined;
}

export function expiry(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return undefined;
}

export function serializeCredentials(path, action) {
  const previous = queues.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(action);
  queues.set(path, pending);
  pending.finally(() => { if (queues.get(path) === pending) queues.delete(path); }).catch(() => {});
  return pending;
}

// Current Claude Code uses proper-lockfile directory locks: a new lock inside
// the config directory plus the legacy sibling lock. Never steal an existing
// lock. The 5-second heartbeat keeps the CLI's 60-second stale check satisfied.
export async function withClaudeRefreshLock(credentialFile, action) {
  const dir = dirname(credentialFile);
  const canonical = await realpath(dir);
  const paths = [join(dir, '.oauth_refresh.lock'), `${canonical}.lock`];
  const held = [];
  let compromised = false;
  let heartbeat = Promise.resolve();
  let timer;
  const validate = async () => {
    if (compromised) throw new ProviderError('credentials_busy', 'CLI credentials are changing. Waiting for the CLI.');
    for (const item of held) {
      let current;
      try { current = await stat(item.path); } catch { compromised = true; }
      if (!current || current.ino !== item.ino || current.birthtimeMs !== item.birthtimeMs) compromised = true;
    }
    if (compromised) throw new ProviderError('credentials_busy', 'CLI credentials are changing. Waiting for the CLI.');
  };
  try {
    for (const path of paths) {
      try { await mkdir(path, { mode: 0o700 }); } catch {
        throw new ProviderError('credentials_busy', 'Claude Code is refreshing its login. Waiting for the CLI.');
      }
      const info = await stat(path);
      held.push({ path, ino: info.ino, birthtimeMs: info.birthtimeMs });
    }
    timer = setInterval(() => {
      heartbeat = heartbeat.then(async () => {
        await validate();
        const now = new Date();
        await Promise.all(held.map(item => utimes(item.path, now, now)));
      }).catch(() => { compromised = true; });
    }, 5000);
    timer.unref();
    return await action(validate);
  } finally {
    clearInterval(timer);
    await heartbeat;
    for (const item of held.reverse()) {
      try {
        const info = await stat(item.path);
        if (info.ino === item.ino && info.birthtimeMs === item.birthtimeMs) await rmdir(item.path);
      } catch { /* never remove somebody else's replacement */ }
    }
  }
}

// Expected contents are compared immediately before atomic replacement. Any
// external change wins, including a logout or metadata edit. Unknown fields
// survive because callers modify a clone of the complete original document.
export async function replaceCredentials(snapshot, data, { validate = async () => {} } = {}) {
  const tempPath = join(dirname(snapshot.path), `.${snapshot.id}-refresh-${randomUUID()}.tmp`);
  let handle;
  try {
    await validate();
    handle = await open(tempPath, 'wx', snapshot.mode & 0o600);
    if (process.platform === 'win32') {
      // Node's mode bits do not represent Windows ACLs. Preserve effective
      // source access rules before replacing it; credential values never enter
      // the child process, its environment, arguments, or output.
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference = "Stop"; $authAcl = Get-Acl -LiteralPath $env:USAGE_CREDENTIAL_SOURCE; $authAcl.SetAccessRuleProtection($true, $true); Set-Acl -LiteralPath $env:USAGE_CREDENTIAL_TARGET -AclObject $authAcl'], {
        windowsHide: true, timeout: 10_000,
        env: { ...process.env, USAGE_CREDENTIAL_SOURCE: snapshot.path, USAGE_CREDENTIAL_TARGET: tempPath },
      });
    }
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await validate();
    const info = await lstat(snapshot.path);
    const current = await readFile(snapshot.path, 'utf8');
    if (!info.isFile() || info.ino !== snapshot.ino || current !== snapshot.raw) return false;
    await rename(tempPath, snapshot.path);
    return true;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('credentials_write', 'Could not safely save refreshed CLI credentials. Sign in again with the CLI.');
  } finally {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
  }
}
