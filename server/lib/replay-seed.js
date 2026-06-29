/**
 * Stratified seed-from-history helper for the replay set.
 * @typedef {{ id: string, project: string|null, promptFile: null, baseline: object }} ReplayTask
 */

/**
 * @param {object[]} rows
 * @param {{ perClass?: number }} opts
 * @returns {ReplayTask[]}
 */
export function seedFromOutcomes(rows = [], { perClass = 4 } = {}) {
  const byClass = new Map();

  for (const row of rows) {
    if (
      row.committed !== true ||
      !row.verifier ||
      row.verifier.exitOk !== true ||
      row.revertedLater === true
    ) continue;

    const cls = row.taskClass;
    if (!byClass.has(cls)) byClass.set(cls, []);
    const bucket = byClass.get(cls);
    if (bucket.length < perClass) bucket.push(row);
  }

  const result = [];
  for (const bucket of byClass.values()) {
    for (const row of bucket) {
      result.push({ id: `replay-${row.id}`, project: row.project ?? null, promptFile: null, baseline: row });
    }
  }
  return result;
}
