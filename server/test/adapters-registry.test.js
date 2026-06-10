// server/test/adapters-registry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters, detectAll } from '../lib/adapters/index.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-reg-')); tmpDirs.push(d); return d; }

test('adapters array has 10 entries with expected ids', () => {
  const ids = adapters.map(a => a.id);
  assert.deepEqual(ids, ['claude-code', 'antigravity', 'gemini-cli', 'copilot-chat', 'codex-cli', 'openclaw', 'hermes', 'agy-cli', 'opencode', 'cline']);
});

test('each adapter exports required fields', () => {
  for (const a of adapters) {
    assert.equal(typeof a.id, 'string', `${a.id} missing id`);
    assert.equal(typeof a.displayName, 'string', `${a.id} missing displayName`);
    assert.equal(typeof a.detect, 'function', `${a.id} missing detect`);
    assert.equal(typeof a.discover, 'function', `${a.id} missing discover`);
  }
});

test('each adapter has at least one extraction function (extractLine, extractSnapshot, or extractSteps)', () => {
  for (const a of adapters) {
    const hasLine = typeof a.extractLine === 'function';
    const hasSnapshot = typeof a.extractSnapshot === 'function';
    const hasSteps = typeof a.extractSteps === 'function';
    assert.ok(hasLine || hasSnapshot || hasSteps,
      `${a.id} must export at least one of extractLine, extractSnapshot, or extractSteps`);
  }
});

test('gemini-cli exports both extractLine and extractSnapshot', () => {
  const gemini = adapters.find(a => a.id === 'gemini-cli');
  assert.ok(gemini, 'gemini-cli adapter not found');
  assert.equal(typeof gemini.extractLine, 'function', 'gemini-cli missing extractLine');
  assert.equal(typeof gemini.extractSnapshot, 'function', 'gemini-cli missing extractSnapshot');
});

test('copilot-chat exports extractSnapshot', () => {
  const copilot = adapters.find(a => a.id === 'copilot-chat');
  assert.ok(copilot, 'copilot-chat adapter not found');
  assert.equal(typeof copilot.extractSnapshot, 'function', 'copilot-chat missing extractSnapshot');
});

test('claude-code exports extractLine', () => {
  const cc = adapters.find(a => a.id === 'claude-code');
  assert.ok(cc, 'claude-code adapter not found');
  assert.equal(typeof cc.extractLine, 'function', 'claude-code missing extractLine');
});

test('antigravity exports extractLine', () => {
  const ag = adapters.find(a => a.id === 'antigravity');
  assert.ok(ag, 'antigravity adapter not found');
  assert.equal(typeof ag.extractLine, 'function', 'antigravity missing extractLine');
});

test('codex-cli exports extractLine', () => {
  const codex = adapters.find(a => a.id === 'codex-cli');
  assert.ok(codex, 'codex-cli adapter not found');
  assert.equal(typeof codex.extractLine, 'function', 'codex-cli missing extractLine');
});

test('openclaw exports extractLine', () => {
  const oc = adapters.find(a => a.id === 'openclaw');
  assert.ok(oc, 'openclaw adapter not found');
  assert.equal(typeof oc.extractLine, 'function', 'openclaw missing extractLine');
});

test('hermes exports extractLine', () => {
  const h = adapters.find(a => a.id === 'hermes');
  assert.ok(h, 'hermes adapter not found');
  assert.equal(typeof h.extractLine, 'function', 'hermes missing extractLine');
});

test('detectAll returns array of 16 entries (10 deep + 6 detect-only) with required shape', () => {
  const tmp = mkTmp();
  const P = {
    claudeDir: path.join(tmp, 'claude'),
    antigravityDirs: [path.join(tmp, 'ag')],
    geminiTmpDir: path.join(tmp, 'gemini-tmp'),
    vscodeStorageDirs: [path.join(tmp, 'vscode-storage')],
    agyCliDir: path.join(tmp, 'agy-cli'),
  };
  const result = detectAll(P);
  assert.equal(result.length, 16);
  for (const entry of result) {
    assert.equal(typeof entry.id, 'string');
    assert.equal(typeof entry.displayName, 'string');
    assert.equal(typeof entry.installed, 'boolean');
    assert.ok(Array.isArray(entry.dataDirs));
    assert.ok(entry.depth === 'deep' || entry.depth === 'detect-only');
  }
});

