// server/test/act-gate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCanAct } from '../lib/act-gate.js';

const ctlAdapter = { id: 'claude-code', controllable: true, detect: () => ({ installed: true }) };
const foreignAdapter = { id: 'codex-cli', controllable: false, detect: () => ({ installed: true }) };

test('allows when a controllable adapter is installed', () => {
  assert.deepEqual(assertCanAct({}, [ctlAdapter]), { ok: true });
});

test('blocks 409 when only foreign adapters are installed', () => {
  const r = assertCanAct({}, [foreignAdapter]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'observe-only');
});
