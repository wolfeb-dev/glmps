// server/lib/adapters/agy-cli.js
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { extractRuns } from '../strings-scan.js';
import { cleanTitle } from './clean-title.js';
import { classifyGit } from '../git-events.js';

export const id = 'agy-cli';
export const displayName = 'Antigravity CLI';

// Load DatabaseSync via require() so the module itself doesn't fail to import
// when node:sqlite is absent or experimental warnings are suppressed.
const require_ = createRequire(import.meta.url);
let DatabaseSync = null;
try { ({ DatabaseSync } = require_('node:sqlite')); } catch {}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_RE = /^(https?:\/\/|file:\/\/|git@|ssh:\/\/)/;
const CONTEXT_FILE_RE = /(^|[\\/])(CLAUDE|AGENTS|GEMINI)\.md$/i;
const MEMORY_RE = /[\\/]memory[\\/][^\\/]+\.md$/i;
const SKILL_PATH_RE = /[\\/]\.agents[\\/]skills[\\/]/i;
const SKILL_NAME_RE = /SKILL\.md$/i;

// ── protobuf timestamp decode ──────────────────────────────────────────────────
// steps.metadata is a protobuf message whose top-level field 1 is a
// google.protobuf.Timestamp (inner field 1 = epoch seconds) marking when the step
// was created. We read just that field to give each event a wall-clock time.

/** Read a base-128 varint at offset o. Returns [value (Number), nextOffset]. */
function readVarint(buf, o) {
  let val = 0, shift = 0;
  while (o < buf.length) {
    const b = buf[o++];
    val += (b & 0x7f) * 2 ** shift; // multiply (not <<) so values > 2^31 stay exact
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [val, o];
}

/** Return the bytes of the first length-delimited (wire 2) field `target`, or null. */
function findLenField(buf, target) {
  let p = 0;
  while (p < buf.length) {
    let tag; [tag, p] = readVarint(buf, p);
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 2) {
      let len; [len, p] = readVarint(buf, p);
      if (field === target) return buf.subarray(p, p + len);
      p += len;
    } else if (wire === 0) { [, p] = readVarint(buf, p); }
    else if (wire === 5) p += 4;
    else if (wire === 1) p += 8;
    else return null; // unknown wire type → bail
  }
  return null;
}

/** Return the value of the first varint (wire 0) field `target`, or null. */
function findVarintField(buf, target) {
  let p = 0;
  while (p < buf.length) {
    let tag; [tag, p] = readVarint(buf, p);
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) {
      let v; [v, p] = readVarint(buf, p);
      if (field === target) return v;
    } else if (wire === 2) {
      let len; [len, p] = readVarint(buf, p);
      p += len;
    } else if (wire === 5) p += 4;
    else if (wire === 1) p += 8;
    else return null;
  }
  return null;
}

/**
 * Step creation time as epoch milliseconds from a steps.metadata BLOB, or null.
 * @param {Buffer|Uint8Array|null|undefined} md
 * @returns {number|null}
 */
export function readStepTsMs(md) {
  if (!md) return null;
  try {
    const buf = Buffer.isBuffer(md) ? md : Buffer.from(md);
    const tsMsg = findLenField(buf, 1);
    if (!tsMsg) return null;
    const sec = findVarintField(tsMsg, 1);
    return sec == null ? null : sec * 1000;
  } catch { return null; }
}

/**
 * Returns the most recent heartbeat timestamp (ms) for the agy CLI process.
 * Checks cli.log and the newest file under log/, returns the max; 0 on errors.
 * @param {object} P - getPaths() result
 * @returns {number}
 */
export function processAliveMs(P) {
  let best = 0;

  // Check cli.log
  try {
    const m = fs.statSync(path.join(P.agyCliDir, 'cli.log')).mtimeMs;
    if (m > best) best = m;
  } catch {}

  // Check log/ newest file
  try {
    const logDir = path.join(P.agyCliDir, 'log');
    const entries = fs.readdirSync(logDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const m = fs.statSync(path.join(logDir, e.name)).mtimeMs;
        if (m > best) best = m;
      } catch {}
    }
  } catch {}

  return best;
}

export function detect(P) {
  let installed = false;
  try { installed = fs.statSync(P.agyCliDir).isDirectory(); } catch {}
  return { installed, dataDirs: [P.agyCliDir] };
}

