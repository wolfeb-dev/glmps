// server/lib/adapters/hermes.js
// The Hermes agent persists to SQLite at <HERMES_HOME>/state.db (tables `sessions`
// and `messages`). One DB holds many sessions, so discover() emits one descriptor per
// session (all pointing at the same file, each carrying its own sessionId) and the core
// loop's sqlite-steps path passes the descriptor to extractSteps as a third argument.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { cleanTitle } from './clean-title.js';
import { classifyGit } from '../git-events.js';

export const id = 'hermes';
export const displayName = 'Hermes';
export const controllable = false;

// Load DatabaseSync via require() so the module still imports when node:sqlite is absent.
const require_ = createRequire(import.meta.url);
let DatabaseSync = null;
try { ({ DatabaseSync } = require_('node:sqlite')); } catch {}

const SOUL_RE = /(^|[\\/])SOUL\.md$/i;          // Hermes persona file (CLAUDE.md analogue)
const MEMORY_RE = /[\\/]memor(y|ies)[\\/]/i;    // memory tool dir (Claude memory analogue)

function dbPathFor(P) {
  return P?.hermesDir ? path.join(P.hermesDir, 'state.db') : null;
}

export function detect(P) {
  const dbPath = dbPathFor(P);
  let installed = false;
  try { installed = !!dbPath && fs.statSync(dbPath).isFile(); } catch {}
  return { installed, dataDirs: P?.hermesDir ? [P.hermesDir] : [] };
}

export function discover(P) {
  const dbPath = dbPathFor(P);
  if (!DatabaseSync || !dbPath) return [];
  try { if (!fs.statSync(dbPath).isFile()) return []; } catch { return []; }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readonly: true });
    const rows = db.prepare(
      `SELECT s.id AS id, s.cwd AS cwd, s.title AS title, s.model AS model,
              s.started_at AS started_at, s.ended_at AS ended_at,
              (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id AND m.active = 1) AS last_active
       FROM sessions s
       WHERE COALESCE(s.archived, 0) = 0 AND s.parent_session_id IS NULL
       ORDER BY last_active DESC`
    ).all();

    const out = [];
    for (const r of rows) {
      const secs = r.last_active ?? r.ended_at ?? r.started_at ?? 0;
      out.push({
        id: `hermes:${r.id}`,
        tool: id,
        kind: 'sqlite-steps',
        file: dbPath,
        sessionId: r.id,
        cwd: r.cwd ?? null,
        label: r.title ?? null,
        model: r.model ?? null,
        mtimeMs: Math.round((secs || 0) * 1000),
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

/** Pull readable text out of a message `content` (plain string or JSON array of parts). */
function contentText(content) {
  if (typeof content !== 'string') return '';
  const s = content.trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed))
        return parsed.map(c => (typeof c === 'string' ? c : (c?.text ?? ''))).join('');
      if (parsed && typeof parsed.text === 'string') return parsed.text;
    } catch { /* fall through to raw */ }
  }
  return content;
}

