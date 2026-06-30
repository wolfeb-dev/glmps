// server/lib/adapters/cline.js
// Cline / Roo Code adapter (VS Code-family extensions).
// Each task is one ui_messages.json file (json-snapshot, self-contained).
// Layout (base = <editor globalStorage>/<extId>):
//   state/taskHistory.json        (Cline)  -> [ { id, task, cwdOnTaskInitialization, ts, modelId } ]
//   tasks/_index.json             (Roo)    -> { entries: [ same shape ] }
//   tasks/<id>/ui_messages.json            -> [ { type:'say'|'ask', say/ask, text, ts } ]
// Format mirrors D:/_scratch_cch_viewer/src-tauri/src/providers/cline.rs,
// with the Windows %APPDATA% branch ADDED (the reference omits it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTitle } from './clean-title.js';
import { classifyGit } from '../git-events.js';

export const id = 'cline';
export const displayName = 'Cline';
export const controllable = false;

// Known Cline-family extension IDs and their display names.
const EXTENSIONS = [
  ['saoudrizwan.claude-dev', 'Cline'],
  ['rooveterinaryinc.roo-cline', 'Roo Code'],
];

// VS Code-family editors: [globalStorage parent dir name, display label].
const EDITORS = [
  ['Code', 'VS Code'],
  ['Cursor', 'Cursor'],
  ['Code - Insiders', 'VS Code Insiders'],
  ['VSCodium', 'VSCodium'],
];

const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

function statDir(d) { try { return fs.statSync(d).isDirectory(); } catch { return false; } }
function isRealFile(p) {
  try { const s = fs.lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; }
}
function notSymlinkDir(d) {
  try { const s = fs.lstatSync(d); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}

/**
 * Enumerate per-OS VS Code-family globalStorage roots that contain a known
 * Cline/Roo extension dir. Returns [{ extDir, label }].
 * If P.clineStorageDir is set (test override), it is treated as a single
 * editor User/globalStorage root and scanned for the extension dirs.
 */
function getBasePaths(P) {
  const out = [];
  const home = os.homedir();

  // Per-OS editor User/globalStorage parents.
  const editorParents = [];
  if (P && P.clineStorageDir) {
    // Test/override: clineStorageDir IS a User/globalStorage dir.
    editorParents.push({ globalStorage: P.clineStorageDir, label: 'Custom' });
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    for (const [dir, label] of EDITORS) {
      editorParents.push({ globalStorage: path.join(appData, dir, 'User', 'globalStorage'), label });
    }
  } else if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    for (const [dir, label] of EDITORS) {
      editorParents.push({ globalStorage: path.join(appSupport, dir, 'User', 'globalStorage'), label });
    }
  } else {
    const config = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
    for (const [dir, label] of EDITORS) {
      editorParents.push({ globalStorage: path.join(config, dir, 'User', 'globalStorage'), label });
    }
  }

  for (const { globalStorage, label: editorLabel } of editorParents) {
    if (!statDir(globalStorage)) continue;
    for (const [extId, extName] of EXTENSIONS) {
      const extDir = path.join(globalStorage, extId);
      if (notSymlinkDir(extDir)) {
        out.push({ extDir, label: `${extName} (${editorLabel})` });
      }
    }
  }
  return out;
}

export function detect(P) {
  const bases = getBasePaths(P);
  const dataDirs = bases.map(b => b.extDir);
  return { installed: bases.length > 0, dataDirs };
}

/** Load the task-history index for one extension base dir. */
function loadTaskHistory(extDir) {
  // Cline: state/taskHistory.json (a bare array)
  const clinePath = path.join(extDir, 'state', 'taskHistory.json');
  if (isRealFile(clinePath)) {
    try {
      const arr = JSON.parse(fs.readFileSync(clinePath, 'utf-8'));
      if (Array.isArray(arr)) return arr;
    } catch {}
  }
  // Roo: tasks/_index.json -> { entries: [...] }
  const rooPath = path.join(extDir, 'tasks', '_index.json');
  if (isRealFile(rooPath)) {
    try {
      const obj = JSON.parse(fs.readFileSync(rooPath, 'utf-8'));
      if (Array.isArray(obj?.entries)) return obj.entries;
    } catch {}
  }
  return [];
}

export function discover(P) {
  const out = [];
  for (const { extDir } of getBasePaths(P)) {
    const history = loadTaskHistory(extDir);
    for (const item of history) {
      const taskId = item?.id;
      if (typeof taskId !== 'string' || !SAFE_ID.test(taskId)) continue;

      const uiPath = path.join(extDir, 'tasks', taskId, 'ui_messages.json');
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(uiPath).mtimeMs; } catch {
        // Fall back to the history timestamp if the file is absent.
        mtimeMs = Number(item?.ts) || 0;
        if (!isRealFile(uiPath)) continue;
      }

      const cwd = typeof item?.cwdOnTaskInitialization === 'string'
        ? item.cwdOnTaskInitialization : null;
      const task = typeof item?.task === 'string' ? item.task : null;
      const label = task ? (cleanTitle(task, 80) ?? task.slice(0, 80)) : null;

      out.push({
        id: `cline:${taskId}`,
        tool: id,
        kind: 'json-snapshot',
        file: uiPath,
        cwd,
        label,
        mtimeMs,
        extra: { taskId },
      });
    }
  }
  return out;
}

