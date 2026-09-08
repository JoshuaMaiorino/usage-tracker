import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../lib/config.js';

const discovered = ['claude', 'chatgpt', 'grok'].map(id => ({ id, found: true }));

async function fixture(t, config) {
  const dir = await mkdtemp(join(tmpdir(), 'combined-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  if (config) await writeFile(path, JSON.stringify(config));
  return { store: new ConfigStore(path), path };
}

test('legacy config migration conservatively preserves all stored opt-outs', async t => {
  const { store, path } = await fixture(t, {
    enabled: { claude: false, chatgpt: true, grok: false }, refreshIntervalMs: 300_000, lanEnabled: true,
  });
  const settings = await store.load(discovered);
  assert.deepEqual(settings.enabled, { claude: false, chatgpt: true, grok: false });
  assert.deepEqual(settings.seen, { claude: true, chatgpt: true, grok: true });
  assert.equal(settings.refreshIntervalMs, 300_000);
  assert.equal(settings.lanEnabled, true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), settings);
});

test('a login added between runs is enabled and discovery history persists', async t => {
  const { store } = await fixture(t);
  const first = await store.load(discovered.map(account => ({ ...account, found: account.id === 'claude' })));
  assert.deepEqual(first.seen, { claude: true, chatgpt: false, grok: false });
  const next = await store.load(discovered);
  assert.deepEqual(next.enabled, { claude: true, chatgpt: true, grok: true });
  assert.deepEqual(next.seen, { claude: true, chatgpt: true, grok: true });
});

test('malformed discovery history is rejected without overwriting the config', async t => {
  for (const seen of [null, [], { grok: 'yes' }, { gemini: true }]) {
    const { store, path } = await fixture(t, { enabled: {}, seen });
    const original = await readFile(path, 'utf8');
    await assert.rejects(store.load(discovered), /config.json is invalid/);
    assert.equal(await readFile(path, 'utf8'), original);
  }
});