function firstLine(s) {
  if (typeof s !== 'string') return '';
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

/** Map one assistant tool call to a shared-shape event. */
function classifyCall(name, args, ts, sessionId, sessionModel) {
  const base = { tool: name, ts, sessionId, path: null };
  const p = typeof args?.path === 'string' ? args.path
    : (typeof args?.target_file === 'string' ? args.target_file : null);

  // File-touching tools: resolve persona/memory paths before generic edit/read.
  if (name === 'read_file' || name === 'write_file' || name === 'patch'
      || name === 'patch_replace' || name === 'patch_v4a') {
    let fp = p;
    if (fp == null && typeof args?.patch_content === 'string') {
      const m = args.patch_content.match(/\*\*\*\s*(?:Update|Add|Delete) File:\s*(.+)/i);
      if (m) fp = m[1].trim();
    }
    const op = name === 'read_file' ? 'read' : 'write';
    if (fp && SOUL_RE.test(fp))
      return { ...base, kind: 'context-file', lane: 'context', path: fp, op, label: fp };
    if (fp && MEMORY_RE.test(fp))
      return { ...base, kind: 'memory', lane: 'context', path: fp, op, label: fp };
    if (name === 'read_file')
      return { ...base, kind: 'tool', lane: 'feed', path: fp, label: fp ?? name };
    return { ...base, kind: 'file-edit', lane: 'feed', path: fp, label: fp ?? name };
  }

  if (name === 'memory')
    return { ...base, kind: 'memory', lane: 'context',
      op: args?.action ?? null, label: cleanTitle(args?.target ?? args?.content ?? 'memory', 120) ?? 'memory' };

  if (name === 'skill_view' || name === 'skills_list' || name === 'skill_manage')
    return { ...base, kind: 'skill', lane: 'context', label: args?.name ?? name };

  if (name === 'delegate_task')
    return { ...base, kind: 'agent', lane: 'context',
      model: args?.model ?? sessionModel ?? null,
      label: 'Delegate: ' + (cleanTitle(args?.goal ?? args?.task ?? '', 120) ?? 'subagent') };

  if (name === 'terminal') {
    const cmd = args?.command ?? '';
    const g = classifyGit(cmd);
    if (g) return { ...base, ...g, tool: name, ts, sessionId };
    return { ...base, kind: 'command', lane: 'feed', label: cleanTitle(cmd, 120) ?? name };
  }

  if (name === 'execute_code')
    return { ...base, kind: 'command', lane: 'feed',
      label: 'python: ' + (cleanTitle(firstLine(args?.code ?? ''), 110) ?? '') };

  return { ...base, kind: 'tool', lane: 'feed', label: name };
}

/**
 * Read messages for one Hermes session and map them to shared-shape events.
 *
 * @param {string} file       - absolute path to state.db
 * @param {number} sinceId    - only rows with messages.id > sinceId
 * @param {object} desc       - descriptor from discover() (carries .sessionId)
 * @returns {{ events: object[], lastIdx: number, title: string|null }}
 */
export function extractSteps(file, sinceId, desc) {
  const sessionId = desc?.sessionId;
  if (!DatabaseSync || !sessionId) return { events: [], lastIdx: sinceId, title: null };

  let db = null;
  try {
    db = new DatabaseSync(file, { readonly: true });

    let title = null;
    if (sinceId < 0) {
      try {
        const srow = db.prepare('SELECT title, model FROM sessions WHERE id = ?').get(sessionId);
        title = srow?.title ?? null;
      } catch {}
    }
    let sessionModel = desc?.model ?? null;
    if (sessionModel == null) {
      try { sessionModel = db.prepare('SELECT model FROM sessions WHERE id = ?').get(sessionId)?.model ?? null; } catch {}
    }

    const rows = db.prepare(
      `SELECT id, role, content, tool_calls, tool_name, timestamp, reasoning
       FROM messages WHERE session_id = ? AND active = 1 AND id > ? ORDER BY id LIMIT 500`
    ).all(sessionId, sinceId);

    const events = [];
    let lastIdx = sinceId;
    for (const row of rows) {
      lastIdx = row.id;
      const ts = row.timestamp != null ? Math.round(row.timestamp * 1000) : null;

      if (row.role === 'user') {
        const text = contentText(row.content);
        if (text) events.push({ kind: 'user', lane: 'feed', tool: 'user', path: null, ts, sessionId,
          label: 'User: ' + (cleanTitle(text, 120) ?? text.slice(0, 120)) });
        continue;
      }

      if (row.role === 'assistant') {
        if (typeof row.reasoning === 'string' && row.reasoning.trim()) {
          events.push({ kind: 'thinking', lane: 'feed', tool: 'thinking', path: null, ts, sessionId,
            label: cleanTitle(row.reasoning, 120) ?? row.reasoning.slice(0, 120) });
        }
        if (!row.tool_calls) continue;
        let calls;
        try { calls = JSON.parse(row.tool_calls); } catch { continue; }
        if (!Array.isArray(calls)) continue;
        for (const tc of calls) {
          const name = tc?.function?.name ?? tc?.name;
          if (typeof name !== 'string') continue;
          let args = {};
          const rawArgs = tc?.function?.arguments ?? tc?.arguments;
          if (typeof rawArgs === 'string') { try { args = JSON.parse(rawArgs); } catch { args = {}; } }
          else if (rawArgs && typeof rawArgs === 'object') args = rawArgs;
          events.push(classifyCall(name, args, ts, sessionId, sessionModel));
        }
        continue;
      }
      // role === 'tool' (results) → skip
    }

    return { events, lastIdx, title };
  } catch {
    return { events: [], lastIdx: sinceId, title: null };
  } finally {
    try { db?.close(); } catch {}
  }
}
