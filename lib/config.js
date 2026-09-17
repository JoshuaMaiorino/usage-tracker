import { mkdir, readFile, open, rename, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_PROVIDER_IDS, isAccountId } from './providers/shared.js';

export const PROVIDER_IDS = BASE_PROVIDER_IDS;
export const MIN_INTERVAL_MS = 120_000;
export const DEFAULT_INTERVAL_MS = 180_000;

/**
 * Ids a config file must cover: the discovered accounts first, in dashboard order, then
 * any base provider that has no login yet, then ids a previous run stored. Keeping
 * stored ids means unplugging a second Claude config directory does not discard the
 * choice made for it.
 */
export function accountIds(accounts = [], stored = []) {
  const ids = [];
  const add = id => { if (isAccountId(id) && !ids.includes(id)) ids.push(id); };
  for (const account of accounts) add(account?.id);
  for (const id of BASE_PROVIDER_IDS) add(id);
  for (const id of stored) add(id);
  return ids;
}

export function validateSettings(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Settings must be a JSON object.');
  }
  const allowed = new Set(['enabled', 'refreshIntervalMs', 'lanEnabled', 'enableAll']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('Unknown setting.');
  const settings = structuredClone(current);
  if ('enabled' in input) {
    if (!input.enabled || typeof input.enabled !== 'object' || Array.isArray(input.enabled)) {
      throw new Error('Enabled accounts must be an object.');
    }
    for (const [id, enabled] of Object.entries(input.enabled)) {
      if (!isAccountId(id) || typeof enabled !== 'boolean') throw new Error('Invalid account setting.');
      settings.enabled[id] = enabled;
      // An explicit changed choice must survive discovery, including opting out
      // before a login exists. Unchanged missing-account checkboxes aren't opt-outs.
      if (enabled !== current.enabled[id]) settings.seen[id] = true;
    }
  }
  if ('refreshIntervalMs' in input) {
    if (!Number.isInteger(input.refreshIntervalMs) || input.refreshIntervalMs < MIN_INTERVAL_MS || input.refreshIntervalMs > 3_600_000) {
      throw new Error('Refresh interval must be between 2 and 60 minutes.');
    }
    settings.refreshIntervalMs = input.refreshIntervalMs;
  }
  if ('lanEnabled' in input) {
    if (typeof input.lanEnabled !== 'boolean') throw new Error('LAN setting must be true or false.');
    settings.lanEnabled = input.lanEnabled;
  }
  if ('enableAll' in input && typeof input.enableAll !== 'boolean') throw new Error('Enable all must be true or false.');
  return settings;
}

/** Enable each newly discovered supported login once; never undo a saved choice. */
export function applyDiscovery(settings, accounts) {
  const next = structuredClone(settings);
  for (const id of accountIds(accounts, Object.keys(settings.seen ?? {}))) {
    if (next.enabled[id] === undefined) next.enabled[id] = false;
    if (next.seen[id] === undefined) next.seen[id] = false;
    if (!next.seen[id] && accounts.some(account => account.id === id && account.found)) {
      next.enabled[id] = true;
      next.seen[id] = true;
    }
  }
  return next;
}

// One queue per file also serializes multiple instances created by integration tests.
const queues = new Map();
export class ConfigStore {
  constructor(path) { this.path = path; }

  async load(accounts) {
    const found = id => accounts.some(account => account.id === id && account.found);
    const makeDefaults = ids => ({
      enabled: Object.fromEntries(ids.map(id => [id, found(id)])),
      seen: Object.fromEntries(ids.map(id => [id, found(id)])),
      refreshIntervalMs: DEFAULT_INTERVAL_MS,
      lanEnabled: false,
    });
    const defaults = makeDefaults(accountIds(accounts));
    let raw;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not read data/config.json. Check its permissions.');
      await this.save(defaults);
      return defaults;
    }
    let settings;
    let stored;
    try {
      stored = JSON.parse(raw);
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error();
      const { seen, ...editable } = stored;
      const ids = accountIds(accounts, [...Object.keys(editable.enabled ?? {}), ...Object.keys(seen ?? {})]);
      settings = validateSettings(editable, makeDefaults(ids));
      if (seen !== undefined && (!seen || typeof seen !== 'object' || Array.isArray(seen)
        || Object.entries(seen).some(([id, value]) => !isAccountId(id) || typeof value !== 'boolean'))) throw new Error();
      settings.seen = Object.fromEntries(ids.map(id => [id,
        // Old builds cannot distinguish a missing login from a deliberate opt-out.
        // Preserve every explicitly stored choice when migrating their config.
        seen === undefined ? Object.hasOwn(stored.enabled || {}, id) || found(id) : seen[id] ?? found(id),
      ]));
      settings = applyDiscovery(settings, accounts);
    } catch { throw new Error('data/config.json is invalid. Correct it or remove it to rediscover accounts.'); }
    if (JSON.stringify(stored) !== JSON.stringify(settings)) await this.save(settings);
    return settings;
  }

  async save(settings) {
    const previous = queues.get(this.path) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      let handle;
      try {
        const mode = await stat(this.path).then(info => info.mode & 0o777, () => 0o600);
        handle = await open(temp, 'wx', mode & 0o600);
        await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temp, this.path);
      } finally {
        await handle?.close();
        await unlink(temp).catch(() => {});
      }
    });
    queues.set(this.path, operation);
    try { await operation; }
    finally { if (queues.get(this.path) === operation) queues.delete(this.path); }
  }
}
