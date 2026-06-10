// server/test/index-store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexStore } from '../lib/index-store.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function tmpIndex() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d);
  return path.join(d, 'index.json');
}

test('upsert merges and persists across reload', () => {
  const file = tmpIndex();
  const s1 = new IndexStore(file);
  s1.upsert('a', { tool: 'claude-code', cwd: 'D:\\', startTs: 1 });
  s1.upsert('a', { title: 'fix the bug', skillsUsed: ['x'] });
  s1.flush();
  const s2 = new IndexStore(file);
  const rec = s2.get('a');
  assert.equal(rec.cwd, 'D:\\');
  assert.equal(rec.title, 'fix the bug');
  assert.deepEqual(rec.skillsUsed, ['x']);
});

test('applyEvents accumulates skill names and titles from events', () => {
  const s = new IndexStore(tmpIndex());
  s.upsert('b', { tool: 'claude-code' });
  s.applyEvents('b', [
    { kind: 'skill', label: 'superpowers:tdd', lane: 'context', ts: 1 },
    { kind: 'skill', label: 'superpowers:tdd', lane: 'context', ts: 2 },
    { kind: 'command', label: 'git status', lane: 'feed', ts: 3 },
  ]);
  assert.deepEqual(s.get('b').skillsUsed, ['superpowers:tdd']);
  assert.equal(s.get('b').eventCount, 3);
});

test('applyEvents sets title from AG user-input marker once', () => {
  const s = new IndexStore(tmpIndex());
  s.applyEvents('c', [
    { kind: 'tool', label: 'User: do the thing', lane: 'feed', ts: 1 },
    { kind: 'tool', label: 'User: second message', lane: 'feed', ts: 2 },
  ]);
  assert.equal(s.get('c').title, 'do the thing');
});

test('list returns records sorted by lastTs desc with filters', () => {
  const s = new IndexStore(tmpIndex());
  s.upsert('a', { tool: 'claude-code', cwd: 'D:\\x', lastTs: 10 });
  s.upsert('b', { tool: 'antigravity', cwd: 'D:\\y', lastTs: 20 });
  assert.deepEqual(s.list({}).map(r => r.id), ['b', 'a']);
  assert.deepEqual(s.list({ tool: 'claude-code' }).map(r => r.id), ['a']);
  assert.deepEqual(s.list({ cwd: 'D:\\y' }).map(r => r.id), ['b']);
});

test('corrupt index file starts empty instead of throwing', () => {
  const file = tmpIndex();
  fs.writeFileSync(file, '{not json');
  const s = new IndexStore(file);
  assert.deepEqual(s.list({}), []);
});
