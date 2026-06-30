import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as qr from '../lib/queue-runner.js';

test('pickNextJob returns lowest-order queued item', () => {
  const items = [
    { id: 'a', state: 'queued', order: 5 },
    { id: 'b', state: 'in_progress', order: 1 },
    { id: 'c', state: 'queued', order: 2 },
  ];
  assert.equal(qr.pickNextJob(items).id, 'c');
  assert.equal(qr.pickNextJob([{ id: 'x', state: 'done', order: 0 }]), null);
});

test('launchHeader: base header names the card and the close instruction', () => {
  const h = qr.launchHeader({ job: { id: 'glmps-7', project: 'nq' }, port: 8123 });
  assert.match(h, /Backlog card glmps-7 \(project: nq\)/);
  assert.match(h, /PATCH http:\/\/127\.0\.0\.1:8123\/api\/backlog\/glmps-7/);
  assert.match(h, /Your task follows\./);
  // No discord origin -> no handoff line.
  assert.doesNotMatch(h, /Discord/i);
});

test('launchHeader: a discord-origin ticket tells the launched session it OWNS the reply', () => {
  const h = qr.launchHeader({
    job: { id: 'glmps-8', project: 'nq', origin: { via: 'discord', chatId: 'C123', messageId: 'M456' } },
    port: 8123,
  });
  assert.match(h, /handed off from Discord/i);
  assert.match(h, /C123/);
  assert.match(h, /message M456/);
  assert.match(h, /will NOT reply inline/i);
});

test('launchHeader: discord origin without chatId adds no handoff line (incomplete origin)', () => {
  const h = qr.launchHeader({ job: { id: 'glmps-9', project: 'nq', origin: { via: 'discord' } }, port: 8123 });
  assert.doesNotMatch(h, /OWN the reply/i);
});

test('pickNextJob skips quarantined items (poison gate)', () => {
  const items = [
    { id: 'q', state: 'queued', order: 1, quarantined: true },
    { id: 'ok', state: 'queued', order: 2 },
  ];
  assert.equal(qr.pickNextJob(items).id, 'ok', 'quarantined job is not auto-launched');
  assert.equal(qr.pickNextJob([{ id: 'q', state: 'queued', order: 1, quarantined: true }]), null);
});

test('shouldClaim respects enabled, paused, and concurrency', () => {
  assert.equal(qr.shouldClaim({ enabled: true, paused: false, runningCount: 0, maxConcurrent: 1 }), true);
  assert.equal(qr.shouldClaim({ enabled: false, paused: false, runningCount: 0, maxConcurrent: 1 }), false);
  assert.equal(qr.shouldClaim({ enabled: true, paused: true, runningCount: 0, maxConcurrent: 1 }), false);
  assert.equal(qr.shouldClaim({ enabled: true, paused: false, runningCount: 1, maxConcurrent: 1 }), false);
});

