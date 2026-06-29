import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask } from '../lib/task-classify.js';

test('debug from fix/bug + test file', () => {
  assert.equal(classifyTask({ firstPrompt: 'fix the failing auth bug', filesTouched: ['src/auth.test.js'] }).taskClass, 'debug');
});
test('feature from implement + new file', () => {
  assert.equal(classifyTask({ firstPrompt: 'implement a new export button', filesTouched: ['src/export.js'] }).taskClass, 'feature');
});
test('refactor', () => {
  assert.equal(classifyTask({ firstPrompt: 'refactor and simplify the parser' }).taskClass, 'refactor');
});
test('docs when all md', () => {
  assert.equal(classifyTask({ firstPrompt: 'update the readme', filesTouched: ['README.md','docs/x.md'] }).taskClass, 'docs');
});
test('research with no edits', () => {
  assert.equal(classifyTask({ firstPrompt: 'investigate and compare options for caching', filesTouched: [] }).taskClass, 'research');
});
test('empty -> other low confidence', () => {
  const r = classifyTask({ firstPrompt: '', filesTouched: [] });
  assert.equal(r.taskClass, 'other');
  assert.ok(r.confidence <= 0.34);
});
