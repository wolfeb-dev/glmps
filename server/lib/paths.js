// server/lib/paths.js
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

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
    statusDir: path.join(stateDir, 'status'),
    requestsFile: path.join(stateDir, 'requests', 'resume.jsonl'),
    undoDir: path.join(stateDir, 'undo'),
    doneGateDir: env.GLMPS_DONE_GATE_DIR ?? path.join(stateDir, 'done-gate'),
    agyCliDir,
    opencodeDir,
    codexDir,
    clineStorageDir,
    hermesDir,
    assetsDir: env.GLMPS_ASSETS_DIR ?? path.join(home, 'glmps-assets'),
  };
}

export function ensureStateDirs(p) {
  for (const d of ['state', 'status', 'requests', 'undo'])
    fs.mkdirSync(path.join(p.stateDir, d), { recursive: true });
}
