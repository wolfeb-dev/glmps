import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyOutcome, mergeOutcome } from '../lib/outcome-record.js';

test('emptyOutcome fills schema with nulls + overrides', () => {
  const o = emptyOutcome({ id: 'x', unit: 'session' });
  assert.equal(o.id, 'x');
  assert.equal(o.unit, 'session');
  assert.equal(o.turns, null);
  assert.deepEqual(o.extra, {});
  assert.equal(o.verifier.tests, null);
  assert.equal(o.wallClockMs.total, null);
});

test('emptyOutcome accepts nested override', () => {
  const o = emptyOutcome({ verifier: { tests: true } });
  assert.equal(o.verifier.tests, true);
  assert.equal(o.verifier.lint, null);
});

test('mergeOutcome deep-merges nested groups without dropping siblings', () => {
  const base = emptyOutcome({ verifier: { lint: true } });
  const merged = mergeOutcome(base, { verifier: { tests: true }, turns: 4 });
  assert.equal(merged.verifier.tests, true);
  assert.equal(merged.verifier.lint, true);
  assert.equal(merged.turns, 4);
  assert.equal(base.turns, null); // base not mutated
});
