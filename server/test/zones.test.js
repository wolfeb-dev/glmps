// server/test/zones.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPath, classifyTier, sessionScope, DEFAULT_ZONE_CONFIG } from '../lib/zones.js';

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

// ── Task 3: tier axis ─────────────────────────────────────────────────────────

const cfg = {
  ...DEFAULT_ZONE_CONFIG,
  tierRoots: {
    artifact: ['/c/acme/api'],
    brain: ['/c/assets'],
    ephemeral: ['/c/state'],
  },
};

test('classifyTier matches absolute roots with artifact<brain<ephemeral precedence', () => {
  assert.equal(classifyTier('/c/acme/api/src/x.js', cfg), 1);
  assert.equal(classifyTier('/c/assets/skills/y.md', cfg), 2);
  assert.equal(classifyTier('/c/state/index.json', cfg), 3);
  assert.equal(classifyTier('/c/other/z', cfg), null);
});

test('classifyPath reports tier alongside zone/env without disturbing them', () => {
  const r = classifyPath('/c/acme/api/web/app.js', { projectRoot: '/c/acme/api', config: cfg });
  assert.equal(r.zone, 'web');
  assert.equal(r.env, 'dev');
  assert.equal(r.tier, 1);
  assert.equal(r.protected, false);
});

test('default config (no tierRoots) yields tier null and existing shape', () => {
  const r = classifyPath('server/lib/x.js', { relative: true });
  assert.equal(r.tier, null);
  assert.equal(r.zone, 'server/lib');
});

test('sessionScope aggregates per-tier counts', () => {
  const s = sessionScope(['/c/acme/api/a.js', '/c/assets/b.md', '/c/state/c.json', '/c/none/d'], { config: cfg });
  assert.equal(s.tiers.artifact, 1);
  assert.equal(s.tiers.brain, 1);
  assert.equal(s.tiers.ephemeral, 1);
  assert.equal(s.tiers.untiered, 1);
});

test('classifyPath: protected+tiered path reports both independently', () => {
  const cfgMixed = { ...cfg, protectedRoots: ['/c/acme/api'] };
  const r = classifyPath('/c/acme/api/server/x.js', { config: cfgMixed });
  assert.equal(r.env, 'prod');
  assert.equal(r.protected, true);
  assert.equal(r.tier, 1);
});
