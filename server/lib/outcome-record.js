/** @fileoverview Shared OutcomeRow schema helpers. Zero deps. */

const NESTED_GROUPS = new Set(['wallClockMs', 'tokens', 'verifier', 'acceptance']);

const TEMPLATE = Object.freeze({
  id: null, unit: null, ts: null, taskClass: null,
  turns: null,
  wallClockMs: Object.freeze({ total: null, modelThink: null, toolWait: null, rework: null }),
  tokens: Object.freeze({ in: null, out: null }),
  verifier: Object.freeze({ tests: null, lint: null, build: null, exitOk: null }),
  acceptance: Object.freeze({ stated: null, met: null }),
  revertedLater: null, criticDisagreement: null,
  toolCalls: null, toolErrors: null, editApplyFailures: null,
  churn: null, detours: null, approvalStalls: null,
  contextUsageRatio: null, retrievalHit: null, firstTry: null,
  committed: null, extra: Object.freeze({}),
});

/**
 * Returns a full OutcomeRow with all metric fields null, except keys present
 * in `partial`, which override. Nested groups in `partial` are applied via a
 * one-level deep merge so sibling keys are preserved.
 *
 * @param {Partial<OutcomeRow>} partial
 * @returns {OutcomeRow}
 */
export function emptyOutcome(partial = {}) {
  const row = structuredClone(TEMPLATE);
  for (const [key, val] of Object.entries(partial)) {
    if (NESTED_GROUPS.has(key) && val !== null && typeof val === 'object') {
      row[key] = { ...row[key], ...val };
    } else {
      row[key] = val;
    }
  }
  return row;
}

/**
 * Returns a new OutcomeRow merging `patch` onto `base`. Nested groups are
 * deep-merged one level (sibling keys preserved); scalar fields are replaced.
 * Never mutates `base`.
 *
 * @param {OutcomeRow} base
 * @param {Partial<OutcomeRow>} patch
 * @returns {OutcomeRow}
 */
export function mergeOutcome(base, patch) {
  const row = structuredClone(base);
  for (const [key, val] of Object.entries(patch)) {
    if (NESTED_GROUPS.has(key) && val !== null && typeof val === 'object') {
      row[key] = { ...row[key], ...val };
    } else {
      row[key] = val;
    }
  }
  return row;
}
