// server/test/adapters-opencode.test.js
// Fixture-based tests for the opencode adapter (temp dirs, no live data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as opencode from '../lib/adapters/opencode.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-oc-')); tmpDirs.push(d); return d; }
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); }

/**
 * Build a minimal opencode storage tree under a temp base.
 * Returns { base, sessionFile, descId } for the single seeded session.
 */
function seed() {
  const base = mkTmp();
  const storage = path.join(base, 'storage');
  const projectId = 'proj1';
  const sessionId = 'ses001';

  writeJson(path.join(storage, 'project', `${projectId}.json`), {
    id: projectId, worktree: '/home/user/myproj',
  });
  writeJson(path.join(storage, 'session', projectId, `${sessionId}.json`), {
    id: sessionId, title: 'Fix the parser bug', time: { created: 1700000000000, updated: 1700000100000 },
  });

  // message: user
  writeJson(path.join(storage, 'message', sessionId, 'msg001.json'), {
    id: 'msg001', role: 'user', time: { created: 1700000010000 },
  });
  writeJson(path.join(storage, 'part', 'msg001', 'prt001.json'), {
    type: 'text', text: 'Please fix the parser',
  });

  // message: assistant with a bash tool part (git commit) + an edit tool part
  writeJson(path.join(storage, 'message', sessionId, 'msg002.json'), {
    id: 'msg002', role: 'assistant', modelID: 'claude', time: { created: 1700000020000 },
  });
  writeJson(path.join(storage, 'part', 'msg002', 'prt001.json'), {
    type: 'tool', tool: 'bash', state: { input: { command: 'git commit -m "fix: parser"' } },
  });
  writeJson(path.join(storage, 'part', 'msg002', 'prt002.json'), {
    type: 'tool', tool: 'edit', state: { input: { filePath: '/home/user/myproj/parser.js' } },
  });
  writeJson(path.join(storage, 'part', 'msg002', 'prt003.json'), {
    type: 'tool', tool: 'read', state: { input: { filePath: '/home/user/myproj/lex.js' } },
  });

  return { base, projectId, sessionId };
}

function makeP(opencodeDir) { return { opencodeDir }; }

// ── detect ──────────────────────────────────────────────────────────────────

test('opencode detect: installed=false when storage missing', () => {
  const { installed } = opencode.detect(makeP(path.join(os.tmpdir(), 'nope-opencode-xyz')));
  assert.equal(installed, false);
});

test('opencode detect: installed=true when storage/ exists, dataDirs includes base', () => {
  const { base } = seed();
  const { installed, dataDirs } = opencode.detect(makeP(base));
  assert.equal(installed, true);
  assert.deepEqual(dataDirs, [base]);
});

// ── mapToolName ───────────────────────────────────────────────────────────────

test('opencode mapToolName: lowercase -> capitalised', () => {
  assert.equal(opencode.mapToolName('read'), 'Read');
  assert.equal(opencode.mapToolName('bash'), 'Bash');
  assert.equal(opencode.mapToolName('edit'), 'Edit');
  assert.equal(opencode.mapToolName('web_search'), 'WebSearch');
  assert.equal(opencode.mapToolName('grep_files'), 'Grep');
  assert.equal(opencode.mapToolName('github_search'), 'github_search');
});

// ── discover ──────────────────────────────────────────────────────────────────

test('opencode discover: empty array when base missing', () => {
  assert.deepEqual(opencode.discover(makeP(path.join(os.tmpdir(), 'nope-xyz'))), []);
});

test('opencode discover: finds one session as json-snapshot with cwd', () => {
  const { base, projectId, sessionId } = seed();
  const descs = opencode.discover(makeP(base));
  assert.equal(descs.length, 1);
  const d = descs[0];
  assert.equal(d.tool, 'opencode');
  assert.equal(d.kind, 'json-snapshot');
  assert.equal(d.cwd, '/home/user/myproj');
  assert.ok(d.file.endsWith(`${sessionId}.json`));
  assert.equal(d.extra.projectId, projectId);
  assert.equal(d.extra.sessionId, sessionId);
  // id carries the messages dir for extractSnapshot
  const { publicId, messagesDir } = opencode.parseDescId(d.id);
  assert.equal(publicId, `opencode:${projectId}:${sessionId}`);
  assert.ok(messagesDir && messagesDir.endsWith(path.join('message', sessionId)));
});

// ── extractSnapshot ───────────────────────────────────────────────────────────

test('opencode extractSnapshot: emits user, git, file-edit, and tool events', () => {
  const { base, projectId, sessionId } = seed();
  const descs = opencode.discover(makeP(base));
  const d = descs[0];
  const sessionText = fs.readFileSync(d.file, 'utf-8');
  const { events, title } = opencode.extractSnapshot(sessionText, d.id);

  assert.equal(title, 'Fix the parser bug');

  const user = events.find(e => e.tool === 'user');
  assert.ok(user, 'expected a user event');
  assert.ok(user.label.includes('Please fix the parser'));
  assert.equal(user.sessionId, `opencode:${projectId}:${sessionId}`);

  const git = events.find(e => e.kind === 'git');
  assert.ok(git, 'expected a git event from bash commit');
  assert.equal(git.gitOp, 'commit');
  assert.ok(git.label.includes('fix: parser'));

  const edit = events.find(e => e.kind === 'file-edit');
  assert.ok(edit, 'expected a file-edit event');
  assert.equal(edit.tool, 'Edit');
  assert.equal(edit.path, '/home/user/myproj/parser.js');

  const read = events.find(e => e.kind === 'tool' && e.tool === 'Read');
  assert.ok(read, 'expected a Read tool event');
  assert.equal(read.path, '/home/user/myproj/lex.js');
});

test('opencode extractSnapshot: malformed session text still reads messages from disk', () => {
  const { base } = seed();
  const d = opencode.discover(makeP(base))[0];
  // Bad session JSON text, but messages dir is intact via the embedded id.
  const { events, title } = opencode.extractSnapshot('{not json', d.id);
  assert.equal(title, null);
  assert.ok(events.some(e => e.tool === 'user'));
});

test('opencode extractSnapshot: id without embedded dir returns no events, no throw', () => {
  assert.doesNotThrow(() => {
    const r = opencode.extractSnapshot('{}', 'opencode:p:s');
    assert.deepEqual(r.events, []);
  });
});

test('opencode extractSnapshot: bash without git -> command event', () => {
  const base = mkTmp();
  const storage = path.join(base, 'storage');
  writeJson(path.join(storage, 'session', 'p', 's.json'), { id: 's', title: 't' });
  writeJson(path.join(storage, 'message', 's', 'm.json'), { id: 'm', role: 'assistant' });
  writeJson(path.join(storage, 'part', 'm', 'a.json'), {
    type: 'tool', tool: 'bash', state: { input: { command: 'npm test' } },
  });
  const d = opencode.discover(makeP(base))[0];
  const { events } = opencode.extractSnapshot(fs.readFileSync(d.file, 'utf-8'), d.id);
  const cmd = events.find(e => e.kind === 'command');
  assert.ok(cmd);
  assert.equal(cmd.tool, 'Bash');
  assert.ok(cmd.label.includes('npm test'));
});
