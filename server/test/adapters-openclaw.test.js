// server/test/adapters-openclaw.test.js
// Tests for the SPECULATIVE openclaw adapter (fixture-based — no live data required).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as openclaw from '../lib/adapters/openclaw.js';

// ── detect ────────────────────────────────────────────────────────────────────

test('openclaw detect: returns dataDirs containing .openclaw and .clawdbot', () => {
  const { dataDirs } = openclaw.detect({});
  assert.ok(Array.isArray(dataDirs));
  assert.ok(dataDirs.some(d => d.includes('.openclaw')));
  assert.ok(dataDirs.some(d => d.includes('.clawdbot')));
});

test('openclaw detect: installed is a boolean', () => {
  const { installed } = openclaw.detect({});
  assert.equal(typeof installed, 'boolean');
});

// ── extractLine ───────────────────────────────────────────────────────────────

test('openclaw extractLine: role=user -> user feed event', () => {
  const line = JSON.stringify({
    role: 'user',
    content: 'Refactor the auth module',
    timestamp: '2026-01-01T00:00:00Z',
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool');
  assert.equal(events[0].lane, 'feed');
  assert.equal(events[0].tool, 'user');
  assert.ok(events[0].label.includes('Refactor'));
});

test('openclaw extractLine: type=user -> user feed event', () => {
  const line = JSON.stringify({
    type: 'user',
    content: 'Write a test for this',
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.ok(events[0].label.includes('Write a test'));
});

test('openclaw extractLine: type=message role=user -> user feed event', () => {
  const line = JSON.stringify({
    type: 'message',
    role: 'user',
    text: 'Summarize the diff',
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.ok(events[0].label.includes('Summarize'));
});

test('openclaw extractLine: type=toolCall -> tool event with name', () => {
  const line = JSON.stringify({
    type: 'toolCall',
    name: 'read_file',
    timestamp: null,
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool');
  assert.equal(events[0].label, 'read_file');
});

test('openclaw extractLine: tool_use field present -> tool event', () => {
  const line = JSON.stringify({
    tool_use: { name: 'bash' },
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool');
  assert.equal(events[0].label, 'bash');
});

test('openclaw extractLine: type=tool_result -> tool event', () => {
  const line = JSON.stringify({
    type: 'tool_result',
    tool: 'bash',
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool');
});

test('openclaw extractLine: junk line -> no events', () => {
  const line = JSON.stringify({ something_else: true, value: 42 });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 0);
});

test('openclaw extractLine: malformed JSON -> no throw, no events', () => {
  assert.doesNotThrow(() => {
    const events = openclaw.extractLine('{bad json}}}', 'sid1');
    assert.equal(events.length, 0);
  });
});

test('openclaw extractLine: user with array content -> concatenates text', () => {
  const line = JSON.stringify({
    role: 'user',
    content: [{ text: 'Hello' }, { text: ' world' }],
  });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.ok(events[0].label.includes('Hello'));
});

test('openclaw extractLine: user with no text -> no event', () => {
  const line = JSON.stringify({ role: 'user', content: '' });
  const events = openclaw.extractLine(line, 'sid1');
  assert.equal(events.length, 0);
});
