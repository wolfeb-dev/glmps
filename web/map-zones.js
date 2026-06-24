// web/map-zones.js
// PURE helpers — NO DOM access. Safe to import in Node for unit tests.
// Directory-driven grouping + labeling + color resolution for the Map view.
// Each graph node is a symbol carrying a `source_file`; the Map groups nodes
// into one rectangle per directory (the dirname of source_file).

/**
 * Directory of a graph-root-relative source_file.
 * 'lib/adapters/agy-cli.js' -> 'lib/adapters'; 'server.js' -> '.'.
 * @param {string} sourceFile
 * @returns {string}
 */
export function dirOf(sourceFile) {
  const s = String(sourceFile ?? '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i === -1 ? '.' : (s.slice(0, i) || '.');
}

/**
 * Group nodes by their directory.
 * @param {Array} nodes - graph.nodes
 * @returns {Map<string, Array>} dir -> nodes[]
 */
export function groupByDirectory(nodes) {
  const byDir = new Map();
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const d = dirOf(n.source_file);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(n);
  }
  return byDir;
}

/**
 * Truncated display label for a directory rectangle.
 * Keeps the tail (most specific segments) and prefixes '…' when over maxLen.
 * @param {string} dir
 * @param {number} maxLen
 * @returns {{text: string, full: string}}
 */
export function dirDisplayLabel(dir, maxLen = 28) {
  const full = dir === '.' ? '(root)' : String(dir ?? '');
  if (full.length <= maxLen) return { text: full, full };
  return { text: '…' + full.slice(full.length - (maxLen - 1)), full };
}

/**
 * Resolve a directory's zone-family color via the injected zoneColor fn.
 * Zone = most frequent `zone` among the directory's nodes (ties: first seen,
 * since Map preserves insertion order). Protected = any node protected/prod.
 * @param {Array} dirNodes
 * @param {(zone: string, isProtected: boolean) => object} zoneColorFn
 * @returns {object} the color descriptor from zoneColorFn
 */
export function dirZoneColor(dirNodes, zoneColorFn) {
  const nodes = Array.isArray(dirNodes) ? dirNodes : [];
  const counts = new Map();
  let isProtected = false;
  for (const n of nodes) {
    if (n.protected || n.env === 'prod') isProtected = true;
    const z = n.zone ?? 'unknown';
    counts.set(z, (counts.get(z) ?? 0) + 1);
  }
  let bestZone = 'unknown', bestCount = -1;
  for (const [z, c] of counts) {
    if (c > bestCount) { bestZone = z; bestCount = c; }
  }
  return zoneColorFn(bestZone, isProtected);
}
