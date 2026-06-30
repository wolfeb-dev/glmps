// server/lib/deps.js
// Declarative third-party dependency manifest for `glmps init`.
import { spawnSync } from 'node:child_process';

export const DEP_MANIFEST = [
  { name: 'node', kind: 'runtime', required: true, cmd: ['node', '--version'], why: 'server runtime (>=18)' },
  { name: 'git', kind: 'cli', required: true, cmd: ['git', '--version'], why: 'branch display, worktrees, learning commits' },
  { name: 'graphify', kind: 'cli', required: false, cmd: ['graphify', '--version'], why: 'knowledge-graph rebuild/update; degrades to no-op' },
  { name: 'claude', kind: 'cli', required: false, cmd: ['claude', '--version'], why: 'queue-runner launch + learning idea-apply' },
];

export function defaultRun(cmd) {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf-8', shell: false });
  return { status: r.status ?? (r.error ? 127 : 0), stdout: (r.stdout ?? '').trim() };
}

export function checkDep(dep, run = defaultRun) {
  let res; try { res = run(dep.cmd); } catch { res = { status: 127, stdout: '' }; }
  const present = res.status === 0;
  return { name: dep.name, required: dep.required, present, version: present ? (res.stdout || null) : null };
}

export function checkDeps(run = defaultRun) {
  const results = DEP_MANIFEST.map(d => checkDep(d, run));
  const missingRequired = results.filter(r => r.required && !r.present).map(r => r.name);
  return { ok: missingRequired.length === 0, results, missingRequired };
}
