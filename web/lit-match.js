// web/lit-match.js
// PURE helpers — NO DOM access. Safe to import in Node for unit tests.
// Determines which graph nodes are "lit" (currently being edited) given
// a session's events and a set of graph nodes.
//
// Matching rule:
//   A node is lit iff its source_file is a FULL path-suffix of some edit path
//   on a '/' boundary:
//     editPath === source_file  OR  editPath.endsWith('/' + source_file)
//   This matches `lib/x.js` (source_file) against an edit of
//   `D:/glmps/server/lib/x.js` while NOT matching `web/lib/x.js`
//   edits to an unrelated `lib/x.js` node unless the full suffix matches.

/**
 * Given a session's events and a graph's nodes, return the set of lit node ids.
 *
 * @param {Array}  events    - session.events array (may be undefined/null)
 * @param {Array}  nodes     - graph.nodes array (may be undefined/null)
 * @returns {Set<string>}    - set of node.id values that are lit
 */
export function computeLitNodeIds(events, nodes) {
  const evts = Array.isArray(events) ? events : [];
  const nds  = Array.isArray(nodes)  ? nodes  : [];

  // Collect normalized edit paths (forward slashes only)
  const editPaths = [];
  for (const e of evts) {
    if (e.kind !== 'file-edit') continue;
    const p = e.path ?? '';
    if (!p) continue;
    editPaths.push(p.replace(/\\/g, '/'));
  }

  if (editPaths.length === 0) return new Set();

  const lit = new Set();
  for (const node of nds) {
    const sf = node.source_file;
    if (!sf) continue;
    // suffix match on '/' boundary
    if (isLitPath(editPaths, sf)) {
      lit.add(node.id);
    }
  }
  return lit;
}

/**
 * Return true iff source_file (graph-root-relative, e.g. 'lib/x.js') is a
 * full path-suffix of any edit path in editPaths (forward-slash normalised).
 *
 * @param {string[]} editPaths - forward-slash normalised absolute/relative edit paths
 * @param {string}   sourceFile - graph-root-relative path, e.g. 'lib/paths.js'
 * @returns {boolean}
 */
export function isLitPath(editPaths, sourceFile) {
  if (!sourceFile) return false;
  for (const ep of editPaths) {
    if (ep === sourceFile || ep.endsWith('/' + sourceFile)) return true;
  }
  return false;
}
