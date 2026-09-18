import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { credentialPath } from './credentials.js';
import { LOGIN_COMMANDS } from './providers/shared.js';

// Claude Code keeps one account per config directory (CLAUDE_CONFIG_DIR), so a second
// subscription on the same PC lives in a sibling of ~/.claude, conventionally named for
// the account: ~/.claude-work, ~/.claude_gmail. Anything else in the home directory is
// ignored, and an extra directory only becomes an account once it holds a CLI login.
const CLAUDE_DIR_NAME = /^\.claude(?:[-_.][A-Za-z0-9][A-Za-z0-9._-]{0,31})?$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
// `.claude.json` grows with project history; skip rather than parse an unbounded file.
const MAX_METADATA_BYTES = 4_194_304;
const emailCache = new Map();

const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');

function configuredDir(value, homeDir) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const dir = value.trim();
  return isAbsolute(dir) ? resolve(dir) : resolve(homeDir, dir);
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function hasCredentials(dir) {
  try { return (await stat(join(dir, '.credentials.json'))).isFile(); } catch { return false; }
}

// Metadata only: the account email the CLI recorded, never a token from the same file.
async function readEmail(path) {
  let info;
  try { info = await stat(path); } catch { return undefined; }
  if (!info.isFile() || info.size > MAX_METADATA_BYTES) return undefined;
  const key = `${path}:${info.size}:${info.mtimeMs}`;
  if (emailCache.has(key)) return emailCache.get(key);
  let email;
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    const value = data?.oauthAccount?.emailAddress;
    if (typeof value === 'string' && value.length <= 254 && EMAIL.test(value)) email = value;
  } catch { email = undefined; }
  if (emailCache.size > 32) emailCache.clear();
  emailCache.set(key, email);
  return email;
}

/**
 * Every Claude config directory on this PC, canonical one first. The canonical
 * directory is always listed, logged in or not, so its card can ask for a login.
 */
export async function listClaudeAccounts({ homeDir = homedir(), env = process.env } = {}) {
  const home = resolve(homeDir);
  const primaryDir = configuredDir(env?.CLAUDE_CONFIG_DIR, home) ?? join(home, '.claude');
  const found = [{ id: 'claude', configDir: primaryDir, suffix: '' }];
  const seen = new Set([primaryDir]);
  const used = new Set(['claude']);
  let entries = [];
  try { entries = await readdir(home, { withFileTypes: true }); } catch { /* an unreadable home directory yields the canonical account only */ }
  const extras = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!CLAUDE_DIR_NAME.test(entry.name)) continue;
    const configDir = resolve(home, entry.name);
    if (seen.has(configDir)) continue;
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && await isDirectory(configDir))) continue;
    if (!await hasCredentials(configDir)) continue;
    seen.add(configDir);
    extras.push({ configDir, suffix: slug(entry.name.replace(/^\.claude[-_.]?/, '')) });
  }
  for (const [index, extra] of extras.entries()) {
    let id = extra.suffix ? `claude-${extra.suffix}` : `claude-${index + 2}`;
    for (let attempt = 2; used.has(id); attempt += 1) id = `claude-${extra.suffix || index + 2}-${attempt}`;
    used.add(id);
    found.push({ ...extra, id });
  }
  const accounts = await Promise.all(found.map(async account => {
    // Claude Code writes `.claude.json` inside CLAUDE_CONFIG_DIR, but beside the home
    // directory for the default `~/.claude`.
    const email = await readEmail(join(account.configDir, '.claude.json'))
      ?? (account.id === 'claude' ? await readEmail(join(home, '.claude.json')) : undefined);
    return { ...account, ...(email ? { email } : {}), type: 'claude', credentialFile: join(account.configDir, '.credentials.json'), loginCommand: LOGIN_COMMANDS.claude };
  }));
  // A single subscription keeps the plain "Claude" card it has always had.
  if (accounts.length === 1) return [{ ...accounts[0], name: 'Claude' }];
  const counts = new Map();
  for (const account of accounts) {
    const key = account.email ? account.email.split('@')[0] : '';
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return accounts.map(account => {
    const local = account.email ? account.email.split('@')[0] : '';
    const label = local && counts.get(local) === 1 ? local : account.email || account.suffix || 'main';
    return { ...account, name: `Claude · ${label}` };
  });
}

/** Ordered account list: every Claude login first, then ChatGPT and Grok. */
export async function listAccounts({ homeDir = homedir(), env = process.env } = {}) {
  const home = resolve(homeDir);
  return [
    ...await listClaudeAccounts({ homeDir: home, env }),
    { id: 'chatgpt', type: 'chatgpt', name: 'ChatGPT', credentialFile: credentialPath('chatgpt', home), loginCommand: LOGIN_COMMANDS.chatgpt },
    { id: 'grok', type: 'grok', name: 'Grok', credentialFile: credentialPath('grok', home), loginCommand: LOGIN_COMMANDS.grok },
  ];
}
