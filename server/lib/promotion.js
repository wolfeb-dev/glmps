/**
 * Pareto-dominance check and champion/challenger promotion evaluator.
 */

/**
 * Compare challenger vs champion for a single field.
 * Returns 'better' | 'worse' | 'same' | 'na'.
 */
function compareField(chalVal, champVal, direction) {
  if (!Number.isFinite(chalVal) || !Number.isFinite(champVal)) return 'na';
  if (direction === 'lower') {
    if (chalVal < champVal) return 'better';
    if (chalVal > champVal) return 'worse';
    return 'same';
  }
  // 'higher'
  if (chalVal > champVal) return 'better';
  if (chalVal < champVal) return 'worse';
  return 'same';
}

/**
 * paretoDominates(challenger, champion, directions) -> boolean
 *
 * Returns true iff challenger is NOT worse on any compared field AND strictly
 * better on at least one. Fields where either side is null/missing/non-finite
 * are ignored.
 *
 * @param {Record<string,number|null|undefined>} challenger
 * @param {Record<string,number|null|undefined>} champion
 * @param {Record<string,'lower'|'higher'>} directions
 */
export function paretoDominates(challenger, champion, directions) {
  let anyBetter = false;
  for (const [field, dir] of Object.entries(directions)) {
    const result = compareField(
      challenger[field] ?? null,
      champion[field] ?? null,
      dir
    );
    if (result === 'worse') return false;
    if (result === 'better') anyBetter = true;
  }
  return anyBetter;
}

/**
 * evaluatePromotion({ champion, challenger, directions })
 * -> { verdict: 'promote'|'hold'|'reject', rationale: string, perMetric: Record<string,'better'|'worse'|'same'|'na'> }
 *
 * - Any 'worse' field -> 'reject' (regression blocks promotion).
 * - At least one 'better' (no 'worse') -> 'promote'.
 * - Otherwise -> 'hold'.
 */
export function evaluatePromotion({ champion, challenger, directions }) {
  const perMetric = {};
  const worse = [];
  const better = [];

  for (const [field, dir] of Object.entries(directions)) {
    const result = compareField(
      challenger[field] ?? null,
      champion[field] ?? null,
      dir
    );
    perMetric[field] = result;
    if (result === 'worse') worse.push(field);
    if (result === 'better') better.push(field);
  }

  if (worse.length > 0) {
    return {
      verdict: 'reject',
      rationale: `regression on: ${worse.join(', ')}`,
      perMetric,
    };
  }
  if (better.length > 0) {
    return {
      verdict: 'promote',
      rationale: `improvement on: ${better.join(', ')}`,
      perMetric,
    };
  }
  return {
    verdict: 'hold',
    rationale: 'no measurable improvement',
    perMetric,
  };
}
