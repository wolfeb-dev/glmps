// server/lib/asset-migrate.js
import fs from 'node:fs';
import path from 'node:path';
import { deployAssets } from './asset-deploy.js';

function entries(d) { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } }
function isRealFile(p) { try { const s = fs.lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } }
function isRealDir(p) { try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } }
function dirHasContent(d) {
  try { return fs.readdirSync(d).length > 0; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

// Move user-OWNED (real, non-symlink) defs from claudeDir into assetsDir, then deploy links back.
// `deploy` is injectable for testing; defaults to the real deployAssets.
export function migrateAssets({ assetsDir, claudeDir, deploy = deployAssets }) {
  if (dirHasContent(assetsDir)) return { ok: false, reason: 'assets dir is not empty', assetsDir };

  const agents = entries(path.join(claudeDir, 'agents'))
    .filter(e => e.name.endsWith('.md') && isRealFile(path.join(claudeDir, 'agents', e.name)))
    .map(e => e.name);
  const skills = entries(path.join(claudeDir, 'skills'))
    .filter(e => isRealDir(path.join(claudeDir, 'skills', e.name)))
    .map(e => e.name);
  const hasGlobalMd = isRealFile(path.join(claudeDir, 'CLAUDE.md'));

  let backupDir = null;
  const ensureBackup = () => {
    if (!backupDir) { backupDir = path.join(claudeDir, `.backup-pre-consolidation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`); fs.mkdirSync(backupDir, { recursive: true }); }
    return backupDir;
  };
  const backup = (src, rel) => { const b = path.join(ensureBackup(), rel); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.cpSync(src, b, { recursive: true }); };

  const moved = [];
  fs.mkdirSync(path.join(assetsDir, 'agents'), { recursive: true });
  for (const name of agents) {
    const src = path.join(claudeDir, 'agents', name);
    backup(src, path.join('agents', name));
    fs.cpSync(src, path.join(assetsDir, 'agents', name));
    fs.rmSync(src, { force: true });
    moved.push({ type: 'agent', name });
  }
  fs.mkdirSync(path.join(assetsDir, 'skills'), { recursive: true });
  for (const name of skills) {
    const src = path.join(claudeDir, 'skills', name);
    backup(src, path.join('skills', name));
    fs.cpSync(src, path.join(assetsDir, 'skills', name), { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
    moved.push({ type: 'skill', name });
  }
  if (hasGlobalMd) {
    const src = path.join(claudeDir, 'CLAUDE.md');
    backup(src, 'CLAUDE.md');
    fs.cpSync(src, path.join(assetsDir, 'CLAUDE.global.md'));
    fs.rmSync(src, { force: true });
    moved.push({ type: 'global-claude-md', name: 'CLAUDE.global.md' });
  }

  const dep = deploy({ assetsDir, claudeDir });

  const mismatches = [];
  const check = (target, backupRel) => {
    try {
      if (!fs.readFileSync(target).equals(fs.readFileSync(path.join(backupDir, backupRel)))) mismatches.push(target);
    } catch { mismatches.push(target); }
  };
  for (const name of agents) check(path.join(claudeDir, 'agents', name), path.join('agents', name));
  if (hasGlobalMd) check(path.join(claudeDir, 'CLAUDE.md'), 'CLAUDE.md');
  // Sentinel check only (SKILL.md per skill dir); the backup is the safety net for full content.
  for (const name of skills) {
    const rel = path.join('skills', name, 'SKILL.md');
    if (fs.existsSync(path.join(backupDir, rel))) check(path.join(claudeDir, 'skills', name, 'SKILL.md'), rel);
  }

  return { ok: mismatches.length === 0, moved, backupDir, deploy: dep, mismatches };
}
