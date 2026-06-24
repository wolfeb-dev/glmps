import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function git(repo, ...args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }); }

// A real, committed git repo whose basename is the backlog card's `project`.
function makeRepo() {
  const repo = tmp('mc-wtrepo-');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  return repo;
}

async function withRepoServer(fn) {
  const repo = makeRepo();
  const project = path.basename(repo);
  const stateDir = tmp('mc-wt-state-');
  const claudeDir = tmp('mc-wt-claude-');
  // repoForProject discovers roots from settings.additionalDirectories.
  fs.writeFileSync(path.join(claudeDir, 'settings.json'),
    JSON.stringify({ permissions: { additionalDirectories: [repo] } }));
  // DRYRUN skips the real terminal/editor launch but the worktree git ops still run.
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const api = {
    get: (p) => j(p),
    post: (p, o) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }),
    patch: (p, o) => j(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }),
  };
  try { await fn({ ...api, h, repo, project }); }
  finally {
    await h.close?.();
    for (const d of [repo, stateDir, claudeDir]) fs.rmSync(d, { recursive: true, force: true });
  }
}

test('a launched job runs in its own git worktree, not the shared repo (useWorktrees)', async () => {
  await withRepoServer(async ({ get, post, h, repo, project }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    await post('/api/backlog', { title: 'job-a', prompt: 'do a', project });
    h.runnerTick();

    const entry = (await get('/api/runner')).body.ledger['glmps-1'];
    assert.ok(entry, 'card was claimed');
    assert.ok(entry.worktree, 'ledger records the worktree');
    const wt = entry.worktree.dir;
    assert.notEqual(path.resolve(wt), path.resolve(repo), 'worktree is isolated from the repo root');
    assert.ok(fs.existsSync(wt), 'worktree dir exists on disk');
    assert.ok(fs.existsSync(path.join(wt, '.git')), 'worktree is a real git worktree');
    // The seeded README from the repo is present in the isolated checkout.
    assert.ok(fs.existsSync(path.join(wt, 'README.md')));
    // The job's branch is checked out there.
    const branches = git(repo, 'branch', '--list', 'glmps-runner/*');
    assert.match(branches, /glmps-runner\//);
  });
});

test('finishing a card removes its worktree checkout but keeps the branch', async () => {
  await withRepoServer(async ({ get, post, patch, h, repo, project }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    await post('/api/backlog', { title: 'job-a', prompt: 'do a', project });
    h.runnerTick();
    const wt = (await get('/api/runner')).body.ledger['glmps-1'].worktree.dir;
    assert.ok(fs.existsSync(wt));

    // Agent self-reports done -> next reconcile drops the ledger entry + cleans the worktree.
    await patch('/api/backlog/glmps-1', { labels: ['agent:done'] });
    h.runnerTick();

    assert.equal((await get('/api/runner')).body.ledger['glmps-1'], undefined, 'ledger entry cleared');
    assert.ok(!fs.existsSync(wt), 'worktree checkout removed');
    // Branch survives so any committed work is recoverable.
    assert.match(git(repo, 'branch', '--list', 'glmps-runner/*'), /glmps-runner\//);
  });
});

test('single-lane default (no useWorktrees, maxConcurrent 1) launches in the repo itself', async () => {
  await withRepoServer(async ({ get, post, h, repo, project }) => {
    await post('/api/runner/config', { enabled: true });
    await post('/api/backlog', { title: 'job-a', prompt: 'do a', project });
    h.runnerTick();
    const entry = (await get('/api/runner')).body.ledger['glmps-1'];
    assert.ok(entry, 'card was claimed');
    assert.equal(entry.worktree ?? null, null, 'no worktree at single-lane default');
    assert.equal(git(repo, 'worktree', 'list').trim().split('\n').length, 1, 'repo has no extra worktrees');
  });
});