// ── message conversion ──────────────────────────────────────────────────────

/** Map a Cline tool name to a common capitalised name (mirrors cline.rs). */
export function mapToolName(name) {
  switch (name) {
    case 'readFile': return 'Read';
    case 'editedExistingFile': case 'newFileCreated': case 'fileDeleted': return 'Write';
    case 'listFilesTopLevel': case 'listFilesRecursive': case 'listCodeDefinitionNames': return 'Glob';
    case 'searchFiles': return 'Grep';
    case 'webFetch': return 'WebFetch';
    case 'webSearch': return 'WebSearch';
    default: return name || 'tool';
  }
}

const FILE_EDIT_TOOLS = new Set(['Write', 'Edit']);

function sayToEvents(say, text, msg, ts, sessionId) {
  switch (say) {
    case 'text':
    case 'completion_result':
      return []; // assistant prose, not a feed action
    case 'reasoning': {
      const t = msg?.reasoning ?? text;
      if (!t) return [];
      return [{
        kind: 'thinking', lane: 'feed', tool: 'thinking', path: null, ts, sessionId,
        label: cleanTitle(t, 120) ?? t.slice(0, 120),
      }];
    }
    case 'tool': {
      let data = null;
      try { data = JSON.parse(text); } catch {}
      const rawName = data?.tool ?? 'unknown';
      const name = mapToolName(rawName);
      const p = typeof data?.path === 'string' ? data.path : null;
      if (FILE_EDIT_TOOLS.has(name)) {
        return [{ kind: 'file-edit', lane: 'feed', tool: name, path: p, ts, sessionId, label: p ?? name }];
      }
      return [{ kind: 'tool', lane: 'feed', tool: name, path: p, ts, sessionId, label: p ?? name }];
    }
    case 'command': {
      if (!text) return [];
      const g = classifyGit(text);
      if (g) return [{ ...g, tool: 'Bash', path: null, ts, sessionId }];
      const label = cleanTitle(text, 120) ?? text.slice(0, 120);
      return [{ kind: 'command', lane: 'feed', tool: 'Bash', path: null, ts, sessionId, label }];
    }
    case 'command_output':
      return [];
    case 'error': {
      if (!text) return [];
      return [{
        kind: 'tool', lane: 'feed', tool: 'error', path: null, ts, sessionId,
        label: 'Error: ' + (cleanTitle(text, 120) ?? text.slice(0, 120)),
      }];
    }
    case 'user_feedback':
    case 'user_feedback_diff': {
      if (!text) return [];
      return [{
        kind: 'tool', lane: 'feed', tool: 'user', path: null, ts, sessionId,
        label: 'User: ' + (cleanTitle(text, 120) ?? text.slice(0, 120)),
      }];
    }
    // Internal/metadata says: skip.
    case 'api_req_started':
    case 'api_req_finished':
    case 'api_req_retried':
    case 'deleted_api_reqs':
    case 'shell_integration_warning':
    case 'shell_integration_warning_with_suggestion':
    case 'checkpoint_created':
    case 'load_mcp_documentation':
    case 'info':
    case 'task_progress':
    case 'hook_status':
    case 'hook_output_stream':
    case 'conditional_rules_applied':
      return [];
    default:
      return [];
  }
}

function askToEvents(ask, text, ts, sessionId) {
  switch (ask) {
    case 'followup':
    case 'act_mode_respond':
    case 'plan_mode_respond':
      if (!text) return [];
      return [{
        kind: 'tool', lane: 'feed', tool: 'user', path: null, ts, sessionId,
        label: 'User: ' + (cleanTitle(text, 120) ?? text.slice(0, 120)),
      }];
    default:
      return [];
  }
}

/** Convert one ui_messages entry into events[]. */
function messageToEvents(msg, sessionId) {
  if (!msg || typeof msg !== 'object') return [];
  const type = msg.type;
  const ts = msg.ts ?? null;
  const text = typeof msg.text === 'string' ? msg.text : '';
  if (type === 'say') return sayToEvents(msg.say ?? '', text, msg, ts, sessionId);
  if (type === 'ask') return askToEvents(msg.ask ?? '', text, ts, sessionId);
  return [];
}

/** json-snapshot kind: ui_messages.json text -> { events, title, cwd } */
export function extractSnapshot(text, sessionId) {
  let arr;
  try { arr = JSON.parse(text); } catch { return { events: [] }; }
  if (!Array.isArray(arr)) return { events: [] };

  const events = arr.flatMap(m => messageToEvents(m, sessionId));

  // Title: first user-facing text (say:text or ask:followup), else null.
  let title = null;
  for (const m of arr) {
    if (m?.type === 'say' && (m.say === 'text') && typeof m.text === 'string' && m.text) {
      title = cleanTitle(m.text, 80); break;
    }
  }

  return { events, title, cwd: null };
}
