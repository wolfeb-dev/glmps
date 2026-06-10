import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectGaps } from '../lib/gap-detect.js';

const edit = (path, op = 'write') => ({ kind: 'file-edit', op, path });
const skill = (label) => ({ kind: 'skill', lane: 'context', label });

test('flags UI edits without frontend-design', () => {
  const g = detectGaps([edit('D:\\glmps\\web\\styles.css')], []);
  assert.ok(g.some(x => x.code === 'ui-without-frontend-design'));
});

test('no UI gap when frontend-design was used (via skillsUsed)', () => {
  const g = detectGaps([edit('web/app.js')], ['frontend-design']);
  assert.ok(!g.some(x => x.code === 'ui-without-frontend-design'));
});

test('no UI gap when frontend-design used (via skill event)', () => {
  const g = detectGaps([skill('frontend-design:frontend-design'), edit('a.css')], []);
  assert.ok(!g.some(x => x.code === 'ui-without-frontend-design'));
});

test('non-UI edits do not trip the UI gap', () => {
  const g = detectGaps([edit('server/server.js'), edit('readme.md')], []);
  assert.ok(!g.some(x => x.code === 'ui-without-frontend-design'));
});

test('reading a UI file is not an edit', () => {
  const g = detectGaps([edit('web/styles.css', 'read')], []);
  assert.equal(g.length, 0);
});

test('flags heavy edits with no subagents', () => {
  const evs = Array.from({ length: 16 }, (_, i) => edit(`src/f${i}.js`));
  const g = detectGaps(evs, []);
  assert.ok(g.some(x => x.code === 'heavy-edits-no-subagents'));
});

test('no heavy-edit gap when subagents were used', () => {
  const evs = [...Array.from({ length: 16 }, (_, i) => edit(`src/f${i}.js`)), { kind: 'agent', label: 'Explore' }];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'heavy-edits-no-subagents'));
});

test('empty / malformed input → no gaps, no throw', () => {
  assert.deepEqual(detectGaps(null, null), []);
  assert.deepEqual(detectGaps([], []), []);
  assert.deepEqual(detectGaps(undefined), []);
});
