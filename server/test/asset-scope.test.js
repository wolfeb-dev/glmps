// server/test/asset-scope.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demungeProject, annotateUnused } from '../lib/asset-scope.js';

// ── demungeProject ────────────────────────────────────────────────────────────

test('demungeProject: D-- → D:\\', () => {
  assert.equal(demungeProject('D--'), 'D:\\');
});

test('demungeProject: D--my-project → D:\\my-project', () => {
  assert.equal(demungeProject('D--my-project'), 'D:\\my-project');
});

test('demungeProject: D--glmps → D:\\glmps', () => {
  assert.equal(demungeProject('D--glmps'), 'D:\\glmps');
});

test('demungeProject: no match → input unchanged', () => {
  assert.equal(demungeProject('unknown-key'), 'unknown-key');
  assert.equal(demungeProject(''), '');
});

test('demungeProject: non-string → empty string', () => {
  assert.equal(demungeProject(null), '');
  assert.equal(demungeProject(undefined), '');
  assert.equal(demungeProject(42), '');
});

// ── annotateUnused ────────────────────────────────────────────────────────────

test('annotateUnused: skills always applicable', () => {
  const unused = {
    skills: [{ name: 'deep-research', path: '/some/path' }],
    agents: [],
    memory: [],
    contextFiles: [],
  };
  const result = annotateUnused(unused, 'D--', 'D:\\');
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].applicable, true);
  assert.equal(result.skills[0].name, 'deep-research');
});

test('annotateUnused: agents always applicable', () => {
  const unused = {
    skills: [],
    agents: [{ name: 'my-agent', path: '/some/path' }],
    memory: [],
    contextFiles: [],
  };
  const result = annotateUnused(unused, 'D--', 'D:\\');
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].applicable, true);
});

test('annotateUnused: memory — matching project key is applicable', () => {
  const unused = {
    skills: [],
    agents: [],
    memory: [
      { name: 'MEMORY.md', project: 'D--', path: 'C:/users/.claude/projects/D--/memory/MEMORY.md' },
      { name: 'MEMORY.md', project: 'D--my-project', path: 'C:/users/.claude/projects/D--my-project/memory/MEMORY.md' },
      { name: 'note.md',   project: 'D--', path: 'C:/users/.claude/projects/D--/memory/note.md' },
    ],
    contextFiles: [],
  };
  const result = annotateUnused(unused, 'D--', 'D:\\');

  assert.equal(result.memory[0].applicable, true,  'D-- MEMORY.md should be applicable');
  assert.equal(result.memory[1].applicable, false,  'D--my-project MEMORY.md should not be applicable');
  assert.equal(result.memory[2].applicable, true,  'D-- note.md should be applicable');
});

test('annotateUnused: memory items get demunged location', () => {
  const unused = {
    skills: [],
    agents: [],
    memory: [
      { name: 'MEMORY.md', project: 'D--my-project', path: '/some/path' },
    ],
    contextFiles: [],
  };
  const result = annotateUnused(unused, 'D--', 'D:\\');
  assert.equal(result.memory[0].location, 'D:\\my-project');
});

test('annotateUnused: contextFiles — global by name → applicable', () => {
  const unused = {
    skills: [],
    agents: [],
    memory: [],
    contextFiles: [
      { name: 'CLAUDE.md (global)', root: 'C:\\Users\\dev\\.claude', path: 'C:\\Users\\dev\\.claude\\CLAUDE.md' },
    ],
  };
  const result = annotateUnused(unused, 'D--', 'D:\\');
  assert.equal(result.contextFiles[0].applicable, true);
  assert.equal(result.contextFiles[0].location, 'global');
});

test('annotateUnused: contextFiles — project file under sessionCwd → applicable', () => {
  const unused = {
    skills: [],
    agents: [],
    memory: [],
    contextFiles: [
      { name: 'CLAUDE.md', root: 'D:\\glmps', path: 'D:\\glmps\\CLAUDE.md' },
    ],
  };
  const result = annotateUnused(unused, 'D--glmps', 'D:\\glmps');
  assert.equal(result.contextFiles[0].applicable, true);
  assert.equal(result.contextFiles[0].location, 'D:\\glmps');
});

test('annotateUnused: contextFiles — project file not under sessionCwd → not applicable', () => {
  const unused = {
    skills: [],
    agents: [],
    memory: [],
    contextFiles: [
      { name: 'CLAUDE.md', root: 'D:\\other-project', path: 'D:\\other-project\\CLAUDE.md' },
    ],
  };
  const result = annotateUnused(unused, 'D--glmps', 'D:\\glmps');
  assert.equal(result.contextFiles[0].applicable, false);
});

test('annotateUnused: null/missing unused → empty groups', () => {
  const result = annotateUnused(null, 'D--', 'D:\\');
  assert.deepEqual(result, { skills: [], agents: [], memory: [], contextFiles: [] });
});

test('annotateUnused: missing sessionProjectKey → all memory not applicable', () => {
  const unused = {
    skills: [],
    agents: [],
    memory: [{ name: 'MEMORY.md', project: 'D--', path: '/p' }],
    contextFiles: [],
  };
  const result = annotateUnused(unused, null, null);
  assert.equal(result.memory[0].applicable, false);
});
