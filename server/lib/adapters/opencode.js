// server/lib/adapters/opencode.js
// OpenCode adapter (JSON tree on disk).
// Layout (base = P.opencodeDir):
//   storage/project/<projectId>.json                  -> { id, worktree }
//   storage/session/<projectId>/<sessionId>.json      -> { id, title, time:{created,updated} }
//   storage/message/<sessionId>/<msgId>.json          -> { role, modelID, tokens, ... }
//   storage/part/<msgId>/<partId>.json                -> { type:'text'|'tool'|'reasoning', ... }
// Format mirrors D:/_scratch_cch_viewer/src-tauri/src/providers/opencode.rs.
// NOTE: a sibling opencode.db (SQLite) may also exist; we read JSON only and
// skip the DB by design (zero-dep server, JSON is the older/portable source).
import fs from 'node:fs';
import path from 'node:path';
import { cleanTitle } from './clean-title.js';
import { classifyGit } from '../git-events.js';

export const id = 'opencode';
export const displayName = 'OpenCode';
export const controllable = false;

const SAFE_ID = /^[A-Za-z0-9_.-]+$/;
// Delimiter embedded in the descriptor id so extractSnapshot can locate the
// on-disk message/part dirs (extractSnapshot only receives text + id, not a path).
const SEP = '|@dir@|';

function statDir(d) { try { return fs.statSync(d).isDirectory(); } catch { return false; } }
function isRealFile(p) {
  try { const s = fs.lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; }
}

export function detect(P) {
  const base = P?.opencodeDir;
  if (typeof base !== 'string') return { installed: false, dataDirs: [] };
  const storage = path.join(base, 'storage');
  return { installed: statDir(storage), dataDirs: [base] };
}

/**
 * Map an opencode lowercase tool name to a common capitalised name.
 * Mirrors normalize_opencode_tool_name in opencode.rs.
 */
export function mapToolName(name) {
  switch (name) {
    case 'read': return 'Read';
    case 'bash': return 'Bash';
    case 'glob': return 'Glob';
    case 'grep': return 'Grep';
    case 'write': return 'Write';
    case 'edit': return 'Edit';
    case 'todowrite': return 'TodoWrite';
    case 'webfetch': return 'WebFetch';
    case 'task': case 'call_omo_agent': return 'Task';
    case 'websearch_web_search_exa':
    case 'websearch_exa_web_search_exa':
    case 'web_search':
    case 'brave-search_brave_web_search':
      return 'WebSearch';
    default:
      if (name && name.startsWith('grep_')) return 'Grep';
      return name || 'tool';
  }
}

const FILE_TOOLS = new Set(['Write', 'Edit']);

/**
 * Build a session descriptor's id that also carries the messages-dir path so the
 * snapshot extractor (which only gets text + id) can read the on-disk parts.
 * Public-facing session id is the part before SEP.
 */
function makeDescId(projectId, sessionId, messagesDir) {
  return `opencode:${projectId}:${sessionId}${SEP}${messagesDir}`;
}
/** Parse the descriptor id back into { publicId, messagesDir }. */
export function parseDescId(descId) {
  const i = descId.indexOf(SEP);
  if (i === -1) return { publicId: descId, messagesDir: null };
  return { publicId: descId.slice(0, i), messagesDir: descId.slice(i + SEP.length) };
}

/** Read worktree (cwd) per projectId from storage/project/*.json. */
function readProjectWorktrees(projectDir) {
  const map = new Map();
  let entries = [];
  try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { return map; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(projectDir, e.name), 'utf-8'));
      const pid = obj?.id;
      if (typeof pid === 'string' && SAFE_ID.test(pid)) {
        map.set(pid, typeof obj?.worktree === 'string' ? obj.worktree : null);
      }
    } catch {}
  }
  return map;
}

export function discover(P) {
  const out = [];
  if (typeof P?.opencodeDir !== 'string') return out;
  const storage = path.join(P.opencodeDir, 'storage');
  if (!statDir(storage)) return out;

  const projectDir = path.join(storage, 'project');
  const sessionRoot = path.join(storage, 'session');
  const messageRoot = path.join(storage, 'message');

  const worktrees = readProjectWorktrees(projectDir);

  let projectIds = [];
  try { projectIds = fs.readdirSync(sessionRoot, { withFileTypes: true }); } catch { return out; }

  for (const pe of projectIds) {
    if (!pe.isDirectory()) continue;
    const projectId = pe.name;
    if (!SAFE_ID.test(projectId)) continue;
    const cwd = worktrees.get(projectId) ?? null;

    const sessDir = path.join(sessionRoot, projectId);
    let sessFiles = [];
    try { sessFiles = fs.readdirSync(sessDir, { withFileTypes: true }); } catch { continue; }

    for (const sf of sessFiles) {
      if (!sf.isFile() || !sf.name.endsWith('.json')) continue;
      const sessionId = sf.name.replace(/\.json$/, '');
      if (!SAFE_ID.test(sessionId)) continue;
      const sessionFile = path.join(sessDir, sf.name);

      // mtime: prefer newest of the session file and its message dir so new
      // messages (which land as new files) trigger a re-poll even if the
      // session JSON itself is untouched.
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(sessionFile).mtimeMs; } catch { continue; }
      const messagesDir = path.join(messageRoot, sessionId);
      try { mtimeMs = Math.max(mtimeMs, fs.statSync(messagesDir).mtimeMs); } catch {}

      out.push({
        id: makeDescId(projectId, sessionId, messagesDir),
        tool: id,
        kind: 'json-snapshot',
        file: sessionFile,
        cwd,
        label: null,
        mtimeMs,
        extra: { projectId, sessionId, messagesDir },
      });
    }
  }
  return out;
}

