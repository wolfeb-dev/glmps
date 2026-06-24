// server/test/zone-config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPaths } from '../lib/paths.js';
import { DEFAULT_ZONE_CONFIG } from '../lib/zones.js';

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
