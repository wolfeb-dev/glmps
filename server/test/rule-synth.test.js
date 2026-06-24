import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRule } from '../lib/rule-synth.js';

// ---------------------------------------------------------------------------
// happy path: rule matches ALL missed + NONE held-out -> ok true
// ---------------------------------------------------------------------------

test('ok true when regex matches all missed and zero held-out', () => {
  const result = validateRule(
    'style|layout|css',
    ['update the styles', 'tweak the layout'],
    ['fix the server bug', 'add a test'],
  );
  assert.equal(result.ok, true);
  assert.equal(result.matchedMissed, 2);
  assert.deepEqual(result.overMatched, []);
});

test('ok true with a single missed prompt and no held-out array', () => {
  const result = validateRule('restyle', ['restyle the button']);
  assert.equal(result.ok, true);
  assert.equal(result.matchedMissed, 1);
  assert.deepEqual(result.overMatched, []);
});

test('ok true when held-out array is explicitly empty', () => {
  const result = validateRule('brainstorm|plan', ['plan this feature'], []);
  assert.equal(result.ok, true);
  assert.equal(result.matchedMissed, 1);
  assert.deepEqual(result.overMatched, []);
});

// ---------------------------------------------------------------------------
// ok false: rule also matches a held-out prompt -> overMatched populated
// ---------------------------------------------------------------------------

test('ok false when rule matches a held-out prompt', () => {
  const result = validateRule(
    'frontend.design',
    ['invoke frontend-design skill for header'],
    ['add frontend-design skill note', 'fix the server'],
  );
  assert.equal(result.ok, false);
  assert.equal(result.matchedMissed, 1);
  assert.ok(result.overMatched.length > 0, 'overMatched should be populated');
  assert.ok(result.overMatched.includes('add frontend-design skill note'));
});

test('ok false when rule matches ALL held-out prompts', () => {
  const result = validateRule(
    'foo',
    ['a foo thing'],
    ['another foo thing', 'yet more foo'],
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.overMatched, ['another foo thing', 'yet more foo']);
});

test('ok false when rule matches SOME held-out prompts', () => {
  const result = validateRule(
    'css',
    ['change the css color'],
    ['pure server fix', 'update css variables', 'refactor db'],
  );
  assert.equal(result.ok, false);
  assert.ok(result.overMatched.includes('update css variables'));
  assert.ok(!result.overMatched.includes('pure server fix'));
  assert.ok(!result.overMatched.includes('refactor db'));
});

// ---------------------------------------------------------------------------
// ok false: rule misses one or more missed prompts
// ---------------------------------------------------------------------------

test('ok false when regex misses a missed prompt', () => {
  const result = validateRule(
    'layout',
    ['tweak layout', 'fix typo in server code'],
    [],
  );
  assert.equal(result.ok, false);
  assert.equal(result.matchedMissed, 1); // matches 'tweak layout' but not 'fix typo in server code'
  assert.deepEqual(result.overMatched, []);
});

test('ok false when regex matches none of the missed prompts', () => {
  const result = validateRule(
    'subagent-dispatch',
    ['refactor db layer', 'add unit tests'],
    [],
  );
  assert.equal(result.ok, false);
  assert.equal(result.matchedMissed, 0);
  assert.deepEqual(result.overMatched, []);
});

// ---------------------------------------------------------------------------
// ok false: missedPrompts is empty (no missed prompts to validate against)
// ---------------------------------------------------------------------------

test('ok false when missedPrompts is empty even if no held-out matches', () => {
  const result = validateRule('anything', [], ['safe prompt']);
  assert.equal(result.ok, false);
  assert.equal(result.matchedMissed, 0);
});

test('ok false when both arrays are empty', () => {
  const result = validateRule('anything', [], []);
  assert.equal(result.ok, false);
  assert.equal(result.matchedMissed, 0);
  assert.deepEqual(result.overMatched, []);
});

test('ok false when missedPrompts defaults (omitted) and held-out also empty', () => {
  const result = validateRule('anything');
  assert.equal(result.ok, false);
  assert.equal(result.matchedMissed, 0);
  assert.deepEqual(result.overMatched, []);
});

// ---------------------------------------------------------------------------
// invalid regex -> ok false with error field
// ---------------------------------------------------------------------------

test('invalid regex returns ok false with error:invalid-regex', () => {
  const result = validateRule('[invalid(regex');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid-regex');
  assert.equal(result.matchedMissed, 0);
  assert.deepEqual(result.overMatched, []);
});

test('invalid regex with missedPrompts still returns error:invalid-regex', () => {
  const result = validateRule('***', ['some missed prompt'], ['held-out']);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid-regex');
});

// ---------------------------------------------------------------------------
// case-insensitive matching (the 'i' flag is applied)
// ---------------------------------------------------------------------------

test('matching is case-insensitive', () => {
  const result = validateRule(
    'FRONTEND.DESIGN',
    ['use the frontend-design skill here'],
    ['unrelated task'],
  );
  assert.equal(result.ok, true);
  assert.equal(result.matchedMissed, 1);
});

// ---------------------------------------------------------------------------
// overMatched is an array of the actual matched held-out strings
// ---------------------------------------------------------------------------

test('overMatched contains the actual held-out strings that matched', () => {
  const result = validateRule(
    'brainstorm',
    ['brainstorm a feature'],
    ['a brainstorm session needed', 'boring server work', 'another brainstorm needed'],
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.overMatched.sort(), [
    'a brainstorm session needed',
    'another brainstorm needed',
  ]);
});