test('detectAll: deep entries have depth=deep', () => {
  const tmp = mkTmp();
  const P = {
    claudeDir: path.join(tmp, 'claude'),
    antigravityDirs: [path.join(tmp, 'ag')],
    geminiTmpDir: path.join(tmp, 'gemini-tmp'),
    vscodeStorageDirs: [path.join(tmp, 'vscode-storage')],
    agyCliDir: path.join(tmp, 'agy-cli'),
  };
  const result = detectAll(P);
  const deep = result.filter(r => r.depth === 'deep');
  assert.equal(deep.length, 10);
  const deepIds = deep.map(r => r.id);
  assert.ok(deepIds.includes('claude-code'));
  assert.ok(deepIds.includes('hermes'));
  assert.ok(deepIds.includes('codex-cli'));
  assert.ok(deepIds.includes('openclaw'));
});

test('detectAll: detect-only entries have depth=detect-only', () => {
  const tmp = mkTmp();
  const P = {
    claudeDir: path.join(tmp, 'claude'),
    antigravityDirs: [path.join(tmp, 'ag')],
    geminiTmpDir: path.join(tmp, 'gemini-tmp'),
    vscodeStorageDirs: [path.join(tmp, 'vscode-storage')],
    agyCliDir: path.join(tmp, 'agy-cli'),
  };
  const result = detectAll(P);
  const detectOnly = result.filter(r => r.depth === 'detect-only');
  assert.equal(detectOnly.length, 6);
  const ids = detectOnly.map(r => r.id);
  for (const expected of ['cursor', 'windsurf', 'aider', 'continue', 'zed', 'copilot-cli']) {
    assert.ok(ids.includes(expected), `detect-only missing ${expected}`);
  }
});

test('detectAll: claude-code shows installed=true when claudeDir exists', () => {
  const tmp = mkTmp();
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const P = {
    claudeDir,
    antigravityDirs: [path.join(tmp, 'ag')],
    geminiTmpDir: path.join(tmp, 'gemini-tmp'),
    vscodeStorageDirs: [path.join(tmp, 'vscode-storage')],
    agyCliDir: path.join(tmp, 'agy-cli'),
  };
  const result = detectAll(P);
  const cc = result.find(r => r.id === 'claude-code');
  assert.equal(cc.installed, true);
});

test('detectAll: gemini-cli shows installed=true when geminiTmpDir has a subdir', () => {
  const tmp = mkTmp();
  const geminiTmpDir = path.join(tmp, 'gemini-tmp');
  fs.mkdirSync(path.join(geminiTmpDir, 'some-project'), { recursive: true });
  const P = {
    claudeDir: path.join(tmp, 'claude'),
    antigravityDirs: [path.join(tmp, 'ag')],
    geminiTmpDir,
    vscodeStorageDirs: [path.join(tmp, 'vscode-storage')],
    agyCliDir: path.join(tmp, 'agy-cli'),
  };
  const result = detectAll(P);
  const gem = result.find(r => r.id === 'gemini-cli');
  assert.equal(gem.installed, true);
});

test('detectAll: copilot-chat shows installed=true when vscodeStorageDir exists', () => {
  const tmp = mkTmp();
  const vscodeStorageDir = path.join(tmp, 'vscode-storage');
  fs.mkdirSync(vscodeStorageDir, { recursive: true });
  const P = {
    claudeDir: path.join(tmp, 'claude'),
    antigravityDirs: [path.join(tmp, 'ag')],
    geminiTmpDir: path.join(tmp, 'gemini-tmp'),
    vscodeStorageDirs: [vscodeStorageDir],
    agyCliDir: path.join(tmp, 'agy-cli'),
  };
  const result = detectAll(P);
  const cp = result.find(r => r.id === 'copilot-chat');
  assert.equal(cp.installed, true);
});

test('agy-cli exports extractSteps', () => {
  const agyCli = adapters.find(a => a.id === 'agy-cli');
  assert.ok(agyCli, 'agy-cli adapter not found');
  assert.equal(typeof agyCli.extractSteps, 'function', 'agy-cli missing extractSteps');
});

test('detectAll: agy-cli shows installed=true when agyCliDir exists', () => {
  const tmp = mkTmp();
  const agyCliDir = path.join(tmp, 'agy-cli');
  fs.mkdirSync(agyCliDir, { recursive: true });
  const P = {
    claudeDir: path.join(tmp, 'claude'),
    antigravityDirs: [path.join(tmp, 'ag')],
    geminiTmpDir: path.join(tmp, 'gemini-tmp'),
    vscodeStorageDirs: [path.join(tmp, 'vscode-storage')],
    agyCliDir,
  };
  const result = detectAll(P);
  const agyCli = result.find(r => r.id === 'agy-cli');
  assert.equal(agyCli.installed, true);
});
