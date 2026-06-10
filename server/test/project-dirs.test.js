// server/test/project-dirs.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRepoDirs, computeAdditionalDirectories, syncProjectDirs } from '../lib/project-dirs.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }
function mkRepo(root, name) { const d = path.join(root, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; }
function mkPlain(root, name) { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; }

test('findRepoDirs returns only child dirs containing .git', () => {
  const root = mkTmp();
  mkRepo(root, 'alpha'); mkRepo(root, 'beta'); mkPlain(root, 'notrepo');
  const found = findRepoDirs([root]).map(p => path.basename(p)).sort();
  assert.deepEqual(found, ['alpha', 'beta']);
});

test('computeAdditionalDirectories refreshes managed roots, preserves externals, sorts', () => {
  const root = mkTmp();
  mkRepo(root, 'alpha');
  const external = 'X:/manual/dir';
  const stale = root.replace(/\\/g, '/') + '/stale-removed';
  const next = computeAdditionalDirectories({ roots: [root], current: [external, stale] });
  assert.ok(next.includes(external), 'external entry preserved');
  assert.ok(next.some(d => d.endsWith('/alpha')), 'discovered repo added');
  assert.ok(!next.some(d => d.endsWith('/stale-removed')), 'stale managed entry dropped');
  assert.deepEqual(next, [...next].sort((a, b) => a.localeCompare(b)), 'sorted');
});

test('syncProjectDirs writes idempotently and preserves other settings', () => {
  const root = mkTmp(); mkRepo(root, 'alpha');
  const settingsFile = path.join(mkTmp(), 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { defaultMode: 'auto' }, theme: 'dark' }, null, 2));
  const r1 = syncProjectDirs({ settingsFile, roots: [root] });
  assert.equal(r1.ok, true); assert.equal(r1.changed, true);
  const s1 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(s1.theme, 'dark');
  assert.equal(s1.permissions.defaultMode, 'auto');
  assert.ok(s1.permissions.additionalDirectories.some(d => d.endsWith('/alpha')));
  const r2 = syncProjectDirs({ settingsFile, roots: [root] });
  assert.equal(r2.changed, false); // idempotent
});

test('syncProjectDirs refuses unreadable settings', () => {
  const r = syncProjectDirs({ settingsFile: path.join(mkTmp(), 'nope.json'), roots: [] });
  assert.equal(r.ok, false);
});
