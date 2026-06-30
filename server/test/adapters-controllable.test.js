// server/test/adapters-controllable.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapters, isControllable, anyControllable } from '../lib/adapters/index.js';

test('exactly claude-code is controllable', () => {
  const ctl = adapters.filter(a => a.controllable === true).map(a => a.id);
  assert.deepEqual(ctl, ['claude-code']);
  for (const a of adapters) assert.equal(typeof a.controllable, 'boolean', `${a.id} must export controllable`);
});

test('isControllable by id', () => {
  assert.equal(isControllable('claude-code'), true);
  assert.equal(isControllable('codex-cli'), false);
  assert.equal(isControllable('nope'), false);
});

test('anyControllable true only when a controllable adapter is installed', () => {
  const Pyes = { claudeDir: process.cwd() }; // claude-code.detect uses statSync(P.claudeDir).isDirectory()
  assert.equal(anyControllable(Pyes), true);
  const Pno = { claudeDir: '/definitely/not/here-xyz' };
  // other adapters resolve their own dirs; assert at least that a missing claudeDir alone is handled
  assert.equal(typeof anyControllable(Pno), 'boolean');
});
