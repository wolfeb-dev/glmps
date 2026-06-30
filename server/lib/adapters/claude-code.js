// server/lib/adapters/claude-code.js
// Adapter wrapping existing claude-code discovery logic.
import fs from 'node:fs';
import path from 'node:path';
import { discoverClaudeSessions } from '../sessions.js';
import { extractClaudeEvents } from '../extract-claude.js';

export const id = 'claude-code';
export const displayName = 'Claude Code';
export const controllable = true;

export function detect(P) {
  const installed = (() => { try { return fs.statSync(P.claudeDir).isDirectory(); } catch { return false; } })();
  return { installed, dataDirs: [P.claudeDir] };
}

/** Returns session descriptors for the adapter registry generic loop. */
export function discover(P) {
  const sessions = discoverClaudeSessions(P);
  return sessions.map(s => ({
    id: s.id,
    tool: id,
    kind: 'jsonl-tail',
    file: s.transcriptPath,
    cwd: s.cwd ?? null,
    label: null,
    mtimeMs: s.mtimeMs,
    extra: { live: s.live, transcriptPath: s.transcriptPath },
  }));
}

export { extractClaudeEvents as extractLine };

/** Returns the tier-classified dirs that Claude Code contributes to brain/ephemeral. */
export function tierDirs(P) {
  return {
    brain: [
      path.join(P.claudeDir, 'skills'),
      path.join(P.claudeDir, 'agents'),
      path.join(P.claudeDir, 'hooks'),
    ],
    ephemeral: [
      P.projectsDir,
      path.join(P.claudeDir, 'cache'),
    ],
  };
}
