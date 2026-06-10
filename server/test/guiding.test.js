// server/test/guiding.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { computeGuiding } from '../lib/guiding.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-guiding-'));
  tmpDirs.push(d);
  return d;
}

test('computeGuiding: returns global CLAUDE.md + project CLAUDE.md + parent AGENTS.md', () => {
  const tmp = mkTmp();
  const claudeDir = path.join(tmp, 'claude');
  const parentDir = path.join(tmp, 'parent');
  const cwd = path.join(parentDir, 'project');

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  const globalMd = path.join(claudeDir, 'CLAUDE.md');
  const projectMd = path.join(cwd, 'CLAUDE.md');
  const parentAgents = path.join(parentDir, 'AGENTS.md');

  fs.writeFileSync(globalMd, '# global');
  fs.writeFileSync(projectMd, '# project');
  fs.writeFileSync(parentAgents, '# agents');

  const result = computeGuiding(cwd, claudeDir);

  // Should have 3 entries
  assert.equal(result.length, 3, `expected 3, got ${result.length}: ${JSON.stringify(result)}`);

  // Project CLAUDE.md nearest first
  assert.equal(result[0].name, 'CLAUDE.md');
  assert.equal(result[0].path, projectMd);
  assert.equal(result[0].scope, 'project');

  // Parent AGENTS.md next
  assert.equal(result[1].name, 'AGENTS.md');
  assert.equal(result[1].path, parentAgents);
  assert.equal(result[1].scope, 'project');

  // Global CLAUDE.md last
  assert.equal(result[2].name, 'CLAUDE.md');
  assert.equal(result[2].path, globalMd);
  assert.equal(result[2].scope, 'global');
});

test('computeGuiding: cwd null → only global (if exists)', () => {
  const tmp = mkTmp();
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const globalMd = path.join(claudeDir, 'CLAUDE.md');
  fs.writeFileSync(globalMd, '# global');

  const result = computeGuiding(null, claudeDir);

  assert.equal(result.length, 1);
  assert.equal(result[0].scope, 'global');
  assert.equal(result[0].path, globalMd);
});

test('computeGuiding: nothing exists → empty array', () => {
  const tmp = mkTmp();
  const claudeDir = path.join(tmp, 'noclaudedir');
  const cwd = path.join(tmp, 'nocwd');

  const result = computeGuiding(cwd, claudeDir);

  assert.equal(result.length, 0);
});

test('computeGuiding: cwd undefined → only global (if exists)', () => {
  const tmp = mkTmp();
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const globalMd = path.join(claudeDir, 'CLAUDE.md');
  fs.writeFileSync(globalMd, '# global');

  const result = computeGuiding(undefined, claudeDir);

  assert.equal(result.length, 1);
  assert.equal(result[0].scope, 'global');
});

test('computeGuiding: deduplicates by resolved path', () => {
  const tmp = mkTmp();
  const claudeDir = path.join(tmp, 'project'); // claudeDir IS the cwd — same CLAUDE.md
  fs.mkdirSync(claudeDir, { recursive: true });
  const sharedMd = path.join(claudeDir, 'CLAUDE.md');
  fs.writeFileSync(sharedMd, '# shared');

  const result = computeGuiding(claudeDir, claudeDir);

  // Even though both cwd-walk and global point to same file, it should appear once
  // The walk finds it first as 'project'; global path is same resolved → upgrade to 'global'
  assert.equal(result.length, 1);
  assert.equal(result[0].path, sharedMd);
  assert.equal(result[0].scope, 'global');
});

test('computeGuiding: only GEMINI.md in cwd, no global', () => {
  const tmp = mkTmp();
  const claudeDir = path.join(tmp, 'noclaudedir');
  const cwd = path.join(tmp, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const geminiMd = path.join(cwd, 'GEMINI.md');
  fs.writeFileSync(geminiMd, '# gemini');

  const result = computeGuiding(cwd, claudeDir);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'GEMINI.md');
  assert.equal(result[0].scope, 'project');
});

test('computeGuiding: projectMemoryDir with MEMORY.md → appended as scope:memory', () => {
  const tmp = mkTmp();
  const claudeDir = path.join(tmp, 'claude');
  const cwd = path.join(tmp, 'proj');
  const memDir = path.join(tmp, 'memory');

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(memDir, { recursive: true });

  const globalMd = path.join(claudeDir, 'CLAUDE.md');
  const memoryMd = path.join(memDir, 'MEMORY.md');
  fs.writeFileSync(globalMd, '# global');
  fs.writeFileSync(memoryMd, '# memory');

  const result = computeGuiding(cwd, claudeDir, memDir);

  // Should have global CLAUDE.md + MEMORY.md
  assert.equal(result.length, 2, `expected 2, got ${result.length}: ${JSON.stringify(result)}`);

  const globalEntry = result.find(e => e.scope === 'global');
  const memEntry    = result.find(e => e.scope === 'memory');

  assert.ok(globalEntry, 'should have global entry');
  assert.ok(memEntry,    'should have memory entry');
  assert.equal(memEntry.name, 'MEMORY.md');
  assert.equal(memEntry.path, memoryMd);
  // memory entry comes after global
  assert.ok(result.indexOf(globalEntry) < result.indexOf(memEntry), 'global before memory');
});

test('computeGuiding: projectMemoryDir without MEMORY.md → no memory entry added', () => {
  const tmp = mkTmp();
  const claudeDir = path.join(tmp, 'claude');
  const memDir = path.join(tmp, 'memory-empty');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(memDir, { recursive: true });
  const globalMd = path.join(claudeDir, 'CLAUDE.md');
  fs.writeFileSync(globalMd, '# global');

  const result = computeGuiding(null, claudeDir, memDir);

  assert.equal(result.length, 1);
  assert.equal(result[0].scope, 'global');
});

test('computeGuiding: projectMemoryDir=null → no memory entry added', () => {
  const tmp = mkTmp();
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# global');

  const result = computeGuiding(null, claudeDir, null);

  assert.equal(result.length, 1);
  assert.equal(result[0].scope, 'global');
});
