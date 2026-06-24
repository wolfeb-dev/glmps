// server/lib/loop-stage.js
// Pure, zero-dependency ESM module.
// Classifies the current loop stage (1–5) from a session's event stream.

const tsVal = t => typeof t === 'string' ? (Date.parse(t) || 0) : (t ?? 0);

const ACTIVE_GATE_RESULTS = new Set(['running', 'block', 'yield']);

/**
 * Determine which of the 5 standardised loop stages a session is in.
 *
 * @param {object[]} events   - Ordered (or unordered) session events.
 * @param {string[]} guiding  - Optional capability-guidance hints (enrich detail only).
 * @param {string[]} gaps     - Optional captured gaps (enrich detail only).
 * @returns {{ stage: number, key: string, status: 'active'|'done', detail: string }}
 */
export function loopStage(events = [], guiding = [], gaps = []) {
  // Work on a ts-sorted copy so "latest wins" logic is position-based.
  const sorted = [...events].sort((a, b) => tsVal(a.ts) - tsVal(b.ts));

  // ── classify each event into a signal bucket ──────────────────────────────
  // We only care about the *latest* occurrence of each signal type.
  let lastSkillAgent  = -Infinity; // ts of most recent skill or agent event
  let lastEdit        = -Infinity; // ts of most recent file-edit or non-read context-file
  let lastAntigravity = -Infinity; // ts of most recent antigravity event
  let lastGate        = null;       // the most recent done-gate event object
  let lastAgentName   = null;       // name of the most recent kind:'agent' dispatch
  let lastAgentTs     = -Infinity;  // ts of that agent event

  for (const e of sorted) {
    const t = tsVal(e.ts);
    switch (e.kind) {
      case 'skill':
        if (t > lastSkillAgent) lastSkillAgent = t;
        break;
      case 'agent':
        if (t > lastSkillAgent) lastSkillAgent = t;
        if (t >= lastAgentTs) { lastAgentTs = t; lastAgentName = agentNameFromLabel(e.label); }
        break;
      case 'file-edit':
        if (t > lastEdit) lastEdit = t;
        break;
      case 'context-file':
        // Only op !== 'read' (and op present) counts as an edit signal
        if (e.op && e.op !== 'read') {
          if (t > lastEdit) lastEdit = t;
        }
        break;
      case 'antigravity':
        if (t > lastAntigravity) lastAntigravity = t;
        break;
      case 'done-gate':
        if (!lastGate || t >= tsVal(lastGate.ts)) lastGate = e;
        break;
    }
  }

  // The active sub-agent: only when an agent dispatch is the most recent
  // skill/agent signal (a later skill or no agent at all → null).
  const agent = (lastAgentTs > -Infinity && lastAgentTs >= lastSkillAgent) ? lastAgentName : null;

  // ── rule evaluation (rules checked in priority order, first match wins) ───

  // Rule 1: gate passed AND no later edit → stage 5 learning
  if (lastGate && lastGate.result === 'pass' && lastEdit <= tsVal(lastGate.ts)) {
    return result(5, 'learning', 'done', 'gate passed; guard applies to next session', gaps, agent);
  }

  // Rule 2: any done-gate present as latest gate signal
  if (lastGate) {
    const gateTs = tsVal(lastGate.ts);
    // But if there's a later edit (work resumed), let rule 4 handle it
    if (lastEdit <= gateTs) {
      const active = !lastGate.result || !['pass', 'skipped'].includes(lastGate.result);
      const status = active ? 'active' : 'done';
      const detail = `gate ${lastGate.result ?? 'unknown'}: ${lastGate.label ?? 'check'}`;
      return result(4, 'gate', status, detail, gaps, agent);
    }
  }

  // Rule 3: antigravity after last edit, and no done-gate after it
  if (lastAntigravity > -Infinity && lastAntigravity >= lastEdit) {
    const gateAfterAgy = lastGate && tsVal(lastGate.ts) > lastAntigravity;
    if (!gateAfterAgy) {
      return result(3, 'adversarial', 'active', 'adversarial dispatch sent', gaps, agent);
    }
  }

  // Rule 4: file-edit (or non-read context-file) after last skill/agent
  if (lastEdit > -Infinity && lastEdit > lastSkillAgent) {
    const editCount = sorted.filter(e =>
      e.kind === 'file-edit' ||
      (e.kind === 'context-file' && e.op && e.op !== 'read')
    ).length;
    const detail = editCount === 1 ? '1 file edited' : `${editCount} files edited`;
    return result(2, 'execute', 'active', detail, gaps, agent);
  }

  // Rule 5: default — orchestrate (capability scan + skill/agent select, merged)
  const haveSkillAgent = lastSkillAgent > -Infinity;
  const detail = haveSkillAgent
    ? 'skill/agent selected'
    : guiding.length
      ? 'capability scan in progress'
      : 'awaiting capability scan';
  return result(1, 'orchestrate', 'active', detail, gaps, agent);
}

// ── internal helpers ─────────────────────────────────────────────────────────

function result(stage, key, status, detail, gaps, agent = null) {
  const enriched = gaps.length
    ? `${detail}; gaps: ${gaps.join(', ')}`
    : detail;
  return { stage, key, status, detail: enriched, agent };
}

// "general-purpose: Implement Task 2" -> "general-purpose"; null if unusable.
function agentNameFromLabel(label) {
  if (typeof label !== 'string') return null;
  const name = label.split(':')[0].trim();
  return name || null;
}
