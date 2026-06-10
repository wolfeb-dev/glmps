// server/lib/adapters/hermes.js
// Real format read from the agent:
// sessions are ~/.hermes/sessions/<session_id>.jsonl, one JSON message per line.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanTitle } from './clean-title.js';

export const id = 'hermes';
export const displayName = 'Hermes';

const HOME = os.homedir();
const HERMES_DIR = path.join(HOME, '.hermes');
const SESSIONS_DIR = path.join(HERMES_DIR, 'sessions');

export function detect(P) {
  let installed = false;
  try { installed = fs.statSync(HERMES_DIR).isDirectory(); } catch {}
  return { installed, dataDirs: [HERMES_DIR] };
}

export function discover(P) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true }); } catch { return out; }

  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
    const filePath = path.join(SESSIONS_DIR, f.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { continue; }

    const basename = f.name.replace(/\.jsonl$/, '');
    out.push({
      id: `hermes:${basename}`,
      tool: id,
      kind: 'jsonl-tail',
      file: filePath,
      cwd: null,
      label: null,
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

  const role = obj.role ?? null;
  const ts = obj.timestamp ?? obj.created_at ?? null;

  // User message
  if (role === 'user') {
    const content = obj.content ?? '';
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(c => (typeof c === 'string' ? c : (c?.text ?? ''))).join('') : '';
    if (!text) return [];
    return [{
      kind: 'tool', lane: 'feed', tool: 'user', path: null, ts, sessionId,
      label: 'User: ' + (cleanTitle(text, 120) ?? text.slice(0, 120)),
    }];
  }

  // Assistant with tool_calls
  if (role === 'assistant') {
    const toolCalls = obj.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
    const events = [];
    for (const tc of toolCalls) {
      const name = tc?.function?.name ?? tc?.name ?? 'tool';
      events.push({ kind: 'tool', lane: 'feed', tool: name, path: null, ts, sessionId, label: name });
    }
    return events;
  }

  // role 'tool' (tool results): skip
  return [];
}
