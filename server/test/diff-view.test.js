// server/test/diff-view.test.js
// Tests for findChangeRange — the pure locator that maps a captured change's
// new-text block onto line indices within the current file content, so the
// editor can inline-highlight the changed region. (renderDiff itself is DOM-
// bound and exercised via the editor; this covers the testable core.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChangeRange } from '../../web/diff-view.js';

const content = ['line a', 'line b', 'changed one', 'changed two', 'line e', 'line f'].join('\n');

test('null / missing change yields null', () => {
  assert.equal(findChangeRange(content, null), null);
  assert.equal(findChangeRange(content, {}), null);
  assert.equal(findChangeRange(content, { old: { text: 'x' }, new: null }), null);
  assert.equal(findChangeRange(content, { new: { text: '' } }), null);
});

test('unique multi-line new block maps to its line range (end exclusive)', () => {
  const r = findChangeRange(content, { new: { text: 'changed one\nchanged two' } });
  assert.deepEqual(r, { start: 2, end: 4 });
});

test('unique single-line new block maps to a 1-line range', () => {
  const r = findChangeRange(content, { new: { text: 'line e' } });
  assert.deepEqual(r, { start: 4, end: 5 });
});

test('no match yields null', () => {
  assert.equal(findChangeRange(content, { new: { text: 'not in file' } }), null);
});

test('ambiguous (multiple matches) yields null', () => {
  const dup = ['foo', 'foo', 'bar'].join('\n');
  assert.equal(findChangeRange(dup, { new: { text: 'foo' } }), null);
});

test('new block longer than file yields null', () => {
  assert.equal(findChangeRange('only one line', { new: { text: 'a\nb\nc\nd' } }), null);
});

test('whole-file write highlights all lines', () => {
  const whole = 'p\nq\nr';
  const r = findChangeRange(whole, { old: null, new: { text: 'p\nq\nr' } });
  assert.deepEqual(r, { start: 0, end: 3 });
});

test('trailing newline in new text does not block the match', () => {
  // text written with a trailing newline -> split produces a trailing '' that
  // the file may not have; it must be dropped before matching.
  const r = findChangeRange(content, { new: { text: 'changed one\nchanged two\n' } });
  assert.deepEqual(r, { start: 2, end: 4 });
});

test('truncated new text matches on its known full-line prefix', () => {
  // truncation can cut the last line mid-string; that partial line is dropped
  // and the remaining full lines are matched.
  const r = findChangeRange(content, { new: { text: 'changed one\nchanged tw', truncated: true } });
  assert.deepEqual(r, { start: 2, end: 3 });
});

test('empty content yields null', () => {
  assert.equal(findChangeRange('', { new: { text: 'anything' } }), null);
});