/** Read and sort message files (by filename) for a session messages dir. */
function readMessages(messagesDir) {
  let entries = [];
  try { entries = fs.readdirSync(messagesDir, { withFileTypes: true }); } catch { return []; }
  const files = entries
    .filter(e => e.isFile() && e.name.endsWith('.json'))
    .map(e => e.name)
    .sort();
  const out = [];
  for (const name of files) {
    const fp = path.join(messagesDir, name);
    if (!isRealFile(fp)) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      out.push({ id: name.replace(/\.json$/, ''), obj });
    } catch {}
  }
  return out;
}

/** Read and sort part files (by filename) for a message id. */
function readParts(partRoot, msgId) {
  const dir = path.join(partRoot, msgId);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const files = entries
    .filter(e => e.isFile() && e.name.endsWith('.json'))
    .map(e => e.name)
    .sort();
  const out = [];
  for (const name of files) {
    const fp = path.join(dir, name);
    if (!isRealFile(fp)) continue;
    try { out.push(JSON.parse(fs.readFileSync(fp, 'utf-8'))); } catch {}
  }
  return out;
}

function textFromParts(parts) {
  let text = '';
  for (const p of parts) {
    if (p?.type === 'text') {
      const t = p.text ?? p.content;
      if (typeof t === 'string') text += t;
    }
  }
  return text;
}

/**
 * Turn one tool part into a feed/context event.
 * Returns an event object or null.
 */
function toolPartToEvent(part, ts, sessionId) {
  const rawName = part?.tool;
  const name = mapToolName(typeof rawName === 'string' ? rawName : '');
  const input = part?.state?.input ?? part?.input ?? {};

  // File path candidates (opencode uses filePath; reference normalises to file_path)
  const filePath = input?.file_path ?? input?.filePath ?? input?.path ?? null;
  const p = typeof filePath === 'string' ? filePath : null;

  if (name === 'Bash') {
    let cmd = input?.command ?? input?.cmd ?? null;
    if (Array.isArray(cmd)) cmd = cmd.filter(x => typeof x === 'string').join(' ');
    if (typeof cmd === 'string') {
      const g = classifyGit(cmd);
      if (g) return { ...g, tool: name, path: null, ts, sessionId };
    }
    const label = cleanTitle(typeof cmd === 'string' ? cmd : name, 120) ?? name;
    return { kind: 'command', lane: 'feed', tool: name, path: null, ts, sessionId, label };
  }

  if (FILE_TOOLS.has(name)) {
    return { kind: 'file-edit', lane: 'feed', tool: name, path: p, ts, sessionId, label: p ?? name };
  }

  return { kind: 'tool', lane: 'feed', tool: name, path: p, ts, sessionId, label: p ?? name };
}

/**
 * json-snapshot kind: text is the session JSON; sessionId is desc.id (carries
 * the embedded messages dir). Returns { events, title, cwd }.
 */
export function extractSnapshot(text, descId) {
  const { publicId, messagesDir } = parseDescId(descId);

  let session = null;
  try { session = JSON.parse(text); } catch {}
  const title = typeof session?.title === 'string' && session.title
    ? (cleanTitle(session.title, 80) ?? session.title.slice(0, 80))
    : null;

  if (!messagesDir) return { events: [], title, cwd: null };

  // part files live under storage/part/<msgId> — sibling of message/<sessionId>
  const messageRoot = path.dirname(messagesDir);        // .../storage/message
  const storageRoot = path.dirname(messageRoot);        // .../storage
  const partRoot = path.join(storageRoot, 'part');

  const events = [];
  const messages = readMessages(messagesDir);

  for (const { id: msgId, obj } of messages) {
    const role = obj?.role ?? 'user';
    const ts = obj?.time?.created ?? null;
    const parts = readParts(partRoot, msgId);

    if (role === 'user') {
      const userText = textFromParts(parts);
      if (userText) {
        events.push({
          kind: 'tool', lane: 'feed', tool: 'user', path: null, ts, sessionId: publicId,
          label: 'User: ' + (cleanTitle(userText, 120) ?? userText.slice(0, 120)),
        });
      }
      continue;
    }

    // assistant (or other): surface tool parts as events
    for (const part of parts) {
      if (part?.type === 'tool') {
        const ev = toolPartToEvent(part, ts, publicId);
        if (ev) events.push(ev);
      }
    }
  }

  return { events, title, cwd: null };
}
