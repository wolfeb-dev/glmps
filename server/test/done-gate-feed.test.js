// Tests for turning the Stop-hook gate's per-session JSONL into dashboard events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doneGateEvents } from '../lib/done-gate-feed.js';

const SID = 'sess-1';

test('pass -> feed event', () => {
  const ev = doneGateEvents(JSON.stringify({ ts: 1, result: 'pass' }), SID);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'done-gate');
  assert.equal(ev[0].lane, 'feed');
  assert.equal(ev[0].sessionId, SID);
  assert.match(ev[0].label, /passed/);
});

test('block -> feed event naming the failed command', () => {
  const ev = doneGateEvents(JSON.stringify({ ts: 2, result: 'block', failedCommand: 'npm test' }), SID);
  assert.equal(ev[0].lane, 'feed');
  assert.match(ev[0].label, /npm test/);
});

test('yield -> feed event', () => {
  const ev = doneGateEvents(JSON.stringify({ ts: 3, result: 'yield', failedCommand: 'npm test' }), SID);
  assert.equal(ev[0].lane, 'feed');
  assert.match(ev[0].label, /yield/i);
});

test('skipped -> context event (not top-level feed)', () => {
  const ev = doneGateEvents(JSON.stringify({ ts: 4, result: 'skipped' }), SID);
  assert.equal(ev[0].lane, 'context');
  assert.match(ev[0].label, /skip/i);
});

test('multiple lines -> one event each, in order', () => {
  const text = [
    JSON.stringify({ ts: 1, result: 'block', failedCommand: 'npm test' }),
    JSON.stringify({ ts: 2, result: 'pass' }),
  ].join('\n');
  const ev = doneGateEvents(text, SID);
  assert.equal(ev.length, 2);
  assert.deepEqual(ev.map(e => e.ts), [1, 2]);
});

test('unknown result + malformed line are skipped, never throws', () => {
  const text = ['not json', JSON.stringify({ result: 'bogus' }), JSON.stringify({ ts: 5, result: 'pass' })].join('\n');
  const ev = doneGateEvents(text, SID);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].label, 'done-gate: passed');
});

test('non-string input -> empty', () => {
  assert.deepEqual(doneGateEvents(null, SID), []);
  assert.deepEqual(doneGateEvents(undefined, SID), []);
  assert.deepEqual(doneGateEvents('', SID), []);
});

test('caps to the most recent max events', () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(JSON.stringify({ ts: i, result: 'pass' }));
  const ev = doneGateEvents(lines.join('\n'), SID, { max: 50 });
  assert.equal(ev.length, 50);
  assert.equal(ev[0].ts, 10); // dropped the oldest 10
});
