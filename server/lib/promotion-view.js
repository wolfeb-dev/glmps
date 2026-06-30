/**
 * promotion-view.js
 * Builds the champion/challenger promotion view for the Experiments page:
 * aggregate outcome rows by `unit`, pick a champion (incumbent) and challenger,
 * and run the Pareto promotion evaluator over their aggregate metrics.
 * Pure; zero deps beyond promotion.js.
 */
import { evaluatePromotion } from './promotion.js';

// Which direction is "better" for each aggregate metric the verdict compares.
export const DIRECTIONS = {
  medianTurns: 'lower',
  verifierPassRate: 'higher',
  firstTryRate: 'higher',
  medianContextUsage: 'lower',
};

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function metricsFor(rows) {
  const turns = rows.map(r => r.turns).filter(v => v != null);
  const vr = rows.filter(r => r.verifier?.exitOk != null);
  const ft = rows.filter(r => r.firstTry != null);
  const ctx = rows.map(r => r.contextUsageRatio).filter(v => v != null);
  return {
    medianTurns: median(turns),
    verifierPassRate: vr.length ? vr.filter(r => r.verifier.exitOk === true).length / vr.length : null,
    firstTryRate: ft.length ? ft.filter(r => r.firstTry === true).length / ft.length : null,
    medianContextUsage: median(ctx),
  };
}

/**
 * Aggregate outcome rows by `unit` (the version/cohort axis).
 * @returns {Record<string, {unit, n, medianTurns, verifierPassRate, firstTryRate, medianContextUsage}>}
 */
export function aggregateByUnit(rows = []) {
  const groups = {};
  for (const row of rows) {
    const u = row.unit ?? '(unversioned)';
    (groups[u] ??= []).push(row);
  }
  const byUnit = {};
  for (const [u, gr] of Object.entries(groups)) {
    byUnit[u] = { unit: u, n: gr.length, ...metricsFor(gr) };
  }
  return byUnit;
}

/**
 * promotionView(rows, { champion, challenger }) -> view object.
 * Defaults: champion = the unit with the MOST outcomes (the incumbent with the
 * longest track record); challenger = the next unit by outcome count. Either can
 * be overridden by passing an explicit unit id. Needs >= 2 units to compare.
 */
export function promotionView(rows = [], { champion, challenger } = {}) {
  const byUnit = aggregateByUnit(rows);
  const units = Object.values(byUnit).sort((a, b) => b.n - a.n);
  if (units.length < 2) {
    return {
      available: false,
      reason: units.length === 0 ? 'no outcome records yet' : 'need at least two units to compare',
      units,
      directions: DIRECTIONS,
    };
  }
  const champUnit = (champion && byUnit[champion]) ? byUnit[champion] : units[0];
  const chalUnit = (challenger && byUnit[challenger]) ? byUnit[challenger]
    : units.find(u => u.unit !== champUnit.unit);
  const ev = evaluatePromotion({ champion: champUnit, challenger: chalUnit, directions: DIRECTIONS });
  return {
    available: true,
    champion: champUnit,
    challenger: chalUnit,
    directions: DIRECTIONS,
    verdict: ev.verdict,
    rationale: ev.rationale,
    perMetric: ev.perMetric,
    units,
  };
}
