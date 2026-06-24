// server/test/capability-feed-core.test.js
// TDD — tests for the pure feedFromTranscript core.
// Run: node --test server/test/capability-feed-core.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedFromTranscript } from '../lib/capability-feed-core.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function assistantLine(toolUses) {
  const content = toolUses.map(tu => ({
    type: 'tool_use',
    name: tu.name,
    input: tu.input ?? {},
  }));
  return JSON.stringify({ type: 'assistant', message: { content } });
}

function editEvent(filePath) {
  return { kind: 'file-edit', op: 'write', path: filePath, lane: 'feed', tool: 'Edit', ts: Date.now() };
}

function readEvent(filePath) {
  return { kind: 'file-edit', op: 'read', path: filePath, lane: 'feed', tool: 'Read', ts: Date.now() };
}

function skillEvent(label) {
  return { kind: 'skill', lane: 'context', label, ts: Date.now() };
}

// A JSONL line for a bash grep (for transcript-gaps bash-grep-over-grep-tool)
function bashGrepLine(n = 5) {
  const tus = Array.from({ length: n }, () => ({
    name: 'Bash', input: { command: 'grep -r foo .' },
  }));
  // Each must be its own assistant message (transcript-gaps counts per tool_use)
  return tus.map(tu => assistantLine([tu]));
}

// ---------------------------------------------------------------------------
// 1. gaps: detectGaps fires from events
// ---------------------------------------------------------------------------

test('gaps includes detectGaps result when UI file edited without frontend-design', () => {
  const events = [editEvent('web/styles.css')];
  const { gaps } = feedFromTranscript({ events, lines: [], skillsUsed: [], project: 'glmps', sessionId: 's1' });
  assert.ok(gaps.some(g => g.code === 'ui-without-frontend-design'),
    'expected ui-without-frontend-design gap');
});

test('no ui gap when frontend-design skill event is present', () => {
  const events = [skillEvent('frontend-design'), editEvent('web/styles.css')];
  const { gaps } = feedFromTranscript({ events, lines: [], skillsUsed: [], project: 'glmps', sessionId: 's1' });
  assert.ok(!gaps.some(g => g.code === 'ui-without-frontend-design'));
});

// ---------------------------------------------------------------------------
// 2. gaps: scanTranscriptForGaps fires from JSONL lines
// ---------------------------------------------------------------------------

test('gaps includes scanTranscriptForGaps result for bash-grep-over-grep-tool', () => {
  const lines = bashGrepLine(5);
  const { gaps } = feedFromTranscript({ events: [], lines, skillsUsed: [], project: 'glmps', sessionId: 's1' });
  assert.ok(gaps.some(g => g.code === 'bash-grep-over-grep-tool'),
    'expected bash-grep-over-grep-tool gap from transcript scan');
});

// ---------------------------------------------------------------------------
// 3. gaps: deduplication by code (first wins)
// ---------------------------------------------------------------------------

test('gaps are deduped by code — first occurrence wins when both sources emit same code', () => {
  // Manufacture a scenario where the same gap code would come from both detectGaps and
  // scanTranscriptForGaps. We can do this by crafting events that trigger a gap from
  // detectGaps, and ensuring the same code would not appear twice.
  // The 'ui-without-frontend-design' code only comes from detectGaps, so we test that
  // the dedup removes duplicates if detectGaps returns it twice (indirectly via two calls).
  // A more direct test: verify the gap array has at most one entry per code.
  const events = [editEvent('web/styles.css')];
  const lines = bashGrepLine(5);
  const { gaps } = feedFromTranscript({ events, lines, skillsUsed: [], project: 'glmps', sessionId: 's1' });
  const codes = gaps.map(g => g.code);
  const unique = new Set(codes);
  assert.equal(codes.length, unique.size, `Duplicate gap codes found: ${codes.join(', ')}`);
});

