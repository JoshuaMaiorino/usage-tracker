import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSelectionChanges, mergeAccountSelections } from '../public/settings-state.js';

test('saving an unchanged form does not disable a login discovered at save time', () => {
  const saved = { claude: true, chatgpt: true, grok: false };
  const form = { ...saved };
  const discovered = { ...saved, grok: true };
  const patch = accountSelectionChanges(saved, form);
  assert.deepEqual(patch, {});
  assert.deepEqual({ ...discovered, ...patch }, discovered);
});

test('save includes only deliberate account changes and preserves another viewer’s untouched choices', () => {
  const saved = { claude: true, chatgpt: true, grok: false };
  const form = { claude: false, chatgpt: true, grok: false };
  const latest = { claude: true, chatgpt: false, grok: true };
  const patch = accountSelectionChanges(saved, form);
  assert.deepEqual(patch, { claude: false });
  assert.deepEqual({ ...latest, ...patch }, { claude: false, chatgpt: false, grok: true });
});

test('rescan adopts newly enabled accounts while preserving an unsaved opt-out', () => {
  const saved = { claude: true, chatgpt: true, grok: false };
  const form = { claude: false, chatgpt: true, grok: false };
  const discovered = { claude: true, chatgpt: true, grok: true };
  const merged = mergeAccountSelections(saved, form, discovered);
  assert.deepEqual(merged, { claude: false, chatgpt: true, grok: true });
  assert.deepEqual(accountSelectionChanges(discovered, merged), { claude: false });
});

test('changing a checkbox back to its saved value removes the pending edit', () => {
  const saved = { claude: false, chatgpt: true };
  assert.deepEqual(accountSelectionChanges(saved, { claude: true, chatgpt: true }), { claude: true });
  assert.deepEqual(accountSelectionChanges(saved, { claude: false, chatgpt: true }), {});
});

test('untouched missing accounts are omitted and reconciliation does not mutate its inputs', () => {
  const saved = Object.freeze({ claude: true });
  const form = Object.freeze({ claude: false, grok: false });
  const incoming = Object.freeze({ claude: true, grok: true });
  assert.deepEqual(accountSelectionChanges(saved, form), { claude: false });
  assert.deepEqual(mergeAccountSelections(saved, form, incoming), { claude: false, grok: true });
});
