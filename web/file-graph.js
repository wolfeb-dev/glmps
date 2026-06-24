// web/file-graph.js
// PURE helpers — NO DOM access. Safe to import in Node for unit tests.
// Collapses a symbol-level code graph into a file-level graph (one node per
// file) and lays file pills out in wrapping rows. Mirrors web/lit-match.js /
// web/map-zones.js (pure modules imported by node tests).

import { dirOf } from './map-zones.js';

/**
 * Collapse a symbol-level graph to one node per file.
 * @param {{nodes?: Array, links?: Array}} graph
 * @returns {{nodes: Array, links: Array}}
 */
export function aggregateToFiles(graph) {
  const symNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const symLinks = Array.isArray(graph?.links) ? graph.links : [];

  const fileOf = new Map();   // symbolId -> source_file
  const byFile = new Map();   // source_file -> { symbols: [], commCounts: Map }
  for (const n of symNodes) {
    const sf = n.source_file;
    if (!sf) continue;
    fileOf.set(n.id, sf);
    if (!byFile.has(sf)) byFile.set(sf, { symbols: [], commCounts: new Map() });
    const f = byFile.get(sf);
    f.symbols.push(n);
    const c = n.community ?? 0;
    f.commCounts.set(c, (f.commCounts.get(c) ?? 0) + 1);
  }

  // Cross-file directed links: dedupe by (source-file, target-file), weight = #symbol links.
  const linkW = new Map();          // "src tgt" -> weight
  const neighbors = new Map();      // file -> Set(other file)
  const addNeighbor = (a, b) => { if (!neighbors.has(a)) neighbors.set(a, new Set()); neighbors.get(a).add(b); };
  for (const l of symLinks) {
    const a = fileOf.get(l.source), b = fileOf.get(l.target);
    if (!a || !b || a === b) continue;
    const key = a + '\x00' + b;
    linkW.set(key, (linkW.get(key) ?? 0) + 1);
    addNeighbor(a, b);
    addNeighbor(b, a);
  }

  const nodes = [];
  for (const [sf, f] of byFile) {
    let bestC = 0, bestN = -1;
    for (const [c, n] of f.commCounts) if (n > bestN) { bestN = n; bestC = c; }
    const s0 = f.symbols[0] ?? {};
    nodes.push({
      id: sf,
      label: sf.split('/').pop(),
      source_file: sf,
      dir: dirOf(sf),
      zone: s0.zone,
      env: s0.env,
      protected: f.symbols.some(s => s.protected || s.env === 'prod'),
      community: bestC,
      symbolCount: f.symbols.length,
      degree: neighbors.get(sf)?.size ?? 0,
      god: false,
    });
  }

  // god = high file-level degree (top ~3% by degree, and degree > 2) — same cut as loadGraph.
  const degsDesc = nodes.map(n => n.degree).sort((a, b) => b - a);
  const cut = degsDesc.length ? degsDesc[Math.min(degsDesc.length - 1, Math.floor(degsDesc.length * 0.03))] : 0;
  for (const n of nodes) n.god = n.degree >= cut && n.degree > 2;

  const links = [...linkW.entries()].map(([key, weight]) => {
    const [source, target] = key.split('\x00');
    return { source, target, weight };
  });

  return { nodes, links };
}

/**
 * Lay file-pill labels out in wrapping rows. Pure geometry — positions are
 * relative to (0,0) of the content area. Long labels truncate with '…'.
 * @param {string[]} labels
 * @param {object} [opts]
 * @returns {{pills: Array<{x:number,y:number,w:number,h:number,text:string,full:string}>, contentW:number, contentH:number}}
 */
export function layoutPills(labels, opts = {}) {
  const {
    charW = 6.2, pillH = 18, padX = 7,
    rowGap = 7, colGap = 7, maxPillW = 180, maxContentW = 600,
  } = opts;
  const list = Array.isArray(labels) ? labels : [];
  const maxChars = Math.max(1, Math.floor((maxPillW - padX * 2) / charW));

  const pills = [];
  let x = 0, y = 0, contentW = 0;
  for (const full of list) {
    const s = String(full ?? '');
    const text = s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
    const w = Math.min(maxPillW, Math.ceil(text.length * charW) + padX * 2);
    if (x > 0 && x + w > maxContentW) { x = 0; y += pillH + rowGap; } // wrap
    pills.push({ x, y, w, h: pillH, text, full: s });
    x += w + colGap;
    contentW = Math.max(contentW, x - colGap);
  }
  const contentH = list.length ? y + pillH : 0;
  return { pills, contentW, contentH };
}
