import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateByUnit, promotionView } from '../lib/promotion-view.js';

const rows = [
  // champion unit 'v1' — 3 rows, decent
  { unit: 'v1', taskClass: 'feature', turns: 5, firstTry: true,  verifier: { exitOk: true },  contextUsageRatio: 0.5 },
  { unit: 'v1', taskClass: 'feature', turns: 5, firstTry: false, verifier: { exitOk: true },  contextUsageRatio: 0.5 },
  { unit: 'v1', taskClass: 'bug',     turns: 6, firstTry: true,  verifier: { exitOk: false }, contextUsageRatio: 0.4 },
  // challenger unit 'v2' — 2 rows, strictly better
  { unit: 'v2', taskClass: 'feature', turns: 3, firstTry: true,  verifier: { exitOk: true },  contextUsageRatio: 0.3 },
  { unit: 'v2', taskClass: 'bug',     turns: 3, firstTry: true,  verifier: { exitOk: true },  contextUsageRatio: 0.3 },
];

test('aggregateByUnit computes per-unit metrics', () => {
  const a = aggregateByUnit(rows);
  assert.equal(a.v1.n, 3);
  assert.equal(a.v2.n, 2);
  assert.equal(a.v1.medianTurns, 5);
  assert.equal(a.v2.medianTurns, 3);
  assert.equal(a.v2.verifierPassRate, 1);
});

test('promotionView: challenger dominates -> promote (champion = most outcomes)', () => {
  const v = promotionView(rows);
  assert.equal(v.available, true);
  assert.equal(v.champion.unit, 'v1'); // n=3
  assert.equal(v.challenger.unit, 'v2');
  assert.equal(v.verdict, 'promote');
  assert.equal(v.perMetric.medianTurns, 'better');
});

test('promotionView: explicit champion/challenger swap -> reject (regression)', () => {
  const v = promotionView(rows, { champion: 'v2', challenger: 'v1' });
  assert.equal(v.champion.unit, 'v2');
  assert.equal(v.challenger.unit, 'v1');
  assert.equal(v.verdict, 'reject'); // v1 worse on turns
});

test('promotionView: fewer than two units -> not available', () => {
  const v = promotionView([{ unit: 'only', turns: 3 }]);
  assert.equal(v.available, false);
  assert.match(v.reason, /two units/);
});
