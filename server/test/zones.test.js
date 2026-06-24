// server/test/zones.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPath, sessionScope, DEFAULT_ZONE_CONFIG } from '../lib/zones.js';

const ROOT = 'D:\\glmps';

test('classifyPath: prefix match returns dev zone (longest wins)', () => {
  const a = classifyPath('D:\\glmps\\server\\lib\\agent-fleet.js', { projectRoot: ROOT });
  assert.equal(a.zone, 'server/lib'); assert.equal(a.env, 'dev'); assert.equal(a.protected, false);
  const b = classifyPath('D:\\glmps\\server\\server.js', { projectRoot: ROOT });
  assert.equal(b.zone, 'server'); assert.equal(b.env, 'dev');
  const c = classifyPath('D:\\glmps\\web\\agents.js', { projectRoot: ROOT });
  assert.equal(c.zone, 'web'); assert.equal(c.env, 'dev');
});

test('classifyPath: protected segment/root => prod, protected:true', () => {
  const seg = classifyPath('D:\\anything\\prod\\live.py', { projectRoot: 'D:\\anything' });
  assert.equal(seg.env, 'prod'); assert.equal(seg.protected, true);
  const root = classifyPath('D:\\glmps_prod\\strategy.py',
    { projectRoot: ROOT, config: { ...DEFAULT_ZONE_CONFIG, protectedRoots: ['D:\\glmps_prod'] } });
  assert.equal(root.env, 'prod'); assert.equal(root.protected, true);
});

test('classifyPath: unknown prefix falls back to first segment, dev', () => {
  const r = classifyPath('D:\\glmps\\scripts\\x.mjs', { projectRoot: ROOT });
  assert.equal(r.zone, 'scripts'); assert.equal(r.env, 'dev'); assert.equal(r.protected, false);
});

test('classifyPath: relative source_file (graph node) classifies without projectRoot', () => {
  const r = classifyPath('lib/adapters/agy-cli.js', { relative: true });
  assert.equal(r.zone, 'lib'); assert.equal(r.env, 'dev');
});

test('sessionScope aggregates zones, flags protected hits, allDev', () => {
  const clean = sessionScope([
    'D:\\glmps\\server\\lib\\agent-fleet.js',
    'D:\\glmps\\server\\lib\\loop-stage.js',
    'D:\\glmps\\web\\agents.js',
  ], { projectRoot: ROOT });
  assert.equal(clean.allDev, true);
  assert.equal(clean.protected.length, 0);
  assert.equal(clean.touched, 3);
  const sl = clean.zones.find(z => z.zone === 'server/lib');
  assert.equal(sl.count, 2);

  const dirty = sessionScope([
    'D:\\glmps\\web\\agents.js',
    'D:\\glmps_prod\\strategy.py',
  ], { projectRoot: ROOT, config: { ...DEFAULT_ZONE_CONFIG, protectedRoots: ['D:\\glmps_prod'] } });
  assert.equal(dirty.allDev, false);
  assert.equal(dirty.protected.length, 1);
  assert.equal(dirty.protected[0].path, 'D:\\glmps_prod\\strategy.py');
});
