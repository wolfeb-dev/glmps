// server/lib/zones.js
// Pure path -> zone/env classification + per-session scope. No deps, no graph.
// Powers the dashboard scope strip (edit paths only) and the Map's node tagging.
import path from 'node:path';

export const DEFAULT_ZONE_CONFIG = {
  // Longest prefix wins. Prefixes are matched against the path RELATIVE to the
  // project root, separators normalized to '/'.
  prefixes: [
    { prefix: 'web/',         zone: 'web',         env: 'dev' },
    { prefix: 'server/test/', zone: 'server/test', env: 'dev' },
    { prefix: 'server/lib/',  zone: 'server/lib',  env: 'dev' },
    { prefix: 'server/',      zone: 'server',      env: 'dev' },
    { prefix: 'lib/',         zone: 'lib',         env: 'dev' }, // graph-relative (root = server/)
    { prefix: 'taps/',        zone: 'taps',        env: 'dev' },
    { prefix: 'companion/',   zone: 'companion',   env: 'dev' },
  ],
  // Any path dir-segment equal to one of these (or matching '*-prod') => prod.
  protectedSegments: ['prod'],
  // Absolute path roots that are protected (e.g. a separate prod repo).
  protectedRoots: [],
  // Orthogonal three-tier asset model (absolute-root prefix lists).
  tierRoots: { artifact: [], brain: [], ephemeral: [] },
  mutationPolicy: { artifact: 'gate', brain: 'versioned', ephemeral: 'readonly' },
};

// Return a copy of `config` with `extraRoots` appended to protectedRoots (deduped),
// preserving every other key. Lets callers fold opt-in, config-driven prod roots
// (e.g. a live trading install) into the zone config without mutating the default.
export function mergeProtectedRoots(config, extraRoots = []) {
  const base = config ?? DEFAULT_ZONE_CONFIG;
  const merged = [...(base.protectedRoots ?? [])];
  for (const r of extraRoots) if (typeof r === 'string' && r && !merged.includes(r)) merged.push(r);
  return { ...base, protectedRoots: merged };
}

const norm = p => (p ?? '').replace(/\\/g, '/');

function isProtected(absPath, config) {
  const a = norm(absPath).toLowerCase();
  for (const r of config.protectedRoots ?? [])
    if (a.startsWith(norm(r).toLowerCase().replace(/\/+$/, '') + '/') || a === norm(r).toLowerCase()) return true;
  const segs = a.split('/').filter(Boolean);
  for (const s of config.protectedSegments ?? [])
    if (segs.some(seg => seg === s || seg.endsWith('-' + s))) return true;
  return false;
}

export function classifyTier(absPath, config = DEFAULT_ZONE_CONFIG) {
  const a = norm(absPath).toLowerCase();
  const roots = config.tierRoots ?? {};
  const order = [[1, 'artifact'], [2, 'brain'], [3, 'ephemeral']];
  for (const [n, key] of order)
    for (const r of roots[key] ?? []) {
      const rr = norm(r).toLowerCase().replace(/\/+$/, '');
      if (a === rr || a.startsWith(rr + '/')) return n;
    }
  return null;
}

export function classifyPath(p, { projectRoot, config = DEFAULT_ZONE_CONFIG, relative = false } = {}) {
  const tier = classifyTier(p, config);
  if (isProtected(p, config)) {
    const segs = norm(p).split('/').filter(Boolean);
    return { zone: segs.slice(-2, -1)[0] ?? segs[0] ?? '(prod)', env: 'prod', protected: true, tier };
  }
  let rel = norm(p);
  if (!relative && projectRoot) {
    const r = norm(path.relative(projectRoot, p));
    if (r && !r.startsWith('..')) rel = r;
  }
  rel = rel.replace(/^\/+/, '');
  let best = null;
  for (const e of config.prefixes ?? [])
    if (rel.toLowerCase().startsWith(e.prefix.toLowerCase()) && (!best || e.prefix.length > best.prefix.length)) best = e;
  if (best) return { zone: best.zone, env: best.env, protected: false, tier };
  const first = rel.split('/').filter(Boolean)[0];
  return { zone: first ?? '(root)', env: 'dev', protected: false, tier };
}

export function sessionScope(paths, { projectRoot, config = DEFAULT_ZONE_CONFIG } = {}) {
  const zmap = new Map(); const protectedHits = [];
  const tiers = { artifact: 0, brain: 0, ephemeral: 0, untiered: 0 };
  for (const p of paths ?? []) {
    if (!p) continue;
    const c = classifyPath(p, { projectRoot, config });
    if (c.protected) protectedHits.push({ path: p, zone: c.zone });
    const prev = zmap.get(c.zone) ?? { zone: c.zone, env: c.env, count: 0 };
    prev.count++; zmap.set(c.zone, prev);
    const t = c.tier;
    tiers[t === 1 ? 'artifact' : t === 2 ? 'brain' : t === 3 ? 'ephemeral' : 'untiered']++;
  }
  return {
    zones: [...zmap.values()].sort((a, b) => b.count - a.count),
    protected: protectedHits,
    allDev: protectedHits.length === 0,
    touched: (paths ?? []).filter(Boolean).length,
    tiers,
  };
}