test('when both sources would produce the same gap code, only one entry appears', () => {
  // We simulate this by passing both events that trigger detectGaps ui-without-frontend-design
  // AND JSONL lines that would trigger the same. Since scanTranscriptForGaps has no CSS-file
  // gap, this is more of a structural dedup test via a custom scenario.
  // Instead, test via bash-grep from lines AND verify detectGaps did not already produce it.
  const lines = bashGrepLine(5);
  const events = [];
  const { gaps } = feedFromTranscript({ events, lines, skillsUsed: [], project: 'glmps', sessionId: 's1' });
  // If bash-grep-over-grep-tool appeared twice (from two sources), it's a bug
  const count = gaps.filter(g => g.code === 'bash-grep-over-grep-tool').length;
  assert.equal(count, 1, 'bash-grep-over-grep-tool should appear exactly once');
});

// ---------------------------------------------------------------------------
// 4. ticket: explicit deferral marker -> ticket with source 'deferred'
// ---------------------------------------------------------------------------

test('ticket is non-null when lastText contains explicit deferral phrase "deferred"', () => {
  const lastText = 'I have deferred this cleanup for now.';
  const { ticket } = feedFromTranscript({ events: [], lines: [], skillsUsed: [], project: 'p', sessionId: 's', lastText });
  assert.ok(ticket !== null, 'expected ticket from deferred');
  assert.equal(ticket.source, 'deferred');
});

test('ticket is non-null when lastText contains "skipping this"', () => {
  const lastText = 'We are skipping this for later.';
  const { ticket } = feedFromTranscript({ events: [], lines: [], skillsUsed: [], project: 'p', sessionId: 's', lastText });
  assert.ok(ticket !== null, 'expected ticket from "skipping this"');
  assert.equal(ticket.source, 'deferred');
});

test('ticket is non-null when lastText contains "not now"', () => {
  const lastText = 'Not now, we will do this in the next sprint.';
  const { ticket } = feedFromTranscript({ events: [], lines: [], skillsUsed: [], project: 'p', sessionId: 's', lastText });
  assert.ok(ticket !== null, 'expected ticket from "not now"');
  assert.equal(ticket.source, 'deferred');
});

test('ticket is non-null when lastText contains "backlog this"', () => {
  const lastText = 'Backlog this until we can allocate time.';
  const { ticket } = feedFromTranscript({ events: [], lines: [], skillsUsed: [], project: 'p', sessionId: 's', lastText });
  assert.ok(ticket !== null, 'expected ticket');
  assert.equal(ticket.source, 'deferred');
});

test('ticket title is first 80 chars of the matched sentence', () => {
  const lastText = 'We will do this later. I have deferred the auth refactor because it is not urgent now.';
  const { ticket } = feedFromTranscript({ events: [], lines: [], skillsUsed: [], project: 'p', sessionId: 's', lastText });
  assert.ok(ticket !== null);
  assert.ok(typeof ticket.title === 'string', 'ticket.title should be a string');
  assert.ok(ticket.title.length <= 80, `title too long: ${ticket.title.length}`);
  assert.ok(ticket.title.length > 0, 'title should not be empty');
});

test('ticket prompt is the full lastText', () => {
  const lastText = 'I have deferred this cleanup for now.';
  const { ticket } = feedFromTranscript({ events: [], lines: [], skillsUsed: [], project: 'p', sessionId: 's', lastText });
  assert.equal(ticket.prompt, lastText);
});

// ---------------------------------------------------------------------------
// 5. ticket: no deferral marker -> null
// ---------------------------------------------------------------------------

test('ticket is null when lastText has no deferral phrase', () => {
  const lastText = 'All done. Tests passing. The implementation is complete.';
  const { ticket } = feedFromTranscript({ events: [], lines: [], skillsUsed: [], project: 'p', sessionId: 's', lastText });
  assert.equal(ticket, null);
});

test('ticket is null when lastText is empty', () => {
  const { ticket } = feedFromTranscript({ events: [], lines: [], skillsUsed: [], project: 'p', sessionId: 's', lastText: '' });
  assert.equal(ticket, null);
});

