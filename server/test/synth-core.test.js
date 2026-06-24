import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectStaleTranscripts,
  dueForRun,
  digest,
} from '../lib/synth-core.js';

// ---------------------------------------------------------------------------
// selectStaleTranscripts
// ---------------------------------------------------------------------------

test('selectStaleTranscripts: returns all when sinceMs is null', () => {
  const files = [
    { path: 'a.jsonl', mtimeMs: 1000 },
    { path: 'b.jsonl', mtimeMs: 2000 },
  ];
  assert.deepEqual(selectStaleTranscripts(files, null), files);
});

test('selectStaleTranscripts: returns all when sinceMs is 0', () => {
  const files = [
    { path: 'a.jsonl', mtimeMs: 1000 },
  ];
  assert.deepEqual(selectStaleTranscripts(files, 0), files);
});

test('selectStaleTranscripts: filters by mtimeMs > sinceMs', () => {
  const files = [
    { path: 'old.jsonl', mtimeMs: 1000 },
    { path: 'new.jsonl', mtimeMs: 3000 },
    { path: 'edge.jsonl', mtimeMs: 2000 },
  ];
  // strictly greater than sinceMs=2000: only new.jsonl
  const result = selectStaleTranscripts(files, 2000);
  assert.deepEqual(result, [{ path: 'new.jsonl', mtimeMs: 3000 }]);
});

test('selectStaleTranscripts: returns empty array when no files pass', () => {
  const files = [{ path: 'a.jsonl', mtimeMs: 500 }];
  assert.deepEqual(selectStaleTranscripts(files, 1000), []);
});

// ---------------------------------------------------------------------------
// dueForRun
// ---------------------------------------------------------------------------

const WEEK = 7 * 24 * 3600 * 1000;

test('dueForRun: true when lastRunMs is null', () => {
  assert.equal(dueForRun(null, Date.now()), true);
});

test('dueForRun: true when elapsed >= interval', () => {
  const now = 10_000_000;
  assert.equal(dueForRun(now - WEEK, now), true);
});

test('dueForRun: true when elapsed exactly equals interval', () => {
  const now = 10_000_000;
  assert.equal(dueForRun(now - WEEK, now, WEEK), true);
});

test('dueForRun: false when elapsed < interval', () => {
  const now = 10_000_000;
  assert.equal(dueForRun(now - WEEK + 1, now), false);
});

test('dueForRun: respects custom intervalMs', () => {
  const now = 10_000;
  assert.equal(dueForRun(now - 5000, now, 5000), true);
  assert.equal(dueForRun(now - 4999, now, 5000), false);
});

// ---------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------

test('digest: aggregates by code and sorts descending by count', () => {
  const gaps = [
    { code: 'A' },
    { code: 'B' },
    { code: 'A' },
    { code: 'C' },
    { code: 'A' },
    { code: 'B' },
  ];
  const result = digest(gaps);
  assert.deepEqual(result, [
    { code: 'A', count: 3 },
    { code: 'B', count: 2 },
    { code: 'C', count: 1 },
  ]);
});

test('digest: returns empty array for empty input', () => {
  assert.deepEqual(digest([]), []);
});

test('digest: handles single entry', () => {
  assert.deepEqual(digest([{ code: 'X' }]), [{ code: 'X', count: 1 }]);
});
