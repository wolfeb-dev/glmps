import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreReplay } from '../lib/replay-score.js';

test('more turns regresses; better verifier improves', () => {
  const base = { turns: 3, verifier: { exitOk: false }, firstTry: false, tokens: {}, wallClockMs: {}, acceptance: {} };
  const prod = { turns: 5, verifier: { exitOk: true }, firstTry: true, tokens: {}, wallClockMs: {}, acceptance: {} };
  const s = scoreReplay(base, prod);
  assert.equal(s.perMetric.turns, 'worse');
  assert.equal(s.perMetric['verifier.exitOk'], 'better');
  assert.equal(s.perMetric.firstTry, 'better');
  assert.ok(s.regressed.includes('turns'));
  assert.ok(s.improved.includes('verifier.exitOk'));
});

test('nulls -> na', () => {
  const base = { turns: null, verifier: {}, tokens: {}, wallClockMs: {}, acceptance: {} };
  const prod = { turns: 4, verifier: {}, tokens: {}, wallClockMs: {}, acceptance: {} };
  assert.equal(scoreReplay(base, prod).perMetric.turns, 'na');
});

test('same value -> same', () => {
  const base = { turns: 3, verifier: {}, tokens: {}, wallClockMs: {}, acceptance: {} };
  const prod = { turns: 3, verifier: {}, tokens: {}, wallClockMs: {}, acceptance: {} };
  assert.equal(scoreReplay(base, prod).perMetric.turns, 'same');
});
