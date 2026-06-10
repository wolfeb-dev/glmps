// Detect capability-usage gaps in a session: cases where a skill/agent should
// likely have been used but wasn't. Pure function over a session's events + the
// persisted skillsUsed list. Returns [{ code, severity, message }].
// Conservative on purpose — only flag high-confidence misses so the signal stays trustworthy.

// Unambiguously front-end by extension (styles, markup, component files).
const CLEAR_UI_EXT = /\.(css|scss|less|html|vue|svelte|tsx|jsx)$/i;
// Plain JS/TS counts as UI only inside a front-end directory (server JS shouldn't trip it).
const UI_DIR_RE = /[\\/](web|ui|frontend|components|styles|public|client)[\\/]/i;
const PLAIN_SCRIPT_RE = /\.(js|ts|mjs|cjs)$/i;
const HEAVY_EDIT_THRESHOLD = 15;

function isUiFile(p) {
  const path = String(p ?? '');
  if (!path) return false;
  if (CLEAR_UI_EXT.test(path)) return true;
  return UI_DIR_RE.test(path) && PLAIN_SCRIPT_RE.test(path);
}

export function detectGaps(events, skillsUsed = []) {
  const evs = Array.isArray(events) ? events : [];
  const skills = Array.isArray(skillsUsed) ? skillsUsed : [];

  const usedSkill = (re) =>
    skills.some(s => re.test(String(s))) ||
    evs.some(e => e.kind === 'skill' && re.test(String(e.label ?? '')));

  const gaps = [];

  // 1) UI/style files edited without the frontend-design skill.
  const editedUi = evs.some(e =>
    (e.kind === 'file-edit' || e.kind === 'context-file') &&
    e.op !== 'read' &&
    isUiFile(e.path));
  if (editedUi && !usedSkill(/frontend-design/i)) {
    gaps.push({
      code: 'ui-without-frontend-design',
      severity: 'warn',
      message: 'Edited UI/style files without the frontend-design skill.',
    });
  }

  // 2) Many file edits with no subagent delegation.
  const editCount = evs.filter(e => e.kind === 'file-edit' && e.op !== 'read').length;
  const usedAgents = evs.some(e => e.kind === 'agent');
  if (editCount >= HEAVY_EDIT_THRESHOLD && !usedAgents) {
    gaps.push({
      code: 'heavy-edits-no-subagents',
      severity: 'info',
      message: `${editCount} file edits with no subagents — consider delegating parallel work.`,
    });
  }

  return gaps;
}
