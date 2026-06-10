// server/test/adapters-copilot.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as copilot from '../lib/adapters/copilot-chat.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cop-')); tmpDirs.push(d); return d; }

function makeP(vscodeStorageDir) {
  return { vscodeStorageDirs: [vscodeStorageDir] };
}

// ── detect ───────────────────────────────────────────────────────────────────

test('copilot detect: installed=false when storage dir missing', () => {
  const P = makeP(path.join(os.tmpdir(), 'nonexistent-vscode-storage-xyz'));
  const { installed } = copilot.detect(P);
  assert.equal(installed, false);
});

test('copilot detect: installed=true when storage dir exists', () => {
  const tmp = mkTmp();
  const { installed, dataDirs } = copilot.detect(makeP(tmp));
  assert.equal(installed, true);
  assert.deepEqual(dataDirs, [tmp]);
});

// ── discover ─────────────────────────────────────────────────────────────────

test('copilot discover: returns empty array when storage dir missing', () => {
  const P = makeP(path.join(os.tmpdir(), 'nonexistent-xyz'));
  assert.deepEqual(copilot.discover(P), []);
});

test('copilot discover: finds chatSession json files with json-snapshot kind', () => {
  const tmp = mkTmp();
  const hashDir = path.join(tmp, 'abc123hash');
  const chatSessionsDir = path.join(hashDir, 'chatSessions');
  fs.mkdirSync(chatSessionsDir, { recursive: true });
  const sessionFile = path.join(chatSessionsDir, '44f7c8e9-uuid.json');
  fs.writeFileSync(sessionFile, JSON.stringify({ version: 3, requests: [] }));

  const descs = copilot.discover(makeP(tmp));
  assert.equal(descs.length, 1);
  assert.equal(descs[0].kind, 'json-snapshot');
  assert.equal(descs[0].tool, 'copilot-chat');
  assert.ok(descs[0].id.includes('abc123hash'));
  assert.ok(descs[0].file.endsWith('.json'));
});

test('copilot discover: reads cwd from workspace.json folder URI', () => {
  const tmp = mkTmp();
  const hashDir = path.join(tmp, 'abc123hash');
  const chatSessionsDir = path.join(hashDir, 'chatSessions');
  fs.mkdirSync(chatSessionsDir, { recursive: true });
  fs.writeFileSync(path.join(chatSessionsDir, 'sess.json'), '{}');
  // Write workspace.json with a folder URI
  fs.writeFileSync(path.join(hashDir, 'workspace.json'), JSON.stringify({
    folder: 'file:///d%3A/myproject',
  }));

  const descs = copilot.discover(makeP(tmp));
  assert.equal(descs.length, 1);
  // cwd should be decoded path (on Windows: d:\myproject, on POSIX: d:\myproject via sep replace)
  assert.ok(descs[0].cwd !== null);
  assert.ok(descs[0].cwd.includes('myproject'));
});

test('copilot discover: missing workspace.json yields null cwd', () => {
  const tmp = mkTmp();
  const hashDir = path.join(tmp, 'xyz456');
  const chatSessionsDir = path.join(hashDir, 'chatSessions');
  fs.mkdirSync(chatSessionsDir, { recursive: true });
  fs.writeFileSync(path.join(chatSessionsDir, 's.json'), '{}');

  const descs = copilot.discover(makeP(tmp));
  assert.equal(descs.length, 1);
  assert.equal(descs[0].cwd, null);
});

test('copilot discover: ignores non-json files in chatSessions', () => {
  const tmp = mkTmp();
  const chatDir = path.join(tmp, 'hh', 'chatSessions');
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, 'notes.txt'), 'not json');
  fs.writeFileSync(path.join(chatDir, 'real.json'), '{}');

  const descs = copilot.discover(makeP(tmp));
  assert.equal(descs.length, 1);
  assert.ok(descs[0].file.endsWith('real.json'));
});

// ── extractSnapshot ───────────────────────────────────────────────────────────

test('copilot extractSnapshot: parses requests with message.text', () => {
  const data = JSON.stringify({
    version: 3,
    sessionId: 'sess1',
    creationDate: 1751424873498,
    lastMessageDate: 1751424900000,
    requests: [
      { requestId: 'r1', message: { text: 'How do I set up a NinjaScript strategy?' } },
    ],
  });
  const result = copilot.extractSnapshot(data, 'copilot:abc:sess1');
  assert.ok(Array.isArray(result.events));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].tool, 'user');
  assert.ok(result.events[0].label.includes('NinjaScript'));
  assert.ok(result.title.includes('NinjaScript'));
});

test('copilot extractSnapshot: parses requests with message.parts[].text', () => {
  const data = JSON.stringify({
    version: 3,
    sessionId: 'sess2',
    creationDate: 1751424873498,
    requests: [
      {
        requestId: 'r2',
        message: {
          parts: [
            { kind: 'text', text: 'Explain this function' },
          ],
        },
      },
    ],
  });
  const result = copilot.extractSnapshot(data, 'copilot:abc:sess2');
  assert.equal(result.events.length, 1);
  assert.ok(result.events[0].label.includes('Explain this function'));
  assert.equal(result.title, 'Explain this function');
});

test('copilot extractSnapshot: empty requests returns empty events', () => {
  const data = JSON.stringify({ version: 3, requests: [] });
  const result = copilot.extractSnapshot(data, 'copilot:abc:empty');
  assert.deepEqual(result.events, []);
});

test('copilot extractSnapshot: corrupt JSON returns empty events, no throw', () => {
  assert.doesNotThrow(() => {
    const result = copilot.extractSnapshot('{corrupt', 'sid');
    assert.deepEqual(result.events, []);
  });
});

test('copilot extractSnapshot: missing requests field returns empty events', () => {
  const data = JSON.stringify({ version: 3, sessionId: 'x' });
  const result = copilot.extractSnapshot(data, 'sid');
  assert.deepEqual(result.events, []);
});

test('copilot extractSnapshot: message with neither text nor parts returns no event', () => {
  const data = JSON.stringify({
    version: 3,
    creationDate: 1000,
    requests: [
      { requestId: 'r1', message: {} },
    ],
  });
  const result = copilot.extractSnapshot(data, 'sid');
  assert.equal(result.events.length, 0);
});

test('copilot extractSnapshot: title truncated to 80 chars', () => {
  const longMsg = 'X'.repeat(200);
  const data = JSON.stringify({
    version: 3,
    creationDate: 1000,
    requests: [{ requestId: 'r1', message: { text: longMsg } }],
  });
  const result = copilot.extractSnapshot(data, 'sid');
  assert.equal(result.title.length, 80);
});
