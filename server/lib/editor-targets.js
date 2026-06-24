// server/lib/editor-targets.js
export const TARGET_IDS = ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'antigravity', 'native-terminal'];
export const TARGET_LABELS = {
  'vscode': 'VS Code', 'vscode-insiders': 'VS Code Insiders', 'cursor': 'Cursor',
  'windsurf': 'Windsurf', 'antigravity': 'Antigravity', 'native-terminal': 'Native terminal',
};
const PROC = {
  'vscode': ['code'], 'vscode-insiders': ['code - insiders', 'code-insiders'],
  'cursor': ['cursor'], 'windsurf': ['windsurf'], 'antigravity': ['antigravity'],
};
export function procNamesFor(id) { return PROC[id] ?? []; }

export function resolveTarget({ item = {}, lastTarget = null, running = [] } = {}) {
  if (item.target && TARGET_IDS.includes(item.target)) return item.target;
  if (lastTarget && TARGET_IDS.includes(lastTarget)) return lastTarget;
  for (const id of TARGET_IDS) if (id !== 'native-terminal' && running.includes(id)) return id;
  return 'native-terminal';
}

// The prompt's content never goes on a command line (which would be re-parsed by
// cmd.exe / PowerShell / .cmd shims and break on quotes, %VAR%, &, or newlines, or
// even inject commands). Instead the seeded command carries only a short, controlled
// ASCII instruction naming the prompt-file PATH; the agent reads the file with its
// own tools. Filesystem paths cannot contain a double-quote, so single-level quoting
// is always safe across cmd, PowerShell, and POSIX sh.
export function taskInstruction(promptFile) {
  return `Read the task described in this file and complete it, then update its backlog card status: ${promptFile}`;
}
export function seededCommand(cmd, promptFile) {
  return `${cmd} "${taskInstruction(promptFile)}"`;
}

// Editor targets are opened through the requestsFile "companion" seam, but only the
// Antigravity companion consumes it today, so a VS Code-family target silently no-ops
// until its companion ships (glmps-10). launchTargetFor resolves the target we will
// ACTUALLY launch: native-terminal and companion-backed targets pass through, but a
// companion-less editor target is downgraded to native-terminal so the session still
// opens (glmps-12). Antigravity counts as companion-backed when it is already live
// (agAlive) or we have a command to launch it (which brings its companion up).
export function launchTargetFor(target, { agAlive = false, antigravityCommand = null } = {}) {
  if (target === 'native-terminal') return 'native-terminal';
  const hasCompanion = target === 'antigravity' && Boolean(agAlive || antigravityCommand);
  return hasCompanion ? target : 'native-terminal';
}

export function nativeTerminalRecipe({ platform, seededCmd, cwd }) {
  const options = { cwd, detached: true, stdio: 'ignore', windowsHide: true, shell: false };
  if (platform === 'win32') {
    return { file: 'cmd', args: ['/c', 'start', '""', 'cmd', '/k', seededCmd], options: { ...options, shell: false } };
  }
  if (platform === 'darwin') {
    const script = `tell application "Terminal" to do script "cd ${cwd} && ${seededCmd}"`;
    return { file: 'osascript', args: ['-e', script], options };
  }
  return { file: 'x-terminal-emulator', args: ['-e', `sh -c '${seededCmd}'`], options };
}

export function companionRecord({ targetId, seededCmd, cwd, now }) {
  return { type: 'terminal', target: targetId, command: seededCmd, cwd, location: 'editor', ts: now };
}
