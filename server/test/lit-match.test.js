// server/test/lit-match.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLitNodeIds, isLitPath } from '../../web/lit-match.js';

// ── helpers ───────────────────────────────────────────────────────────────────
function fileEditEvent(path) {
  return { kind: 'file-edit', path };
}
function node(id, source_file) {
  return { id, source_file };
}

// ── isLitPath ─────────────────────────────────────────────────────────────────

test('isLitPath: exact match', () => {
  assert.ok(isLitPath(['lib/paths.js'], 'lib/paths.js'));
});

test('isLitPath: suffix match on / boundary — server/ root stripping', () => {
  assert.ok(isLitPath(['D:/glmps/server/lib/paths.js'], 'lib/paths.js'));
});

test('isLitPath: does NOT match on basename alone (different zone)', () => {
  // Edit is server/lib/paths.js. source_file 'web/paths.js' shares only a
  // basename with 'lib/paths.js' but the suffix rule requires the full
  // source_file segment to appear after a '/', not just the tail.
  // 'D:/glmps/server/lib/paths.js' does NOT end with '/web/paths.js'.
  assert.ok(!isLitPath(['D:/glmps/server/lib/paths.js'], 'web/paths.js'),
    'web/paths.js must not be lit by an edit to server/lib/paths.js');
});

test('isLitPath: returns false for empty sourceFile', () => {
  assert.ok(!isLitPath(['D:/glmps/server/lib/paths.js'], ''));
  assert.ok(!isLitPath(['D:/glmps/server/lib/paths.js'], null));
});

test('isLitPath: returns false when no edit paths', () => {
  assert.ok(!isLitPath([], 'lib/paths.js'));
});

// ── computeLitNodeIds ─────────────────────────────────────────────────────────

test('computeLitNodeIds: suffix match lights the right node', () => {
  const events = [fileEditEvent('D:/glmps/server/lib/paths.js')];
  const nodes  = [node('n1', 'lib/paths.js'), node('n2', 'web/paths.js')];
  const lit    = computeLitNodeIds(events, nodes);
  assert.ok(lit.has('n1'),  'n1 (lib/paths.js) should be lit');
  assert.ok(!lit.has('n2'), 'n2 (web/paths.js) must NOT be lit (different zone, basename only)');
});

test('computeLitNodeIds: backslash edit paths normalize and match', () => {
  const events = [fileEditEvent('D:\\glmps\\server\\lib\\paths.js')];
  const nodes  = [node('n1', 'lib/paths.js')];
  const lit    = computeLitNodeIds(events, nodes);
  assert.ok(lit.has('n1'));
});

test('computeLitNodeIds: empty events → empty lit set', () => {
  const lit = computeLitNodeIds([], [node('n1', 'lib/paths.js')]);
  assert.equal(lit.size, 0);
});

test('computeLitNodeIds: null/undefined events → empty lit set', () => {
  assert.equal(computeLitNodeIds(null,      [node('n1', 'lib/x.js')]).size, 0);
  assert.equal(computeLitNodeIds(undefined, [node('n1', 'lib/x.js')]).size, 0);
});

test('computeLitNodeIds: no file-edit events → empty lit set', () => {
  const events = [
    { kind: 'tool-use', path: 'D:/glmps/server/lib/paths.js' },
    { kind: 'agent-start', path: 'D:/glmps/server/lib/paths.js' },
  ];
  const lit = computeLitNodeIds(events, [node('n1', 'lib/paths.js')]);
  assert.equal(lit.size, 0);
});

test('computeLitNodeIds: multiple edits light multiple nodes', () => {
  const events = [
    fileEditEvent('D:/glmps/server/lib/paths.js'),
    fileEditEvent('D:/glmps/server/server.js'),
  ];
  const nodes  = [node('n1', 'lib/paths.js'), node('n2', 'server.js'), node('n3', 'web/app.js')];
  const lit    = computeLitNodeIds(events, nodes);
  assert.ok(lit.has('n1'));
  assert.ok(lit.has('n2'));
  assert.ok(!lit.has('n3'));
});

test('computeLitNodeIds: no false basename collision — two nodes same filename different zones', () => {
  // lib/adapter.js vs web/adapter.js — only the suffix-matching one should light
  const events = [fileEditEvent('D:/glmps/server/lib/adapter.js')];
  const nodes  = [
    node('server-adapter', 'lib/adapter.js'),
    node('web-adapter',    'web/adapter.js'),
  ];
  const lit = computeLitNodeIds(events, nodes);
  assert.ok(lit.has('server-adapter'),  'server-side adapter must be lit');
  assert.ok(!lit.has('web-adapter'),    'web adapter must NOT be lit');
});

test('computeLitNodeIds: null/undefined nodes → empty lit set', () => {
  const events = [fileEditEvent('D:/glmps/server/lib/paths.js')];
  assert.equal(computeLitNodeIds(events, null).size,      0);
  assert.equal(computeLitNodeIds(events, undefined).size, 0);
});
