export async function getState(session) {
  const q = session ? `?session=${encodeURIComponent(session)}` : '';
  return (await fetch(`/api/state${q}`)).json();
}
export function onEvents(handler) {
  const es = new EventSource('/api/events');
  es.onmessage = m => { try { handler(JSON.parse(m.data)); } catch {} };
  return es;
}
export async function search(q, filters = {}) {
  const p = new URLSearchParams({ q });
  if (filters.messageType) p.set('messageType', filters.messageType);
  if (filters.hasErrors) p.set('hasErrors', '1');
  if (filters.hasToolCalls) p.set('hasToolCalls', '1');
  if (filters.hasFileChanges) p.set('hasFileChanges', '1');
  if (filters.project) p.set('project', filters.project);
  if (filters.dateRange?.from) p.set('from', filters.dateRange.from);
  if (filters.dateRange?.to) p.set('to', filters.dateRange.to);
  return (await fetch(`/api/search?${p.toString()}`)).json();
}
export async function readFile(p) {
  const r = await fetch(`/api/file?path=${encodeURIComponent(p)}`);
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || `read failed (${r.status})`); }
  return r.json();
}
export async function saveFile(path, content, hash, force = false) {
  const r = await fetch('/api/file', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content, hash, force }) });
  return { status: r.status, body: await r.json() };
}
export async function undoFile(path) {
  return (await fetch('/api/file/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })).json();
}
export async function resume(sessionId, cwd, location) {
  return (await fetch('/api/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, cwd, location }) })).json();
}
export async function openInEditor(path) {
  const r = await fetch('/api/open-in-editor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  return { status: r.status, body: await r.json() };
}
export async function getConfig() { return (await fetch('/api/config')).json(); }
export async function launchTerminal(terminal, cwd) {
  const r = await fetch('/api/terminal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ terminal, cwd }) });
  return { status: r.status, body: await r.json() };
}
export async function restartServer() {
  return (await fetch('/api/restart', { method: 'POST' })).json();
}
export async function health() {
  try { return (await fetch('/api/health')).ok; } catch { return false; }
}
export async function getLearning() { return (await fetch('/api/learning')).json(); }
export async function addIdea(text) {
  return (await fetch('/api/learning/idea', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })).json();
}
export async function learningAction(id, action, arg) {
  // promote carries a { target } ('global'|'memory'); alternative carries a { rule }.
  const body = action === 'promote' ? { target: arg } : (arg != null ? { rule: arg } : {});
  return (await fetch(`/api/learning/item/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
}
export async function setLearningConfig(autoApplyGaps) {
  return (await fetch('/api/learning/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoApplyGaps }) })).json();
}
export async function fetchBudget() { return (await fetch('/api/budget')).json(); }
export async function fetchEngagement() { return (await fetch('/api/engagement')).json(); }
export async function getAgents() { return (await fetch('/api/agents')).json(); }
export async function getGraph(project, session) {
  const q = new URLSearchParams();
  if (project) q.set('project', project);
  if (session) q.set('session', session);
  return (await fetch('/api/graph?' + q)).json();
}
export async function getBacklog(project) {
  const q = project ? `?project=${encodeURIComponent(project)}` : '';
  return (await fetch(`/api/backlog${q}`)).json();
}
export async function addBacklogItem(item) {
  return (await fetch('/api/backlog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item) })).json();
}
export async function updateBacklogItem(id, patch) {
  return (await fetch(`/api/backlog/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })).json();
}
export async function setBacklogPaused(paused) {
  return (await fetch('/api/backlog/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused }) })).json();
}
export async function approveBacklogItem(id) {
  return (await fetch(`/api/backlog/${encodeURIComponent(id)}/approve`, { method: 'POST' })).json();
}

// ── Queue runner ─────────────────────────────────────────────────────────────
export async function getRunner() { return (await fetch('/api/runner')).json(); }
export async function setRunnerConfig(patch) {
  return (await fetch('/api/runner/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })).json();
}
export async function runBacklogItem(id) {
  const r = await fetch(`/api/runner/run/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// ── Graph + learning maintenance ─────────────────────────────────────────────

export async function graphStatus() {
  return (await fetch('/api/graph/status')).json();
}
export async function rebuildGraph(root) {
  const body = root ? { root } : {};
  return (await fetch('/api/graph/rebuild', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
}
export async function learningStatus() {
  return (await fetch('/api/learning/status')).json();
}
export async function runSynth(days) {
  const body = days != null ? { days } : {};
  return (await fetch('/api/learning/synth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
}

// ── Kanban / board wrappers ───────────────────────────────────────────────────

export async function reorderBacklog({ project, status, ids }) {
  const r = await fetch('/api/backlog/reorder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, status, ids }) });
  if (!r.ok) throw new Error('reorder failed'); return r.json();
}
export async function deleteBacklogItem(id) {
  const r = await fetch(`/api/backlog/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('delete failed'); return r.json();
}
export async function getProjects() {
  const r = await fetch('/api/projects'); if (!r.ok) throw new Error('projects failed'); return r.json();
}
export async function postTerminal({ terminal, cwd }) {
  const r = await fetch('/api/terminal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ terminal, cwd }) });
  if (!r.ok) throw new Error('terminal failed'); return r.json();
}
