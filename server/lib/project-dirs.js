// server/lib/project-dirs.js
// Keep settings.json permissions.additionalDirectories in sync with the git repos
// found one level under each configured root. Roots come from GLMPS_PROJECT_ROOTS
// (set by the caller); there is no hardcoded default, so this is a no-op until
// configured — safe for OSS.
import fs from 'node:fs';
import path from 'node:path';

function normRoot(r) {
  return r.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
}

// Immediate child dirs of each root that contain a `.git` entry (dir or file).
export function findRepoDirs(roots) {
  const out = [];
  for (const root of roots) {
    const r = normRoot(root);
    let entries;
    try { entries = fs.readdirSync(r, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (/^\$/.test(e.name) || /^System Volume Information$/i.test(e.name)) continue;
      const dir = path.join(r, e.name);
      try {
        if (fs.existsSync(path.join(dir, '.git'))) out.push(dir.replace(/\\/g, '/'));
      } catch {}
    }
  }
  return out;
}

// Managed roots refreshed from disk; manually-added dirs outside the roots preserved.
export function computeAdditionalDirectories({ roots, current = [] }) {
  const normRoots = roots.map(normRoot);
  const found = findRepoDirs(roots);
  const isManaged = (d) => {
    const n = d.replace(/\\/g, '/').toLowerCase();
    return normRoots.some((r) => n.startsWith(r.toLowerCase()));
  };
  const preserved = current.filter((d) => !isManaged(d));
  return [...new Set([...preserved, ...found])].sort((a, b) => a.localeCompare(b));
}

// Read settings, recompute additionalDirectories, write atomically only on change.
export function syncProjectDirs({ settingsFile, roots }) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
  catch (err) { return { ok: false, reason: `cannot read ${settingsFile}: ${err.message}` }; }

  settings.permissions = settings.permissions || {};
  const current = Array.isArray(settings.permissions.additionalDirectories)
    ? settings.permissions.additionalDirectories : [];
  const next = computeAdditionalDirectories({ roots, current });
  const curSorted = [...current].sort((a, b) => a.localeCompare(b));
  const unchanged = next.length === curSorted.length && next.every((v, i) => v === curSorted[i]);
  if (unchanged) return { ok: true, changed: false, dirs: next };

  settings.permissions.additionalDirectories = next;
  const tmp = settingsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsFile);
  return { ok: true, changed: true, dirs: next };
}
