// server/test/adapters-hermes.test.js
// Tests for the hermes adapter (fixture-based — no live sessions required).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hermes from '../lib/adapters/hermes.js';

// ── detect ────────────────────────────────────────────────────────────────────

test('hermes detect: returns dataDirs with .hermes path', () => {
  const { dataDirs } = hermes.detect({});
  assert.ok(Array.isArray(dataDirs));
  assert.ok(dataDirs.some(d => d.includes('.hermes')));
});

test('hermes detect: installed is a boolean', () => {
  const { installed } = hermes.detect({});
  assert.equal(typeof installed, 'boolean');
});

// ── extractLine ───────────────────────────────────────────────────────────────

test('hermes extractLine: role=user string content -> user feed event', () => {
  const line = JSON.stringify({
    role: 'user',
    content: 'Deploy the staging environment',
    timestamp: '2026-01-01T00:00:00Z',
  });
  const events = hermes.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tool');
  assert.equal(events[0].lane, 'feed');
  assert.equal(events[0].tool, 'user');
  assert.ok(events[0].label.includes('Deploy'));
});

test('hermes extractLine: role=user array content -> concatenates text', () => {
  const line = JSON.stringify({
    role: 'user',
    content: [{ text: 'Run ' }, { text: 'tests' }],
  });
  const events = hermes.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.ok(events[0].label.includes('Run'));
});

test('hermes extractLine: role=user empty content -> no event', () => {
  const line = JSON.stringify({ role: 'user', content: '' });
  const events = hermes.extractLine(line, 'sid1');
  assert.equal(events.length, 0);
});

test('hermes extractLine: role=assistant with tool_calls -> one event per call', () => {
  const line = JSON.stringify({
    role: 'assistant',
    content: null,
    tool_calls: [
      { function: { name: 'bash' }, id: 'tc1' },
      { function: { name: 'read_file' }, id: 'tc2' },
    ],
  });
  const events = hermes.extractLine(line, 'sid1');
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'tool');
  assert.equal(events[0].label, 'bash');
  assert.equal(events[1].label, 'read_file');
});

test('hermes extractLine: role=assistant without tool_calls -> no events', () => {
  const line = JSON.stringify({
    role: 'assistant',
    content: 'I have completed the task.',
  });
  const events = hermes.extractLine(line, 'sid1');
  assert.equal(events.length, 0);
});

test('hermes extractLine: role=assistant with empty tool_calls -> no events', () => {
  const line = JSON.stringify({ role: 'assistant', content: 'ok', tool_calls: [] });
  const events = hermes.extractLine(line, 'sid1');
  assert.equal(events.length, 0);
});

test('hermes extractLine: role=tool -> skip, no events', () => {
  const line = JSON.stringify({ role: 'tool', content: 'output here', tool_call_id: 'tc1' });
  const events = hermes.extractLine(line, 'sid1');
  assert.equal(events.length, 0);
});

test('hermes extractLine: tool_call with name field directly -> uses name', () => {
  const line = JSON.stringify({
    role: 'assistant',
    tool_calls: [{ name: 'search_web' }],
  });
  const events = hermes.extractLine(line, 'sid1');
  assert.equal(events.length, 1);
  assert.equal(events[0].label, 'search_web');
});

test('hermes extractLine: junk line -> no events', () => {
  const line = JSON.stringify({ foo: 'bar', baz: 42 });
  const events = hermes.extractLine(line, 'sid1');
  assert.equal(events.length, 0);
});

test('hermes extractLine: malformed JSON -> no throw, no events', () => {
  assert.doesNotThrow(() => {
    const events = hermes.extractLine('{{corrupt}', 'sid1');
    assert.equal(events.length, 0);
  });
});
