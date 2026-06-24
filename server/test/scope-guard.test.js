// Tests for the pure scope-guard decision function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideScopeGuard } from '../lib/scope-guard.js';

const CONTRACT = { commands: ['npm test'] };
const ROOT = '/repo';
const CUSTOM_CONFIG = {
  prefixes: [],
  protectedSegments: [],
  protectedRoots: ['/repo/prod-deploy'],
};

// --- no contract -> always allow (limits blast radius to opted-in repos) ---

test('no contract -> allow, empty reason', () => {
  const r = decideScopeGuard({
    changedPaths: ['/repo/prod/config.py'],
    projectRoot: ROOT,
    contract: null,
  });
  assert.equal(r.action, 'allow');
  assert.equal(r.reason, '');
});

// --- override -> allow with override reason ---

test('override truthy -> allow with override reason', () => {
  const r = decideScopeGuard({
    changedPaths: ['/repo/prod/config.py'],
    projectRoot: ROOT,
    contract: CONTRACT,
    override: true,
  });
  assert.equal(r.action, 'allow');
  assert.match(r.reason, /prod\.allow/);
});

// --- no protected paths -> allow ---

test('no protected paths -> allow', () => {
  const r = decideScopeGuard({
    changedPaths: ['/repo/server/lib/foo.js', '/repo/web/index.html'],
    projectRoot: ROOT,
    contract: CONTRACT,
  });
  assert.equal(r.action, 'allow');
  assert.equal(r.protectedCount, 0);
  assert.deepEqual(r.protected, []);
});

// --- empty changedPaths -> allow ---

test('empty changedPaths -> allow', () => {
  const r = decideScopeGuard({
    changedPaths: [],
    projectRoot: ROOT,
    contract: CONTRACT,
  });
  assert.equal(r.action, 'allow');
  assert.equal(r.protectedCount, 0);
});

// --- protected paths present -> block ---

test('protected path (segment "prod") + contract -> block', () => {
  const r = decideScopeGuard({
    changedPaths: ['/repo/prod/config.py', '/repo/server/lib/foo.js'],
    projectRoot: ROOT,
    contract: CONTRACT,
  });
  assert.equal(r.action, 'block');
  assert.equal(r.protectedCount, 1);
  assert.ok(r.protected.length === 1);
  // reason must name the file
  assert.match(r.reason, /config\.py/);
  // reason must name the zone
  assert.match(r.reason, /prod/);
  // reason must name the escape hatch
  assert.match(r.reason, /prod\.allow/);
});

test('multiple protected paths -> block with all listed', () => {
  const r = decideScopeGuard({
    changedPaths: ['/repo/prod/a.py', '/repo/prod/b.py'],
    projectRoot: ROOT,
    contract: CONTRACT,
  });
  assert.equal(r.action, 'block');
  assert.equal(r.protectedCount, 2);
  assert.match(r.reason, /a\.py/);
  assert.match(r.reason, /b\.py/);
});

// --- override suppresses block even when protected ---

test('override + protected -> allow', () => {
  const r = decideScopeGuard({
    changedPaths: ['/repo/prod/config.py'],
    projectRoot: ROOT,
    contract: CONTRACT,
    override: 'prod.allow',
  });
  assert.equal(r.action, 'allow');
  assert.match(r.reason, /prod\.allow/);
});

// --- custom config with protectedRoots ---

test('custom config protectedRoots -> block for path under that root', () => {
  const r = decideScopeGuard({
    changedPaths: ['/repo/prod-deploy/main.tf'],
    projectRoot: ROOT,
    config: CUSTOM_CONFIG,
    contract: CONTRACT,
  });
  assert.equal(r.action, 'block');
  assert.equal(r.protectedCount, 1);
  assert.match(r.reason, /main\.tf/);
});

test('custom config protectedRoots -> allow for path outside that root', () => {
  const r = decideScopeGuard({
    changedPaths: ['/repo/server/lib/foo.js'],
    projectRoot: ROOT,
    config: CUSTOM_CONFIG,
    contract: CONTRACT,
  });
  assert.equal(r.action, 'allow');
  assert.equal(r.protectedCount, 0);
});

// --- return shape ---

test('block result has protectedCount and protected array', () => {
  const r = decideScopeGuard({
    changedPaths: ['/repo/prod/x.js'],
    projectRoot: ROOT,
    contract: CONTRACT,
  });
  assert.equal(typeof r.protectedCount, 'number');
  assert.ok(Array.isArray(r.protected));
  assert.ok(r.protected[0].path);
  assert.ok(r.protected[0].zone);
});
