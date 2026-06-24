// server/test/graph-status.test.js
// Unit tests for the pure computeGraphStatus function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGraphStatus } from '../lib/graph-status.js';

const BASE = { project: 'my-repo', root: '/d/my-repo', nodes: 42, mtimeMs: 1700000000000 };

test('needsUpdate true when commits differ', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: 'abc1234', headCommit: 'def5678' });
  assert.equal(r.needsUpdate, true);
});

test('needsUpdate false when commits are equal', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: 'abc1234', headCommit: 'abc1234' });
  assert.equal(r.needsUpdate, false);
});

test('needsUpdate false when builtAtCommit is missing', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: null, headCommit: 'abc1234' });
  assert.equal(r.needsUpdate, false);
});

test('needsUpdate false when headCommit is missing', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: 'abc1234', headCommit: null });
  assert.equal(r.needsUpdate, false);
});

test('needsUpdate false when both commits missing', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: null, headCommit: null });
  assert.equal(r.needsUpdate, false);
});

test('passes nodes through as integer', () => {
  const r = computeGraphStatus({ ...BASE, nodes: 17.9, builtAtCommit: null, headCommit: null });
  assert.equal(r.nodes, 17);
});

test('nodes defaults to 0 for undefined/falsy', () => {
  const r = computeGraphStatus({ ...BASE, nodes: undefined, builtAtCommit: null, headCommit: null });
  assert.equal(r.nodes, 0);
});

test('passes rebuiltMs (mtimeMs) through', () => {
  const r = computeGraphStatus({ ...BASE, mtimeMs: 9999, builtAtCommit: null, headCommit: null });
  assert.equal(r.rebuiltMs, 9999);
});

test('rebuiltMs is null when mtimeMs is null/undefined', () => {
  const r = computeGraphStatus({ ...BASE, mtimeMs: null, builtAtCommit: null, headCommit: null });
  assert.equal(r.rebuiltMs, null);
  const r2 = computeGraphStatus({ ...BASE, mtimeMs: undefined, builtAtCommit: null, headCommit: null });
  assert.equal(r2.rebuiltMs, null);
});

test('passes project, root, builtAtCommit, headCommit through', () => {
  const r = computeGraphStatus({
    project: 'foo', root: '/x/foo', nodes: 3, mtimeMs: 1,
    builtAtCommit: 'aaa', headCommit: 'bbb',
  });
  assert.equal(r.project, 'foo');
  assert.equal(r.root, '/x/foo');
  assert.equal(r.builtAtCommit, 'aaa');
  assert.equal(r.headCommit, 'bbb');
});

test('needsUpdate false when builtAtCommit is empty string', () => {
  const r = computeGraphStatus({ ...BASE, builtAtCommit: '', headCommit: 'abc1234' });
  assert.equal(r.needsUpdate, false);
});
