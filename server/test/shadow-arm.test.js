import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordShadow, shadowRates } from '../lib/shadow-arm.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-shadow-')); }

test('counterfactual rate is independent of actual fires', () => {
  const d = tmp();
  // would have fired 3/4 times, but only actually fired 1/4 (shadow slice)
  recordShadow(d, { taskClass: 'feature', wouldFire: true, fired: true });
  recordShadow(d, { taskClass: 'feature', wouldFire: true, fired: false });
  recordShadow(d, { taskClass: 'feature', wouldFire: true, fired: false });
  recordShadow(d, { taskClass: 'feature', wouldFire: false, fired: false });
  const r = shadowRates(d);
  assert.equal(r.byClass.feature.n, 4);
  assert.equal(r.byClass.feature.counterfactualRate, 0.75);
  assert.equal(r.byClass.feature.fireRate, 0.25);
});

test('missing file -> empty', () => {
  assert.deepEqual(shadowRates(tmp()), { byClass: {} });
});
