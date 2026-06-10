// server/test/adapters-gemini.test.js
// Fixture-based tests for the deepened gemini-cli adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as gemini from '../lib/adapters/gemini-cli.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gem-')); tmpDirs.push(d); return d; }
function makeP(geminiTmpDir) { return { geminiTmpDir }; }

// ── detect ───────────────────────────────────────────────────────────────────

test('gemini detect: installed=false when dir missing', () => {
  assert.equal(gemini.detect(makeP(path.join(os.tmpdir(), 'nope-gem-xyz'))).installed, false);
});

test('gemini detect: installed=false when dir empty', () => {
  assert.equal(gemini.detect(makeP(mkTmp())).installed, false);
});

test('gemini detect: installed=true with a subdir', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, 'some-project'));
  const { installed, dataDirs } = gemini.detect(makeP(tmp));
  assert.equal(installed, true);
  assert.deepEqual(dataDirs, [tmp]);
});

// ── mapToolName ───────────────────────────────────────────────────────────────

test('gemini mapToolName: known names map to common names', () => {
  assert.equal(gemini.mapToolName('read_file'), 'Read');
  assert.equal(gemini.mapToolName('write_file'), 'Write');
  assert.equal(gemini.mapToolName('replace'), 'Edit');
  assert.equal(gemini.mapToolName('run_shell_command'), 'Bash');
  assert.equal(gemini.mapToolName('search_file_content'), 'Grep');
  assert.equal(gemini.mapToolName('unknown_x'), 'unknown_x');
});

// ── discover ──────────────────────────────────────────────────────────────────

test('gemini discover: empty when tmp dir missing', () => {
  assert.deepEqual(gemini.discover(makeP(path.join(os.tmpdir(), 'nope-xyz'))), []);
});

test('gemini discover: .json -> json-snapshot, .jsonl -> jsonl-tail, ignores others', () => {
  const tmp = mkTmp();
  const chatsDir = path.join(tmp, 'proj', 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(path.join(chatsDir, 'session-1.json'), '{}');
  fs.writeFileSync(path.join(chatsDir, 'session-2.jsonl'), '');
  fs.writeFileSync(path.join(chatsDir, 'readme.txt'), 'x');

  const descs = gemini.discover(makeP(tmp));
  assert.equal(descs.length, 2);
  const byKind = Object.fromEntries(descs.map(d => [d.kind, d]));
  assert.ok(byKind['json-snapshot'].file.endsWith('.json'));
  assert.ok(byKind['jsonl-tail'].file.endsWith('.jsonl'));
});

test('gemini discover: reads cwd from <hash>/.project_root', () => {
  const tmp = mkTmp();
  const projectDir = path.join(tmp, 'abc123');
  const chatsDir = path.join(projectDir, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.project_root'), '/home/user/realproj\n');
  fs.writeFileSync(path.join(chatsDir, 'session-1.json'), '{}');

  const descs = gemini.discover(makeP(tmp));
  assert.equal(descs.length, 1);
  assert.equal(descs[0].cwd, '/home/user/realproj');
});

// ── extractLine ───────────────────────────────────────────────────────────────

test('gemini extractLine: user message -> user feed event', () => {
  const line = JSON.stringify({ id: 'm1', timestamp: 't', type: 'user', content: [{ text: 'Hello Gemini' }] });
  const evs = gemini.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].tool, 'user');
  assert.ok(evs[0].label.includes('Hello Gemini'));
});

test('gemini extractLine: gemini toolCalls map names + kinds (read/edit/shell)', () => {
  const line = JSON.stringify({
    id: 'm2', timestamp: 't', type: 'gemini', content: '',
    toolCalls: [
      { id: 'a', name: 'read_file', args: { absolute_path: '/x/a.js' } },
      { id: 'b', name: 'write_file', args: { file_path: '/x/b.js' } },
      { id: 'c', name: 'run_shell_command', args: { command: 'npm test' } },
    ],
  });
  const evs = gemini.extractLine(line, 'sid');
  assert.equal(evs.length, 3);

  const read = evs[0];
  assert.equal(read.kind, 'tool');
  assert.equal(read.tool, 'Read');
  assert.equal(read.path, '/x/a.js');

  const write = evs[1];
  assert.equal(write.kind, 'file-edit');
  assert.equal(write.tool, 'Write');
  assert.equal(write.path, '/x/b.js');

  const shell = evs[2];
  assert.equal(shell.kind, 'command');
  assert.equal(shell.tool, 'Bash');
  assert.ok(shell.label.includes('npm test'));
});

