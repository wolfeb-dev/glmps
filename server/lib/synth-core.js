// server/lib/synth-core.js
// Pure, side-effect-free functions for the weekly capability synthesizer.
// Zero runtime deps; unit-tested by server/test/synth-core.test.js.

/**
 * selectStaleTranscripts(files, sinceMs)
 * files   - Array<{path:string, mtimeMs:number}>
 * sinceMs - number|null|0 — when falsy, all files are returned.
 * Returns  Array<{path,mtimeMs}> where mtimeMs > sinceMs.
 */
export function selectStaleTranscripts(files, sinceMs) {
  if (!sinceMs) return files.slice();
  return files.filter(f => f.mtimeMs > sinceMs);
}

const DEFAULT_INTERVAL = 7 * 24 * 3600 * 1000;

/**
 * dueForRun(lastRunMs, nowMs, intervalMs?)
 * Returns true when lastRunMs is null (never run) or elapsed >= intervalMs.
 */
export function dueForRun(lastRunMs, nowMs, intervalMs = DEFAULT_INTERVAL) {
  if (lastRunMs == null) return true;
  return (nowMs - lastRunMs) >= intervalMs;
}

/**
 * digest(allGaps)
 * allGaps - Array<{code:string,...}>
 * Returns Array<{code:string, count:number}> sorted descending by count.
 */
export function digest(allGaps) {
  const counts = new Map();
  for (const g of allGaps) {
    const c = String(g.code ?? '');
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);
}