test('reconcile drops finished jobs, requeues dead ones, holds past maxRetries', () => {
  const items = [
    { id: 'done1', state: 'done' },
    { id: 'dead1', state: 'in_progress' },
    { id: 'dead2', state: 'in_progress' },
  ];
  const ledger = {
    done1: { pid: 1, startedAt: 0, target: 'cursor', retries: 0 },
    dead1: { pid: 2, startedAt: 0, target: 'cursor', retries: 0 },
    dead2: { pid: 3, startedAt: 0, target: 'cursor', retries: 2 },
  };
  const isAlive = (pid) => false;
  const out = qr.reconcileLedger({ ledger, items, isAlive, now: 10, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.equal(out.ledger.done1, undefined);
  assert.equal(out.ledger.dead1.retries, 1);
  assert.equal(out.ledger.dead2, undefined);
  assert.deepEqual(out.actions.find(a => a.id === 'dead1'), { id: 'dead1', action: 'requeue', reason: 'process exited' });
  assert.equal(out.actions.find(a => a.id === 'dead2').action, 'hold');
});

test('reconcile keeps an editor-launched job (pid null) alive until done or timeout', () => {
  // Editor/companion launches own their own process, so launchSession records a
  // null pid ("liveness tracked via card state + timeout"). A null pid must NOT be
  // read as "exited" — otherwise a still-running session is requeued every tick.
  const items = [{ id: 'editor1', state: 'in_progress' }];
  const ledger = { editor1: { pid: null, startedAt: 0, target: 'antigravity', retries: 0 } };
  const out = qr.reconcileLedger({ ledger, items, isAlive: () => false, now: 500, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.deepEqual(out.actions, [], 'no requeue/hold while within the runtime budget');
  assert.ok(out.ledger.editor1, 'entry retained');
  assert.equal(out.ledger.editor1.retries, 0, 'no retry burned');
});

test('reconcile still times out a stuck editor-launched job (pid null) past maxRuntimeMs', () => {
  const items = [{ id: 'editor1', state: 'in_progress' }];
  const ledger = { editor1: { pid: null, startedAt: 0, target: 'antigravity', retries: 0 } };
  const out = qr.reconcileLedger({ ledger, items, isAlive: () => false, now: 5000, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.equal(out.actions[0].action, 'requeue');
  assert.match(out.actions[0].reason, /timeout/);
});

test('reconcile holds/requeues a live-but-overrunning job', () => {
  const items = [{ id: 'slow', state: 'in_progress' }];
  const ledger = { slow: { pid: 9, startedAt: 0, target: 'cursor', retries: 0 } };
  const out = qr.reconcileLedger({ ledger, items, isAlive: () => true, now: 5000, maxRuntimeMs: 1000, maxRetries: 2 });
  assert.equal(out.actions[0].action, 'requeue');
  assert.match(out.actions[0].reason, /timeout/);
});

// ── Worktree isolation (parallel agents must not clobber a shared repo) ──

test('shouldIsolate: worktrees engage when forced on OR when concurrency > 1', () => {
  // The default (single lane, no force) keeps the agent in the repo itself.
  assert.equal(qr.shouldIsolate({ useWorktrees: false, maxConcurrent: 1 }), false);
  // Raising concurrency auto-engages isolation — the safety net for same-project jobs.
  assert.equal(qr.shouldIsolate({ useWorktrees: false, maxConcurrent: 2 }), true);
  // Forcing it on isolates even a single lane.
  assert.equal(qr.shouldIsolate({ useWorktrees: true, maxConcurrent: 1 }), true);
  assert.equal(qr.shouldIsolate({}), false);
});

test('worktreePlan: deterministic dir + valid branch, both sanitized', () => {
  const a = qr.worktreePlan({ baseDir: '/wt', project: 'data-pipeline', jobId: 'glmps-1' });
  assert.equal(a.dir, path.join('/wt', 'data-pipeline', 'glmps-1'));
  assert.equal(a.branch, 'glmps-runner/data-pipeline/glmps-1');
  // Same inputs -> same plan (collision-free per job, stable across ticks).
  assert.deepEqual(qr.worktreePlan({ baseDir: '/wt', project: 'data-pipeline', jobId: 'glmps-1' }), a);
  // Spaces / unsafe chars are scrubbed so the path is clean and the branch is git-legal.
  const b = qr.worktreePlan({ baseDir: '/wt', project: 'My Web App', jobId: 'glmps-2' });
  assert.equal(b.dir, path.join('/wt', 'My-Web-App', 'glmps-2'));
  assert.equal(b.branch, 'glmps-runner/My-Web-App/glmps-2');
  assert.ok(!/[ ~^:?*\[\\]/.test(b.branch), 'branch contains no git-illegal characters');
});

test('worktree git recipes target the repo with -C and never use a shell', () => {
  const add = qr.worktreeAddRecipe({ repo: '/repo', dir: '/wt/p/j', branch: 'glmps-runner/p/j' });
  assert.deepEqual(add, { file: 'git', args: ['-C', '/repo', 'worktree', 'add', '-B', 'glmps-runner/p/j', '/wt/p/j'] });
  assert.deepEqual(qr.worktreeRemoveRecipe({ repo: '/repo', dir: '/wt/p/j' }),
    { file: 'git', args: ['-C', '/repo', 'worktree', 'remove', '--force', '/wt/p/j'] });
  assert.deepEqual(qr.worktreePruneRecipe({ repo: '/repo' }),
    { file: 'git', args: ['-C', '/repo', 'worktree', 'prune'] });
});
