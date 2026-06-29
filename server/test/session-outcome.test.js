import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSessionOutcome, finalizeSession, backfillReverts } from '../lib/session-outcome.js';
import { readOutcomes } from '../lib/outcome-store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sess-out-')); }

const fixture = {
  sessionId: 's1',
  firstPrompt: 'implement a new export feature',
  filesTouched: ['src/export.js'],
  usage: { input: 100, output: 50, ctxUsedPct: 30 },
  acceptanceText: '- [ ] tests pass\n- [x] builds\n',
  events: [
    { kind: 'prompt', ts: 1000 },
    { kind: 'tool', tool: 'Bash', label: 'npm test', ts: 1200 },
    { kind: 'tool_result', ok: true, ts: 1500 },
    { kind: 'git', label: 'commit abc123', ts: 1600 },
    { kind: 'answer', ts: 1700 },
  ],
};

test('buildSessionOutcome composes the modules', () => {
  const row = buildSessionOutcome(fixture);
  assert.equal(row.id, 'session-s1');
  assert.equal(row.unit, 'session');
  assert.equal(row.taskClass, 'feature');
  assert.equal(row.turns, 1);
  assert.equal(row.verifier.tests, true);
  assert.equal(row.acceptance.stated, 2);
  assert.equal(row.committed, true);
});

test('finalizeSession appends once and is idempotent', () => {
  const d = tmp();
  const a = finalizeSession(d, fixture);
  assert.equal(a.appended, true);
  const b = finalizeSession(d, fixture);
  assert.equal(b.appended, false);
  assert.equal(readOutcomes(d).length, 1);
});

test('backfillReverts marks a later-reverted session', () => {
  const d = tmp();
  finalizeSession(d, fixture);
  const n = backfillReverts(d, [{ kind: 'git', label: 'revert', sessionId: 's1' }]);
  assert.equal(n, 1);
  assert.equal(readOutcomes(d)[0].revertedLater, true);
});
