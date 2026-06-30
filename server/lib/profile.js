// server/lib/profile.js
// Pure load/normalize for a per-client engagement profile (glmps.profile.json).
// No server deps; consumed by paths.js (env overrides win) and glmps-init.
import fs from 'node:fs';
import path from 'node:path';

export function expandHome(p, home) {
  if (typeof p !== 'string') return p;
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

const HARNESS_KEYS = ['claudeDir', 'antigravityDir', 'opencodeDir', 'codexDir', 'hermesDir', 'vscodeStorageDir'];

export function normalizeProfile(raw, home) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const eh = v => expandHome(v, home);
  const arr = a => (Array.isArray(a) ? a.filter(x => typeof x === 'string').map(eh) : []);
  const harness = {};
  for (const k of HARNESS_KEYS) harness[k] = raw.harness?.[k] ? eh(raw.harness[k]) : null;
  let tiers = null;
  if (raw.tiers && typeof raw.tiers === 'object') {
    tiers = {
      artifact: arr(raw.tiers.artifact),
      brain: arr(raw.tiers.brain),
      ephemeral: arr(raw.tiers.ephemeral),
    };
  }
  return {
    version: 1,
    engagement: typeof raw.engagement === 'string' ? raw.engagement : 'default',
    identity: {
      handle: raw.identity?.handle ?? null,
      name: raw.identity?.name ?? null,
      email: raw.identity?.email ?? null,
    },
    stateDir: raw.stateDir ? eh(raw.stateDir) : null,
    assetsDir: raw.assetsDir ? eh(raw.assetsDir) : null,
    repoRoots: arr(raw.repoRoots),
    tiers,
    mutationPolicy: {
      artifact: raw.mutationPolicy?.artifact ?? 'gate',
      brain: raw.mutationPolicy?.brain ?? 'versioned',
      ephemeral: raw.mutationPolicy?.ephemeral ?? 'readonly',
    },
    harness,
    editableRoots: arr(raw.editableRoots),
    terminals: Array.isArray(raw.terminals) ? raw.terminals : [],
  };
}

export function deriveTierRoots(P, adapters = []) {
  if (P.profile?.tiers) return P.profile.tiers;
  const dedupe = a => [...new Set(a.filter(Boolean))];
  const brain = [P.assetsDir, P.agentsDir];
  const ephemeral = [P.stateDir];
  for (const a of adapters) {
    if (typeof a.tierDirs !== 'function') continue;
    let d; try { d = a.tierDirs(P); } catch { continue; }
    if (d?.brain) brain.push(...d.brain);
    if (d?.ephemeral) ephemeral.push(...d.ephemeral);
  }
  return { artifact: dedupe(P.repoRoots ?? []), brain: dedupe(brain), ephemeral: dedupe(ephemeral) };
}

export function engagementView(P, adapters = []) {
  const tiers = deriveTierRoots(P, adapters);
  const controllable = adapters.some(a => {
    if (a.controllable !== true) return false;
    try { return a.detect(P).installed === true; } catch { return false; }
  });
  const prof = P.profile ?? {};
  return {
    engagement: prof.engagement ?? 'default',
    identity: prof.identity ?? null,
    controllable,
    mutationPolicy: prof.mutationPolicy ?? { artifact: 'gate', brain: 'versioned', ephemeral: 'readonly' },
    tiers: {
      artifact: { roots: tiers.artifact },
      brain: { roots: tiers.brain },
      ephemeral: { roots: tiers.ephemeral },
    },
  };
}

export function loadProfile({ cwd, env = process.env, home } = {}) {
  const candidates = [];
  if (env.GLMPS_PROFILE) candidates.push(env.GLMPS_PROFILE);
  if (cwd) candidates.push(path.join(cwd, 'glmps.profile.json'));
  for (const file of candidates) {
    let txt;
    try { txt = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    try { return normalizeProfile(JSON.parse(txt), home); }
    catch { console.warn(`[glmps] ignoring unparseable profile: ${file}`); return null; }
  }
  return null;
}
