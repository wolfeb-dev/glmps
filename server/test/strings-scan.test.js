// server/test/strings-scan.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRuns } from '../lib/strings-scan.js';

test('extractRuns: returns runs of printable ASCII >= minLen', () => {
  // 'hello' = 5 bytes, 'world!' = 6 bytes, 0x01 = separator
  const buf = Buffer.concat([
    Buffer.from('hello', 'ascii'),
    Buffer.from([0x01]),
    Buffer.from('world!', 'ascii'),
    Buffer.from([0x01]),
    Buffer.from('hi', 'ascii'), // too short (2 < 6)
  ]);
  const runs = extractRuns(buf, 6);
  assert.deepEqual(runs, ['world!']);
});

test('extractRuns: default minLen is 6', () => {
  const buf = Buffer.from('abcdef\x00ghijkl', 'ascii');
  const runs = extractRuns(buf);
  assert.deepEqual(runs, ['abcdef', 'ghijkl']);
});

test('extractRuns: returns empty array for empty buffer', () => {
  assert.deepEqual(extractRuns(Buffer.alloc(0)), []);
});

test('extractRuns: handles non-Buffer Uint8Array input', () => {
  const ua = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x21]); // 'hello!'
  const runs = extractRuns(ua);
  assert.deepEqual(runs, ['hello!']);
});

test('extractRuns: run spanning full buffer (no trailing separator) is included', () => {
  const buf = Buffer.from('abcdefg', 'ascii'); // 7 chars, no terminator
  const runs = extractRuns(buf, 6);
  assert.deepEqual(runs, ['abcdefg']);
});
