// server/test/agent-fleet.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAgentFile, groupOf, scanFleet, DEFAULT_REGISTRY } from '../lib/agent-fleet.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-fleet-'));
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// parseAgentFile
// ---------------------------------------------------------------------------

test('parseAgentFile extracts name, role, tools, and model from frontmatter', () => {
  const text = `---
name: backtest-skeptic
description: validates backtests adversarially
model: opus
tools: Read, Grep, Glob, Bash, WebFetch
---

body content here
`;
  const agent = parseAgentFile(text);
  assert.equal(agent.name, 'backtest-skeptic');
  assert.equal(agent.role, 'validates backtests adversarially');
  assert.deepEqual(agent.tools, ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch']);
  assert.equal(agent.model, 'opus');
});

test('parseAgentFile access is write when tools include Edit', () => {
  const text = `---
name: strategy-coder
description: implements strategy specs
model: sonnet
tools: Read, Edit, Write, Bash, Glob, Grep
---
`;
  const agent = parseAgentFile(text);
  assert.equal(agent.access, 'write');
});

test('parseAgentFile access is write when tools include Write', () => {
  const text = `---
name: writer-agent
description: writes files
tools: Read, Write, Grep
---
`;
  const agent = parseAgentFile(text);
  assert.equal(agent.access, 'write');
});

test('parseAgentFile access is read-only when tools include Bash but not Edit/Write', () => {
  const text = `---
name: bash-agent
description: runs bash commands
tools: Read, Bash
---
`;
  const agent = parseAgentFile(text);
  // Bash alone is NOT write — read-only analysis agents run scripts without editing.
  assert.equal(agent.access, 'read-only');
});

test('parseAgentFile access is read-only for Read/Grep-only agent', () => {
  const text = `---
name: scout
description: explores code
tools: Read, Grep, Glob
---
`;
  const agent = parseAgentFile(text);
  assert.deepEqual(agent.tools, ['Read', 'Grep', 'Glob']);
  assert.equal(agent.access, 'read-only');
});

test('parseAgentFile tools * becomes ["*"] and access is write', () => {
  const text = `---
name: general-purpose
description: catch-all agent
tools: *
---
`;
  const agent = parseAgentFile(text);
  assert.deepEqual(agent.tools, ['*']);
  assert.equal(agent.access, 'write');
});

test('parseAgentFile "All tools" becomes ["*"] and access is write', () => {
  const text = `---
name: all-tools-agent
description: has all tools
tools: All tools
---
`;
  const agent = parseAgentFile(text);
  assert.deepEqual(agent.tools, ['*']);
  assert.equal(agent.access, 'write');
});

test('parseAgentFile "all tools" (lowercase) becomes ["*"] and access is write', () => {
  const text = `---
name: all-tools-agent
description: has all tools
tools: all tools
---
`;
  const agent = parseAgentFile(text);
  assert.deepEqual(agent.tools, ['*']);
  assert.equal(agent.access, 'write');
});

test('parseAgentFile model is null when not present in frontmatter', () => {
  const text = `---
name: no-model-agent
description: no model specified
tools: Read, Grep
---
`;
  const agent = parseAgentFile(text);
  assert.equal(agent.model, null);
});

test('parseAgentFile handles missing frontmatter gracefully', () => {
  const text = 'Just a plain body with no frontmatter.';
  const agent = parseAgentFile(text);
  assert.equal(agent.name, null);
  assert.equal(agent.role, null);
  assert.deepEqual(agent.tools, []);
  assert.equal(agent.model, null);
  assert.equal(agent.access, 'read-only');
});

test('parseAgentFile handles space-separated tools', () => {
  const text = `---
name: space-tools
description: space separated
tools: Read Grep Glob
---
`;
  const agent = parseAgentFile(text);
  assert.deepEqual(agent.tools, ['Read', 'Grep', 'Glob']);
});

// ---------------------------------------------------------------------------
// groupOf
// ---------------------------------------------------------------------------

test('groupOf maps research/scout names to scout', () => {
  assert.equal(groupOf({ name: 'strategy-scout', role: 'researches ideas' }), 'scout');
  assert.equal(groupOf({ name: 'explore', role: 'searches code' }), 'scout');
  assert.equal(groupOf({ name: 'code-explorer', role: 'explores files' }), 'scout');
  assert.equal(groupOf({ name: 'researcher', role: '' }), 'scout');
});

test('groupOf maps coder/implement names to implement', () => {
  assert.equal(groupOf({ name: 'strategy-coder', role: 'implements specs' }), 'implement');
  assert.equal(groupOf({ name: 'ninjascript-coder', role: '' }), 'implement');
  assert.equal(groupOf({ name: 'code-simplifier', role: 'simplifies code' }), 'implement');
  assert.equal(groupOf({ name: 'builder', role: 'implements features' }), 'implement');
});

test('groupOf maps skeptic/adversary/review names to verify', () => {
  assert.equal(groupOf({ name: 'backtest-skeptic', role: 'validates backtests' }), 'verify');
  assert.equal(groupOf({ name: 'adversary', role: 'adversarial agent' }), 'verify');
  assert.equal(groupOf({ name: 'code-reviewer', role: 'reviews diffs' }), 'verify');
  assert.equal(groupOf({ name: 'gate-keeper', role: '' }), 'verify');
  assert.equal(groupOf({ name: 'validator', role: '' }), 'verify');
});

test('groupOf maps plan/architect names to plan', () => {
  assert.equal(groupOf({ name: 'plan', role: 'plans features' }), 'plan');
  assert.equal(groupOf({ name: 'architect', role: '' }), 'plan');
  assert.equal(groupOf({ name: 'strategy-architect', role: '' }), 'plan');
});

test('groupOf maps git/gh names to git', () => {
  assert.equal(groupOf({ name: 'git-agent', role: '' }), 'git');
  assert.equal(groupOf({ name: 'gh-helper', role: '' }), 'git');
});

test('groupOf returns general for unrecognized agents', () => {
  assert.equal(groupOf({ name: 'foo-bar', role: 'does something' }), 'general');
  assert.equal(groupOf({ name: 'random', role: '' }), 'general');
});

test('groupOf: specific buckets beat the generic "research"/scout keyword', () => {
  // Real-world descriptions contain "research" yet must classify by their specific role.
  assert.equal(groupOf({ name: 'backtest-skeptic', role: 'adversarially validate any backtest, strategy result, or research finding' }), 'verify');
  assert.equal(groupOf({ name: 'strategy-coder', role: 'implements a finalized spec into a Python research repo' }), 'implement');
  assert.equal(groupOf({ name: 'claude-code-guide', role: 'answers Claude Code / SDK / API questions' }), 'scout');
});

// ---------------------------------------------------------------------------
// scanFleet
// ---------------------------------------------------------------------------

test('scanFleet parses .md files in agentsDir with source:assets and correct group/access', () => {
  const tmp = mkTmp();
  const agentsDir = path.join(tmp, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  fs.writeFileSync(path.join(agentsDir, 'backtest-skeptic.md'), `---
name: backtest-skeptic
description: validates backtests adversarially
model: opus
tools: Read, Grep, Glob, Bash, WebFetch
---
body
`);
  fs.writeFileSync(path.join(agentsDir, 'strategy-coder.md'), `---
name: strategy-coder
description: implements strategy specs
model: sonnet
tools: Read, Edit, Write, Bash, Glob, Grep
---
body
`);
  fs.writeFileSync(path.join(agentsDir, 'scout.md'), `---
name: strategy-scout
description: researches strategy ideas
model: sonnet
tools: Read, Grep, Glob, WebFetch, WebSearch
---
body
`);

  const result = scanFleet({ agentsDir, registry: [] });
  assert.equal(result.agents.length, 3);

  const skeptic = result.agents.find(a => a.name === 'backtest-skeptic');
  assert.ok(skeptic, 'backtest-skeptic should be present');
  assert.equal(skeptic.source, 'assets');
  assert.equal(skeptic.group, 'verify');
  // backtest-skeptic runs Bash for analysis but never edits → read-only
  assert.equal(skeptic.access, 'read-only');
  assert.ok(skeptic.path, 'should have path');

  const coder = result.agents.find(a => a.name === 'strategy-coder');
  assert.ok(coder, 'strategy-coder should be present');
  assert.equal(coder.source, 'assets');
  assert.equal(coder.group, 'implement');
  assert.equal(coder.access, 'write');

  const scout = result.agents.find(a => a.name === 'strategy-scout');
  assert.ok(scout, 'strategy-scout should be present');
  assert.equal(scout.source, 'assets');
  assert.equal(scout.group, 'scout');
  assert.equal(scout.access, 'read-only');
});

test('scanFleet appends registry agents with source:registry', () => {
  const tmp = mkTmp();
  const agentsDir = path.join(tmp, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'file-agent.md'), `---
name: file-agent
description: reads files
tools: Read, Grep
---
`);

  const registry = [
    { name: 'Explore', role: 'fast read-only search', tools: ['Read', 'Grep', 'Glob'], model: null, access: 'read-only' },
    { name: 'Plan', role: 'plans features', tools: ['Read', 'Grep', 'Glob'], model: null, access: 'read-only' },
  ];

  const result = scanFleet({ agentsDir, registry });
  const names = result.agents.map(a => a.name);
  assert.ok(names.includes('file-agent'), 'file-agent from dir should be present');
  assert.ok(names.includes('Explore'), 'Explore from registry should be present');
  assert.ok(names.includes('Plan'), 'Plan from registry should be present');

  const explore = result.agents.find(a => a.name === 'Explore');
  assert.equal(explore.source, 'registry');
  const plan = result.agents.find(a => a.name === 'Plan');
  assert.equal(plan.source, 'registry');
});

test('scanFleet backtest-skeptic and adversary get runtime:antigravity and reasoning:max', () => {
  const tmp = mkTmp();
  const agentsDir = path.join(tmp, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  fs.writeFileSync(path.join(agentsDir, 'backtest-skeptic.md'), `---
name: backtest-skeptic
description: validates backtests
tools: Read, Grep
---
`);
  fs.writeFileSync(path.join(agentsDir, 'adversary.md'), `---
name: adversary
description: adversarial agent
tools: Read, Grep
---
`);
  fs.writeFileSync(path.join(agentsDir, 'normal-agent.md'), `---
name: normal-agent
description: a normal agent
tools: Read, Grep
---
`);

  const result = scanFleet({ agentsDir, registry: [] });

  const skeptic = result.agents.find(a => a.name === 'backtest-skeptic');
  assert.equal(skeptic.runtime, 'antigravity');
  assert.equal(skeptic.reasoning, 'max');

  const adversary = result.agents.find(a => a.name === 'adversary');
  assert.equal(adversary.runtime, 'antigravity');
  assert.equal(adversary.reasoning, 'max');

  const normal = result.agents.find(a => a.name === 'normal-agent');
  assert.equal(normal.runtime, 'claude');
  assert.equal(normal.reasoning, 'default');
});

test('scanFleet missing agentsDir returns only registry agents, does not throw', () => {
  const result = scanFleet({
    agentsDir: 'Z:\\no-such-dir-9999',
    registry: [
      { name: 'Explore', role: 'fast search', tools: ['Read'], model: null, access: 'read-only' },
    ],
  });
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].name, 'Explore');
  assert.equal(result.agents[0].source, 'registry');
});

