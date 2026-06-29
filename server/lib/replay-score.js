/**
 * replay-score.js
 * Compares a produced OutcomeRow against a frozen baseline.
 */

const LOWER_IS_BETTER = [
  'turns',
  'tokens.in',
  'tokens.out',
  'wallClockMs.total',
  'toolErrors',
  'editApplyFailures',
  'churn',
  'contextUsageRatio',
];

const HIGHER_IS_BETTER = [
  'firstTry',
  'verifier.exitOk',
  'acceptance.met',
];

/**
 * Resolve a dot-path from an object, returning undefined if any segment is missing.
 * @param {object} obj
 * @param {string} path  e.g. 'tokens.in'
 * @returns {*}
 */
function getPath(obj, path) {
  return path.split('.').reduce((cur, key) => {
    if (cur == null) return undefined;
    return cur[key];
  }, obj);
}

/**
 * Coerce a value to a number for comparison.
 * Booleans become 1/0; other values pass through as-is.
 * @param {*} v
 * @returns {number|*}
 */
function coerce(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/**
 * Score a produced OutcomeRow against a baseline.
 *
 * @param {object} baseline
 * @param {object} produced
 * @returns {{ perMetric: Record<string, 'better'|'worse'|'same'|'na'>, regressed: string[], improved: string[] }}
 */
export function scoreReplay(baseline, produced) {
  const perMetric = {};

  function score(field, direction) {
    const rawA = getPath(baseline, field);
    const rawB = getPath(produced, field);

    if (rawA == null || rawB == null) {
      perMetric[field] = 'na';
      return;
    }

    const a = coerce(rawA);
    const b = coerce(rawB);

    if (direction === 'lower') {
      perMetric[field] = b < a ? 'better' : b > a ? 'worse' : 'same';
    } else {
      perMetric[field] = b > a ? 'better' : b < a ? 'worse' : 'same';
    }
  }

  for (const field of LOWER_IS_BETTER) score(field, 'lower');
  for (const field of HIGHER_IS_BETTER) score(field, 'higher');

  const regressed = Object.keys(perMetric).filter(f => perMetric[f] === 'worse');
  const improved  = Object.keys(perMetric).filter(f => perMetric[f] === 'better');

  return { perMetric, regressed, improved };
}
