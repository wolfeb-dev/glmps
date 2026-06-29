/**
 * outcome-metrics.js
 * Pure session-metrics computation + summary aggregation.
 * Zero dependencies, Node 18+ ESM.
 */

/**
 * @param {{ events?: Array<{kind:string,ts:number,[k:string]:any}>, usage?: {input?:number,output?:number,ctxUsedPct?:number}|null }} opts
 * @returns {object} Partial<OutcomeRow>
 */
export function computeMetrics({ events = [], usage = null } = {}) {
  // Sort ascending by ts
  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  // turns: count prompt events
  const turns = sorted.filter(e => e.kind === 'prompt').length;

  // wallClockMs.total
  let total = null;
  if (sorted.length >= 2) {
    total = sorted[sorted.length - 1].ts - sorted[0].ts;
  }

  // wallClockMs.toolWait: for each tool event, find the NEXT tool_result after it
  const toolEvents = sorted.reduce((acc, e, i) => {
    if (e.kind === 'tool') acc.push(i);
    return acc;
  }, []);

  let toolWait = null;
  if (toolEvents.length > 0) {
    let sum = 0;
    for (const toolIdx of toolEvents) {
      const toolTs = sorted[toolIdx].ts;
      // find first tool_result after this index
      const resultEvent = sorted.slice(toolIdx + 1).find(e => e.kind === 'tool_result');
      if (resultEvent != null) {
        sum += resultEvent.ts - toolTs;
      }
    }
    toolWait = sum;
  }

  // toolCalls + toolErrors
  const toolCalls = sorted.filter(e => e.kind === 'tool').length;
  const toolErrors = sorted.filter(e => e.kind === 'tool_result' && e.error === true).length;

  // tokens
  const tokensIn = usage?.input ?? null;
  const tokensOut = usage?.output ?? null;

  // contextUsageRatio
  const contextUsageRatio = (typeof usage?.ctxUsedPct === 'number') ? usage.ctxUsedPct / 100 : null;

  // firstTry
  const firstTry = (turns != null) ? (turns <= 1) : null;

  return {
    turns,
    wallClockMs: {
      total,
      modelThink: null,
      toolWait,
      rework: null,
    },
    tokens: {
      in: tokensIn,
      out: tokensOut,
    },
    toolCalls,
    toolErrors,
    contextUsageRatio,
    firstTry,
  };
}

/**
 * @param {Array<object>} rows
 * @returns {{ byClass: { [taskClass: string]: { n: number, medianTurns: number|null, verifierPassRate: number|null, firstTryRate: number|null, medianContextUsage: number|null } } }}
 */
export function summarizeOutcomes(rows = []) {
  const groups = {};

  for (const row of rows) {
    const cls = row.taskClass ?? '__unknown__';
    if (!groups[cls]) groups[cls] = [];
    groups[cls].push(row);
  }

  const byClass = {};
  for (const [cls, groupRows] of Object.entries(groups)) {
    const n = groupRows.length;

    // medianTurns: ignore nulls
    const turnValues = groupRows.map(r => r.turns).filter(v => v != null);
    const medianTurns = median(turnValues);

    // verifierPassRate: fraction where verifier.exitOk===true among rows where exitOk is non-null
    const verifierRows = groupRows.filter(r => r.verifier?.exitOk != null);
    const verifierPassRate = verifierRows.length > 0
      ? verifierRows.filter(r => r.verifier.exitOk === true).length / verifierRows.length
      : null;

    // firstTryRate: fraction with firstTry===true among non-null
    const firstTryRows = groupRows.filter(r => r.firstTry != null);
    const firstTryRate = firstTryRows.length > 0
      ? firstTryRows.filter(r => r.firstTry === true).length / firstTryRows.length
      : null;

    // medianContextUsage: ignore nulls
    const ctxValues = groupRows.map(r => r.contextUsageRatio).filter(v => v != null);
    const medianContextUsage = median(ctxValues);

    byClass[cls] = { n, medianTurns, verifierPassRate, firstTryRate, medianContextUsage };
  }

  return { byClass };
}

/**
 * Compute median of a numeric array. Returns null for empty arrays.
 * @param {number[]} arr
 * @returns {number|null}
 */
function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
