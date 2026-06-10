// server/test/search.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchTranscripts } from '../lib/search.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

test('finds case-insensitive matches with snippets, respects cap', async () => {
  const tmp = mkTmp();
  const f1 = path.join(tmp, 'a.jsonl');
  fs.writeFileSync(f1, [
    JSON.stringify({ type: 'user', message: { content: 'please fix the NinjaScript compile error' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at NINJASCRIPT now' }] } }),
    JSON.stringify({ type: 'user', message: { content: 'unrelated' } }),
  ].join('\n') + '\n');
  const targets = [{ id: 'a', transcriptPath: f1 }];
  const all = await searchTranscripts(targets, 'ninjascript', { cap: 10 });
  assert.equal(all.length, 2);
  assert.equal(all[0].sessionId, 'a');
  assert.match(all[0].snippet, /NinjaScript/);
  const capped = await searchTranscripts(targets, 'ninjascript', { cap: 1 });
  assert.equal(capped.length, 1);
  assert.equal(capped.capped, true);
});

test('unreadable target is skipped, not thrown', async () => {
  const r = await searchTranscripts([{ id: 'x', transcriptPath: 'Q:\\none\\x.jsonl' }], 'whatever', { cap: 10 });
  assert.deepEqual([...r], []);
});

test('empty targets returns empty array', async () => {
  const r = await searchTranscripts([], 'whatever', { cap: 10 });
  assert.deepEqual([...r], []);
});

// ── filters ──────────────────────────────────────────

function writeJsonl(dir, name, records) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return f;
}

test('messageType filter keeps only matching record types', async () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'm.jsonl', [
    { type: 'user', message: { content: 'fix the widget' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'fixing the widget now' }] } },
  ]);
  const targets = [{ id: 's', transcriptPath: f }];
  const userOnly = await searchTranscripts(targets, 'widget', { cap: 10, filters: { messageType: 'user' } });
  assert.equal(userOnly.length, 1);
  assert.match(userOnly[0].snippet, /fix the widget/);
  const asstOnly = await searchTranscripts(targets, 'widget', { cap: 10, filters: { messageType: 'assistant' } });
  assert.equal(asstOnly.length, 1);
  assert.match(asstOnly[0].snippet, /fixing the widget/);
});

test('hasToolCalls filter keeps only records with tool_use blocks', async () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 't.jsonl', [
    { type: 'user', message: { content: 'run the build please' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'build please' } }] } },
  ]);
  const targets = [{ id: 's', transcriptPath: f }];
  const r = await searchTranscripts(targets, 'please', { cap: 10, filters: { hasToolCalls: true } });
  assert.equal(r.length, 1);
  assert.match(r[0].snippet, /Bash/);
});

test('hasFileChanges filter keeps only file-editing tool records', async () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'fc.jsonl', [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'token here' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'token here' } }] } },
  ]);
  const targets = [{ id: 's', transcriptPath: f }];
  const r = await searchTranscripts(targets, 'token', { cap: 10, filters: { hasFileChanges: true } });
  assert.equal(r.length, 1);
  assert.match(r[0].snippet, /Edit/);
});

test('hasErrors filter keeps only records flagged is_error', async () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'err.jsonl', [
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'boom failure', is_error: true }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok failure word', is_error: false }] } },
  ]);
  const targets = [{ id: 's', transcriptPath: f }];
  const r = await searchTranscripts(targets, 'failure', { cap: 10, filters: { hasErrors: true } });
  assert.equal(r.length, 1);
  assert.match(r[0].snippet, /boom/);
});

test('dateRange filter bounds matches by record timestamp', async () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'd.jsonl', [
    { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'alpha marker' } },
    { type: 'user', timestamp: '2026-06-01T00:00:00.000Z', message: { content: 'beta marker' } },
  ]);
  const targets = [{ id: 's', transcriptPath: f }];
  const r = await searchTranscripts(targets, 'marker', { cap: 10,
    filters: { dateRange: { from: '2026-05-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' } } });
  assert.equal(r.length, 1);
  assert.match(r[0].snippet, /beta/);
});

test('project filter matches target cwd basename', async () => {
  const tmp = mkTmp();
  const f1 = writeJsonl(tmp, 'p1.jsonl', [{ type: 'user', message: { content: 'shared marker' } }]);
  const f2 = writeJsonl(tmp, 'p2.jsonl', [{ type: 'user', message: { content: 'shared marker' } }]);
  const targets = [
    { id: 'a', transcriptPath: f1, cwd: 'D:\\projects\\alpha' },
    { id: 'b', transcriptPath: f2, cwd: 'D:\\projects\\beta' },
  ];
  const r = await searchTranscripts(targets, 'marker', { cap: 10, filters: { project: 'alpha' } });
  assert.equal(r.length, 1);
  assert.equal(r[0].sessionId, 'a');
});

test('multiple filters combine (AND)', async () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'combo.jsonl', [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { x: 'combo target' } }] } },
    { type: 'user', message: { content: 'combo target as user' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'combo target text only' }] } },
  ]);
  const targets = [{ id: 's', transcriptPath: f }];
  const r = await searchTranscripts(targets, 'combo target', { cap: 10,
    filters: { messageType: 'assistant', hasFileChanges: true } });
  assert.equal(r.length, 1);
  assert.match(r[0].snippet, /Edit/);
});

test('no filters (or empty filters object) preserves original behavior', async () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'noop.jsonl', [
    { type: 'user', message: { content: 'keep marker one' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'keep marker two' }] } },
  ]);
  const targets = [{ id: 's', transcriptPath: f }];
  const none = await searchTranscripts(targets, 'marker', { cap: 10 });
  const empty = await searchTranscripts(targets, 'marker', { cap: 10, filters: {} });
  const nullf = await searchTranscripts(targets, 'marker', { cap: 10, filters: null });
  assert.equal(none.length, 2);
  assert.equal(empty.length, 2);
  assert.equal(nullf.length, 2);
});

test('filtered search still respects the cap', async () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'cap.jsonl', [
    { type: 'user', message: { content: 'cap marker a' } },
    { type: 'user', message: { content: 'cap marker b' } },
    { type: 'user', message: { content: 'cap marker c' } },
  ]);
  const targets = [{ id: 's', transcriptPath: f }];
  const r = await searchTranscripts(targets, 'marker', { cap: 2, filters: { messageType: 'user' } });
  assert.equal(r.length, 2);
  assert.equal(r.capped, true);
});

test('non-JSON matched lines are dropped when filters are active', async () => {
  const tmp = mkTmp();
  const f = path.join(tmp, 'mixed.jsonl');
  fs.writeFileSync(f, [
    'plain text line with marker but not json',
    JSON.stringify({ type: 'user', message: { content: 'json marker line' } }),
  ].join('\n') + '\n');
  const targets = [{ id: 's', transcriptPath: f }];
  const r = await searchTranscripts(targets, 'marker', { cap: 10, filters: { messageType: 'user' } });
  assert.equal(r.length, 1);
  assert.match(r[0].snippet, /json marker/);
});
