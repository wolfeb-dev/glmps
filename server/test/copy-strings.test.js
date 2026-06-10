// server/test/copy-strings.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invocationFor } from '../../web/copy-strings.js';

test('skill, agent, memory invocations', () => {
  assert.equal(invocationFor({ type: 'skill', name: 'dcf', plugin: 'financial-analysis' }),
    '/financial-analysis:dcf');
  assert.equal(invocationFor({ type: 'skill', name: 'code-review', plugin: null }), '/code-review');
  assert.equal(invocationFor({ type: 'skill', name: 'nq', plugin: 'project' }), '/nq');
  assert.equal(invocationFor({ type: 'agent', name: 'Explore' }),
    'Use the Explore agent for this task');
  assert.equal(invocationFor({ type: 'memory', path: 'C:\\u\\memory\\note.md' }),
    'Read C:\\u\\memory\\note.md before continuing');
  assert.equal(invocationFor({ type: 'context-file', path: 'D:\\p\\CLAUDE.md' }),
    'Read D:\\p\\CLAUDE.md before continuing');
});
