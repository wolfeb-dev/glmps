// Phase 0 substrate integration: exercise outcome-record + task-classify +
// outcome-store + cross-model-eval together as they will be composed downstream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyOutcome, mergeOutcome } from '../lib/outcome-record.js';
import { classifyTask } from '../lib/task-classify.js';
import { appendOutcome, readOutcomes, updateOutcome } from '../lib/outcome-store.js';
import { criticDisagreement } from '../lib/cross-model-eval.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-outcome-int-')); }

test('classify -> build -> append -> read -> backfill round trip', async () => {
  const d = tmp();
  const { taskClass } = classifyTask({
    firstPrompt: 'implement a new outcomes panel',
    filesTouched: ['web/outcomes.js'],
  });
  assert.equal(taskClass, 'feature');

  let row = emptyOutcome({ id: 'session-int-1', unit: 'session', taskClass });
  row = mergeOutcome(row, { turns: 5, verifier: { tests: true }, committed: true, revertedLater: null });
  appendOutcome(d, row);

  const read = readOutcomes(d, { unit: 'session' });
  assert.equal(read.length, 1);
  assert.equal(read[0].taskClass, 'feature');
  assert.equal(read[0].verifier.tests, true);
  assert.equal(read[0].turns, 5);

  // lagging-truth backfill
  updateOutcome(d, 'session-int-1', { revertedLater: false });
  assert.equal(readOutcomes(d)[0].revertedLater, false);
});

test('cross-model critic disagreement stays fail-open with no key', async () => {
  // No ANTHROPIC_API_KEY supplied -> null, never throws, no network.
  const v = await criticDisagreement({ question: 'q', answer: 'a', apiKey: '' });
  assert.equal(v, null);
});
