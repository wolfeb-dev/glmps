// server/lib/adapters/openclaw.js
// SPECULATIVE: Format inferred from openclaw docs and deepwiki. Unverified
// against live data — treat as best-effort until confirmed against real sessions.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanTitle } from './clean-title.js';

export const id = 'openclaw';
export const displayName = 'OpenClaw';

const HOME = os.homedir();

function findRoot() {
  const candidates = [
    path.join(HOME, '.openclaw'),
    path.join(HOME, '.clawdbot'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch {}
  }
  return null;
}

export function detect(P) {
  const root = findRoot();
  const dataDirs = [path.join(HOME, '.openclaw'), path.join(HOME, '.clawdbot')];
  return { installed: root !== null, dataDirs };
}

/**
 * Try to read a sessions store file (sessions.json / store.json) and extract
 * a label for a given session basename.  Tolerant of any shape surprise.
 */
function readSessionLabel(storeFile, basename) {
  try {
    const raw = fs.readFileSync(storeFile, 'utf-8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const entry = obj[basename];
    if (!entry || typeof entry !== 'object') return null;
    return entry.label ?? entry.title ?? null;
  } catch { return null; }
}

export function discover(P) {
  const out = [];
  const root = findRoot();
  if (!root) return out;

  // agents/<agentId>/sessions/*.jsonl
  const agentsDir = path.join(root, 'agents');
  let agentDirs = [];
  try { agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch {}

  for (const agent of agentDirs) {
    if (!agent.isDirectory()) continue;
    const agentId = agent.name;
    const sessionsDir = path.join(agentsDir, agentId, 'sessions');
    const storeFile = path.join(sessionsDir, 'sessions.json');
    let files = [];
    try { files = fs.readdirSync(sessionsDir, { withFileTypes: true }); } catch { continue; }

    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const filePath = path.join(sessionsDir, f.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { continue; }

      const basename = f.name.replace(/\.jsonl$/, '');
      const label = readSessionLabel(storeFile, basename);
      out.push({
        id: `openclaw:${agentId}:${basename}`,
        tool: id,
        kind: 'jsonl-tail',
        file: filePath,
        cwd: null,
        label: label ?? null,
        mtimeMs,
      });
    }
  }

  // sessions/*.jsonl (flat layout at root)
  const rootSessionsDir = path.join(root, 'sessions');
  const rootStoreFile = path.join(rootSessionsDir, 'store.json');
  let rootFiles = [];
  try { rootFiles = fs.readdirSync(rootSessionsDir, { withFileTypes: true }); } catch {}

  for (const f of rootFiles) {
    if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
    const filePath = path.join(rootSessionsDir, f.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { continue; }

    const basename = f.name.replace(/\.jsonl$/, '');
    const label = readSessionLabel(rootStoreFile, basename);
    out.push({
      id: `openclaw:main:${basename}`,
      tool: id,
      kind: 'jsonl-tail',
      file: filePath,
      cwd: null,
      label: label ?? null,
      mtimeMs,
    });
  }

  return out;
}

/** jsonl-tail: one line -> events[] */
export function extractLine(line, sessionId) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  if (!obj || typeof obj !== 'object') return [];

  const ts = obj.timestamp ?? obj.ts ?? null;

  // User message
  const isUser = obj.role === 'user'
    || obj.type === 'user'
    || (obj.type === 'message' && obj.role === 'user');
  if (isUser) {
    const content = obj.content ?? obj.text ?? '';
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(c => (typeof c === 'string' ? c : (c?.text ?? ''))).join('') : '';
    if (!text) return [];
    return [{
      kind: 'tool', lane: 'feed', tool: 'user', path: null, ts, sessionId,
      label: 'User: ' + (cleanTitle(text, 120) ?? text.slice(0, 120)),
    }];
  }

  // Tool calls — various field shapes seen across versions
  const isToolCall = obj.type === 'toolCall'
    || obj.tool_use != null
    || obj.type === 'tool_result';
  if (isToolCall) {
    const name = obj.name ?? obj.tool_use?.name ?? obj.tool ?? 'tool';
    return [{ kind: 'tool', lane: 'feed', tool: name, path: null, ts, sessionId, label: name }];
  }

  return [];
}
