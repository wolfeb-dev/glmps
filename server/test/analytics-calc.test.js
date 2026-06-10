// server/test/analytics-calc.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cwdLastSeg,
  modelKey,
  rowTokens,
  maxOf,
  groupByModel,
  groupByProject,
  donutArcs,
  heatBuckets,
} from '../../web/analytics-calc.js';

// ── cwdLastSeg ──────────────────────────────────────
test('cwdLastSeg handles forward/back slashes and trailing separators', () => {
  assert.equal(cwdLastSeg('D:\\glmps'), 'glmps');
  assert.equal(cwdLastSeg('/home/u/proj/'), 'proj');
  assert.equal(cwdLastSeg('C:/a/b/c\\d'), 'd');
  assert.equal(cwdLastSeg(''), '');
  assert.equal(cwdLastSeg(null), '');
  assert.equal(cwdLastSeg(undefined), '');
});

// ── modelKey ────────────────────────────────────────
test('modelKey coarsens model strings to a tier key', () => {
  assert.equal(modelKey('claude-opus-4-8[1m]'), 'opus');
  assert.equal(modelKey('Opus 4.8 (1M context)'), 'opus');
  assert.equal(modelKey('claude-3-5-sonnet'), 'sonnet');
  assert.equal(modelKey('Haiku'), 'haiku');
  assert.equal(modelKey(''), 'unknown');
  assert.equal(modelKey(null), 'unknown');
  assert.equal(modelKey(42), 'unknown');
});

test('modelKey strips a trailing parenthetical for non-tier models', () => {
  assert.equal(modelKey('gpt-4o (preview)'), 'gpt-4o');
});

// ── rowTokens ───────────────────────────────────────
test('rowTokens sums the four token figures, treating missing as 0', () => {
  assert.equal(rowTokens({ input: 10, output: 20, cacheRead: 5, cacheCreate: 1 }), 36);
  assert.equal(rowTokens({ input: 10 }), 10);
  assert.equal(rowTokens({}), 0);
  assert.equal(rowTokens(null), 0);
});

// ── maxOf ───────────────────────────────────────────
test('maxOf returns the largest value of a key', () => {
  assert.equal(maxOf([{ c: 3 }, { c: 9 }, { c: 1 }], 'c'), 9);
  assert.equal(maxOf([], 'c'), 0);
  assert.equal(maxOf([{ c: -2 }, {}], 'c'), 0);
});

test('maxOf accepts an accessor function', () => {
  assert.equal(maxOf([{ a: 1 }, { a: 4 }], (x) => x.a * 2), 8);
});

// ── groupByModel ────────────────────────────────────
const perSession = [
  { sid: 's1', model: 'claude-opus-4-8[1m]', costUsd: 2.0, input: 100, output: 50, cacheRead: 10, cacheCreate: 5, cwd: 'D:\\glmps', lastTs: 1 },
  { sid: 's2', model: 'Opus 4.8 (1M context)', costUsd: 1.0, input: 40, output: 20, cacheRead: 0, cacheCreate: 0, cwd: 'D:\\glmps', lastTs: 2 },
  { sid: 's3', model: 'claude-3-5-sonnet', costUsd: 3.0, input: 60, output: 30, cacheRead: 2, cacheCreate: 1, cwd: '/home/u/other', lastTs: 3 },
];

test('groupByModel collapses tiers and sorts by cost desc, tokens tie-break', () => {
  const g = groupByModel(perSession);
  // opus cost 3.0 (tokens 225) ties sonnet cost 3.0 (tokens 93) -> opus wins on tokens
  assert.deepEqual(g.map((x) => x.key), ['opus', 'sonnet']);
  const opus = g.find((x) => x.key === 'opus');
  assert.equal(opus.sessions, 2);
  assert.equal(opus.costUsd, 3.0);
  assert.equal(opus.input, 140);
  assert.equal(opus.output, 70);
  assert.equal(opus.tokens, 100 + 50 + 10 + 5 + 40 + 20);
});

test('groupByModel returns [] for empty/invalid input', () => {
  assert.deepEqual(groupByModel([]), []);
  assert.deepEqual(groupByModel(null), []);
  assert.deepEqual(groupByModel(undefined), []);
});

