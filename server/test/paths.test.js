// server/test/paths.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPaths, ensureStateDirs } from '../lib/paths.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

test('defaults derive from home dir', () => {
  const p = getPaths({});
  assert.equal(p.claudeDir, path.join(os.homedir(), '.claude'));
  assert.equal(p.activeSessionsFile,
    path.join(os.homedir(), '.claude', '.claude-manager', 'active-sessions.json'));
  // primary antigravityDir is now antigravity-ide
  assert.equal(p.antigravityDir, path.join(os.homedir(), '.gemini', 'antigravity-ide'));
  assert.deepEqual(p.antigravityDirs, [
    path.join(os.homedir(), '.gemini', 'antigravity-ide'),
    path.join(os.homedir(), '.gemini', 'antigravity-cli'),
    path.join(os.homedir(), '.gemini', 'antigravity'),
  ]);
  assert.equal(p.stateDir, path.join(os.homedir(), '.glmps'));
});

test('getPaths: agyCliDir defaults to ~/.gemini/antigravity-cli', () => {
  const P = getPaths({});
  const home = os.homedir();
  assert.equal(P.agyCliDir, path.join(home, '.gemini', 'antigravity-cli'));
});

test('getPaths: agyCliDir overridden by GLMPS_AGY_CLI_DIR', () => {
  const P = getPaths({ GLMPS_AGY_CLI_DIR: '/custom/agy-cli' });
  assert.equal(P.agyCliDir, '/custom/agy-cli');
});

test('assetsDir honors GLMPS_ASSETS_DIR override', () => {
  const P = getPaths({ GLMPS_ASSETS_DIR: '/tmp/custom-assets' });
  assert.equal(P.assetsDir, '/tmp/custom-assets');
});

test('assetsDir defaults to the sibling glmps-assets repo (launch-env independent)', () => {
  const P = getPaths({}); // no GLMPS_ASSETS_DIR — must NOT fall back to the home dir
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const expected = path.join(path.dirname(repoRoot), 'glmps-assets');
  assert.equal(P.assetsDir, expected);
  assert.equal(P.agentsDir, path.join(expected, 'agents'));
});

test('agentsDir honors GLMPS_AGENTS_DIR override', () => {
  const P = getPaths({ GLMPS_AGENTS_DIR: '/tmp/custom-agents' });
  assert.equal(P.agentsDir, '/tmp/custom-agents');
});

test('doneGateDir honors GLMPS_DONE_GATE_DIR override', () => {
  const P = getPaths({ GLMPS_DONE_GATE_DIR: '/tmp/dg' });
  assert.equal(P.doneGateDir, '/tmp/dg');
});

test('doneGateDir defaults under stateDir', () => {
  const P = getPaths({ GLMPS_STATE_DIR: '/tmp/st' });
  assert.equal(P.doneGateDir, path.join('/tmp/st', 'done-gate'));
});

test('env overrides win and ensureStateDirs creates subdirs', () => {
  const tmp = mkTmp();
  const p = getPaths({ GLMPS_STATE_DIR: tmp, GLMPS_CLAUDE_DIR: 'X:\\c', GLMPS_ANTIGRAVITY_DIR: 'X:\\a' });
  assert.equal(p.stateDir, tmp);
  assert.equal(p.claudeDir, 'X:\\c');
  assert.equal(p.antigravityDir, 'X:\\a');
  // env override yields a one-element array
  assert.deepEqual(p.antigravityDirs, ['X:\\a']);
  ensureStateDirs(p);
  for (const d of ['state', 'status', 'requests', 'undo'])
    assert.ok(fs.existsSync(path.join(tmp, d)), d);
});

test('profile supplies stateDir/claudeDir/repoRoots when env is absent', () => {
  const profile = {
    stateDir: '/eng/state', assetsDir: '/eng/assets',
    repoRoots: ['/eng/api', '/eng/web'],
    harness: { claudeDir: '/eng/claude', antigravityDir: null, opencodeDir: null, codexDir: null, hermesDir: null, vscodeStorageDir: null },
  };
  const P = getPaths({}, profile);
  assert.equal(P.stateDir, '/eng/state');
  assert.equal(P.claudeDir, '/eng/claude');
  assert.deepEqual(P.repoRoots, ['/eng/api', '/eng/web']);
  assert.equal(P.assetsDir, '/eng/assets');
});

test('env overrides profile (env wins)', () => {
  const profile = { stateDir: '/eng/state', harness: { claudeDir: '/eng/claude' } };
  const P = getPaths({ GLMPS_STATE_DIR: '/env/state', GLMPS_CLAUDE_DIR: '/env/claude' }, profile);
  assert.equal(P.stateDir, '/env/state');
  assert.equal(P.claudeDir, '/env/claude');
});

test('no profile => identical behavior to before (repoRoots empty)', () => {
  const P = getPaths({});
  assert.deepEqual(P.repoRoots, []);
  assert.equal(P.profile, null);
  assert.ok(P.claudeDir.endsWith(path.join('.claude')) || P.claudeDir.includes('.claude'));
});
