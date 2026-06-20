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
export async function getUsage() { return (await fetch('/api/usage')).json(); }
export async function readFile(p) { return (await fetch(`/api/file?path=${encodeURIComponent(p)}`)).json(); }
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
