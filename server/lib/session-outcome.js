/**
 * session-outcome.js
 * Session-outcome orchestrator. Composes outcome-record, task-classify,
 * outcome-metrics, verifier-signals, and outcome-store into a single API.
 * Zero deps, Node 18+ ESM.
 */

import { emptyOutcome, mergeOutcome } from './outcome-record.js';
import { classifyTask } from './task-classify.js';
import { computeMetrics } from './outcome-metrics.js';
import { verifierFromEvents, acceptanceCoverage } from './verifier-signals.js';
import { appendOutcome, readOutcomes, updateOutcome } from './outcome-store.js';

/**
 * @param {{
 *   sessionId: string,
 *   events?: object[],
 *   usage?: object|null,
 *   firstPrompt?: string,
 *   filesTouched?: string[],
 *   acceptanceText?: string,
 * }} opts
 * @returns {object} OutcomeRow
 */
export function buildSessionOutcome({
  sessionId,
  events = [],
  usage = null,
  firstPrompt = '',
  filesTouched = [],
  acceptanceText = '',
} = {}) {
  const id = `session-${sessionId}`;
  const unit = 'session';

  // ts = last event ts or null
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const ts = sorted.length > 0 ? sorted[sorted.length - 1].ts : null;

  const { taskClass } = classifyTask({ firstPrompt, filesTouched });

  let row = emptyOutcome({ id, unit, ts, taskClass });
  row = mergeOutcome(row, computeMetrics({ events, usage }));

  row.verifier = verifierFromEvents(events);
  row.acceptance = acceptanceCoverage(acceptanceText, events);

  row.committed = events.some(e =>
    /commit/i.test(String(e.label ?? e.kind ?? ''))
  ) ? true : null;

  return row;
}

/**
 * @param {string} stateDir
 * @param {object} input  — same shape as buildSessionOutcome opts
 * @returns {{ row: object, appended: boolean }}
 */
export function finalizeSession(stateDir, input) {
  const row = buildSessionOutcome(input);
  const existing = readOutcomes(stateDir).find(r => r.id === row.id);
  if (existing) {
    return { row: existing, appended: false };
  }
  appendOutcome(stateDir, row);
  return { row, appended: true };
}

/**
 * For each gitEvent that reverts/amends a prior session commit, mark
 * revertedLater:true on the matching session row via updateOutcome.
 *
 * @param {string} stateDir
 * @param {object[]} gitEvents
 * @returns {number} count of rows updated
 */
export function backfillReverts(stateDir, gitEvents = []) {
  let count = 0;
  try {
    for (const ev of gitEvents) {
      try {
        const label = String(ev.label ?? ev.kind ?? '');
        const isRevertOrAmend = /revert|amend/i.test(label);
        if (!isRevertOrAmend) continue;

        // Determine target row id
        let targetId = null;
        if (ev.sessionId) {
          targetId = `session-${ev.sessionId}`;
        } else if (ev.targetId) {
          targetId = ev.targetId;
        }
        if (!targetId) continue;

        const { row } = updateOutcome(stateDir, targetId, { revertedLater: true });
        if (row) count++;
      } catch {
        // defensive: skip malformed events
      }
    }
  } catch {
    // defensive: no throw on outer errors
  }
  return count;
}
