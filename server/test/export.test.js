// server/test/export.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSessionContent, toMarkdown, toJson } from '../../web/export.js';

test('extractSessionContent: non-array input returns empty array', () => {
  assert.deepEqual(extractSessionContent(null), []);
  assert.deepEqual(extractSessionContent(undefined), []);
  assert.deepEqual(extractSessionContent('nope'), []);
});

test('extractSessionContent: normalizes GLMPS events by kind', () => {
  const events = [
    { kind: 'skill', label: 'frontend-design' },
    { kind: 'tool', op: 'read', label: 'app.js' },
    { kind: 'git', label: 'commit: fix bug' },
    { kind: 'agent', model: 'opus', label: 'subagent' },
  ];
  const parts = extractSessionContent(events);
  assert.deepEqual(parts, [
    { kind: 'skill', text: 'frontend-design' },
    { kind: 'tool', text: 'read app.js' },
    { kind: 'git', text: 'commit: fix bug' },
    { kind: 'agent', text: 'opus: subagent' },
  ]);
});

test('extractSessionContent: includes write change payload as a change part', () => {
  const events = [
    { kind: 'tool', op: 'write', label: 'x.js',
      change: { old: { text: 'a' }, new: { text: 'b' } } },
  ];
  const parts = extractSessionContent(events);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].kind, 'tool');
  assert.equal(parts[0].text, 'write x.js');
  assert.equal(parts[1].kind, 'change');
  assert.match(parts[1].text, /- a/);
  assert.match(parts[1].text, /\+ b/);
});

test('extractSessionContent: skips empty/blank labels', () => {
  const parts = extractSessionContent([
    { kind: 'tool', label: '' },
    { kind: 'tool', label: '   ' },
    { kind: 'skill', label: 'real' },
  ]);
  assert.deepEqual(parts, [{ kind: 'skill', text: 'real' }]);
});

test('extractSessionContent: flattens raw message objects (string content)', () => {
  const items = [{ message: { role: 'user', content: 'please fix it' } }];
  const parts = extractSessionContent(items);
  assert.deepEqual(parts, [{ kind: 'user', text: 'please fix it' }]);
});

test('extractSessionContent: flattens raw message array content (text/thinking/tool/result)', () => {
  const items = [{
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'here is the fix' },
        { type: 'tool_use', name: 'Edit' },
        { type: 'tool_result', content: 'ok', is_error: false },
        { type: 'tool_result', content: 'boom', is_error: true },
      ],
    },
  }];
  const parts = extractSessionContent(items);
  assert.deepEqual(parts.map(p => p.kind), ['thinking', 'assistant', 'tool', 'result', 'error']);
  assert.equal(parts[3].text, 'ok');
  assert.equal(parts[4].text, 'boom');
});

test('toMarkdown: emits title, meta block, and per-part sections', () => {
  const md = toMarkdown(
    { title: 'My Session', sessionId: 'abc123', tool: 'claude', model: 'opus', exportedAt: '2026-06-08' },
    [{ kind: 'user', text: 'hello' }, { kind: 'change', text: '- a\n+ b' }],
  );
  assert.match(md, /^# My Session/);
  assert.match(md, /- Session: `abc123`/);
  assert.match(md, /- Tool: claude/);
  assert.match(md, /## user\nhello/);
  // change kind is fenced
  assert.match(md, /## change\n```\n- a\n\+ b\n```/);
});

test('toMarkdown: falls back to sessionId then "Session" for the title', () => {
  assert.match(toMarkdown({ sessionId: 'sid' }, []), /^# sid/);
  assert.match(toMarkdown({}, []), /^# Session/);
});

test('toJson: round-trips a structured document with meta and parts', () => {
  const parts = [{ kind: 'tool', text: 'read app.js' }];
  const json = toJson({ title: 'T', sessionId: 's', tool: 'claude', model: 'opus', exportedAt: 'now' }, parts);
  const obj = JSON.parse(json);
  assert.equal(obj.title, 'T');
  assert.equal(obj.sessionId, 's');
  assert.equal(obj.tool, 'claude');
  assert.deepEqual(obj.parts, parts);
});

test('toJson: missing meta fields become null and parts default to []', () => {
  const obj = JSON.parse(toJson());
  assert.equal(obj.title, null);
  assert.equal(obj.sessionId, null);
  assert.deepEqual(obj.parts, []);
});
