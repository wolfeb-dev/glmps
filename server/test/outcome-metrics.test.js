import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, summarizeOutcomes } from '../lib/outcome-metrics.js';

test('turns, wall-clock, toolWait, ctx', () => {
  const events = [
    { kind: 'prompt', ts: 1000 },
    { kind: 'tool', tool: 'Bash', ts: 1200 },
    { kind: 'tool_result', ts: 1700, error: false },
    { kind: 'tool', tool: 'Edit', ts: 1800 },
    { kind: 'tool_result', ts: 1850, error: true },
    { kind: 'answer', ts: 2000 },
  ];
  const m = computeMetrics({ events, usage: { input: 10, output: 20, ctxUsedPct: 40 } });
  assert.equal(m.turns, 1);
  assert.equal(m.wallClockMs.total, 1000);
  assert.equal(m.wallClockMs.toolWait, 550);
  assert.equal(m.toolCalls, 2);
  assert.equal(m.toolErrors, 1);
  assert.equal(m.tokens.in, 10);
  assert.equal(m.contextUsageRatio, 0.4);
  assert.equal(m.firstTry, true);
});

test('empty events -> nulls, no throw', () => {
  const m = computeMetrics({ events: [], usage: null });
  assert.equal(m.wallClockMs.total, null);
  assert.equal(m.toolCalls, 0);
  assert.equal(m.tokens.in, null);
  assert.equal(m.contextUsageRatio, null);
});

test('summarizeOutcomes aggregates by taskClass', () => {
  const rows = [
    { taskClass: 'feature', turns: 3, firstTry: true, verifier: { exitOk: true }, contextUsageRatio: 0.5 },
    { taskClass: 'feature', turns: 5, firstTry: false, verifier: { exitOk: false }, contextUsageRatio: 0.7 },
    { taskClass: 'debug', turns: 2, firstTry: true, verifier: { exitOk: null }, contextUsageRatio: null },
  ];
  const s = summarizeOutcomes(rows);
  assert.equal(s.byClass.feature.n, 2);
  assert.equal(s.byClass.feature.medianTurns, 4);
  assert.equal(s.byClass.feature.verifierPassRate, 0.5);
  assert.equal(s.byClass.feature.firstTryRate, 0.5);
  assert.equal(s.byClass.debug.verifierPassRate, null);
});
