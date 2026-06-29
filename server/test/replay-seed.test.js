import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedFromOutcomes } from '../lib/replay-seed.js';

const good = (id, cls) => ({ id, taskClass: cls, committed: true, verifier: { exitOk: true }, revertedLater: false });

test('only known-good rows are seeded', () => {
  const rows = [
    good('a', 'feature'),
    { id: 'b', taskClass: 'feature', committed: false, verifier: { exitOk: true } }, // not committed
    { id: 'c', taskClass: 'feature', committed: true, verifier: { exitOk: false } }, // failed verifier
    { id: 'd', taskClass: 'feature', committed: true, verifier: { exitOk: true }, revertedLater: true }, // reverted
  ];
  const seeded = seedFromOutcomes(rows);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].id, 'replay-a');
  assert.equal(seeded[0].baseline.id, 'a');
});

test('caps perClass and stratifies', () => {
  const rows = [good('a','feature'), good('b','feature'), good('c','feature'), good('x','debug')];
  const seeded = seedFromOutcomes(rows, { perClass: 2 });
  const byClass = seeded.reduce((m,t)=>{ (m[t.baseline.taskClass] ??= 0); m[t.baseline.taskClass]++; return m; }, {});
  assert.equal(byClass.feature, 2);
  assert.equal(byClass.debug, 1);
});

test('empty -> []', () => {
  assert.deepEqual(seedFromOutcomes([]), []);
});