export function discover(P) {
  const convDir = path.join(P.agyCliDir, 'conversations');
  let files = [];
  try { files = fs.readdirSync(convDir, { withFileTypes: true }); } catch { return []; }

  const out = [];
  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith('.db')) continue;
    const filePath = path.join(convDir, f.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { continue; }
    const basename = f.name.replace(/\.db$/, '');
    out.push({
      id: `agy:${basename}`,
      tool: id,
      kind: 'sqlite-steps',
      file: filePath,
      mtimeMs,
      cwd: null,
      label: null,
    });
  }
  return out;
}

/**
 * Parse a single payload buffer: extract runs, find tool-call JSON fragments.
 * Returns array of { toolName, toolAction, toolSummary } or null entries.
 */
function parsePayload(buf) {
  const results = [];
  const runs = extractRuns(buf, 6);

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    // Find JSON fragment: run or run.slice(1) starts with '{' and contains toolAction/toolSummary
    const jsonCandidate = run.startsWith('{') ? run : (run.length > 1 && run[1] === '{' ? run.slice(1) : null);
    if (!jsonCandidate) continue;
    if (!jsonCandidate.includes('toolAction') && !jsonCandidate.includes('toolSummary')) continue;

    // Strip trailing non-JSON chars (e.g. ':' at end)
    const jsonStr = jsonCandidate.replace(/:$/, '');

    let toolAction = null;
    let toolSummary = null;
    let pathArg = null;
    let cmdArg = null;
    try {
      const parsed = JSON.parse(jsonStr);
      toolAction = parsed.toolAction ?? null;
      toolSummary = parsed.toolSummary ?? null;
      // Extract path from known keys (priority order)
      const rawPath = parsed.AbsolutePath ?? parsed.TargetFile ?? parsed.Path ?? null;
      if (rawPath != null) {
        // JSON-unescape backslashes (already parsed, so value is clean)
        pathArg = String(rawPath);
      }
      const rawCmd = parsed.CommandLine ?? parsed.Command ?? null;
      if (rawCmd != null) cmdArg = String(rawCmd);
    } catch {
      // Regex fallback
      const taMatch = jsonStr.match(/"toolAction"\s*:\s*"([^"]+)"/);
      const tsMatch = jsonStr.match(/"toolSummary"\s*:\s*"([^"]+)"/);
      toolAction = taMatch?.[1] ?? null;
      toolSummary = tsMatch?.[1] ?? null;
      // Regex fallback for path keys — unescape \\ → \
      const pathMatch = jsonStr.match(/"(?:AbsolutePath|TargetFile|Path)"\s*:\s*"([^"]+)"/);
      if (pathMatch) {
        pathArg = pathMatch[1].replace(/\\\\/g, '\\');
      }
      const cmdMatch = jsonStr.match(/"(?:CommandLine|Command)"\s*:\s*"([^"]+)"/);
      if (cmdMatch) cmdArg = cmdMatch[1].replace(/\\\\/g, '\\');
    }

    // Tool name: run at i-1 matching TOOL_NAME_RE
    let toolName = null;
    if (i >= 1 && TOOL_NAME_RE.test(runs[i - 1])) {
      toolName = runs[i - 1];
    }

    results.push({ toolName, toolAction, toolSummary, pathArg, cmdArg });
  }

  return results;
}

/**
 * Extract a title candidate from a payload's runs.
 * Returns the first run that is: >= 20 chars, doesn't start with '{',
 * is not a UUID or junk-prefixed UUID, not a URL, not a single token with no spaces.
 */
function extractTitleCandidate(buf) {
  const runs = extractRuns(buf, 20);
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  for (const run of runs) {
    if (run.startsWith('{')) continue;
    if (URL_RE.test(run)) continue;
    // Reject if contains a UUID anywhere in the string
    if (uuidPattern.test(run)) continue;
    // Reject if contains sessionID
    if (/sessionid/i.test(run)) continue;

    // Strip leading non-letter junk (like '&' prefix or 'b$' junk on user messages)
    const clean = run.replace(/^[^A-Za-z0-9]+/, '');
    if (clean.length < 20) continue;

    // Reject if mostly non-letter characters (letters < 50% of length)
    const letterCount = (clean.match(/[A-Za-z]/g) ?? []).length;
    if (letterCount < clean.length * 0.5) continue;

    return clean;
  }
  return null;
}

