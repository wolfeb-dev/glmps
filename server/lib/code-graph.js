// server/lib/code-graph.js
import fs from 'node:fs';
import { classifyPath, DEFAULT_ZONE_CONFIG } from './zones.js';

export function loadGraph(graphPath, { projectRoot, config = DEFAULT_ZONE_CONFIG, headCommit } = {}) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(graphPath, 'utf8')); } catch { return null; }
  const links = Array.isArray(raw.links) ? raw.links : [];
  const deg = new Map();
  for (const l of links) {
    deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
    deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
  }
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map(n => {
    const z = classifyPath(n.source_file ?? '', { relative: true, config });
    return { ...n, zone: z.zone, env: z.env, protected: z.protected, degree: deg.get(n.id) ?? 0 };
  });
  const degsDesc = nodes.map(n => n.degree).sort((a, b) => b - a);
  const cut = degsDesc.length ? degsDesc[Math.min(degsDesc.length - 1, Math.floor(degsDesc.length * 0.03))] : 0;
  for (const n of nodes) n.god = n.degree >= cut && n.degree > 2;
  const builtAtCommit = raw.built_at_commit ?? null;
  let stale = null;
  if (headCommit && builtAtCommit) {
    const a = String(headCommit), b = String(builtAtCommit);
    stale = !(a.startsWith(b) || b.startsWith(a));
  }
  return { nodes, links, communities: new Set(nodes.map(n => n.community)).size, builtAtCommit, stale };
}