test('scanFleet with no registry argument defaults to DEFAULT_REGISTRY', () => {
  const result = scanFleet({ agentsDir: 'Z:\\no-such-dir-9999' });
  assert.ok(result.agents.length > 0, 'should have default registry agents');
  assert.ok(result.agents.every(a => a.source === 'registry'), 'all should be from registry');
});

test('DEFAULT_REGISTRY contains expected harness agents', () => {
  const names = DEFAULT_REGISTRY.map(a => a.name);
  assert.ok(names.includes('Explore'), 'should include Explore');
  assert.ok(names.includes('Plan'), 'should include Plan');
  assert.ok(names.includes('code-simplifier'), 'should include code-simplifier');
  assert.ok(names.includes('claude-code-guide'), 'should include claude-code-guide');
  assert.ok(names.includes('statusline-setup'), 'should include statusline-setup');
  // general-purpose agent
  assert.ok(names.some(n => n === 'general-purpose' || n.includes('general')),
    'should include a general-purpose agent');
  assert.ok(names.includes('git'), 'should include the git subagent');
  assert.ok(names.includes('adversary'), 'should include the adversary agent');
});

test('DEFAULT_REGISTRY: git is write/group:git (claude), adversary is verify/read-only (antigravity·max)', () => {
  const result = scanFleet({ agentsDir: 'Z:\\no-such-dir-9999' });
  const git = result.agents.find(a => a.name === 'git');
  assert.ok(git, 'git present');
  assert.equal(git.group, 'git');
  assert.equal(git.access, 'write');
  assert.equal(git.runtime, 'claude');
  const adv = result.agents.find(a => a.name === 'adversary');
  assert.ok(adv, 'adversary present');
  assert.equal(adv.group, 'verify');
  assert.equal(adv.access, 'read-only');
  assert.equal(adv.runtime, 'antigravity');
  assert.equal(adv.reasoning, 'max');
});

