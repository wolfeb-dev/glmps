// server/lib/live-install-guard.js
// Pure decision core for the live-install write guard. A poisoned/queued agent
// job must not be able to push changes straight into a live-trading install
// (e.g. the live NinjaTrader bin\Custom directory). The PreToolUse hook
// (hooks/live-install-guard.js) feeds tool calls here and blocks writes into
// configured live-install paths unless the operator has explicitly approved.
//
// No I/O. The hook supplies livePaths (from config) and handles the override.

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Verbs / redirections that mutate the filesystem (POSIX + PowerShell + cmd).
const WRITE_TOKENS = /(\bcp\b|\bcopy\b|\bmv\b|\bmove\b|\brm\b|\bdel\b|\berase\b|\brmdir\b|\brobocopy\b|\bxcopy\b|out-file|set-content|add-content|new-item|\btee\b|>>?)/i;

function norm(p) { return String(p ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, ''); }

// Parse a ';' / ',' / newline separated list of live-install path prefixes.
export function parseLivePaths(str) {
  return String(str ?? '')
    .split(/[;,\n]/)
    .map(s => norm(s.trim()))
    .filter(Boolean);
}

function underPrefix(target, prefix) {
  const t = norm(target);
  return t === prefix || t.startsWith(prefix + '/');
}

/**
 * Decide whether a tool call writes into a live-install path.
 * @returns {{ blocked: boolean, reason?: string, target?: string }}
 */
export function guardLiveWrite({ tool_name, tool_input = {}, livePaths = [] } = {}) {
  if (!livePaths.length) return { blocked: false };

  if (WRITE_TOOLS.has(tool_name)) {
    const target = tool_input.file_path || tool_input.notebook_path || tool_input.path;
    if (!target) return { blocked: false };
    const hit = livePaths.find(lp => underPrefix(target, lp));
    if (hit) return { blocked: true, target: String(target), reason: `${tool_name} into live-install path: ${target}` };
    return { blocked: false };
  }

  if (tool_name === 'Bash') {
    const cmd = String(tool_input.command ?? '');
    const c = norm(cmd);
    const hit = livePaths.find(lp => c.includes(lp));
    // Only block when the command references a live path AND mutates the FS.
    // A read-only reference (cat/type/Get-Content) is allowed.
    if (hit && WRITE_TOKENS.test(cmd)) return { blocked: true, target: hit, reason: `Bash command writes into a live-install path (${hit})` };
    return { blocked: false };
  }

  return { blocked: false };
}
