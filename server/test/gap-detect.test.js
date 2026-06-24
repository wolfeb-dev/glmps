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

// ---------------------------------------------------------------------------
// ui-design-too-late: frontend-design used but after the first UI edit
// ---------------------------------------------------------------------------

test('ui-design-too-late: fires when first UI edit precedes first frontend-design skill event', () => {
  const evs = [
    { kind: 'file-edit', op: 'write', path: 'web/styles.css', ts: 100 },
    { kind: 'skill', lane: 'context', label: 'frontend-design:frontend-design', ts: 200 },
  ];
  const g = detectGaps(evs, []);
  assert.ok(g.some(x => x.code === 'ui-design-too-late'), 'expected ui-design-too-late gap');
});

test('ui-design-too-late: does NOT fire when frontend-design precedes first UI edit', () => {
  const evs = [
    { kind: 'skill', lane: 'context', label: 'frontend-design:frontend-design', ts: 50 },
    { kind: 'file-edit', op: 'write', path: 'web/styles.css', ts: 200 },
  ];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'ui-design-too-late'), 'should not fire when skill came first');
});

test('ui-design-too-late: does NOT fire when no frontend-design skill at all (covered by ui-without-frontend-design)', () => {
  const evs = [
    { kind: 'file-edit', op: 'write', path: 'web/styles.css', ts: 100 },
  ];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'ui-design-too-late'));
});

test('ui-design-too-late: does NOT fire when no UI edits at all', () => {
  const evs = [
    { kind: 'skill', lane: 'context', label: 'frontend-design:frontend-design', ts: 100 },
  ];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'ui-design-too-late'));
});

test('ui-design-too-late: works with string ts values', () => {
  const evs = [
    { kind: 'file-edit', op: 'write', path: 'a.css', ts: '2026-01-01T10:00:00Z' },
    { kind: 'skill', lane: 'context', label: 'frontend-design', ts: '2026-01-01T11:00:00Z' },
  ];
  const g = detectGaps(evs, []);
  assert.ok(g.some(x => x.code === 'ui-design-too-late'));
});

// ---------------------------------------------------------------------------
// reread-loop: same path read more than 8 times
// ---------------------------------------------------------------------------

test('reread-loop: fires when a path is read more than 8 times', () => {
  const evs = Array.from({ length: 9 }, () => ({ kind: 'file-edit', op: 'read', path: 'server/lib/gap-detect.js', ts: 1 }));
  const g = detectGaps(evs, []);
  const gap = g.find(x => x.code === 'reread-loop');
  assert.ok(gap, 'expected reread-loop gap');
  assert.match(gap.message, /server\/lib\/gap-detect\.js/);
  assert.match(gap.message, /9/);
});

test('reread-loop: does NOT fire at exactly 8 reads', () => {
  const evs = Array.from({ length: 8 }, () => ({ kind: 'file-edit', op: 'read', path: 'server/lib/gap-detect.js', ts: 1 }));
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'reread-loop'));
});

test('reread-loop: reports the worst offender (highest count)', () => {
  const evs = [
    ...Array.from({ length: 9 }, () => ({ kind: 'file-edit', op: 'read', path: 'file-a.js', ts: 1 })),
    ...Array.from({ length: 12 }, () => ({ kind: 'file-edit', op: 'read', path: 'file-b.js', ts: 1 })),
  ];
  const g = detectGaps(evs, []);
  const gap = g.find(x => x.code === 'reread-loop');
  assert.ok(gap);
  assert.match(gap.message, /file-b\.js/);
  assert.match(gap.message, /12/);
});

// ---------------------------------------------------------------------------
// done-without-verification: >= 15 non-read edits, no verification-before-completion
// ---------------------------------------------------------------------------

test('done-without-verification: fires at or above HEAVY_EDIT_THRESHOLD with no verification skill', () => {
  const evs = Array.from({ length: 15 }, (_, i) => ({ kind: 'file-edit', op: 'write', path: `f${i}.js`, ts: 1 }));
  const g = detectGaps(evs, []);
  assert.ok(g.some(x => x.code === 'done-without-verification'));
});

test('done-without-verification: does NOT fire when verification-before-completion skill event present', () => {
  const evs = [
    ...Array.from({ length: 15 }, (_, i) => ({ kind: 'file-edit', op: 'write', path: `f${i}.js`, ts: 1 })),
    { kind: 'skill', lane: 'context', label: 'superpowers:verification-before-completion', ts: 2 },
  ];
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'done-without-verification'));
});

test('done-without-verification: does NOT fire when verification-before-completion in skillsUsed', () => {
  const evs = Array.from({ length: 15 }, (_, i) => ({ kind: 'file-edit', op: 'write', path: `f${i}.js`, ts: 1 }));
  const g = detectGaps(evs, ['superpowers:verification-before-completion']);
  assert.ok(!g.some(x => x.code === 'done-without-verification'));
});

test('done-without-verification: does NOT fire below threshold (14 edits)', () => {
  const evs = Array.from({ length: 14 }, (_, i) => ({ kind: 'file-edit', op: 'write', path: `f${i}.js`, ts: 1 }));
  const g = detectGaps(evs, []);
  assert.ok(!g.some(x => x.code === 'done-without-verification'));
});
