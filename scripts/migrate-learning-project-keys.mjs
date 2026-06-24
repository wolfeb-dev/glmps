#!/usr/bin/env node
// One-time migration: collapse learning-store rows that the three writers split
// across different `project` spellings (raw cwd "D:\\glmps", basename
// "glmps", projects slug "D--glmps") into a single canonical
// (code, project) row. Resolved status (applied/discarded) wins over pending, so
// the duplicate "pending" gaps that kept re-surfacing collapse into their already-
// applied rows.
//
//   node scripts/migrate-learning-project-keys.mjs            # dry-run (default)
//   node scripts/migrate-learning-project-keys.mjs --apply    # writes (after backup)
//
// Env: GLMPS_STATE_DIR overrides the store location (defaults to getPaths().stateDir).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverLib = path.join(here, '..', 'server', 'lib');
const toURL = (p) => pathToFileURL(p).href;

const { normalizeProject, dedupKey, guardForGap } = await (async () => {
  const ls = await import(toURL(path.join(serverLib, 'learning-store.js')));
  const lt = await import(toURL(path.join(serverLib, 'learning-templates.js')));
  return { normalizeProject: ls.normalizeProject, dedupKey: ls.dedupKey, guardForGap: lt.guardForGap };
})();

const { getPaths } = await import(toURL(path.join(serverLib, 'paths.js')));
const stateDir = process.env.GLMPS_STATE_DIR ?? getPaths().stateDir;
const storePath = path.join(stateDir, 'learning', 'store.json');
const apply = process.argv.includes('--apply');

const raw = fs.readFileSync(storePath, 'utf-8');
const store = JSON.parse(raw);
const items = Array.isArray(store.items) ? store.items : [];

// --- Build the set of "full" path-derived slugs present (e.g. D--glmps).
// A bare basename ("glmps") that the Stop hook wrote can then be remapped
// to the one full slug ending in "-<basename>", recovering the lost path.
const fullSlug = (s) => /^[A-Za-z]--/.test(s); // X:\... -> "X--..."
const fullSlugs = new Set(items.map((it) => normalizeProject(it.project)).filter(fullSlug));

function canonicalProject(rawProject) {
  const norm = normalizeProject(rawProject);
  if (norm === '' || fullSlug(norm)) return norm;
  const matches = [...fullSlugs].filter((f) => f.endsWith('-' + norm));
  return matches.length === 1 ? matches[0] : norm;
}

// --- Group by (code, canonicalProject) ---
const STATUS_RANK = { applied: 5, discarded: 4, dispatched: 3, failed: 2, pending: 1 };
const groups = new Map();
for (const it of items) {
  const proj = canonicalProject(it.project);
  const key = `${it.code}|${proj}`;
  if (!groups.has(key)) groups.set(key, { proj, members: [] });
  groups.get(key).members.push(it);
}

function mergeGroup({ proj, members }) {
  if (members.length === 1) {
    const only = members[0];
    // Still re-key/re-project to canonical (raw-cwd spellings normalize to the slug).
    const id = dedupKey({ source: 'gap', code: only.code, project: proj });
    return { ...only, project: proj, id };
  }
  // Pick the most-resolved member as the representative.
  const byRank = [...members].sort(
    (a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0) || (b.updatedTs ?? 0) - (a.updatedTs ?? 0),
  );
  const rep = byRank[0];
  const applied = members.find((m) => m.status === 'applied');
  const newest = [...members].sort((a, b) => (b.updatedTs ?? 0) - (a.updatedTs ?? 0))[0];
  const code = rep.code;
  const merged = {
    ...rep,
    id: dedupKey({ source: 'gap', code, project: proj }),
    project: proj,
    status: rep.status,
    count: members.reduce((n, m) => n + (m.count ?? 0), 0),
    createdTs: Math.min(...members.map((m) => m.createdTs ?? Infinity)),
    updatedTs: Math.max(...members.map((m) => m.updatedTs ?? 0)),
    lastSessionId: newest.lastSessionId ?? newest.sessionId ?? rep.lastSessionId,
    applyCommit: applied?.applyCommit ?? members.find((m) => m.applyCommit)?.applyCommit ?? null,
    proposedGuard: applied?.proposedGuard ?? members.find((m) => m.proposedGuard)?.proposedGuard ?? guardForGap(code) ?? null,
  };
  return merged;
}

const mergedItems = [...groups.values()].map(mergeGroup);

// --- Report ---
const collapsed = [...groups.values()].filter((g) => g.members.length > 1);
console.log(`store: ${storePath}`);
console.log(`items: ${items.length} -> ${mergedItems.length}  (${items.length - mergedItems.length} rows merged away)\n`);
console.log('=== merges (only groups with >1 row) ===');
for (const g of collapsed.sort((a, b) => a.members[0].code.localeCompare(b.members[0].code))) {
  const merged = mergeGroup(g);
  const before = g.members
    .map((m) => `${JSON.stringify(m.project)}:${m.status}(${m.count})`)
    .join(' + ');
  const flips = g.members.filter((m) => m.status === 'pending' && merged.status !== 'pending').length;
  console.log(`  ${g.members[0].code} -> ${JSON.stringify(g.proj)} : ${merged.status}(${merged.count})`);
  console.log(`        from  ${before}${flips ? `   [${flips} pending dupe(s) resolved]` : ''}`);
}
const stillPending = mergedItems.filter((i) => i.status === 'pending');
console.log(`\npending rows after migration: ${stillPending.length}`);
for (const p of stillPending) console.log(`  - ${p.code} | project=${JSON.stringify(p.project)}`);

if (!apply) {
  console.log('\n(dry-run; re-run with --apply to write. A timestamped backup is made first.)');
  process.exit(0);
}

// --- Apply (backup first) ---
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${storePath}.bak-${stamp}`;
fs.copyFileSync(storePath, backup);
const out = { ...store, items: mergedItems };
const tmp = storePath + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
fs.renameSync(tmp, storePath);
console.log(`\nAPPLIED. backup: ${backup}`);
