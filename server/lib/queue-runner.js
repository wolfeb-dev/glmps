// server/lib/queue-runner.js
// Pure decision core for the queue runner. No I/O; the server injects effects.

import path from 'node:path';

export function pickNextJob(items = []) {
  // Poison gate: a quarantined ticket (flagged at intake by poison-scan) is never
  // auto-launched. It stays queued and visible until an operator approves it.
  const queued = items.filter(i => i.state === 'queued' && !i.quarantined);
  if (!queued.length) return null;
  return queued.reduce((best, i) => (i.order < best.order ? i : best));
}

export function shouldClaim({ enabled, paused, runningCount, maxConcurrent } = {}) {
  return !!enabled && !paused && runningCount < maxConcurrent;
}

// Build the seed header prepended to a launched job's prompt. Pure + testable.
// Discord handoff guard (glmps-21): when a ticket carries a discord origin, the
// launched session is told it OWNS the single reply to that chat, so a message
// handed off to the backlog is not ALSO answered inline by the session that
// filed it. The filing session sets the origin and stays silent; this session
// is the one point of reply.
export function launchHeader({ job = {}, port } = {}) {
  const lines = [
    `Backlog card ${job.id} (project: ${job.project}). You were launched by the GLMPS queue runner.`,
    `When done, close the card: PATCH http://127.0.0.1:${port}/api/backlog/${job.id} with {"labels":["agent:done"]} (use "agent:backlog" to requeue).`,
  ];
  const o = job.origin;
  if (o && o.via === 'discord' && o.chatId) {
    lines.push(
      `This ticket was handed off from Discord and you OWN the reply: when done, reply to Discord chat ${o.chatId}` +
      `${o.messageId ? ` (re: message ${o.messageId})` : ''} via the discord reply tool. The session that filed this ` +
      `ticket will NOT reply inline, so do not assume the user already received an answer.`,
    );
  }
  lines.push(`Your task follows.`);
  return lines.join('\n');
}

// ── Worktree isolation ───────────────────────────────────────────────────────
// Two agents launched for the SAME project would otherwise share one checkout
// (`cwd: repoFor(project)`) and clobber each other's files. Mirroring the AO
// mechanic, each isolated job gets a private git worktree on its own branch.

// Isolation is mandatory once more than one lane can run (maxConcurrent > 1) and
// can be forced on for a single lane via the `useWorktrees` config flag.
export function shouldIsolate({ useWorktrees = false, maxConcurrent = 1 } = {}) {
  return !!useWorktrees || maxConcurrent > 1;
}

// Scrub anything that is not path- and git-branch-safe (spaces, ~ ^ : ? * etc.)
// down to '-', so the worktree dir is clean and the branch name is git-legal.
function safeSeg(s) { return String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '-'); }

// Deterministic, collision-free location + branch for a job: one dir per
// (project, jobId) under baseDir, on branch glmps-runner/<project>/<jobId>.
export function worktreePlan({ baseDir, project, jobId }) {
  const proj = safeSeg(project);
  const job = safeSeg(jobId);
  return { dir: path.join(baseDir, proj, job), branch: `glmps-runner/${proj}/${job}` };
}

// Pure git command recipes (file + argv); the server executes them with
// execFileSync — never a shell, so spaced paths and branch names are safe.
// `-B` (force-create/reset) tolerates a leftover branch from a crashed run.
export function worktreeAddRecipe({ repo, dir, branch }) {
  return { file: 'git', args: ['-C', repo, 'worktree', 'add', '-B', branch, dir] };
}
export function worktreeRemoveRecipe({ repo, dir }) {
  return { file: 'git', args: ['-C', repo, 'worktree', 'remove', '--force', dir] };
}
export function worktreePruneRecipe({ repo }) {
  return { file: 'git', args: ['-C', repo, 'worktree', 'prune'] };
}

const FINISHED = new Set(['done', 'in_review', 'cancelled']);

export function reconcileLedger({ ledger = {}, items = [], isAlive, now, maxRuntimeMs, maxRetries } = {}) {
  const byId = new Map(items.map(i => [i.id, i]));
  const next = {};
  const actions = [];
  for (const [id, entry] of Object.entries(ledger)) {
    const item = byId.get(id);
    if (!item || FINISHED.has(item.state)) continue;
    // A null pid means the session is editor/companion-owned (launchSession could
    // not return a real pid); its liveness is governed by the card state and the
    // runtime timeout only, never a pid probe. Probing it would read every such
    // still-running job as "exited" and requeue it on the next tick.
    const exited = entry.pid != null && !isAlive(entry.pid);
    const overran = (now - entry.startedAt) > maxRuntimeMs;
    if (!exited && !overran) { next[id] = entry; continue; }
    const reason = overran ? 'timeout' : 'process exited';
    if (entry.retries < maxRetries) {
      actions.push({ id, action: 'requeue', reason });
      next[id] = { ...entry, retries: entry.retries + 1 };
    } else {
      actions.push({ id, action: 'hold', reason });
    }
  }
  return { ledger: next, actions };
}