test('scanFleet skips non-.md files in agentsDir', () => {
  const tmp = mkTmp();
  const agentsDir = path.join(tmp, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'README.txt'), 'not an agent');
  fs.writeFileSync(path.join(agentsDir, 'config.json'), '{}');
  fs.writeFileSync(path.join(agentsDir, 'real-agent.md'), `---
name: real-agent
description: a real agent
tools: Read
---
`);

  const result = scanFleet({ agentsDir, registry: [] });
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].name, 'real-agent');
});

test('each agent object has the full expected shape', () => {
  const tmp = mkTmp();
  const agentsDir = path.join(tmp, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'test-agent.md'), `---
name: test-agent
description: a test agent
model: haiku
tools: Read, Grep
---
`);

  const result = scanFleet({ agentsDir, registry: [] });
  const agent = result.agents[0];

  assert.ok('name' in agent, 'has name');
  assert.ok('role' in agent, 'has role');
  assert.ok('tools' in agent, 'has tools');
  assert.ok('model' in agent, 'has model');
  assert.ok('access' in agent, 'has access');
  assert.ok('group' in agent, 'has group');
  assert.ok('source' in agent, 'has source');
  assert.ok('runtime' in agent, 'has runtime');
  assert.ok('reasoning' in agent, 'has reasoning');
  assert.ok('path' in agent, 'has path');

  assert.equal(typeof agent.name, 'string');
  assert.equal(typeof agent.role, 'string');
  assert.ok(Array.isArray(agent.tools));
  assert.equal(agent.model, 'haiku');
  assert.equal(agent.access, 'read-only');
  assert.equal(agent.source, 'assets');
  assert.equal(agent.runtime, 'claude');
  assert.equal(agent.reasoning, 'default');
});

