// server/lib/capability-feed-core.js
// Pure, testable core for the per-session capability feeder.
// No fs, no process — takes everything as args for unit testability.
import { detectGaps } from './gap-detect.js';
import { scanTranscriptForGaps } from './transcript-gaps.js';

// Matches explicit, conservative deferral language only.
// Conservative: we only fire on clear, unambiguous deferral signals.
const DEFERRAL_RE = /\b(deferr?(ed|ing)?|skip(ping)? (this|that|it|for now)|not now|do (this|it|that) later|leave (this|that|it) for later|backlog (this|it)|file a ticket|won.?t do (this|it) now)\b/i;

// Code extensions that count as "code changed" for triggering a graphify refresh.
const CODE_EXT_RE = /\.(js|mjs|cjs|ts|py|cs)$/i;

/**
 * feedFromTranscript({ events, lines, skillsUsed, project, sessionId, lastText })
 *
 * @param {object[]} events     - Shared event shape objects from extractClaudeEvents
 * @param {string[]} lines      - Raw JSONL transcript lines (for scanTranscriptForGaps)
 * @param {string[]} skillsUsed - Skills already recorded in the index for this session
 * @param {string}   project    - Project name (cwd basename)
 * @param {string}   sessionId  - Session identifier
 * @param {string}   lastText   - Last assistant/user text block from the transcript
 * @param {string[]} backtestProjects - Opt-in project substrings (config) that arm
 *                                      the backtest-result-without-skeptic gap; empty = off
 *
 * @returns {{ gaps: object[], ticket: object|null, codeChanged: boolean }}
 */
export function feedFromTranscript({
  events = [],
  lines = [],
  skillsUsed = [],
  project = '',
  sessionId = '',
  lastText = '',
  backtestProjects = [],
} = {}) {
  // --- gaps: merge detectGaps + scanTranscriptForGaps, dedup by code (first wins) ---
  const fromEvents = detectGaps(events, skillsUsed);
  const fromLines = scanTranscriptForGaps(lines, { project, backtestProjects });

  const seen = new Set();
  const gaps = [];
  for (const g of [...fromEvents, ...fromLines]) {
    if (seen.has(g.code)) continue;
    seen.add(g.code);
    gaps.push(g);
  }

  // --- ticket: conservative — explicit deferral marker only ---
  let ticket = null;
  if (typeof lastText === 'string' && lastText.length > 0) {
    if (DEFERRAL_RE.test(lastText)) {
      // Title: first 80 chars of lastText (the deferred sentence)
      const title = lastText.slice(0, 80);
      ticket = { source: 'deferred', title, prompt: lastText };
    }
  }

  // --- codeChanged: any non-read file-edit whose path is a code file ---
  const codeChanged = (Array.isArray(events) ? events : []).some(
    e => e.kind === 'file-edit' && e.op !== 'read' && CODE_EXT_RE.test(String(e.path ?? '')),
  );

  return { gaps, ticket, codeChanged };
}
