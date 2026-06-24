// server/lib/graph-status.js
// Pure function: derive display/staleness status for a single graphify graph.
// No I/O, no imports — fully testable in isolation.

/**
 * computeGraphStatus({ project, root, nodes, builtAtCommit, headCommit, mtimeMs })
 *
 * Returns:
 *   { project, root, nodes, rebuiltMs, builtAtCommit, headCommit, needsUpdate }
 *
 * needsUpdate is true only when BOTH commits are known AND they differ.
 * Conservative: unknown commit on either side => needsUpdate false.
 */
export function computeGraphStatus({ project, root, nodes, builtAtCommit, headCommit, mtimeMs }) {
  const needsUpdate = !!(builtAtCommit && headCommit && builtAtCommit !== headCommit);
  return {
    project,
    root,
    nodes: nodes | 0,
    rebuiltMs: mtimeMs ?? null,
    builtAtCommit: builtAtCommit ?? null,
    headCommit: headCommit ?? null,
    needsUpdate,
  };
}
