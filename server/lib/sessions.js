// server/lib/sessions.js
import fs from 'node:fs';
import path from 'node:path';

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

// -> [{ id, tool:'claude-code', cwd, transcriptPath, live, mtimeMs }]
export function discoverClaudeSessions({ activeSessionsFile, projectsDir }) {
  const reg = readJson(activeSessionsFile, []);
  const regEntries = Array.isArray(reg) ? reg.filter(e => e?.sessionId) : [];
  const live = new Map();
  for (const e of regEntries) if (pidAlive(e.ppid)) live.set(e.sessionId, e);

  const out = new Map();
  let projects = [];
  try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch {}
  for (const d of projects) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    let files = [];
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue; // root files only
      const id = f.name.slice(0, -'.jsonl'.length);
      const full = path.join(dir, f.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
      out.set(id, {
        id, tool: 'claude-code', transcriptPath: full, mtimeMs,
        cwd: live.get(id)?.cwd ?? null, live: live.has(id),
      });
    }
  }
  // registry entries not found by the scan still count (brand-new or foreign-dir sessions)
  for (const e of regEntries) {
    if (out.has(e.sessionId)) continue;
    const isLive = live.has(e.sessionId);
    out.set(e.sessionId, {
      id: e.sessionId, tool: 'claude-code', transcriptPath: e.transcriptPath,
      mtimeMs: isLive ? Date.now() : 0, cwd: e.cwd ?? null, live: isLive });
  }
  return [...out.values()];
}

// -> [{ id, tool:'antigravity', dir, logPath|null, pbPath|null, mtimeMs, format:'log'|'pb' }]
export function discoverAgSessions({ antigravityDirs, brainDir }) {
  // Support legacy single-brainDir call (for backward compat in tests that pass {brainDir})
  const roots = antigravityDirs ?? (brainDir ? [path.dirname(brainDir)] : []);

  // keyed by id; keeps best entry across all roots
  const byId = new Map();

  function upsert(entry) {
    const existing = byId.get(entry.id);
    if (!existing) { byId.set(entry.id, entry); return; }
    // 'log' format beats 'pb'; same format → keep max mtime
    if (existing.format === 'log' && entry.format === 'pb') {
      // keep existing log but update mtime if pb is newer
      if (entry.mtimeMs > existing.mtimeMs)
        existing.mtimeMs = entry.mtimeMs;
      return;
    }
    if (existing.format === 'pb' && entry.format === 'log') {
      byId.set(entry.id, { ...entry, mtimeMs: Math.max(entry.mtimeMs, existing.mtimeMs) });
      return;
    }
    // same format — keep max mtime
    if (entry.mtimeMs > existing.mtimeMs) byId.set(entry.id, entry);
  }

  for (const root of roots) {
    // scan brain/<id>/ for log-format sessions
    const scanBrainDir = path.join(root, 'brain');
    let brainEntries = [];
    try { brainEntries = fs.readdirSync(scanBrainDir, { withFileTypes: true }); } catch {}
    for (const d of brainEntries) {
      if (!d.isDirectory()) continue;
      let logPath = path.join(scanBrainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(logPath).mtimeMs;
      } catch {
        logPath = path.join(scanBrainDir, d.name, '.system_generated', 'logs', 'overview.txt');
        try {
          mtimeMs = fs.statSync(logPath).mtimeMs;
        } catch {
          continue;
        }
      }

      // Also check messages folder and history.jsonl for newer mtime to keep active sessions alive
      const msgDir = path.join(scanBrainDir, d.name, '.system_generated', 'messages');
      try {
        const msgMtime = fs.statSync(msgDir).mtimeMs;
        if (msgMtime > mtimeMs) mtimeMs = msgMtime;
      } catch {}

      const historyPath = path.join(root, 'history.jsonl');
      try {
        const histMtime = fs.statSync(historyPath).mtimeMs;
        if (histMtime > mtimeMs) mtimeMs = histMtime;
      } catch {}

      upsert({ id: d.name, tool: 'antigravity', dir: path.join(scanBrainDir, d.name),
        logPath, pbPath: null, mtimeMs, format: 'log' });
    }

    // scan conversations/*.pb for pb-format sessions
    const convsDir = path.join(root, 'conversations');
    let pbEntries = [];
    try { pbEntries = fs.readdirSync(convsDir, { withFileTypes: true }); } catch {}
    for (const f of pbEntries) {
      if (!f.isFile() || !f.name.endsWith('.pb')) continue;
      const id = f.name.slice(0, -'.pb'.length);
      const pbPath = path.join(convsDir, f.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(pbPath).mtimeMs; } catch {}
      upsert({ id, tool: 'antigravity', dir: convsDir,
        logPath: null, pbPath, mtimeMs, format: 'pb' });
    }
  }

  return [...byId.values()];
}

export function livenessOf(processAlive, lastWriteMs, nowMs, cfg) {
  if (!processAlive) return 'ended';
  return (nowMs - lastWriteMs) <= cfg.workingThresholdMs ? 'working' : 'idle';
}
