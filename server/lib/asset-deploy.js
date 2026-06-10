// server/lib/asset-deploy.js
import fs from 'node:fs';
import path from 'node:path';

function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function sameContent(a, b) { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } }

function linkResolvesTo(dest, src) {
  const st = lstat(dest);
  if (!st || !st.isSymbolicLink()) return false;
  try { return path.resolve(fs.realpathSync(dest)) === path.resolve(fs.realpathSync(src)); }
  catch { return false; }
}

// The managed mappings derived from the asset store.
function plan(assetsDir, claudeDir) {
  const items = [];
  const agentsSrc = path.join(assetsDir, 'agents');
  for (const name of safeReaddir(agentsSrc))
    if (name.endsWith('.md') && isFile(path.join(agentsSrc, name)))
      items.push({ kind: 'file', src: path.join(agentsSrc, name), dest: path.join(claudeDir, 'agents', name) });
  const skillsSrc = path.join(assetsDir, 'skills');
  for (const name of safeReaddir(skillsSrc)) {
    const s = path.join(skillsSrc, name);
    if (isDir(s)) items.push({ kind: 'dir', src: s, dest: path.join(claudeDir, 'skills', name) });
  }
  const gmd = path.join(assetsDir, 'CLAUDE.global.md');
  if (isFile(gmd)) items.push({ kind: 'file', src: gmd, dest: path.join(claudeDir, 'CLAUDE.md') });
  return items;
}

export function deployAssets({ assetsDir, claudeDir }) {
  const report = { linked: [], skipped: [], backedUp: [], copied: [], failed: [] };
  let backupDir = null;
  const ensureBackup = () => {
    if (!backupDir) { backupDir = path.join(claudeDir, `.backup-pre-consolidation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`); fs.mkdirSync(backupDir, { recursive: true }); }
    return backupDir;
  };

  for (const it of plan(assetsDir, claudeDir)) {
    try {
      const st = lstat(it.dest);
      if (st && st.isSymbolicLink() && linkResolvesTo(it.dest, it.src)) { report.skipped.push(it.dest); continue; }
      if (st) {
        // already-synced copy fallback (real file, identical) -> skip, no churn
        if (it.kind === 'file' && !st.isSymbolicLink() && sameContent(it.dest, it.src)) { report.skipped.push(it.dest); continue; }
        if (it.kind === 'dir' && !st.isSymbolicLink() && isDir(it.dest)) { report.skipped.push(it.dest); continue; }
        const bdir = ensureBackup();
        const rel = path.relative(claudeDir, it.dest).replace(/[\\/]/g, '__');
        const bpath = path.join(bdir, rel);
        fs.cpSync(it.dest, bpath, { recursive: true });
        fs.rmSync(it.dest, { recursive: true, force: true });
        report.backedUp.push({ dest: it.dest, backup: bpath });
      }
      fs.mkdirSync(path.dirname(it.dest), { recursive: true });
      try {
        fs.symlinkSync(it.src, it.dest, it.kind === 'dir' ? 'junction' : 'file');
        report.linked.push(it.dest);
      } catch {
        // symlink not permitted (e.g. Windows without Developer Mode) -> copy fallback
        fs.cpSync(it.src, it.dest, { recursive: true });
        report.copied.push(it.dest);
      }
    } catch (e) {
      report.failed.push({ dest: it.dest, error: String((e && e.message) || e) });
    }
  }
  return report;
}