/**
 * Read steps from a SQLite db and map to events.
 *
 * @param {string} file         - absolute path to .db file
 * @param {number} sinceIdx     - only return rows with idx > sinceIdx
 * @returns {{ events: object[], lastIdx: number, title: string|null }}
 */
export function extractSteps(file, sinceIdx) {
  if (!DatabaseSync) return { events: [], lastIdx: sinceIdx, title: null };

  let db = null;
  try {
    db = new DatabaseSync(file, { readonly: true });
    // Older/synthetic DBs may lack the metadata column; select it only when present.
    const hasMeta = db.prepare('PRAGMA table_info(steps)').all().some(c => c.name === 'metadata');
    const cols = hasMeta ? 'idx, step_type, step_payload, metadata' : 'idx, step_type, step_payload';
    const rows = db.prepare(
      `SELECT ${cols} FROM steps WHERE idx > ? ORDER BY idx LIMIT 500`
    ).all(sinceIdx);

    const events = [];
    let lastIdx = sinceIdx;
    let title = null;

    // Title: only on first call (sinceIdx === -1 or 0, meaning from beginning)
    const wantTitle = sinceIdx < 0;

    for (const row of rows) {
      lastIdx = row.idx;
      const ua = row.step_payload;
      if (!ua) continue;
      const buf = Buffer.isBuffer(ua) ? ua : Buffer.from(ua);
      const ts = hasMeta ? readStepTsMs(row.metadata) : null;

      if (wantTitle && title === null && row.idx < 10) {
        const candidate = extractTitleCandidate(buf);
        if (candidate) title = cleanTitle(candidate, 80) ?? null;
      }

      const fragments = parsePayload(buf);
      for (const { toolName, toolAction, toolSummary, pathArg, cmdArg } of fragments) {
        const name = toolName ?? 'tool';
        const p = pathArg ?? '';

        // For command-type tools, classify git from the actual command line first
        if (/^(run_command|shell|exec)/.test(name)) {
          const cmdStr = cmdArg ?? toolAction ?? toolSummary ?? '';
          const g = classifyGit(cmdStr);
          if (g) {
            events.push({ ...g, tool: name, path: p || null, ts });
            continue;
          }
          const label = cleanTitle(toolSummary ?? toolAction ?? cmdArg ?? name, 120) ?? name;
          events.push({ kind: 'command', lane: 'feed', tool: name, path: p || null, ts, label });
          continue;
        }

        if (name === 'view_file') {
          const label = cleanTitle(toolSummary ?? toolAction ?? name, 120) ?? name;
          if (SKILL_NAME_RE.test(p) || SKILL_PATH_RE.test(p)) {
            events.push({ kind: 'skill', lane: 'context', tool: name, path: p || null, ts, label, op: 'read' });
          } else if (CONTEXT_FILE_RE.test(p)) {
            events.push({ kind: 'context-file', lane: 'context', tool: name, path: p || null, ts, label, op: 'read' });
          } else if (MEMORY_RE.test(p)) {
            events.push({ kind: 'memory', lane: 'context', tool: name, path: p || null, ts, label, op: 'read' });
          } else {
            events.push({ kind: 'tool', lane: 'feed', tool: name, path: p || null, ts, label });
          }
          continue;
        }

        if (/^(write_to_file|replace_file_content|multi_replace_file_content)$/.test(name)) {
          const label = cleanTitle(toolSummary ?? toolAction ?? name, 120) ?? name;
          if (CONTEXT_FILE_RE.test(p)) {
            events.push({ kind: 'context-file', lane: 'context', tool: name, path: p || null, ts, label, op: 'write' });
          } else if (MEMORY_RE.test(p)) {
            events.push({ kind: 'memory', lane: 'context', tool: name, path: p || null, ts, label, op: 'write' });
          } else {
            events.push({ kind: 'file-edit', lane: 'feed', tool: name, path: p || null, ts, label });
          }
          continue;
        }

        const label = cleanTitle(toolSummary ?? toolAction ?? name, 120) ?? name;
        events.push({ kind: 'tool', lane: 'feed', tool: name, path: p || null, ts, label });
      }
    }

    return { events, lastIdx, title };
  } catch {
    return { events: [], lastIdx: sinceIdx, title: null };
  } finally {
    try { db?.close(); } catch {}
  }
}
