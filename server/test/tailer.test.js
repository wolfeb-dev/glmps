// server/test/tailer.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readNewLines } from '../lib/tailer.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
  tmpDirs.push(d);
  return path.join(d, 't.jsonl');
}

test('reads appended complete lines and advances offset', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{"a":1}\n{"a":2}\n');
  const r1 = readNewLines(f, 0, '');
  assert.deepEqual(r1.lines, ['{"a":1}', '{"a":2}']);
  fs.appendFileSync(f, '{"a":3}\n');
  const r2 = readNewLines(f, r1.offset, r1.carry);
  assert.deepEqual(r2.lines, ['{"a":3}']);
});

test('buffers partial trailing line until newline arrives', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{"a":1}\n{"par');
  const r1 = readNewLines(f, 0, '');
  assert.deepEqual(r1.lines, ['{"a":1}']);
  assert.equal(r1.carry, '{"par');
  fs.appendFileSync(f, 'tial":true}\n');
  const r2 = readNewLines(f, r1.offset, r1.carry);
  assert.deepEqual(r2.lines, ['{"partial":true}']);
  assert.equal(r2.carry, '');
});

test('missing file returns empty result, not throw', () => {
  const r = readNewLines(path.join(os.tmpdir(), 'mc-none', 'x.jsonl'), 0, '');
  assert.deepEqual(r, { lines: [], offset: 0, carry: '' });
});

test('backfill cap: starting offset can skip ahead', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'x'.repeat(100) + '\n{"tail":1}\n');
  const size = fs.statSync(f).size;
  // caller computes start = max(0, size - cap); first partial line is discarded
  const r = readNewLines(f, size - 12, '', { discardFirstPartial: true });
  assert.deepEqual(r.lines, ['{"tail":1}']);
});

test('strips CRLF line endings', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{"a":1}\r\n{"a":2}\r\n');
  const r = readNewLines(f, 0, '');
  assert.deepEqual(r.lines, ['{"a":1}', '{"a":2}']);
  assert.equal(r.carry, '');
});

test('empty file returns no lines, no carry', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '');
  const r = readNewLines(f, 0, '');
  assert.deepEqual(r, { lines: [], offset: 0, carry: '' });
});
