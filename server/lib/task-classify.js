// server/lib/task-classify.js
// Heuristic task classifier — zero deps, ESM.

const KEYWORDS = {
  debug:    ['fix', 'bug', 'broken', 'failing', 'error', 'crash', 'regression'],
  feature:  ['add', 'build', 'implement', 'create', 'new feature', 'support'],
  refactor: ['refactor', 'clean up', 'cleanup', 'simplify', 'rename', 'restructure', 'extract'],
  research: ['research', 'investigate', 'compare', 'evaluate', 'explore', 'find out', 'what is'],
  docs:     ['docs', 'readme', 'document', 'changelog'],
  ops:      ['deploy', 'release', 'ci', 'pipeline', 'install', 'config', 'env'],
  review:   ['review', 'audit', 'check', 'assess'],
};

const isTestFile   = (p) => p.includes('.test.') || p.includes('/test');
const isMdFile     = (p) => p.endsWith('.md');
const isSourceFile = (p) => !isTestFile(p) && !isMdFile(p);

/**
 * @param {{ firstPrompt?: string, filesTouched?: string[] }} opts
 * @returns {{ taskClass: string, confidence: number }}
 */
export function classifyTask({ firstPrompt = '', filesTouched = [] } = {}) {
  const prompt = firstPrompt.toLowerCase();

  // --- keyword scores (1 pt per matched keyword) ---
  const scores = {};
  for (const [cls, words] of Object.entries(KEYWORDS)) {
    scores[cls] = words.reduce((n, w) => n + (prompt.includes(w) ? 1 : 0), 0);
  }

  // --- file-signal boosts ---

  // debug: amplify when a test file is in scope
  if (filesTouched.some(isTestFile)) {
    scores.debug *= 1.5;
  }

  // feature: amplify when non-test source files are touched
  if (filesTouched.some(isSourceFile)) {
    scores.feature *= 1.5;
  }

  // research: amplify when nothing was touched (pure exploration), only if signal exists
  if (filesTouched.length === 0 && scores.research > 0) {
    scores.research *= 1.5;
  }

  // docs: strong amplify when every touched file is markdown
  if (filesTouched.length > 0 && filesTouched.every(isMdFile)) {
    scores.docs *= 2;
  }

  // --- argmax + confidence ---
  const sum = Object.values(scores).reduce((a, b) => a + b, 0);
  if (sum === 0) return { taskClass: 'other', confidence: 0 };

  const maxScore = Math.max(...Object.values(scores));
  const winners  = Object.entries(scores).filter(([, s]) => s === maxScore);

  // ties -> 'other'
  if (winners.length !== 1) {
    return { taskClass: 'other', confidence: maxScore / sum };
  }

  return { taskClass: winners[0][0], confidence: maxScore / sum };
}
