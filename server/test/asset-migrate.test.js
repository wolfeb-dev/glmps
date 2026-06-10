// server/test/asset-migrate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateAssets } from '../lib/asset-migrate.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

function seedClaude(claudeDir) {
  fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'agents', 'backtest-skeptic.md'), 'agent A');
  fs.writeFileSync(path.join(claudeDir, 'agents', 'strategy-coder.md'), 'agent B');
  fs.mkdirSync(path.join(claudeDir, 'skills', 'strategy-architect'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 'strategy-architect', 'SKILL.md'), 'skill A');
  // vendored skill = symlink; must be LEFT untouched
  const vendorTarget = path.join(claudeDir, '_vendor_tdd');
  fs.mkdirSync(vendorTarget, { recursive: true });
  fs.writeFileSync(path.join(vendorTarget, 'SKILL.md'), 'vendored');
  fs.symlinkSync(vendorTarget, path.join(claudeDir, 'skills', 'tdd'), 'junction');
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'global rules');
}

test('migrateAssets moves owned defs, leaves vendored symlinks, verifies', () => {
  const root = mkTmp();
  const claudeDir = path.join(root, 'claude'), assetsDir = path.join(root, 'assets');
  seedClaude(claudeDir);
  const r = migrateAssets({ assetsDir, claudeDir });
  assert.equal(r.ok, true);
  assert.equal(r.mismatches.length, 0);
  // owned defs now live in the store
  assert.equal(fs.readFileSync(path.join(assetsDir, 'agents', 'backtest-skeptic.md'), 'utf8'), 'agent A');
  assert.equal(fs.readFileSync(path.join(assetsDir, 'skills', 'strategy-architect', 'SKILL.md'), 'utf8'), 'skill A');
  assert.equal(fs.readFileSync(path.join(assetsDir, 'CLAUDE.global.md'), 'utf8'), 'global rules');
  // and are readable back through ~/.claude (links)
  assert.equal(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8'), 'global rules');
  // vendored symlink untouched
  assert.ok(fs.lstatSync(path.join(claudeDir, 'skills', 'tdd')).isSymbolicLink());
  // backup captured the originals
  assert.equal(fs.readFileSync(path.join(r.backupDir, 'CLAUDE.md'), 'utf8'), 'global rules');
});

test('migrateAssets refuses to run over a non-empty store', () => {
  const root = mkTmp();
  const claudeDir = path.join(root, 'claude'), assetsDir = path.join(root, 'assets');
  seedClaude(claudeDir);
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'something.md'), 'x');
  const r = migrateAssets({ assetsDir, claudeDir });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not empty/i);
});

test('migrateAssets reports verify failure when deploy yields wrong content', () => {
  const root = mkTmp();
  const claudeDir = path.join(root, 'claude'), assetsDir = path.join(root, 'assets');
  seedClaude(claudeDir);
  // inject a deploy that corrupts one target
  const badDeploy = ({ claudeDir }) => {
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'CORRUPT');
    return { linked: [], skipped: [], backedUp: [], copied: [], failed: [] };
  };
  const r = migrateAssets({ assetsDir, claudeDir, deploy: badDeploy });
  assert.equal(r.ok, false);
  assert.ok(r.mismatches.some(m => m.endsWith('CLAUDE.md')));
});
