// server/test/map-zones.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirOf, groupByDirectory, dirDisplayLabel, dirZoneColor } from '../../web/map-zones.js';

const node = (id, source_file, extra = {}) => ({ id, source_file, ...extra });

// ── dirOf ─────────────────────────────────────────────────────────────────────
test('dirOf: nested path → directory', () => {
  assert.equal(dirOf('lib/adapters/agy-cli.js'), 'lib/adapters');
});
test('dirOf: single-segment dir', () => {
  assert.equal(dirOf('lib/paths.js'), 'lib');
});
test('dirOf: root file → "."', () => {
  assert.equal(dirOf('server.js'), '.');
});
test('dirOf: backslashes normalize', () => {
  assert.equal(dirOf('lib\\adapters\\x.js'), 'lib/adapters');
});
test('dirOf: empty/nullish → "."', () => {
  assert.equal(dirOf(''), '.');
  assert.equal(dirOf(null), '.');
});

// ── groupByDirectory ───────────────────────────────────────────────────────────
test('groupByDirectory: splits nodes into directory buckets', () => {
  const nodes = [
    node('a', 'lib/paths.js'),
    node('b', 'lib/zones.js'),
    node('c', 'lib/adapters/x.js'),
    node('d', 'server.js'),
  ];
  const g = groupByDirectory(nodes);
  assert.deepEqual([...g.keys()].sort(), ['.', 'lib', 'lib/adapters']);
  assert.equal(g.get('lib').length, 2);
  assert.equal(g.get('lib/adapters').length, 1);
  assert.equal(g.get('.').length, 1);
});
test('groupByDirectory: lib and lib/adapters are separate buckets', () => {
  const nodes = [node('a', 'lib/x.js'), node('b', 'lib/adapters/y.js')];
  const g = groupByDirectory(nodes);
  assert.ok(g.has('lib'));
  assert.ok(g.has('lib/adapters'));
  assert.notEqual(g.get('lib'), g.get('lib/adapters'));
});
test('groupByDirectory: null/undefined → empty map', () => {
  assert.equal(groupByDirectory(null).size, 0);
  assert.equal(groupByDirectory(undefined).size, 0);
});

// ── dirDisplayLabel ─────────────────────────────────────────────────────────────
test('dirDisplayLabel: short path passes through', () => {
  assert.deepEqual(dirDisplayLabel('lib/adapters'), { text: 'lib/adapters', full: 'lib/adapters' });
});
test('dirDisplayLabel: root shows (root)', () => {
  assert.deepEqual(dirDisplayLabel('.'), { text: '(root)', full: '(root)' });
});
test('dirDisplayLabel: long path truncates with … and keeps the tail; full retains complete path', () => {
  const dir = 'server/lib/adapters/very/deep/nested/folder';
  const { text, full } = dirDisplayLabel(dir, 20);
  assert.equal(full, dir);
  assert.ok(text.startsWith('…'));
  assert.equal(text.length, 20);
  assert.ok(dir.endsWith(text.slice(1)));   // tail preserved
});

// ── dirZoneColor ────────────────────────────────────────────────────────────────
const fakeZoneColor = (zone, isProtected) => ({ zone, isProtected });

test('dirZoneColor: resolves most-frequent zone among nodes', () => {
  const dirNodes = [
    node('a', 'lib/adapters/x.js', { zone: 'lib' }),
    node('b', 'lib/adapters/y.js', { zone: 'lib' }),
  ];
  const col = dirZoneColor(dirNodes, fakeZoneColor);
  assert.equal(col.zone, 'lib');
  assert.equal(col.isProtected, false);
});
test('dirZoneColor: protected if any node protected/prod', () => {
  const dirNodes = [
    node('a', 'x/y.js', { zone: 'x' }),
    node('b', 'x/z.js', { zone: 'x', env: 'prod' }),
  ];
  assert.equal(dirZoneColor(dirNodes, fakeZoneColor).isProtected, true);
});
test('dirZoneColor: mixed zones → most frequent wins, ties keep first seen', () => {
  const dirNodes = [
    node('a', 'x/a.js', { zone: 'lib' }),
    node('b', 'x/b.js', { zone: 'web' }),
    node('c', 'x/c.js', { zone: 'lib' }),
  ];
  assert.equal(dirZoneColor(dirNodes, fakeZoneColor).zone, 'lib');
  const tie = [node('a', 'x/a.js', { zone: 'web' }), node('b', 'x/b.js', { zone: 'lib' })];
  assert.equal(dirZoneColor(tie, fakeZoneColor).zone, 'web');
});
