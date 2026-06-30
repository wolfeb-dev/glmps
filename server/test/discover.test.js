// server/test/discover.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverRepos, buildProfileDraft } from '../lib/discover.js';

test('discoverRepos finds .git dirs up to depth 2', () => {
  const tree = { '/s/a/.git': true, '/s/b/c/.git': true, '/s/d': true };
  const fsmod = {
    readdirSync: (d) => {
      if (d === '/s') return [{ name: 'a', isDirectory: () => true }, { name: 'b', isDirectory: () => true }, { name: 'd', isDirectory: () => true }];
      if (d === '/s/b') return [{ name: 'c', isDirectory: () => true }];
      return [];
    },
    existsSync: (p) => !!tree[p.replace(/\\/g, '/')],
  };
  const repos = discoverRepos(['/s'], fsmod).map(p => p.replace(/\\/g, '/'));
  assert.ok(repos.includes('/s/a'));
  assert.ok(repos.includes('/s/b/c'));
  assert.ok(!repos.includes('/s/d'));
});

test('buildProfileDraft only includes installed harness dirs', () => {
  const draft = buildProfileDraft({
    engagement: 'acme', identity: { handle: 'al' }, repoRoots: ['/r'],
    harnesses: [{ id: 'claude-code', installed: true, dataDirs: ['/c/claude'] }, { id: 'codex-cli', installed: false, dataDirs: ['/c/codex'] }],
    stateDir: '~/.glmps/acme',
  });
  assert.equal(draft.engagement, 'acme');
  assert.deepEqual(draft.repoRoots, ['/r']);
  assert.equal(draft.harness.claudeDir, '/c/claude');
  assert.ok(!('codexDir' in draft.harness) || draft.harness.codexDir == null);
});
