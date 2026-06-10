// server/lib/guiding.js
// computeGuiding(cwd, claudeDir, projectMemoryDir) -> [{ name, path, scope }]
// Order: project entries nearest-cwd-first, then global, then memory last.

import fs from 'node:fs';
import path from 'node:path';

const GUIDING_NAMES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
const MAX_LEVELS = 24;

/**
 * Compute the guiding-context files for a session.
 * @param {string|null|undefined} cwd            - session working directory
 * @param {string}                claudeDir       - path to ~/.claude
 * @param {string|null|undefined} projectMemoryDir - path to the session's project memory dir (optional)
 * @returns {{ name: string, path: string, scope: 'global'|'project'|'memory' }[]}
 */
export function computeGuiding(cwd, claudeDir, projectMemoryDir) {
  const seen = new Set();
  const project = [];

  // Walk from cwd upward, collecting CLAUDE.md/AGENTS.md/GEMINI.md
  if (cwd && typeof cwd === 'string') {
    try {
      let dir = path.resolve(cwd);
      let prev = null;
      let levels = 0;
      while (dir !== prev && levels < MAX_LEVELS) {
        for (const name of GUIDING_NAMES) {
          const candidate = path.join(dir, name);
          let resolved;
          try { resolved = fs.realpathSync(candidate); } catch { resolved = candidate; }
          if (!seen.has(resolved)) {
            try {
              fs.accessSync(candidate, fs.constants.F_OK);
              seen.add(resolved);
              project.push({ name, path: candidate, scope: 'project' });
            } catch { /* not found */ }
          }
        }
        prev = dir;
        dir = path.dirname(dir);
        levels++;
      }
    } catch { /* defensive: bad cwd */ }
  }

  // Always include <claudeDir>/CLAUDE.md as scope 'global' when it exists
  const globalPath = claudeDir ? path.join(claudeDir, 'CLAUDE.md') : null;
  const globalResult = [];
  if (globalPath) {
    let resolvedGlobal;
    try { resolvedGlobal = fs.realpathSync(globalPath); } catch { resolvedGlobal = globalPath; }
    if (!seen.has(resolvedGlobal)) {
      try {
        fs.accessSync(globalPath, fs.constants.F_OK);
        globalResult.push({ name: 'CLAUDE.md', path: globalPath, scope: 'global' });
      } catch { /* not found */ }
    } else {
      // Already found in walk — upgrade it to 'global' scope but don't duplicate.
      // Find it in project and relabel.
      const idx = project.findIndex(e => {
        let r; try { r = fs.realpathSync(e.path); } catch { r = e.path; }
        return r === resolvedGlobal;
      });
      if (idx !== -1) {
        project[idx] = { ...project[idx], scope: 'global' };
      }
    }
  }

  // If projectMemoryDir given and exists, include MEMORY.md as scope:'memory'
  const memoryResult = [];
  if (projectMemoryDir && typeof projectMemoryDir === 'string') {
    try {
      const memPath = path.join(projectMemoryDir, 'MEMORY.md');
      fs.accessSync(memPath, fs.constants.F_OK);
      memoryResult.push({ name: 'MEMORY.md', path: memPath, scope: 'memory' });
    } catch { /* not found or bad dir */ }
  }

  // Order: project (nearest-cwd first) then global then memory last
  return [...project, ...globalResult, ...memoryResult];
}
