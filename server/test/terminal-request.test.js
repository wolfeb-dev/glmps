// server/test/terminal-request.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTerminalRequest } from '../lib/terminal-request.js';

const TERMINALS = [
  { label: 'Claude', command: 'claude', icon: 'claude' },
  { label: 'Gemini', command: 'gemini', icon: 'gemini' },
  { label: 'Blank', command: '', icon: 'terminal' },
];

// fsImpl stubs: dirs that exist vs files vs missing
const okDirFs = { statSync: () => ({ isDirectory: () => true }) };
const notDirFs = { statSync: () => ({ isDirectory: () => false }) };
const missingFs = { statSync: () => { throw new Error('ENOENT'); } };

test('resolves a known label to its command with the right record shape', () => {
  const { record, error } = buildTerminalRequest(
    { terminal: 'Claude', cwd: null }, TERMINALS, { now: 123 });
  assert.equal(error, undefined);
  assert.deepEqual(record, { type: 'terminal', command: 'claude', cwd: null, location: 'editor', ts: 123 });
});

test('unknown label is rejected', () => {
  const { record, error } = buildTerminalRequest({ terminal: 'Nope' }, TERMINALS);
  assert.equal(record, undefined);
  assert.match(error, /unknown terminal/);
});

test('blank-command label yields an empty command (open empty terminal)', () => {
  const { record, error } = buildTerminalRequest({ terminal: 'Blank', cwd: null }, TERMINALS, { now: 1 });
  assert.equal(error, undefined);
  assert.equal(record.command, '');
  assert.equal(record.type, 'terminal');
});

test('valid cwd (existing directory) is kept', () => {
  const { record, error } = buildTerminalRequest(
    { terminal: 'Claude', cwd: '/some/dir' }, TERMINALS, { now: 5, fsImpl: okDirFs });
  assert.equal(error, undefined);
  assert.equal(record.cwd, '/some/dir');
});

test('cwd that is not a directory is rejected', () => {
  const { record, error } = buildTerminalRequest(
    { terminal: 'Claude', cwd: '/some/file' }, TERMINALS, { fsImpl: notDirFs });
  assert.equal(record, undefined);
  assert.match(error, /cwd/);
});

test('missing cwd path is rejected', () => {
  const { record, error } = buildTerminalRequest(
    { terminal: 'Claude', cwd: '/nope' }, TERMINALS, { fsImpl: missingFs });
  assert.equal(record, undefined);
  assert.match(error, /cwd/);
});

test('non-string cwd is rejected', () => {
  const { error } = buildTerminalRequest({ terminal: 'Claude', cwd: 42 }, TERMINALS);
  assert.match(error, /cwd/);
});

test('omitted cwd produces a null-cwd record', () => {
  const { record, error } = buildTerminalRequest({ terminal: 'Claude' }, TERMINALS, { now: 9 });
  assert.equal(error, undefined);
  assert.equal(record.cwd, null);
});

test('non-array terminals config is handled (no crash, unknown)', () => {
  const { error } = buildTerminalRequest({ terminal: 'Claude' }, undefined);
  assert.match(error, /unknown terminal/);
});
