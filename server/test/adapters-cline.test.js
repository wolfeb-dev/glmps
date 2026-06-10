// server/test/adapters-cline.test.js
// Fixture-based tests for the cline (Cline/Roo) adapter, using the
// GLMPS_CLINE_DIR override so a temp globalStorage dir stands in for the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cline from '../lib/adapters/cline.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cline-')); tmpDirs.push(d); return d; }
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); }
function makeP(clineStorageDir) { return { clineStorageDir }; }

const CLINE_EXT = 'saoudrizwan.claude-dev';
const ROO_EXT = 'rooveterinaryinc.roo-cline';

/** Seed a Cline extension (state/taskHistory.json) inside a globalStorage dir. */
function seedCline() {
  const gs = mkTmp(); // stands in for User/globalStorage
  const extDir = path.join(gs, CLINE_EXT);
  writeJson(path.join(extDir, 'state', 'taskHistory.json'), [
    { id: 'task1', task: 'Add a login form', cwdOnTaskInitialization: '/home/u/app', ts: 1700000000000, modelId: 'claude' },
  ]);
  writeJson(path.join(extDir, 'tasks', 'task1', 'ui_messages.json'), [
    { ts: 1700000001000, type: 'ask', ask: 'followup', text: 'Where should the form live?' },
    { ts: 1700000002000, type: 'say', say: 'text', text: 'In components/Login.jsx' },
    { ts: 1700000003000, type: 'say', say: 'tool', text: JSON.stringify({ tool: 'editedExistingFile', path: '/home/u/app/Login.jsx' }) },
    { ts: 1700000004000, type: 'say', say: 'tool', text: JSON.stringify({ tool: 'readFile', path: '/home/u/app/index.js' }) },
    { ts: 1700000005000, type: 'say', say: 'command', text: 'npm run build' },
    { ts: 1700000006000, type: 'say', say: 'command', text: 'git commit -m "feat: login"' },
    { ts: 1700000007000, type: 'say', say: 'reasoning', text: 'I should validate inputs' },
    { ts: 1700000008000, type: 'say', say: 'api_req_started', text: '{}' },
  ]);
  return { gs, extDir };
}

/** Seed a Roo extension (tasks/_index.json) inside a globalStorage dir. */
function seedRoo() {
  const gs = mkTmp();
  const extDir = path.join(gs, ROO_EXT);
  writeJson(path.join(extDir, 'tasks', '_index.json'), {
    entries: [{ id: 'rootask', task: 'Refactor module', cwdOnTaskInitialization: '/home/u/mod', ts: 1700000000000 }],
  });
  writeJson(path.join(extDir, 'tasks', 'rootask', 'ui_messages.json'), [
    { ts: 1, type: 'say', say: 'text', text: 'Working on it' },
  ]);
  return { gs, extDir };
}

// ── detect ──────────────────────────────────────────────────────────────────

test('cline detect: installed=false when override dir has no ext dirs', () => {
  const gs = mkTmp();
  assert.equal(cline.detect(makeP(gs)).installed, false);
});

test('cline detect: installed=true when Cline ext dir present', () => {
  const { gs, extDir } = seedCline();
  const { installed, dataDirs } = cline.detect(makeP(gs));
  assert.equal(installed, true);
  assert.ok(dataDirs.includes(extDir));
});

test('cline detect: detects Roo ext dir too', () => {
  const { gs, extDir } = seedRoo();
  const { installed, dataDirs } = cline.detect(makeP(gs));
  assert.equal(installed, true);
  assert.ok(dataDirs.includes(extDir));
});

// ── mapToolName ───────────────────────────────────────────────────────────────

test('cline mapToolName: maps cline tool names', () => {
  assert.equal(cline.mapToolName('readFile'), 'Read');
  assert.equal(cline.mapToolName('editedExistingFile'), 'Write');
  assert.equal(cline.mapToolName('newFileCreated'), 'Write');
  assert.equal(cline.mapToolName('searchFiles'), 'Grep');
  assert.equal(cline.mapToolName('webSearch'), 'WebSearch');
  assert.equal(cline.mapToolName('weird'), 'weird');
});

// ── discover ──────────────────────────────────────────────────────────────────

test('cline discover: Cline taskHistory -> json-snapshot descriptor with cwd + label', () => {
  const { gs } = seedCline();
  const descs = cline.discover(makeP(gs));
  assert.equal(descs.length, 1);
  const d = descs[0];
  assert.equal(d.tool, 'cline');
  assert.equal(d.kind, 'json-snapshot');
  assert.equal(d.id, 'cline:task1');
  assert.equal(d.cwd, '/home/u/app');
  assert.ok(d.label.includes('Add a login form'));
  assert.ok(d.file.endsWith(path.join('tasks', 'task1', 'ui_messages.json')));
});

test('cline discover: Roo _index.json -> descriptor', () => {
  const { gs } = seedRoo();
  const descs = cline.discover(makeP(gs));
  assert.equal(descs.length, 1);
  assert.equal(descs[0].id, 'cline:rootask');
  assert.equal(descs[0].cwd, '/home/u/mod');
});

test('cline discover: empty when override dir bare', () => {
  assert.deepEqual(cline.discover(makeP(mkTmp())), []);
});

test('cline discover: skips task with missing ui_messages file', () => {
  const gs = mkTmp();
  const extDir = path.join(gs, CLINE_EXT);
  writeJson(path.join(extDir, 'state', 'taskHistory.json'), [
    { id: 'ghost', task: 'no file', cwdOnTaskInitialization: '/x', ts: 1 },
  ]);
  assert.deepEqual(cline.discover(makeP(gs)), []);
});

// ── extractSnapshot ───────────────────────────────────────────────────────────

test('cline extractSnapshot: emits user, file-edit, tool, command, git, thinking events', () => {
  const { gs } = seedCline();
  const d = cline.discover(makeP(gs))[0];
  const text = fs.readFileSync(d.file, 'utf-8');
  const { events, title } = cline.extractSnapshot(text, d.id);

  assert.equal(title, 'In components/Login.jsx');

  const user = events.find(e => e.tool === 'user');
  assert.ok(user, 'ask:followup -> user event');
  assert.ok(user.label.includes('Where should the form live?'));

  const edit = events.find(e => e.kind === 'file-edit');
  assert.ok(edit);
  assert.equal(edit.tool, 'Write');
  assert.equal(edit.path, '/home/u/app/Login.jsx');

  const read = events.find(e => e.kind === 'tool' && e.tool === 'Read');
  assert.ok(read);
  assert.equal(read.path, '/home/u/app/index.js');

  const cmd = events.find(e => e.kind === 'command');
  assert.ok(cmd);
  assert.equal(cmd.tool, 'Bash');
  assert.ok(cmd.label.includes('npm run build'));

  const git = events.find(e => e.kind === 'git');
  assert.ok(git);
  assert.equal(git.gitOp, 'commit');

  const think = events.find(e => e.kind === 'thinking');
  assert.ok(think);
  assert.ok(think.label.includes('validate inputs'));

  // api_req_started is internal metadata -> skipped
  assert.ok(!events.some(e => e.tool === 'api_req_started'));
});

test('cline extractSnapshot: malformed JSON -> empty events, no throw', () => {
  assert.doesNotThrow(() => assert.deepEqual(cline.extractSnapshot('{bad', 'cline:x').events, []));
});

test('cline extractSnapshot: non-array JSON -> empty events', () => {
  assert.deepEqual(cline.extractSnapshot('{"foo":1}', 'cline:x').events, []);
});
