import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msprt, cuped } from '../lib/sequential-test.js';

test('clearly-better B is decided B', () => {
  const A = [0,0,0,0,0,0,0,0];
  const B = [1,1,1,1,1,1,1,1];
  const r = msprt(A, B);
  assert.equal(r.decision, 'B');
});

test('indistinguishable arms stay continue', () => {
  const A = [1,2,3,2,1,2,3,2];
  const B = [1,2,3,2,1,2,3,2];
  assert.equal(msprt(A, B).decision, 'continue');
});

test('empty -> continue n0', () => {
  assert.deepEqual(msprt([], []), { decision: 'continue', llr: 0, n: 0 });
});

test('cuped reduces variance for correlated covariate', () => {
  const x = [1,2,3,4,5,6,7,8];
  const y = x.map(v => 2*v + 0.1); // perfectly correlated
  const adj = cuped(y, x);
  const varOf = a => { const m=a.reduce((s,v)=>s+v,0)/a.length; return a.reduce((s,v)=>s+(v-m)**2,0)/a.length; };
  assert.ok(varOf(adj) < varOf(y));
});
