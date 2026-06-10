// server/lib/terminal-request.js
// Pure logic for the new-terminal launcher (POST /api/terminal).
// Resolves a requested terminal against the configured list and validates cwd,
// returning a request record to append to the companion's requests file.
import fs from 'node:fs';

// buildTerminalRequest({ terminal, cwd }, terminals, { now, fsImpl })
//   terminal  - the chosen terminal's label (server resolves the command itself;
//               an arbitrary command string from the client is never trusted)
//   cwd       - optional working directory; if given it must be an existing dir
// Returns { record } on success, or { error } on failure.
export function buildTerminalRequest({ terminal, cwd = null } = {}, terminals, { now = Date.now(), fsImpl = fs } = {}) {
  const list = Array.isArray(terminals) ? terminals : [];
  const match = list.find(t => t && t.label === terminal);
  if (!match) return { error: 'unknown terminal' };

  let validCwd = null;
  if (cwd != null) {
    if (typeof cwd !== 'string') return { error: 'invalid cwd' };
    try {
      if (!fsImpl.statSync(cwd).isDirectory()) return { error: 'cwd is not a directory' };
    } catch {
      return { error: 'cwd not found' };
    }
    validCwd = cwd;
  }

  return {
    record: {
      type: 'terminal',
      command: typeof match.command === 'string' ? match.command : '',
      cwd: validCwd,
      location: 'editor',
      ts: now,
    },
  };
}
