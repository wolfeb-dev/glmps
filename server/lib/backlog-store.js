import fs from 'node:fs';
import path from 'node:path';
import { scanTicket } from './poison-scan.js';

const STATES = new Set(['queued', 'held', 'in_progress', 'in_review', 'done', 'cancelled']);

export function emptyState() { return { items: [], paused: false, seq: 0 }; }

function now() { return new Date().toISOString(); }

export function addItem(state, { project, title, prompt, state: itemState, source, priority, origin } = {}) {
  const proj = project ?? 'default';
  const ttl  = title ?? '';
  const src  = source ?? 'manual';

  // Dedup: if an open item with the same (project, title, source) exists, return it.
  const CLOSED = new Set(['done', 'cancelled']);
  const existing = state.items.find(
    i => i.project === proj && i.title === ttl && i.source === src && !CLOSED.has(i.state)
  );
  if (existing) return { state, item: existing, isNew: false };

  const seq = state.seq + 1;
  const ts = now();
  const order = state.items.reduce((m, i) => Math.max(m, i.order), 0) + 1;
  const promptText = (prompt ?? title ?? '').trim();
  // Poisoning gate: scan the ticket at intake, attach provenance, and quarantine
  // anything the scanner flags as block-worthy. Quarantined queued items are
  // skipped by the autonomous runner (pickNextJob) until an operator approves.
  const provenance = scanTicket({ title: ttl, prompt: promptText, source: src });
  const item = {
    id: `glmps-${seq}`,
    project: proj,
    title: ttl,
    prompt: promptText,
    state: STATES.has(itemState) ? itemState : 'queued',
    source: src,
    groupId: null, order,
    priority: priority !== undefined ? priority : null,
    sessionId: null, branch: null, prUrl: null,
    origin: origin ?? null,   // optional handoff context, e.g. { via:'discord', chatId, messageId, user }
    provenance,
    quarantined: provenance.quarantined,
    activity: [], createdAt: ts, updatedAt: ts,
  };
  return { state: { ...state, items: [...state.items, item], seq }, item, isNew: true };
}

const PATCHABLE = new Set(['title', 'prompt', 'state', 'groupId', 'order', 'priority', 'sessionId', 'branch', 'prUrl']);

export function updateItem(state, id, patch = {}) {
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    const next = { ...i };
    for (const [k, v] of Object.entries(patch)) if (PATCHABLE.has(k)) next[k] = v;
    next.updatedAt = now();
    item = next;
    return next;
  });
  return { state: { ...state, items }, item };
}

// AO sends label-only deltas; interpret them into our state + activity.
export function applyLabelDelta(state, id, { labels = [], removeLabels = [], comment } = {}) {
  let derived = null;
  if (labels.includes('agent:backlog')) derived = 'queued';
  if (labels.includes('agent:in-progress')) derived = 'in_progress';
  if (labels.includes('merged-unverified') || labels.includes('agent:done')) derived = 'done';
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    const next = { ...i };
    if (derived) next.state = derived;
    if (comment) next.activity = [...i.activity, { ts: now(), text: comment }];
    next.updatedAt = now();
    item = next;
    return next;
  });
  return { state: { ...state, items }, item };
}

// Operator-only release of a poison-quarantined ticket. Deliberately NOT part of
// updateItem's PATCHABLE set, so a generic PATCH cannot silently clear the gate;
// releasing a held ticket is an explicit, logged human action.
export function approveItem(state, id) {
  let item = null;
  const items = state.items.map(i => {
    if (i.id !== id) return i;
    const next = { ...i, quarantined: false, updatedAt: now() };
    next.activity = [...(i.activity || []), { ts: now(), text: 'poison-quarantine approved by operator' }];
    item = next;
    return next;
  });
  return { state: { ...state, items }, item };
}

export function setPaused(state, paused) { return { ...state, paused: !!paused }; }

export function listItems(state, { project, status } = {}) {
  if (status === 'queued' && state.paused) return [];
  return state.items.filter(i =>
    (project == null || i.project === project) &&
    (status == null || i.state === status));
}

// ── FS wrappers (atomic save via .tmp rename; mirrors learning-store) ──
function file(stateDir) { return path.join(stateDir, 'backlog', 'store.json'); }

export function load(stateDir) {
  try { return { ...emptyState(), ...JSON.parse(fs.readFileSync(file(stateDir), 'utf-8')) }; }
  catch { return emptyState(); }
}

export function save(stateDir, state) {
  const f = file(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, f);
}

export function reorderItems(state, { ids = [], status, project } = {}) {
  const pos = new Map(ids.map((id, i) => [id, i]));
  const setStatus = STATES.has(status) ? status : null;
  const touched = [];
  const items = state.items.map(i => {
    if (!pos.has(i.id)) return i;
    const next = { ...i, order: pos.get(i.id), updatedAt: now() };
    if (setStatus) next.state = setStatus;
    touched.push(next);
    return next;
  });
  touched.sort((a, b) => a.order - b.order);
  return { state: { ...state, items }, items: touched };
}

export function removeItem(state, id) {
  const items = state.items.filter(i => i.id !== id);
  return { state: { ...state, items }, removed: items.length !== state.items.length };
}

export function approveItemIn(stateDir, id) { const r = approveItem(load(stateDir), id); save(stateDir, r.state); return r; }
export function addItemTo(stateDir, input) { const r = addItem(load(stateDir), input); save(stateDir, r.state); return r; }
export function updateItemIn(stateDir, id, patch) { const r = updateItem(load(stateDir), id, patch); save(stateDir, r.state); return r; }
export function applyLabelDeltaIn(stateDir, id, delta) { const r = applyLabelDelta(load(stateDir), id, delta); save(stateDir, r.state); return r; }
export function setPausedIn(stateDir, paused) { const s = setPaused(load(stateDir), paused); save(stateDir, s); return s; }
export function listFrom(stateDir, filters) { return listItems(load(stateDir), filters); }
export function reorderItemsIn(stateDir, payload) { const r = reorderItems(load(stateDir), payload); save(stateDir, r.state); return { items: r.items }; }
export function removeItemIn(stateDir, id) { const r = removeItem(load(stateDir), id); save(stateDir, r.state); return { removed: r.removed }; }
