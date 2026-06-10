// server/test/inventory.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanInventory } from '../lib/inventory.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

test('scanInventory finds plugin skills, agents, memory, and context files', () => {
  const tmp = mkTmp();
  // plugin skill: <pluginsCache>/<marketplace>/<plugin>/<ver>/skills/<name>/SKILL.md
  const skillDir = path.join(tmp, 'cache', 'mp', 'superpowers', '5.1.0', 'skills', 'brainstorming');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
    '---\nname: brainstorming\ndescription: explore ideas\n---\nbody');
  // plugin agent: .../agents/<name>.md
  const agentDir = path.join(tmp, 'cache', 'mp', 'code-simplifier', '1.0.0', 'agents');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'code-simplifier.md'),
    '---\nname: code-simplifier\ndescription: simplifies\n---\n');
  // memory: <projectsDir>/<proj>/memory/*.md
  const memDir = path.join(tmp, 'projects', 'D--', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- index');
  fs.writeFileSync(path.join(memDir, 'note.md'), '---\nname: note\n---\nfact');
  // context file in a known project root + AG project skill
  const proj = path.join(tmp, 'work');
  fs.mkdirSync(path.join(proj, '.agents', 'skills', 'nq'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'rules');
  fs.writeFileSync(path.join(proj, '.agents', 'skills', 'nq', 'SKILL.md'),
    '---\nname: nq\ndescription: project skill\n---\n');
  // global CLAUDE.md
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'global rules');

  const inv = scanInventory({
    pluginsCacheDir: path.join(tmp, 'cache'),
    projectsDir: path.join(tmp, 'projects'),
    projectRoots: [proj],
    claudeDir,
  });
  assert.deepEqual(inv.skills.map(s => [s.name, s.plugin]).sort(),
    [['brainstorming', 'superpowers'], ['nq', 'project']].sort());
  assert.equal(inv.agents.length, 1);
  assert.equal(inv.agents[0].name, 'code-simplifier');
  assert.equal(inv.memory.length, 2);
  assert.equal(inv.contextFiles.length, 2); // project CLAUDE.md + global CLAUDE.md
  assert.ok(inv.skills.every(s => typeof s.description === 'string'));
});

test('missing directories yield empty inventories, no throw', () => {
  const inv = scanInventory({
    pluginsCacheDir: 'Q:\\nope', projectsDir: 'Q:\\nope2', projectRoots: ['Q:\\nope3'], claudeDir: 'Q:\\nope4' });
  assert.deepEqual(inv, { skills: [], agents: [], memory: [], contextFiles: [] });
});

test('scanInventory finds user-level and project-level Claude agents and skills', () => {
  const tmp = mkTmp();
  // user-level (global) agent: ~/.claude/agents/<name>.md
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'agents', 'backtest-skeptic.md'),
    '---\nname: backtest-skeptic\ndescription: validates backtests\n---\nbody');
  // user-level (global) skill: ~/.claude/skills/<name>/SKILL.md
  fs.mkdirSync(path.join(claudeDir, 'skills', 'strategy-architect'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 'strategy-architect', 'SKILL.md'),
    '---\nname: strategy-architect\ndescription: spec out a strategy\n---\nbody');
  // project-level agent + skill under <root>/.claude
  const proj = path.join(tmp, 'work');
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'proj-agent.md'),
    '---\nname: proj-agent\ndescription: project agent\n---\n');
  fs.mkdirSync(path.join(proj, '.claude', 'skills', 'proj-skill'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'skills', 'proj-skill', 'SKILL.md'),
    '---\nname: proj-skill\ndescription: project skill\n---\n');

  const inv = scanInventory({
    pluginsCacheDir: path.join(tmp, 'cache'),   // absent -> no plugin items
    projectsDir: path.join(tmp, 'projects'),    // absent -> no memory
    projectRoots: [proj],
    claudeDir,
  });

  assert.deepEqual(inv.agents.map(a => [a.name, a.plugin]).sort(),
    [['backtest-skeptic', 'user'], ['proj-agent', 'project']].sort());
  assert.deepEqual(inv.skills.map(s => [s.name, s.plugin]).sort(),
    [['proj-skill', 'project'], ['strategy-architect', 'user']].sort());
  // every item still carries a string description and a path
  assert.ok(inv.agents.every(a => typeof a.description === 'string' && a.path));
  assert.ok(inv.skills.every(s => typeof s.description === 'string' && s.path));
});

test('scanInventory follows symlinked user skill dirs (asset-boundary deploy)', () => {
  const tmp = mkTmp();
  const claudeDir = path.join(tmp, 'claude');
  // real skill source (mirrors the private asset store), symlinked into ~/.claude/skills
  const srcSkill = path.join(tmp, 'assets', 'skills', 'strategy-architect');
  fs.mkdirSync(srcSkill, { recursive: true });
  fs.writeFileSync(path.join(srcSkill, 'SKILL.md'),
    '---\nname: strategy-architect\ndescription: spec out a strategy\n---\nbody');
  fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
  fs.symlinkSync(srcSkill, path.join(claudeDir, 'skills', 'strategy-architect'), 'junction');

  const inv = scanInventory({
    pluginsCacheDir: path.join(tmp, 'none'),
    projectsDir: path.join(tmp, 'none2'),
    projectRoots: [],
    claudeDir,
  });
  assert.ok(inv.skills.some(s => s.name === 'strategy-architect'),
    'a skill deployed as a symlinked dir should be discovered');
});
