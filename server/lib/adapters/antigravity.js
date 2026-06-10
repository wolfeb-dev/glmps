// server/lib/adapters/antigravity.js
// Adapter wrapping existing antigravity discovery logic.
import fs from 'node:fs';
import { discoverAgSessions } from '../sessions.js';
import { extractAgEvents } from '../extract-antigravity.js';

export const id = 'antigravity';
export const displayName = 'Antigravity IDE';

export function detect(P) {
  const installed = P.antigravityDirs.some(d => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
  return { installed, dataDirs: P.antigravityDirs };
}

/** Returns session descriptors for the adapter registry generic loop. */
export function discover(P) {
  const sessions = discoverAgSessions({ antigravityDirs: P.antigravityDirs });
  return sessions.map(s => ({
    id: s.id,
    tool: id,
    kind: s.format === 'log' ? 'jsonl-tail' : 'pb-only',
    file: s.logPath ?? null,
    cwd: null,
    label: null,
    mtimeMs: s.mtimeMs,
    extra: { format: s.format, logPath: s.logPath, pbPath: s.pbPath, dir: s.dir },
  }));
}

export { extractAgEvents as extractLine };
