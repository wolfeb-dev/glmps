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

  // Helper: parse ts to a numeric millisecond value (accepts number or ISO string).
  const tsMs = (e) => {
    const v = e.ts;
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    const parsed = Date.parse(String(v));
    return isNaN(parsed) ? Number(v) : parsed;
  };

  // 3) UI/style files edited BEFORE the frontend-design skill was invoked
  //    (the skill was eventually used, but too late).
  const uiEditEvents = evs.filter(e =>
    (e.kind === 'file-edit' || e.kind === 'context-file') &&
    e.op !== 'read' &&
    isUiFile(e.path));
  const fdSkillEvents = evs.filter(e =>
    e.kind === 'skill' && /frontend-design/i.test(String(e.label ?? '')));
  if (uiEditEvents.length > 0 && fdSkillEvents.length > 0) {
    const earliestUiEdit = Math.min(...uiEditEvents.map(tsMs));
    const earliestFdSkill = Math.min(...fdSkillEvents.map(tsMs));
    if (earliestUiEdit < earliestFdSkill) {
      gaps.push({
        code: 'ui-design-too-late',
        severity: 'warn',
        message: 'Edited UI/style files before invoking frontend-design (skill came after the work).',
      });
    }
  }

  // 4) Same path read more than 8 times (re-read loop).
  const readCounts = new Map();
  for (const e of evs) {
    if (e.op === 'read' && e.path != null) {
      const p = String(e.path);
      readCounts.set(p, (readCounts.get(p) ?? 0) + 1);
    }
  }
  let worstPath = null;
  let worstCount = 0;
  for (const [p, n] of readCounts) {
    if (n > worstCount) { worstPath = p; worstCount = n; }
  }
  if (worstCount > 8) {
    gaps.push({
      code: 'reread-loop',
      severity: 'info',
      message: `Re-read ${worstPath} ${worstCount} times - read once or query graphify for orientation.`,
    });
  }

  // 5) Many edits with no verification-before-completion gate.
  if (editCount >= HEAVY_EDIT_THRESHOLD && !usedSkill(/verification-before-completion/i)) {
    gaps.push({
      code: 'done-without-verification',
      severity: 'warn',
      message: 'Many edits with no verification-before-completion gate.',
    });
  }

  return gaps;
}
