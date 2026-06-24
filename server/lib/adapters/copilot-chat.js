// server/lib/adapters/copilot-chat.js
import fs from 'node:fs';
import path from 'node:path';
import { cleanTitle } from './clean-title.js';

export const id = 'copilot-chat';
export const displayName = 'VS Code Copilot Chat';

export function detect(P) {
  const installed = P.vscodeStorageDirs.some(d => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
  return { installed, dataDirs: P.vscodeStorageDirs };
}

/** Read workspace.json folder URI for a storage hash dir and decode to local path. */
function readWorkspaceCwd(hashDir) {
  try {
    const raw = fs.readFileSync(path.join(hashDir, 'workspace.json'), 'utf-8');
    const obj = JSON.parse(raw);
    const folder = obj?.folder;
    if (typeof folder !== 'string' || !folder.startsWith('file:')) return null;
    // file:///d%3A/foo -> decode and normalise to system path
    const decoded = decodeURIComponent(folder.replace(/^file:\/\/\//, ''));
    // Windows: d:/foo -> d:\foo (only when drive letter present)
    return decoded.replace(/\//g, path.sep);
  } catch { return null; }
}

export function discover(P) {
  const out = [];
  for (const storageDir of P.vscodeStorageDirs) {
    let hashDirs = [];
    try { hashDirs = fs.readdirSync(storageDir, { withFileTypes: true }); } catch { continue; }

    for (const d of hashDirs) {
      if (!d.isDirectory()) continue;
      const hashDir = path.join(storageDir, d.name);
      const chatSessionsDir = path.join(hashDir, 'chatSessions');
      let chatFiles = [];
      try { chatFiles = fs.readdirSync(chatSessionsDir, { withFileTypes: true }); } catch { continue; }

      const cwd = readWorkspaceCwd(hashDir);

      for (const f of chatFiles) {
        if (!f.isFile() || !f.name.endsWith('.json')) continue;
        const filePath = path.join(chatSessionsDir, f.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { continue; }

        const sessionId = `copilot:${d.name}:${f.name.replace(/\.json$/, '')}`;
        out.push({
          id: sessionId,
          tool: id,
          kind: 'json-snapshot',
          file: filePath,
          cwd: cwd ?? null,
          label: null,
          mtimeMs,
          extra: { hashDir: d.name },
        });
      }
    }
  }
  return out;
}

/** Extract user text from a request message object (defensive — fields vary by version). */
function extractUserText(message) {
  if (!message) return '';
  if (typeof message.text === 'string' && message.text) return message.text;
  if (Array.isArray(message.parts)) {
    for (const p of message.parts) {
      if (p?.kind === 'text' && typeof p.text === 'string' && p.text) return p.text;
      if (typeof p?.text === 'string' && p.text) return p.text;
    }
  }
  return '';
}

/** json-snapshot kind: whole file text -> { events, title, cwd } */
export function extractSnapshot(text, sessionId) {
  let data;
  try { data = JSON.parse(text); } catch { return { events: [] }; }

  const requests = Array.isArray(data?.requests) ? data.requests : [];
  if (requests.length === 0) return { events: [] };

  const ts = data.creationDate ?? data.lastMessageDate ?? null;
  const events = [];
  let title = null;

  for (const req of requests) {
    const userText = extractUserText(req?.message);
    if (userText) {
      if (!title) title = cleanTitle(userText, 80);
      events.push({
        kind: 'tool', lane: 'feed', tool: 'user', path: null, ts, sessionId,
        label: 'User: ' + (cleanTitle(userText, 120) ?? userText.slice(0, 120)),
      });
    }
  }

  return { events, title, cwd: null };
}
