// server/test/deps.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEP_MANIFEST, checkDep, checkDeps } from '../lib/deps.js';

const fakeRun = (present) => (cmd) =>
  present.includes(cmd[0]) ? { status: 0, stdout: cmd[0] + ' 1.2.3' } : { status: 127, stdout: '' };

test('manifest has node+git required, graphify+claude optional', () => {
  const byName = Object.fromEntries(DEP_MANIFEST.map(d => [d.name, d]));
  assert.equal(byName.node.required, true);
  assert.equal(byName.git.required, true);
  assert.equal(byName.graphify.required, false);
  assert.equal(byName.claude.required, false);
});

test('checkDep reports presence/version', () => {
  const r = checkDep(DEP_MANIFEST[0], fakeRun(['node']));
  assert.equal(r.present, true);
  assert.match(r.version, /1\.2\.3/);
});

test('checkDeps ok only when all required present', () => {
  assert.equal(checkDeps(fakeRun(['node', 'git'])).ok, true);
  const miss = checkDeps(fakeRun(['node'])); // git missing
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.missingRequired, ['git']);
});
