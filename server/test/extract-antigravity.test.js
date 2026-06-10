// server/test/extract-antigravity.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAgEvents, unquote } from '../lib/extract-antigravity.js';

const SID = 'ag-1';
const line = (toolCalls, extra = {}) => JSON.stringify({
  step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
  created_at: '2026-06-05T10:00:00Z', tool_calls: toolCalls, ...extra,
});

test('unquote strips JSON-encoded wrapping', () => {
  assert.equal(unquote('"d:\\\\proj\\\\x.md"'), 'd:\\proj\\x.md');
  assert.equal(unquote('plain'), 'plain');
  assert.equal(unquote(undefined), '');
});

test('skill file view -> skill event; AGENTS.md -> context-file', () => {
  const ev = extractAgEvents(line([
    { name: 'view_file', args: { AbsolutePath: '"d:\\\\p\\\\.agents\\\\skills\\\\nq\\\\SKILL.md"', IsSkillFile: '"true"' } },
    { name: 'view_file', args: { AbsolutePath: '"d:\\\\p\\\\AGENTS.md"' } },
    { name: 'view_file', args: { AbsolutePath: '"d:\\\\p\\\\main.py"' } },
  ]), SID);
  assert.deepEqual(ev.map(e => [e.kind, e.lane]), [
    ['skill', 'context'], ['context-file', 'context'], ['tool', 'feed']]);
});

test('writes and commands classify; user input becomes turn marker', () => {
  const ev = extractAgEvents(line([
    { name: 'write_to_file', args: { TargetFile: '"d:\\\\p\\\\a.py"' } },
    { name: 'run_command', args: { CommandLine: '"uv run x.py"', toolSummary: '"Run x"' } },
  ]), SID);
  assert.deepEqual(ev.map(e => e.kind), ['file-edit', 'command']);
  const turn = extractAgEvents(JSON.stringify({
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
    created_at: '2026-06-05T10:00:00Z', content: '<USER_REQUEST>\ndo the thing\n</USER_REQUEST>' }), SID);
  assert.equal(turn[0].kind, 'tool');
  assert.equal(turn[0].lane, 'feed');
  assert.match(turn[0].label, /do the thing/);
});

test('malformed line yields no events', () => {
  assert.deepEqual(extractAgEvents('garbage', SID), []);
});

test('view_file of AGENTS.md gets op:read', () => {
  const ev = extractAgEvents(line([
    { name: 'view_file', args: { AbsolutePath: '"d:\\\\p\\\\AGENTS.md"' } },
  ]), SID);
  assert.equal(ev[0].op, 'read');
});

test('write_to_file on a non-context path stays file-edit feed, no op', () => {
  const ev = extractAgEvents(line([
    { name: 'write_to_file', args: { TargetFile: '"d:\\\\proj\\\\main.py"', CodeContent: '"content"' } },
  ]), SID);
  assert.equal(ev[0].kind, 'file-edit');
  assert.equal(ev[0].lane, 'feed');
  assert.equal(ev[0].op, undefined);
});

test('write_to_file on CLAUDE.md -> context-file context lane, op:write, change.old:null', () => {
  const ev = extractAgEvents(line([
    { name: 'write_to_file', args: {
      TargetFile: '"d:\\\\p\\\\CLAUDE.md"',
      CodeContent: '"new content"',
    }},
  ]), SID);
  assert.equal(ev[0].kind, 'context-file');
  assert.equal(ev[0].lane, 'context');
  assert.equal(ev[0].op, 'write');
  assert.ok(ev[0].change, 'change present');
  assert.equal(ev[0].change.old, null);
  assert.deepEqual(ev[0].change.new, { text: 'new content', truncated: false });
});

test('replace_file_content on memory path -> memory context lane, op:write, change has both sides', () => {
  const ev = extractAgEvents(line([
    { name: 'replace_file_content', args: {
      TargetFile: '"d:\\\\u\\\\.claude\\\\projects\\\\D--\\\\memory\\\\M.md"',
      TargetContent: '"old body"',
      ReplacementContent: '"new body"',
    }},
  ]), SID);
  assert.equal(ev[0].kind, 'memory');
  assert.equal(ev[0].lane, 'context');
  assert.equal(ev[0].op, 'write');
  assert.deepEqual(ev[0].change.old, { text: 'old body', truncated: false });
  assert.deepEqual(ev[0].change.new, { text: 'new body', truncated: false });
});

test('run_command with git commit -> git event in context lane', () => {
  const ev = extractAgEvents(line([
    { name: 'run_command', args: {
      CommandLine: '"git commit -m \\"feat: update memory\\""',
      toolSummary: '"commit"',
    }},
  ]), SID);
  assert.equal(ev[0].kind, 'git');
  assert.equal(ev[0].lane, 'context');
  assert.equal(ev[0].gitOp, 'commit');
});

test('run_command with non-git command -> regular command event', () => {
  const ev = extractAgEvents(line([
    { name: 'run_command', args: { CommandLine: '"uv run x.py"', toolSummary: '"Run x"' } },
  ]), SID);
  assert.equal(ev[0].kind, 'command');
  assert.equal(ev[0].lane, 'feed');
});
