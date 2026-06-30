// server/test/zone-config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPaths } from '../lib/paths.js';
import { DEFAULT_ZONE_CONFIG, mergeProtectedRoots } from '../lib/zones.js';

test('malformed GLMPS_ZONE_CONFIG does not throw and falls back to DEFAULT_ZONE_CONFIG', () => {
  let result;
  assert.doesNotThrow(() => { result = getPaths({ GLMPS_ZONE_CONFIG: '{not json' }); });
  assert.deepEqual(result.zoneConfig, DEFAULT_ZONE_CONFIG);
});

test('valid GLMPS_ZONE_CONFIG is parsed and used', () => {
  const custom = { prefixes: [], protectedSegments: ['prod'], protectedRoots: [] };
  const result = getPaths({ GLMPS_ZONE_CONFIG: JSON.stringify(custom) });
  assert.deepEqual(result.zoneConfig, custom);
});

test('absent GLMPS_ZONE_CONFIG yields DEFAULT_ZONE_CONFIG', () => {
  const result = getPaths({});
  assert.deepEqual(result.zoneConfig, DEFAULT_ZONE_CONFIG);
});

test('mergeProtectedRoots appends extra roots to protectedRoots and dedups', () => {
  const cfg = { prefixes: [], protectedSegments: ['prod'], protectedRoots: ['D:/glmps_prod'] };
  const out = mergeProtectedRoots(cfg, ['D:/live/NinjaTrader 8/bin/Custom', 'D:/glmps_prod']);
  assert.deepEqual(out.protectedRoots, ['D:/glmps_prod', 'D:/live/NinjaTrader 8/bin/Custom']);
  assert.deepEqual(out.protectedSegments, ['prod'], 'other keys preserved');
});

test('mergeProtectedRoots with empty extra leaves protectedRoots equivalent', () => {
  const out = mergeProtectedRoots(DEFAULT_ZONE_CONFIG, []);
  assert.deepEqual(out.protectedRoots, DEFAULT_ZONE_CONFIG.protectedRoots);
});

test('mergeProtectedRoots tolerates missing protectedRoots in the input config', () => {
  const out = mergeProtectedRoots({ prefixes: [], protectedSegments: [] }, ['D:/x']);
  assert.deepEqual(out.protectedRoots, ['D:/x']);
});
