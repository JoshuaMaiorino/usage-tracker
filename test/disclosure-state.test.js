import test from 'node:test';
import assert from 'node:assert/strict';
import { DisclosureState } from '../public/disclosure-state.js';

const limit = (usedPercent, id = 'weekly-fable') => ({ id, scope: 'Fable', durationSeconds: 604800, usedPercent });

test('model limits open when approaching or reaching exhaustion, but account details start closed', () => {
  const state = new DisclosureState();
  assert.equal(state.update('claude-details'), false);
  assert.equal(state.update('claude-models', [limit(89)]), false);
  assert.equal(state.update('claude-models', [limit(90)]), true);
  assert.equal(state.update('chatgpt-models', [limit(100)]), true);
});

test('a deliberate close survives ordinary polling and percentage changes within the same severity', () => {
  const state = new DisclosureState();
  assert.equal(state.update('models', [limit(91)]), true);
  state.setOpen('models', false);
  assert.equal(state.update('models', [limit(91)]), false);
  assert.equal(state.update('models', [limit(92)]), false);
  assert.equal(state.update('models', [limit(99.9)]), false);
  assert.equal(state.update('models', [limit(100)]), true);
  state.setOpen('models', false);
  assert.equal(state.update('models', [limit(101)]), false);
});

test('a newly urgent model reopens details even when another model is already exhausted', () => {
  const state = new DisclosureState();
  state.update('models', [limit(100), limit(89, 'weekly-other')]);
  state.setOpen('models', false);
  assert.equal(state.update('models', [limit(100), limit(90, 'weekly-other')]), true);
  state.setOpen('models', false);
  assert.equal(state.update('models', [limit(90, 'weekly-other'), limit(100)]), false);
  assert.equal(state.update('models', [limit(90, 'weekly-other'), limit(100), limit(90, 'new-model')]), true);
});

test('a new allowance cycle can alert again after its usage falls below the threshold', () => {
  const state = new DisclosureState();
  state.update('models', [limit(100)]);
  state.setOpen('models', false);
  assert.equal(state.update('models', [limit(0)]), false);
  assert.equal(state.update('models', [limit(90)]), true);
});

test('manual expansion persists through lower usage and account rows updating', () => {
  const state = new DisclosureState();
  state.update('models', [limit(20)]);
  state.setOpen('models', true);
  assert.equal(state.update('models', [limit(10)]), true);
  state.setOpen('details', true);
  assert.equal(state.update('details'), true);
  state.setOpen('details', false);
  assert.equal(state.update('details'), false);
});

test('invalid values do not create an alert and providers retain independent choices', () => {
  const state = new DisclosureState();
  assert.equal(state.update('claude-models', [limit(null), limit('100'), limit(NaN), limit(Infinity)]), false);
  assert.equal(state.update('chatgpt-models', [limit(100)]), true);
  assert.equal(state.update('claude-models', [limit(0)]), false);
});
