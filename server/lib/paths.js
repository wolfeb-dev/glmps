// server/lib/paths.js
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_ZONE_CONFIG } from './zones.js';
import { fileURLToPath } from 'node:url';

// The glmps-assets repo is a sibling of this code repo. Derive the
// default from THIS module's location (server/lib/paths.js) so the server
// resolves the assets dir regardless of how it was launched (e.g. a
// companion-spawned process without GLMPS_ASSETS_DIR in its env). GLMPS_ASSETS_DIR
// still overrides. Previously this defaulted to ~/glmps-assets,
// which does not exist, so learning Approve/Promote hit ENOENT.
const _repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_ASSETS_DIR = path.join(path.dirname(_repoRoot), 'glmps-assets');

export function getPaths(env = process.env) {
  const home = os.homedir();
  const claudeDir = env.GLMPS_CLAUDE_DIR ?? path.join(home, '.claude');
  const antigravityDirs = env.GLMPS_ANTIGRAVITY_DIR
    ? [env.GLMPS_ANTIGRAVITY_DIR]
    : [
        path.join(home, '.gemini', 'antigravity-ide'),
        path.join(home, '.gemini', 'antigravity-cli'),
        path.join(home, '.gemini', 'antigravity'),
      ];
  const antigravityDir = antigravityDirs[0]; // primary (kept for backward compat)
  const stateDir = env.GLMPS_STATE_DIR ?? path.join(home, '.glmps');
  const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');

  // Hermes agent home: $HERMES_HOME (a persisted user var on Windows), else platform default
  // (%LOCALAPPDATA%\hermes on Windows, ~/.hermes on POSIX). GLMPS_HERMES_DIR overrides (tests).
  const hermesDir = env.GLMPS_HERMES_DIR ?? env.HERMES_HOME
    ?? (process.platform === 'win32' ? path.join(localAppData, 'hermes') : path.join(home, '.hermes'));
  const geminiTmpDir = env.GLMPS_GEMINI_TMP_DIR ?? path.join(home, '.gemini', 'tmp');
  const vscodeStorageDirs = env.GLMPS_VSCODE_STORAGE_DIR
    ? [env.GLMPS_VSCODE_STORAGE_DIR]
    : [path.join(appData, 'Code', 'User', 'workspaceStorage')];
  const agyCliDir = env.GLMPS_AGY_CLI_DIR ?? path.join(home, '.gemini', 'antigravity-cli');

  // OpenCode base: $OPENCODE_HOME, else $XDG_DATA_HOME/opencode, else ~/.local/share/opencode.
  // GLMPS_OPENCODE_DIR overrides all of the above (used by tests).
  const opencodeDir = env.GLMPS_OPENCODE_DIR
    ?? env.OPENCODE_HOME
    ?? (env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'opencode') : path.join(home, '.local', 'share', 'opencode'));

  // Codex base: $CODEX_HOME, else ~/.codex. GLMPS_CODEX_DIR overrides (tests).
  const codexDir = env.GLMPS_CODEX_DIR ?? env.CODEX_HOME ?? path.join(home, '.codex');

  // Cline/Roo VS Code globalStorage roots. GLMPS_CLINE_DIR (single override, tests) wins;
  // otherwise enumerate per-OS editor globalStorage dirs in adapters/cline.js.
  const clineStorageDir = env.GLMPS_CLINE_DIR ?? null;

  return {
    claudeDir,
    projectsDir: path.join(claudeDir, 'projects'),
    activeSessionsFile: path.join(claudeDir, '.claude-manager', 'active-sessions.json'),
    cmTap: path.join(claudeDir, '.claude-manager', 'statusline-tap.js'),
    settingsFile: path.join(claudeDir, 'settings.json'),
    credentialsFile: path.join(claudeDir, '.credentials.json'),
    cmStatuslineFile: path.join(claudeDir, '.claude-manager', 'statusline.json'),
    pluginsCacheDir: path.join(claudeDir, 'plugins', 'cache'),
    antigravityDirs,
    antigravityDir, // first entry; kept for consumers that need a single root
    brainDir: path.join(antigravityDir, 'brain'),
    geminiTmpDir,
    vscodeStorageDirs,
    stateDir,
    offsetsFile: path.join(stateDir, 'state', 'offsets.json'),
    indexFile: path.join(stateDir, 'state', 'index.json'),
    outcomesDir: env.GLMPS_OUTCOME_DIR ?? path.join(stateDir, 'outcomes'),
    statusDir: path.join(stateDir, 'status'),
    requestsFile: path.join(stateDir, 'requests', 'resume.jsonl'),
    undoDir: path.join(stateDir, 'undo'),
    worktreesDir: env.GLMPS_WORKTREES_DIR ?? path.join(stateDir, 'runner', 'worktrees'),
    doneGateDir: env.GLMPS_DONE_GATE_DIR ?? path.join(stateDir, 'done-gate'),
    agyCliDir,
    opencodeDir,
    codexDir,
    clineStorageDir,
    hermesDir,
    assetsDir: env.GLMPS_ASSETS_DIR ?? DEFAULT_ASSETS_DIR,
    agentsDir: env.GLMPS_AGENTS_DIR ?? path.join(env.GLMPS_ASSETS_DIR ?? DEFAULT_ASSETS_DIR, 'agents'),
    zoneConfig: (() => {
      if (!env.GLMPS_ZONE_CONFIG) return DEFAULT_ZONE_CONFIG;
      try { return JSON.parse(env.GLMPS_ZONE_CONFIG); } catch { return DEFAULT_ZONE_CONFIG; }
    })(),
  };
}

export function graphPathFor(projectRoot) {
  if (!projectRoot) return null;
  for (const rel of ['graphify-out/graph.json', 'server/graphify-out/graph.json']) {
    const f = path.join(projectRoot, rel);
    try { if (fs.existsSync(f)) return f; } catch {}
  }
  return null;
}

export function ensureStateDirs(p) {
  for (const d of ['state', 'status', 'requests', 'undo'])
    fs.mkdirSync(path.join(p.stateDir, d), { recursive: true });
}
