import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReplay } from '../lib/replay-run.js';

test('runs the injected launch and builds an outcome', async () => {
  const task = { id: 'replay-x', promptFile: '/p/x.txt' };
  const launch = async (t) => ({ sessionId: 'sx', events: [{ kind: 'prompt', ts: 1 }], usage: null, firstPrompt: 'do x', filesTouched: [] });
  const buildOutcome = (input) => ({ id: `session-${input.sessionId}`, unit: 'session', firstPrompt: input.firstPrompt });
  const { produced } = await runReplay('/state', task, { launch, buildOutcome });
  assert.equal(produced.id, 'session-sx');
});

test('failed launch yields produced null (no throw)', async () => {
  const launch = async () => { throw new Error('runner died'); };
  const { produced } = await runReplay('/state', { id: 'r' }, { launch, buildOutcome: () => ({}) });
  assert.equal(produced, null);
});
