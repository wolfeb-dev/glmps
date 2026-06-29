// Sequential testing utilities: mixture SPRT + CUPED variance reduction

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function varPop(arr) {
  const m = mean(arr);
  return arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
}

function cov(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  return a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / a.length;
}

/**
 * Robbins mixture-SPRT for a difference of normal means (always-valid).
 * @param {number[]} samplesA
 * @param {number[]} samplesB
 * @param {{ alpha?: number, tau2?: number }} opts
 * @returns {{ decision: 'A'|'B'|'continue', llr: number, n: number }}
 */
export function msprt(samplesA, samplesB, { alpha = 0.05, tau2 = null } = {}) {
  const n = Math.min(samplesA.length, samplesB.length);
  if (n === 0) return { decision: 'continue', llr: 0, n: 0 };

  const A = samplesA.slice(0, n);
  const B = samplesB.slice(0, n);

  const meanA = mean(A);
  const meanB = mean(B);
  const dbar = meanB - meanA;

  let sigma2 = (varPop(A) + varPop(B)) / 2;
  if (sigma2 === 0) sigma2 = 1e-9;

  const t2 = tau2 !== null ? tau2 : sigma2;

  const llr =
    0.5 * Math.log(sigma2 / (sigma2 + n * t2)) +
    (n * n * t2 * dbar * dbar) / (2 * sigma2 * (sigma2 + n * t2));

  const bound = Math.log(1 / alpha);

  let decision;
  if (llr >= bound && dbar > 0) decision = 'B';
  else if (llr >= bound && dbar < 0) decision = 'A';
  else decision = 'continue';

  return { decision, llr, n };
}

/**
 * CUPED variance reduction.
 * @param {number[]} values
 * @param {number[]} covariate
 * @returns {number[]}
 */
export function cuped(values, covariate) {
  const vp = varPop(covariate);
  const theta = vp === 0 ? 0 : cov(values, covariate) / vp;
  const mc = mean(covariate);
  return values.map((y, i) => y - theta * (covariate[i] - mc));
}
