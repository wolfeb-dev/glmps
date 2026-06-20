// server/test/extract-claude.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClaudeEvents } from '../lib/extract-claude.js';

const SID = 's-1';
function assistantLine(toolUses) {
  return JSON.stringify({
    type: 'assistant', sessionId: SID, timestamp: '2026-06-05T10:00:00Z',
    message: { role: 'assistant', content: toolUses.map(t => ({ type: 'tool_use', ...t })) },
  });
}

test('skill invocation -> context lane skill event', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Skill', input: { skill: 'superpowers:brainstorming' } }]), SID);
  assert.equal(ev.length, 1);
  assert.match(JSON.stringify(ev[0]), /"kind":"skill"/);
  assert.equal(ev[0].lane, 'context');
  assert.equal(ev[0].label, 'superpowers:brainstorming');
});

test('Read of CLAUDE.md / memory / ordinary file classify differently', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Read', input: { file_path: 'C:\\Users\\w\\.claude\\CLAUDE.md' } },
    { id: 't2', name: 'Read', input: { file_path: 'C:\\Users\\w\\.claude\\projects\\D--\\memory\\MEMORY.md' } },
    { id: 't3', name: 'Read', input: { file_path: 'D:\\proj\\main.py' } },
  ]), SID);
  assert.deepEqual(ev.map(e => [e.kind, e.lane]), [
    ['context-file', 'context'], ['memory', 'context'], ['tool', 'feed']]);
});

test('Agent, mcp__, Edit, Bash classification', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Agent', input: { subagent_type: 'Explore', description: 'scan repo' } },
    { id: 't2', name: 'mcp__claude_ai_FMP__authenticate', input: {} },
    { id: 't3', name: 'Edit', input: { file_path: 'D:\\proj\\a.cs' } },
    { id: 't4', name: 'Bash', input: { command: 'git status', description: 'Show status' } },
  ]), SID);
  assert.deepEqual(ev.map(e => e.kind), ['agent', 'mcp', 'file-edit', 'command']);
  assert.deepEqual(ev.map(e => e.lane), ['context', 'context', 'feed', 'feed']);
  assert.equal(ev[0].label, 'Explore: scan repo');
});

test('non-assistant and malformed lines yield no events', () => {
  assert.deepEqual(extractClaudeEvents('{"type":"mode","mode":"normal"}', SID), []);
  assert.deepEqual(extractClaudeEvents('not json at all', SID), []);
});

test('Read of CLAUDE.md gets op:read', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Read', input: { file_path: 'C:\\u\\.claude\\CLAUDE.md' } },
  ]), SID);
  assert.equal(ev[0].op, 'read');
});

test('Write/Edit of acceptance.md classifies as context-file (context lane, diff)', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Edit', input: { file_path: 'D:\\glmps\\acceptance.md', old_string: 'a', new_string: 'b' } },
  ]), SID);
  assert.equal(ev[0].kind, 'context-file');
  assert.equal(ev[0].lane, 'context');
  assert.equal(ev[0].op, 'write');
  assert.ok(ev[0].change, 'should carry a change diff');
});

test('Write of CLAUDE.md gets op:write and change with old:null', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Write', input: { file_path: 'C:\\u\\.claude\\CLAUDE.md', content: 'new body' } },
  ]), SID);
  assert.equal(ev[0].op, 'write');
  assert.ok(ev[0].change, 'change present');
  assert.equal(ev[0].change.old, null);
  assert.deepEqual(ev[0].change.new, { text: 'new body', truncated: false });
});

test('Edit of memory file gets op:write and change with old/new', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Edit', input: {
      file_path: 'C:\\u\\.claude\\projects\\D--\\memory\\MEMORY.md',
      old_string: 'before', new_string: 'after',
    }},
  ]), SID);
  assert.equal(ev[0].op, 'write');
  assert.deepEqual(ev[0].change.old, { text: 'before', truncated: false });
  assert.deepEqual(ev[0].change.new, { text: 'after', truncated: false });
});

test('Read of memory file gets op:read, no change field', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Read', input: { file_path: 'C:\\u\\.claude\\projects\\D--\\memory\\FOO.md' } },
  ]), SID);
  assert.equal(ev[0].op, 'read');
  assert.equal(ev[0].change, undefined);
});

test('Edit of ordinary file gets no op field', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Edit', input: { file_path: 'D:\\proj\\main.py', old_string: 'x', new_string: 'y' } },
  ]), SID);
  assert.equal(ev[0].op, undefined);
  assert.equal(ev[0].change, undefined);
});

test('Edit carries +/- line counts for the feed badge', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Edit', input: { file_path: 'D:\\proj\\main.py', old_string: 'a\nb', new_string: 'a\nb\nc\nd' } },
  ]), SID);
  assert.equal(ev[0].kind, 'file-edit');
  assert.equal(ev[0].del, 2);
  assert.equal(ev[0].add, 4);
});

test('MultiEdit is a file-edit with summed +/- counts', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'MultiEdit', input: { file_path: 'D:\\proj\\x.js', edits: [
      { old_string: 'a', new_string: 'a\nb' },
      { old_string: 'c\nd', new_string: 'c' },
    ] } },
  ]), SID);
  assert.equal(ev[0].kind, 'file-edit');
  assert.equal(ev[0].add, 3);
  assert.equal(ev[0].del, 3);
});

test('Bash git commit -> git event in context lane with message', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Bash', input: { command: 'git commit -m "feat: add thing"', description: 'commit changes' } },
  ]), SID);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'git');
  assert.equal(ev[0].lane, 'context');
  assert.equal(ev[0].gitOp, 'commit');
  assert.equal(ev[0].label, 'commit: feat: add thing');
});

test('Agent tool_use with model:haiku yields event.model === haiku', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Do task', model: 'haiku' } },
  ]), SID);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'agent');
  assert.equal(ev[0].model, 'haiku');
});

test('Agent tool_use without model yields event.model === null', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Do task' } },
  ]), SID);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'agent');
  assert.equal(ev[0].model, null);
});

test('Workflow event has model null', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Workflow', input: { name: 'my-workflow' } },
  ]), SID);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'agent');
  assert.equal(ev[0].model, null);
});

test('Bash git status -> regular command event (not git kind)', () => {
  const ev = extractClaudeEvents(assistantLine([
    { id: 't1', name: 'Bash', input: { command: 'git status', description: 'Show status' } },
  ]), SID);
  assert.equal(ev[0].kind, 'command');
  assert.equal(ev[0].lane, 'feed');
});
