// server/lib/discover.js
// Pure repo/harness discovery and profile-draft builder for `glmps init`.
// No side-effects; injectable fs for testability.
import nodeFs from 'node:fs';
import path from 'node:path';

// Normalize to forward slashes so injected-fs mocks and real Windows paths both work.
const fwdSlash = s => s.replace(/\\/g, '/');
const fjoin = (...parts) => fwdSlash(path.join(...parts));

// Maps adapter id -> harness profile key
const HARNESS_DIR_KEY = {
  'claude-code': 'claudeDir',
  'antigravity': 'antigravityDir',
  'opencode': 'opencodeDir',
  'codex-cli': 'codexDir',
  'hermes': 'hermesDir',
};

/**
 * discoverRepos(searchRoots, fsmod, maxDepth)
 *   -> string[] of dirs containing a .git entry, up to maxDepth levels deep.
 * Deduplicates. Stops descending into a dir once .git is found.
 */
export function discoverRepos(searchRoots, fsmod = nodeFs, maxDepth = 2) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    if (fsmod.existsSync(fjoin(dir, '.git'))) { found.push(dir); return; }
    let entries = [];
    try { entries = fsmod.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory && e.isDirectory()) walk(fjoin(dir, e.name), depth + 1);
    }
  };
  for (const root of searchRoots ?? []) walk(fwdSlash(root), 0);
  return [...new Set(found)];
}

/**
 * discoverHarnesses(P, adapters)
 *   -> [{ id, installed, dataDirs }]
 * Calls adapter.detect(P) for each adapter; swallows errors gracefully.
 */
export function discoverHarnesses(P, adapters) {
  return (adapters ?? []).map(a => {
    let d;
    try { d = a.detect(P); } catch { d = { installed: false, dataDirs: [] }; }
    return { id: a.id, installed: !!d.installed, dataDirs: d.dataDirs ?? [] };
  });
}

/**
 * buildProfileDraft({ engagement, identity, repoRoots, harnesses, stateDir })
 *   -> profile object ready to JSON.stringify.
 * Only includes harness dirs for installed harnesses.
 */
export function buildProfileDraft({ engagement, identity, repoRoots, harnesses, stateDir }) {
  const harness = {};
  for (const h of harnesses ?? []) {
    const key = HARNESS_DIR_KEY[h.id];
    if (key && h.installed && h.dataDirs?.[0]) harness[key] = h.dataDirs[0];
  }
  return {
    version: 1,
    engagement,
    identity: identity ?? {},
    stateDir: stateDir ?? `~/.glmps/${engagement}`,
    repoRoots: repoRoots ?? [],
    harness,
  };
}