// ── groupByProject ──────────────────────────────────
test('groupByProject keys by cwd last segment and sorts by cost desc, tokens tie-break', () => {
  const g = groupByProject(perSession);
  // glmps cost 3.0 (tokens 225) ties other cost 3.0 (tokens 93) -> mc wins on tokens
  assert.deepEqual(g.map((x) => x.key), ['glmps', 'other']);
  const mc = g.find((x) => x.key === 'glmps');
  assert.equal(mc.sessions, 2);
  assert.equal(mc.costUsd, 3.0);
});

test('groupByProject buckets missing cwd under (unknown)', () => {
  const g = groupByProject([{ sid: 'x', costUsd: 1, cwd: '' }]);
  assert.equal(g.length, 1);
  assert.equal(g[0].key, '(unknown)');
});

// ── donutArcs ───────────────────────────────────────
test('donutArcs returns three segments with correct fractions', () => {
  const arcs = donutArcs({ input: 50, output: 25, cacheRead: 15, cacheCreate: 10 });
  assert.equal(arcs.length, 3);
  assert.deepEqual(arcs.map((a) => a.key), ['input', 'output', 'cache']);
  // total = 100; cache = 15+10 = 25
  assert.equal(arcs[0].fraction, 0.5);
  assert.equal(arcs[1].fraction, 0.25);
  assert.equal(arcs[2].fraction, 0.25);
  // Each non-zero segment yields a non-empty path
  for (const a of arcs) assert.ok(a.d.length > 0, `segment ${a.key} should have a path`);
});

test('donutArcs path commands are well-formed (M/A/L/Z)', () => {
  const arcs = donutArcs({ input: 50, output: 50, cacheRead: 0, cacheCreate: 0 });
  const inputSeg = arcs.find((a) => a.key === 'input');
  assert.match(inputSeg.d, /^M /);
  assert.match(inputSeg.d, / A /);
  assert.match(inputSeg.d, /Z/);
  // Numbers only — no NaN should leak into the path
  assert.ok(!/NaN/.test(inputSeg.d));
});

test('donutArcs handles all-zero with empty paths and zero fractions', () => {
  const arcs = donutArcs({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  assert.equal(arcs.length, 3);
  for (const a of arcs) {
    assert.equal(a.fraction, 0);
    assert.equal(a.d, '');
  }
});

test('donutArcs handles a single full segment by splitting the sweep', () => {
  const arcs = donutArcs({ input: 100, output: 0, cacheRead: 0, cacheCreate: 0 });
  const inputSeg = arcs.find((a) => a.key === 'input');
  assert.equal(inputSeg.fraction, 1);
  // Full circle: path is split into two arc bands -> two M commands
  const mCount = (inputSeg.d.match(/M /g) || []).length;
  assert.equal(mCount, 2);
  assert.ok(!/NaN/.test(inputSeg.d));
  // Empty segments stay empty
  assert.equal(arcs.find((a) => a.key === 'output').d, '');
});

test('donutArcs respects custom geometry options', () => {
  const arcs = donutArcs({ input: 1, output: 1, cacheRead: 0, cacheCreate: 0 }, { cx: 30, cy: 30, radius: 20, thickness: 6 });
  const seg = arcs.find((a) => a.key === 'input');
  assert.ok(seg.d.length > 0);
  assert.ok(!/NaN/.test(seg.d));
});

// ── heatBuckets ─────────────────────────────────────
test('heatBuckets assigns 4 levels by quartile of max and 0 for empty days', () => {
  const heatmap = [
    { date: '2026-06-01', count: 0 },
    { date: '2026-06-02', count: 2 },   // 2/8 = .25 -> level 1
    { date: '2026-06-03', count: 3 },   // .375 -> level 2
    { date: '2026-06-04', count: 5 },   // .625 -> level 3
    { date: '2026-06-05', count: 8 },   // 1.0 -> level 4
  ];
  const b = heatBuckets(heatmap);
  assert.deepEqual(b.map((x) => x.level), [0, 1, 2, 3, 4]);
  // preserves date + count
  assert.equal(b[4].date, '2026-06-05');
  assert.equal(b[4].count, 8);
});

test('heatBuckets is all-zero level when there is no activity', () => {
  const b = heatBuckets([{ date: 'd1', count: 0 }, { date: 'd2', count: 0 }]);
  assert.deepEqual(b.map((x) => x.level), [0, 0]);
});

test('heatBuckets handles empty/invalid input', () => {
  assert.deepEqual(heatBuckets([]), []);
  assert.deepEqual(heatBuckets(null), []);
});
