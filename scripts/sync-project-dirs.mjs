#!/usr/bin/env node
// Sync ~/.claude/settings.json permissions.additionalDirectories from the git
// repos under GLMPS_PROJECT_ROOTS (path.delimiter-separated, e.g. "D:/" or
// "D:/;E:/work"). No roots set => no-op. Intended to run on session start and
// before launching, so new repos are picked up automatically.
import os from 'node:os';
import path from 'node:path';
import { syncProjectDirs } from '../server/lib/project-dirs.js';

const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
const roots = (process.env.GLMPS_PROJECT_ROOTS || '')
  .split(path.delimiter).map((s) => s.trim()).filter(Boolean);

if (!roots.length) {
  console.log('sync-project-dirs: GLMPS_PROJECT_ROOTS not set; nothing to do.');
  process.exit(0);
}

const r = syncProjectDirs({ settingsFile, roots });
if (!r.ok) { console.error('sync-project-dirs: ' + r.reason); process.exit(1); }
console.log(`sync-project-dirs: ${r.changed ? 'updated' : 'unchanged'} (${r.dirs.length} dir(s))`);
