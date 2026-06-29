import fs from 'node:fs';
import path from 'node:path';

export function replayFile(stateDir) {
  return path.join(stateDir, 'replay', 'tasks.json');
}

export function load(stateDir) {
  try { return { tasks: [], ...JSON.parse(fs.readFileSync(replayFile(stateDir), 'utf-8')) }; }
  catch { return { tasks: [] }; }
}

export function save(stateDir, state) {
  const f = replayFile(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, f);
}

export function addReplayTask(stateDir, { id, project = null, promptFile = null, baseline = null } = {}) {
  const state = load(stateDir);
  const existing = state.tasks.find(t => t.id === id);
  if (existing) return { task: existing, isNew: false };
  const task = { id, project, promptFile, baseline, createdAt: new Date().toISOString() };
  const next = { ...state, tasks: [...state.tasks, task] };
  save(stateDir, next);
  return { task, isNew: true };
}

export function listReplayTasks(stateDir) {
  return load(stateDir).tasks;
}
