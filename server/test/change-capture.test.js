// server/test/change-capture.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampSide, makeChange } from '../lib/change-capture.js';

test('clampSide: null/undefined input returns null', () => {
  assert.equal(clampSide(null), null);
  assert.equal(clampSide(undefined), null);
  assert.equal(clampSide(42), null);
});

test('clampSide: short string returns { text, truncated:false }', () => {
  const r = clampSide('hello');
  assert.deepEqual(r, { text: 'hello', truncated: false });
});

test('clampSide: string at exactly CAP returns truncated:false', () => {
  const s = 'a'.repeat(4096);
  const r = clampSide(s);
  assert.equal(r.truncated, false);
  assert.equal(r.text.length, 4096);
});

test('clampSide: string over CAP truncates and sets truncated:true', () => {
  const s = 'x'.repeat(5000);
  const r = clampSide(s);
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 4096);
  assert.equal(r.text, s.slice(0, 4096));
});

test('makeChange: both null/undefined returns undefined', () => {
  assert.equal(makeChange(null, null), undefined);
  assert.equal(makeChange(undefined, undefined), undefined);
});

test('makeChange: whole-file write (oldText null, newText string) has old:null', () => {
  const r = makeChange(null, 'new content');
  assert.equal(r.old, null);
  assert.deepEqual(r.new, { text: 'new content', truncated: false });
});

test('makeChange: edit with old and new has both sides', () => {
  const r = makeChange('old text', 'new text');
  assert.deepEqual(r.old, { text: 'old text', truncated: false });
  assert.deepEqual(r.new, { text: 'new text', truncated: false });
});

test('makeChange: oversized content sets truncated:true on affected side', () => {
  const bigOld = 'o'.repeat(5000);
  const r = makeChange(bigOld, 'short new');
  assert.equal(r.old.truncated, true);
  assert.equal(r.old.text.length, 4096);
  assert.equal(r.new.truncated, false);
});
