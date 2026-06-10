// server/test/asset-deploy.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deployAssets } from '../lib/asset-deploy.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

function seedAssets(assetsDir) {
  fs.mkdirSync(path.join(assetsDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'agents', 'backtest-skeptic.md'), 'agent A');
  fs.mkdirSync(path.join(assetsDir, 'skills', 'strategy-architect'), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'skills', 'strategy-architect', 'SKILL.md'), 'skill A');
  fs.writeFileSync(path.join(assetsDir, 'CLAUDE.global.md'), 'global rules');
}

test('deployAssets places all managed items; targets carry source content', () => {
  const root = mkTmp();
  const assetsDir = path.join(root, 'assets'), claudeDir = path.join(root, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  seedAssets(assetsDir);
  const r = deployAssets({ assetsDir, claudeDir });
  assert.equal(fs.readFileSync(path.join(claudeDir, 'agents', 'backtest-skeptic.md'), 'utf8'), 'agent A');
  assert.equal(fs.readFileSync(path.join(claudeDir, 'skills', 'strategy-architect', 'SKILL.md'), 'utf8'), 'skill A');
  assert.equal(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8'), 'global rules');
  assert.equal(r.linked.length + r.copied.length, 3);
  assert.equal(r.failed.length, 0);
});

test('deployAssets is idempotent on re-run', () => {
  const root = mkTmp();
  const assetsDir = path.join(root, 'assets'), claudeDir = path.join(root, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  seedAssets(assetsDir);
  deployAssets({ assetsDir, claudeDir });
  const r2 = deployAssets({ assetsDir, claudeDir });
  assert.equal(r2.skipped.length, 3);
  assert.equal(r2.linked.length + r2.copied.length + r2.backedUp.length, 0);
});

test('deployAssets backs up a conflicting real file before placing', () => {
  const root = mkTmp();
  const assetsDir = path.join(root, 'assets'), claudeDir = path.join(root, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  seedAssets(assetsDir);
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'OLD personal rules');
  const r = deployAssets({ assetsDir, claudeDir });
  assert.equal(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8'), 'global rules');
  assert.equal(r.backedUp.length, 1);
  assert.equal(fs.readFileSync(r.backedUp[0].backup, 'utf8'), 'OLD personal rules');
});