test('gemini extractLine: shell toolCall with git -> git event', () => {
  const line = JSON.stringify({
    id: 'm3', timestamp: 't', type: 'gemini', content: '',
    toolCalls: [{ id: 'g', name: 'shell', args: { command: 'git commit -m "wip: stuff"' } }],
  });
  const evs = gemini.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'git');
  assert.equal(evs[0].gitOp, 'commit');
});

test('gemini extractLine: thoughts -> thinking events', () => {
  const line = JSON.stringify({
    id: 'm4', timestamp: 't', type: 'gemini', content: '',
    thoughts: [{ subject: 'Planning', description: 'read the file first' }],
  });
  const evs = gemini.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'thinking');
  assert.ok(evs[0].label.includes('Planning'));
});

test('gemini extractLine: tokens -> tokens event with change', () => {
  const line = JSON.stringify({
    id: 'm5', timestamp: 't', type: 'gemini', content: '',
    tokens: { input: 100, output: 50, cached: 10 },
  });
  const evs = gemini.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'tokens');
  assert.equal(evs[0].change.input, 100);
  assert.equal(evs[0].change.output, 50);
  assert.equal(evs[0].change.cached, 10);
});

test('gemini extractLine: gemini with no actionable content -> no events', () => {
  const line = JSON.stringify({ id: 'm6', timestamp: 't', type: 'gemini', content: 'Done.' });
  assert.equal(gemini.extractLine(line, 'sid').length, 0);
});

test('gemini extractLine: $set metadata line -> no events', () => {
  assert.equal(gemini.extractLine(JSON.stringify({ '$set': { x: 1 } }), 'sid').length, 0);
});

test('gemini extractLine: malformed JSON -> no throw, no events', () => {
  assert.doesNotThrow(() => assert.equal(gemini.extractLine('not json', 'sid').length, 0));
});

// ── extractSnapshot ────────────────────────────────────────────────────────────

test('gemini extractSnapshot: parses messages + title from first user message', () => {
  const snap = JSON.stringify({
    sessionId: 'abc',
    messages: [
      { id: 'm1', timestamp: 't', type: 'user', content: [{ text: 'Set up the project' }] },
      { id: 'm2', timestamp: 't', type: 'gemini', content: '', toolCalls: [{ id: 'a', name: 'read_file', args: { file_path: '/x' } }] },
    ],
  });
  const r = gemini.extractSnapshot(snap, 'sid');
  assert.equal(r.title, 'Set up the project');
  assert.ok(r.events.some(e => e.tool === 'user'));
  assert.ok(r.events.some(e => e.tool === 'Read'));
});

test('gemini extractSnapshot: prefers explicit summary as title', () => {
  const snap = JSON.stringify({
    summary: 'Refactor auth flow',
    messages: [{ id: 'm1', timestamp: 't', type: 'user', content: 'do the thing' }],
  });
  assert.equal(gemini.extractSnapshot(snap, 'sid').title, 'Refactor auth flow');
});

test('gemini extractSnapshot: skips subagent session files entirely', () => {
  const snap = JSON.stringify({
    kind: 'subagent',
    messages: [{ id: 'm1', timestamp: 't', type: 'user', content: 'should be ignored' }],
  });
  const r = gemini.extractSnapshot(snap, 'sid');
  assert.deepEqual(r.events, []);
});

test('gemini extractSnapshot: malformed JSON -> empty events, no throw', () => {
  assert.doesNotThrow(() => assert.deepEqual(gemini.extractSnapshot('{bad', 'sid').events, []));
});