// ---------------------------------------------------------------------------
// pluginsCacheDir scanning + dedup
// ---------------------------------------------------------------------------

test('scanFleet finds agents/*.md inside pluginsCacheDir recursively and marks source:plugin', () => {
  const tmp = mkTmp();
  // Structure: <cache>/<pub>/<plug>/<ver>/agents/foo.md
  const agentsDir = path.join(tmp, 'pub', 'myplugin', '1.0.0', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'foo.md'), `---
name: foo-agent
description: plugin foo agent
tools: Read, Grep
---
body
`);

  const result = scanFleet({ pluginsCacheDir: tmp, registry: [] });
  assert.equal(result.agents.length, 1);
  const agent = result.agents[0];
  assert.equal(agent.name, 'foo-agent');
  assert.equal(agent.source, 'plugin');
  assert.ok(agent.path, 'should have path');
  assert.ok(agent.path.endsWith('foo.md') || agent.path.includes('foo.md'), 'path points at foo.md');
  assert.equal(agent.access, 'read-only');
});

test('scanFleet dedup: plugin .md for a registry name wins (has path; registry stub dropped)', () => {
  const tmp = mkTmp();
  // Registry has 'code-simplifier'; plugin dir ALSO has a code-simplifier.md
  const agentsDir = path.join(tmp, 'pub', 'simplifier-plugin', '2.0.0', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'code-simplifier.md'), `---
name: code-simplifier
description: plugin-provided simplifier with a real file
tools: Read, Edit
---
body
`);

  const registry = [
    { name: 'code-simplifier', role: 'registry stub — no file', tools: ['Edit', 'Read'], model: null, access: 'write' },
    { name: 'Explore',         role: 'fast search', tools: ['Read', 'Grep', 'Glob'], model: null, access: 'read-only' },
  ];

  const result = scanFleet({ pluginsCacheDir: tmp, registry });
  // Should have exactly 2 agents: the plugin code-simplifier + Explore from registry
  assert.equal(result.agents.length, 2);

  const cs = result.agents.find(a => (a.name ?? '').toLowerCase() === 'code-simplifier');
  assert.ok(cs, 'code-simplifier should be present');
  assert.equal(cs.source, 'plugin');
  assert.ok(cs.path, 'plugin agent must have a path');

  const explore = result.agents.find(a => a.name === 'Explore');
  assert.ok(explore, 'Explore from registry should still be present');
  assert.equal(explore.source, 'registry');
});
