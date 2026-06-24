// server/test/inventory.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanInventory, dedupeInventory } from '../lib/inventory.js';

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

test('scanInventory lists acceptance.md as a context file', () => {
  const tmp = mkTmp();
  const proj = path.join(tmp, 'work');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'acceptance.md'), '---\ncommands:\n  - npm test\n---\n');

  const inv = scanInventory({
    pluginsCacheDir: path.join(tmp, 'nocache'),
    projectsDir: path.join(tmp, 'noproj'),
    projectRoots: [proj],
    claudeDir: path.join(tmp, 'noclaude'),
  });
  assert.ok(inv.contextFiles.some(c => c.name === 'acceptance.md' && c.root === proj),
    `expected acceptance.md in contextFiles: ${JSON.stringify(inv.contextFiles)}`);
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

test('scanInventory collapses stale cached plugin versions, keeping the newest', () => {
  const tmp = mkTmp();
  for (const ver of ['5.1.0', '6.0.3']) {
    const d = path.join(tmp, 'cache', 'mp', 'superpowers', ver, 'skills', 'brainstorming');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'),
      `---\nname: brainstorming\ndescription: v${ver}\n---\n`);
  }
  const inv = scanInventory({
    pluginsCacheDir: path.join(tmp, 'cache'),
    projectsDir: path.join(tmp, 'noproj'), projectRoots: [], claudeDir: path.join(tmp, 'noclaude'),
  });
  const brainstorming = inv.skills.filter(s => s.name === 'brainstorming');
  assert.equal(brainstorming.length, 1, 'two cached versions of one skill should collapse to one');
  assert.ok(brainstorming[0].path.includes('6.0.3'), 'the newest version should be kept');
});

test('scanInventory collapses stale cached agent versions, keeping the newest', () => {
  const tmp = mkTmp();
  for (const ver of ['1.0.0', '2.0.0']) {
    const d = path.join(tmp, 'cache', 'mp', 'myplug', ver, 'agents');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'foo.md'), `---\nname: foo\ndescription: v${ver}\n---\n`);
  }
  const inv = scanInventory({
    pluginsCacheDir: path.join(tmp, 'cache'),
    projectsDir: path.join(tmp, 'noproj'), projectRoots: [], claudeDir: path.join(tmp, 'noclaude'),
  });
  const foo = inv.agents.filter(a => a.name === 'foo');
  assert.equal(foo.length, 1, 'two cached versions of one agent should collapse to one');
  assert.ok(foo[0].path.includes('2.0.0'), 'the newest version should be kept');
});

test('scanInventory keeps same-named skills from different plugins distinct', () => {
  const tmp = mkTmp();
  for (const plug of ['earnings-reviewer', 'equity-research']) {
    const d = path.join(tmp, 'cache', 'mp', plug, '0.1.0', 'skills', 'earnings-analysis');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'),
      `---\nname: earnings-analysis\ndescription: from ${plug}\n---\n`);
  }
  const inv = scanInventory({
    pluginsCacheDir: path.join(tmp, 'cache'),
    projectsDir: path.join(tmp, 'noproj'), projectRoots: [], claudeDir: path.join(tmp, 'noclaude'),
  });
  const ea = inv.skills.filter(s => s.name === 'earnings-analysis');
  assert.equal(ea.length, 2, 'same name from two different plugins are distinct skills, not dupes');
  assert.deepEqual(ea.map(s => s.plugin).sort(), ['earnings-reviewer', 'equity-research']);
});

test('dedupeInventory collapses items that resolve to the same physical file', () => {
  const tmp = mkTmp();
  // one real skill, reached via two different scan roots (symlink farm / overlapping roots)
  const src = path.join(tmp, 'assets', 'skills', 'foo');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: foo\ndescription: real\n---\n');
  const linkDir = path.join(tmp, 'mirror', 'skills');
  fs.mkdirSync(linkDir, { recursive: true });
  fs.symlinkSync(src, path.join(linkDir, 'foo'), 'junction');

  const realFile = path.join(src, 'SKILL.md');
  const linkFile = path.join(linkDir, 'foo', 'SKILL.md');
  const inv = {
    skills: [
      { name: 'foo', description: 'real', plugin: 'user', path: realFile },
      { name: 'foo', description: 'real', plugin: 'project', path: linkFile },
    ], agents: [], memory: [], contextFiles: [],
  };
  const out = dedupeInventory(inv);
  assert.equal(out.skills.length, 1, 'two paths to the same physical SKILL.md should collapse to one');
});

test('dedupeInventory is a no-op for already-distinct inventories', () => {
  const inv = {
    skills: [{ name: 'a', plugin: 'p', path: 'Z:\\a\\SKILL.md' },
             { name: 'b', plugin: 'p', path: 'Z:\\b\\SKILL.md' }],
    agents: [{ name: 'x', plugin: 'q', path: 'Z:\\x.md' }],
    memory: [{ name: 'm.md', project: 'D--', path: 'Z:\\m.md' }],
    contextFiles: [{ name: 'CLAUDE.md', root: 'Z:\\', path: 'Z:\\CLAUDE.md' }],
  };
  const out = dedupeInventory(inv);
  assert.equal(out.skills.length, 2);
  assert.equal(out.agents.length, 1);
  assert.equal(out.memory.length, 1);
  assert.equal(out.contextFiles.length, 1);
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