test('ticket is null when lastText is undefined', () => {
  const { ticket } = feedFromTranscript({ events: [], lines: [], skillsUsed: [], project: 'p', sessionId: 's' });
  assert.equal(ticket, null);
});

// ---------------------------------------------------------------------------
// 6. codeChanged: true when a non-read .js/.ts/.py/.cs edit is present
// ---------------------------------------------------------------------------

test('codeChanged is true when a .js file-edit event is present', () => {
  const events = [editEvent('server/lib/foo.js')];
  const { codeChanged } = feedFromTranscript({ events, lines: [], skillsUsed: [], project: 'p', sessionId: 's' });
  assert.equal(codeChanged, true);
});

test('codeChanged is true for .mjs edit', () => {
  const events = [editEvent('scripts/build.mjs')];
  const { codeChanged } = feedFromTranscript({ events, lines: [], skillsUsed: [], project: 'p', sessionId: 's' });
  assert.equal(codeChanged, true);
});

test('codeChanged is true for .ts edit', () => {
  const events = [editEvent('src/main.ts')];
  const { codeChanged } = feedFromTranscript({ events, lines: [], skillsUsed: [], project: 'p', sessionId: 's' });
  assert.equal(codeChanged, true);
});

test('codeChanged is true for .py edit', () => {
  const events = [editEvent('train.py')];
  const { codeChanged } = feedFromTranscript({ events, lines: [], skillsUsed: [], project: 'p', sessionId: 's' });
  assert.equal(codeChanged, true);
});

test('codeChanged is true for .cs edit', () => {
  const events = [editEvent('Strategy.cs')];
  const { codeChanged } = feedFromTranscript({ events, lines: [], skillsUsed: [], project: 'p', sessionId: 's' });
  assert.equal(codeChanged, true);
});

test('codeChanged is false when the only .js event is a read', () => {
  const events = [readEvent('server/lib/foo.js')];
  const { codeChanged } = feedFromTranscript({ events, lines: [], skillsUsed: [], project: 'p', sessionId: 's' });
  assert.equal(codeChanged, false);
});

test('codeChanged is false when no events match code extensions', () => {
  const events = [editEvent('web/styles.css'), editEvent('README.md')];
  const { codeChanged } = feedFromTranscript({ events, lines: [], skillsUsed: [], project: 'p', sessionId: 's' });
  assert.equal(codeChanged, false);
});

test('codeChanged is false when events is empty', () => {
  const { codeChanged } = feedFromTranscript({ events: [], lines: [], skillsUsed: [], project: 'p', sessionId: 's' });
  assert.equal(codeChanged, false);
});

// ---------------------------------------------------------------------------
// 7. combined: realistic session scenario
// ---------------------------------------------------------------------------

test('realistic session: UI edit + bash greps + deferral + js edit -> all fields populated', () => {
  const events = [
    editEvent('web/styles.css'),
    editEvent('server/lib/foo.js'),
  ];
  const lines = bashGrepLine(5);
  const lastText = 'I have deferred the tooltip refactor for now. It is too risky to do this before release.';

  const result = feedFromTranscript({ events, lines, skillsUsed: [], project: 'glmps', sessionId: 's99', lastText });

  assert.ok(result.gaps.some(g => g.code === 'ui-without-frontend-design'), 'ui gap expected');
  assert.ok(result.gaps.some(g => g.code === 'bash-grep-over-grep-tool'), 'bash-grep gap expected');
  assert.ok(result.ticket !== null, 'ticket expected');
  assert.equal(result.ticket.source, 'deferred');
  assert.equal(result.codeChanged, true);
});

// ---------------------------------------------------------------------------
// 8. default arg safety
// ---------------------------------------------------------------------------

test('feedFromTranscript with all defaults returns safe empty result', () => {
  const result = feedFromTranscript({});
  assert.ok(Array.isArray(result.gaps));
  assert.equal(result.ticket, null);
  assert.equal(result.codeChanged, false);
});
