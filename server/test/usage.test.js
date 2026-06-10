// server/test/usage.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextNow, splitUsage } from '../lib/usage.js';

const events = [
  { kind: 'skill', lane: 'context', label: 'superpowers:brainstorming', path: null, ts: 1, sessionId: 's1' },
  { kind: 'context-file', lane: 'context', label: 'C:\\u\\CLAUDE.md', path: 'C:\\u\\CLAUDE.md', ts: 2, sessionId: 's1' },
  { kind: 'context-file', lane: 'context', label: 'C:\\u\\CLAUDE.md', path: 'C:\\u\\CLAUDE.md', ts: 3, sessionId: 's1' },
  { kind: 'memory', lane: 'context', label: 'C:\\u\\memory\\MEMORY.md', path: 'C:\\u\\memory\\MEMORY.md', ts: 4, sessionId: 's1' },
  { kind: 'command', lane: 'feed', label: 'git status', path: null, ts: 5, sessionId: 's1' },
];

test('contextNow dedups by kind+key keeping latest ts, excludes feed lane', () => {
  const now = contextNow(events);
  assert.equal(now.length, 3);
  const ctx = now.find(e => e.kind === 'context-file');
  assert.equal(ctx.ts, 3);
  assert.ok(!now.some(e => e.lane === 'feed'));
});

test('contextNow sorts newest first', () => {
  const now = contextNow(events);
  assert.deepEqual(now.map(e => e.kind), ['memory', 'context-file', 'skill']);
});

test('splitUsage marks inventory items used when events reference them', () => {
  const inventory = {
    skills: [
      { name: 'brainstorming', plugin: 'superpowers', path: 'x' },
      { name: 'dcf', plugin: 'financial-analysis', path: 'y' }],
    memory: [{ name: 'MEMORY.md', path: 'C:\\u\\memory\\MEMORY.md' }],
    agents: [{ name: 'Explore', path: 'z' }],
    contextFiles: [{ name: 'CLAUDE.md', path: 'C:\\u\\CLAUDE.md' }],
  };
  const { used, unused } = splitUsage(inventory, events);
  assert.deepEqual(used.skills.map(s => s.name), ['brainstorming']);
  assert.deepEqual(unused.skills.map(s => s.name), ['dcf']);
  assert.equal(used.memory.length, 1);
  assert.equal(unused.agents.length, 1);
  assert.equal(used.contextFiles.length, 1);
});

test('splitUsage: agent events match agents; forward/back slashes normalize', () => {
  const inventory = {
    skills: [], memory: [], contextFiles: [{ name: 'AGENTS.md', path: 'D:\\p\\AGENTS.md' }],
    agents: [{ name: 'Explore', path: 'z' }],
  };
  const ev = [
    { kind: 'agent', lane: 'context', label: 'Explore: scan repo', path: null, ts: 1, sessionId: 's1' },
    { kind: 'context-file', lane: 'context', label: 'D:/p/AGENTS.md', path: 'D:/p/AGENTS.md', ts: 2, sessionId: 's1' },
  ];
  const { used } = splitUsage(inventory, ev);
  assert.equal(used.agents.length, 1);
  assert.equal(used.contextFiles.length, 1);
});

test('contextNow orders correctly with mixed ISO-string and numeric ts', () => {
  const ev = [
    { kind: 'skill', lane: 'context', label: 'a', path: null, ts: '2026-06-05T10:00:00Z', sessionId: 's' },
    { kind: 'memory', lane: 'context', label: 'b', path: null, ts: Date.parse('2026-06-05T11:00:00Z'), sessionId: 's' },
  ];
  assert.deepEqual(contextNow(ev).map(e => e.label), ['b', 'a']);
});
