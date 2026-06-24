// server/lib/learning-store.js
// Learning queue: pure model transforms + fs wrappers.
// Zero runtime dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { guardForGap } from './learning-templates.js';

// ---------------------------------------------------------------------------
// emptyState
// ---------------------------------------------------------------------------

export function emptyState() {
  return { items: [], config: { autoApplyGaps: false }, seq: 0 };
}

// ---------------------------------------------------------------------------
// sha1(str) — stable hex digest for dedup keys
// ---------------------------------------------------------------------------

function sha1(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// normalizeProject(p) -> canonical project key
//
// The three store writers spell `project` differently for the SAME repo:
//   live /api/state -> raw cwd            "D:\\glmps"
//   Stop-hook feeder -> (now) raw cwd     "D:\\glmps"
//   SessionStart synth -> projects slug   "D--glmps"
// Map all of them to the ~/.claude/projects dir-slug form so dedupKey collapses
// them to one row. The slug replaces every non-alphanumeric char with '-', which
// is exactly how Claude Code names its projects/ subdirectories, and is idempotent
// on an already-slugged value (D--glmps -> D--glmps).
// ---------------------------------------------------------------------------

export function normalizeProject(p) {
  return String(p ?? '').replace(/[^A-Za-z0-9]/g, '-');
}

// ---------------------------------------------------------------------------
// dedupKey(item) -> string
// ---------------------------------------------------------------------------

export function dedupKey(item) {
  if (item.source === 'gap') {
    return sha1(`${item.code}|${normalizeProject(item.project)}`);
  }
  return item.id;
}

// ---------------------------------------------------------------------------
// titleFromGap(gap) — derive a short human-readable label
// ---------------------------------------------------------------------------

function titleFromGap(gap) {
  if (gap.code) return gap.code.replace(/-/g, ' ');
  if (gap.message) return gap.message.slice(0, 60);
  return 'gap';
}

// ---------------------------------------------------------------------------
// upsertGapInto(state, gap, ctx) -> { state, item, isNew }
//
// gap = { code, severity, message }
// ctx = { project, sessionId }
// Dedup by dedupKey; recurrence bumps count/updatedTs.
// A discarded item is never resurfaced.
// ---------------------------------------------------------------------------

export function upsertGapInto(state, gap, ctx = {}) {
  // Canonicalize the project so the same repo always keys to one row regardless
  // of which writer (and which spelling) produced it. The stored `project` field
  // is the canonical slug too.
  const project = normalizeProject(ctx.project ?? '');
  const sessionId = ctx.sessionId ?? '';
  const key = sha1(`${gap.code}|${project}`);
  const existing = state.items.find((i) => i.source === 'gap' && i.id === key);

  if (existing) {
    // Resolved items are immutable on re-detection: a discarded gap never
    // resurfaces and an applied one is left alone (no churn, no resurrection).
    if (existing.status === 'discarded' || existing.status === 'applied') {
      return { state, item: existing, isNew: false, changed: false };
    }
    // Count DISTINCT sessions, not polls: detectGaps re-emits standing gaps on
    // every /api/state poll, so only bump when a *different* session exhibits the
    // same gap. Same-session re-polls are no-ops, so the store is not rewritten
    // each tick (the recurrence badge then means "sessions", not "poll count").
    if (sessionId && sessionId !== existing.lastSessionId) {
      const updated = { ...existing, count: existing.count + 1, lastSessionId: sessionId, updatedTs: Date.now() };
      const items = state.items.map((i) => (i.id === key ? updated : i));
      return { state: { ...state, items }, item: updated, isNew: false, changed: true };
    }
    return { state, item: existing, isNew: false, changed: false };
  }

  const now = Date.now();
  const newItem = {
    id: key,
    source: 'gap',
    code: gap.code ?? null,
    severity: gap.severity ?? 'warn',
    title: titleFromGap(gap),
    body: gap.message ?? '',
    project,
    sessionId,
    lastSessionId: sessionId,
    status: 'pending',
    proposedGuard: guardForGap(gap.code) ?? null,
    applyCommit: null,
    count: 1,
    error: null,
    createdTs: now,
    updatedTs: now,
  };

  return {
    state: { ...state, items: [...state.items, newItem] },
    item: newItem,
    isNew: true,
    changed: true,
  };
}

// ---------------------------------------------------------------------------
// addIdea(state, text) -> { state, item }
// ---------------------------------------------------------------------------

export function addIdea(state, text) {
  const id = `idea-${state.seq + 1}`;
  const now = Date.now();
  const item = {
    id,
    source: 'idea',
    code: null,
    severity: 'idea',
    title: text.slice(0, 60),
    body: text,
    project: '',
    sessionId: '',
    status: 'pending',
    proposedGuard: null,
    applyCommit: null,
    count: 1,
    error: null,
    createdTs: now,
    updatedTs: now,
  };
  return {
    state: { ...state, seq: state.seq + 1, items: [...state.items, item] },
    item,
  };
}

// ---------------------------------------------------------------------------
// applyAction(state, id, action, payload) -> { state, item }  PURE
//
// action in 'approve' | 'discard' | 'alternative'
// approve: leaves status 'pending' — server orchestrates actual apply then
//          calls markApplied/markDispatched.
// discard: -> status 'discarded'
// alternative: sets proposedGuard.rule from payload.rule, keeps status 'pending'
// All transitions update updatedTs.
// ---------------------------------------------------------------------------

export function applyAction(state, id, action, payload = {}) {
  const existing = state.items.find((i) => i.id === id);
  if (!existing) throw new Error(`Item not found: ${id}`);

  const now = Date.now();
  let updated;

  switch (action) {
    case 'discard':
      updated = { ...existing, status: 'discarded', updatedTs: now };
      break;

    case 'alternative': {
      const guard = {
        ...(existing.proposedGuard ?? { file: 'CLAUDE.global.md', section: 'Learned guards' }),
        rule: payload.rule,
      };
      updated = { ...existing, proposedGuard: guard, updatedTs: now };
      break;
    }

    case 'approve':
      // Server orchestrates the actual apply; leave pending.
      updated = { ...existing, updatedTs: now };
      break;

    default:
      throw new Error(`Unknown action: ${action}`);
  }

  const items = state.items.map((i) => (i.id === id ? updated : i));
  return { state: { ...state, items }, item: updated };
}

// ---------------------------------------------------------------------------
// Helper setters (all return { state, item })
// ---------------------------------------------------------------------------

export function markApplied(state, id, commit) {
  const now = Date.now();
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new Error(`Item not found: ${id}`);
  const updated = { ...item, status: 'applied', applyCommit: commit, updatedTs: now };
  const items = state.items.map((i) => (i.id === id ? updated : i));
  return { state: { ...state, items }, item: updated };
}

export function markDispatched(state, id) {
  const now = Date.now();
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new Error(`Item not found: ${id}`);
  const updated = { ...item, status: 'dispatched', updatedTs: now };
  const items = state.items.map((i) => (i.id === id ? updated : i));
  return { state: { ...state, items }, item: updated };
}

export function markFailed(state, id, error) {
  const now = Date.now();
  const item = state.items.find((i) => i.id === id);
  if (!item) throw new Error(`Item not found: ${id}`);
  const updated = { ...item, status: 'failed', error, updatedTs: now };
  const items = state.items.map((i) => (i.id === id ? updated : i));
  return { state: { ...state, items }, item: updated };
}

export function setConfig(state, patch) {
  return { ...state, config: { ...state.config, ...patch } };
}

// ---------------------------------------------------------------------------
// fs wrappers
// ---------------------------------------------------------------------------

function storePath(stateDir) {
  return path.join(stateDir, 'learning', 'store.json');
}

export function load(stateDir) {
  try {
    const raw = fs.readFileSync(storePath(stateDir), 'utf-8');
    const parsed = JSON.parse(raw);
    // Ensure seq exists (backward compat if old file was saved without it)
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

export function save(stateDir, state) {
  const file = storePath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Convenience load→mutate→save wrappers
// ---------------------------------------------------------------------------

export function upsertGap(stateDir, gap, ctx) {
  const state = load(stateDir);
  const result = upsertGapInto(state, gap, ctx);
  save(stateDir, result.state);
  return result;
}

export function addIdeaTo(stateDir, text) {
  const state = load(stateDir);
  const result = addIdea(state, text);
  save(stateDir, result.state);
  return result;
}

export function setConfigIn(stateDir, patch) {
  const state = load(stateDir);
  const updated = setConfig(state, patch);
  save(stateDir, updated);
  return updated;
}
