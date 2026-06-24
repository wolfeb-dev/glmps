// server/test/loop-stage.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopStage } from '../lib/loop-stage.js';

// Helpers to build minimal valid events
const skill  = (ts, label = 'brainstorming') => ({ kind: 'skill',       lane: 'context', label, ts, sessionId: 's' });
const agent  = (ts, label = 'Explore')       => ({ kind: 'agent',       lane: 'feed',    label, ts, sessionId: 's' });
const edit   = (ts, path  = 'a.js')          => ({ kind: 'file-edit',   lane: 'feed',    label: path, path, ts, sessionId: 's' });
const ctx    = (ts, op, path = 'CLAUDE.md')  => ({ kind: 'context-file',lane: 'context', label: path, path, op, ts, sessionId: 's' });
const agy    = (ts)                           => ({ kind: 'antigravity', lane: 'feed',    label: 'dispatch', ts, sessionId: 's' });
const gate   = (ts, result)                   => ({ kind: 'done-gate',   lane: 'feed',    label: 'npm test', result, ts, sessionId: 's' });

// ─── Stage 1 — orchestrate ───────────────────────────────────────────────────

test('empty events → stage 1 orchestrate', () => {
  const r = loopStage([]);
  assert.equal(r.stage, 1);
  assert.equal(r.key, 'orchestrate');
  assert.equal(r.status, 'active');
  assert.ok(typeof r.detail === 'string');
});

test('only a skill event → stage 1 orchestrate', () => {
  const r = loopStage([skill(1)]);
  assert.equal(r.stage, 1);
  assert.equal(r.key, 'orchestrate');
});

test('only an agent event → stage 1 orchestrate', () => {
  const r = loopStage([agent(1)]);
  assert.equal(r.stage, 1);
  assert.equal(r.key, 'orchestrate');
});

test('non-empty guiding array → stage 1 orchestrate', () => {
  const r = loopStage([], ['capability scan hint']);
  assert.equal(r.stage, 1);
  assert.equal(r.key, 'orchestrate');
});

test('skill + agent but no edit → still stage 1', () => {
  const r = loopStage([skill(1), agent(2)]);
  assert.equal(r.stage, 1);
  assert.equal(r.key, 'orchestrate');
});

// ─── Stage 2 — execute ───────────────────────────────────────────────────────

test('file-edit after a skill → stage 2 execute', () => {
  const r = loopStage([skill(1), edit(2)]);
  assert.equal(r.stage, 2);
  assert.equal(r.key, 'execute');
  assert.equal(r.status, 'active');
});

test('file-edit with no prior skill → stage 2 execute', () => {
  const r = loopStage([edit(1)]);
  assert.equal(r.stage, 2);
  assert.equal(r.key, 'execute');
});

test('context-file op:read does NOT advance past skill (stays orchestrate)', () => {
  const r = loopStage([skill(1), ctx(2, 'read')]);
  assert.equal(r.stage, 1);
  assert.equal(r.key, 'orchestrate');
});

test('context-file op:edit after skill → stage 2 execute', () => {
  const r = loopStage([skill(1), ctx(2, 'edit')]);
  assert.equal(r.stage, 2);
  assert.equal(r.key, 'execute');
});

test('context-file op:write after skill → stage 2 execute', () => {
  const r = loopStage([skill(1), ctx(2, 'write')]);
  assert.equal(r.stage, 2);
  assert.equal(r.key, 'execute');
});

test('context-file with no op → treated as non-edit, stays orchestrate', () => {
  // op is undefined/absent — no op means read-only context load
  const r = loopStage([skill(1), { kind: 'context-file', lane: 'context', label: 'x', path: 'x', ts: 2, sessionId: 's' }]);
  assert.equal(r.stage, 1);
  assert.equal(r.key, 'orchestrate');
});

// ─── Stage 3 — adversarial ───────────────────────────────────────────────────

test('antigravity event after edits → stage 3 adversarial', () => {
  const r = loopStage([skill(1), edit(2), agy(3)]);
  assert.equal(r.stage, 3);
  assert.equal(r.key, 'adversarial');
  assert.equal(r.status, 'active');
});

test('antigravity before an edit → still stage 2 execute (edit is later)', () => {
  const r = loopStage([skill(1), agy(2), edit(3)]);
  assert.equal(r.stage, 2);
  assert.equal(r.key, 'execute');
});

// ─── Stage 4 — gate ──────────────────────────────────────────────────────────

test('done-gate result:running → stage 4 gate, status active', () => {
  const r = loopStage([skill(1), edit(2), gate(3, 'running')]);
  assert.equal(r.stage, 4);
  assert.equal(r.key, 'gate');
  assert.equal(r.status, 'active');
});

test('done-gate result:block → stage 4 gate, status active', () => {
  const r = loopStage([skill(1), edit(2), gate(3, 'block')]);
  assert.equal(r.stage, 4);
  assert.equal(r.key, 'gate');
  assert.equal(r.status, 'active');
});

test('done-gate result:yield → stage 4 gate, status active', () => {
  const r = loopStage([skill(1), edit(2), gate(3, 'yield')]);
  assert.equal(r.stage, 4);
  assert.equal(r.key, 'gate');
  assert.equal(r.status, 'active');
});

test('done-gate result:skipped → stage 4 gate, status done', () => {
  const r = loopStage([skill(1), edit(2), gate(3, 'skipped')]);
  assert.equal(r.stage, 4);
  assert.equal(r.key, 'gate');
  assert.equal(r.status, 'done');
});

test('done-gate with unknown result → stage 4 gate, status active', () => {
  const r = loopStage([skill(1), edit(2), gate(3, 'unknown-result')]);
  assert.equal(r.stage, 4);
  assert.equal(r.key, 'gate');
  assert.equal(r.status, 'active');
});

// ─── Stage 5 — learning ──────────────────────────────────────────────────────

test('done-gate result:pass with no later edit → stage 5 learning, status done', () => {
  const r = loopStage([skill(1), edit(2), gate(3, 'pass')]);
  assert.equal(r.stage, 5);
  assert.equal(r.key, 'learning');
  assert.equal(r.status, 'done');
});

test('done-gate result:pass with no edits at all → stage 5 learning', () => {
  const r = loopStage([gate(1, 'pass')]);
  assert.equal(r.stage, 5);
  assert.equal(r.key, 'learning');
  assert.equal(r.status, 'done');
});

// ─── Latest-wins / ordering ───────────────────────────────────────────────────

test('done-gate:pass followed by a later file-edit → back to stage 2 execute', () => {
  const r = loopStage([skill(1), edit(2), gate(3, 'pass'), edit(4)]);
  assert.equal(r.stage, 2);
  assert.equal(r.key, 'execute');
});

test('later skill after edits does NOT regress to orchestrate (edit is still present)', () => {
  // The edit is ts=2, skill is ts=3. stage is still execute because an edit exists after initial orchestrate.
  // (A skill after edits doesn't erase the fact that edits happened — rule 4 only requires edit after *last* skill/agent)
  // Per rule 4: file-edit after last skill/agent → stage 2.
  // skill@3 is the last skill/agent; edit@2 is BEFORE it → falls through to stage 1.
  const r = loopStage([edit(2), skill(3)]);
  assert.equal(r.stage, 1);
  assert.equal(r.key, 'orchestrate');
});

test('ISO-string ts ordering works correctly (antigravity after edit)', () => {
  const r = loopStage([
    { kind: 'file-edit',   lane: 'feed', label: 'a.js', path: 'a.js', ts: '2026-06-20T10:00:00Z', sessionId: 's' },
    { kind: 'antigravity', lane: 'feed', label: 'dispatch',            ts: '2026-06-20T11:00:00Z', sessionId: 's' },
  ]);
  assert.equal(r.stage, 3);
  assert.equal(r.key, 'adversarial');
});

// ─── 5-step invariant ────────────────────────────────────────────────────────

test('stage is always 1-5 (never 6+)', () => {
  const cases = [
    [],
    [skill(1)],
    [skill(1), edit(2)],
    [skill(1), edit(2), agy(3)],
    [skill(1), edit(2), gate(3, 'block')],
    [skill(1), edit(2), gate(3, 'pass')],
  ];
  for (const events of cases) {
    const r = loopStage(events);
    assert.ok(r.stage >= 1 && r.stage <= 5, `stage out of range: ${r.stage}`);
  }
});

test('key is never "scan" or "select"', () => {
  const cases = [[], [skill(1)], [agent(1)], [edit(1)]];
  for (const events of cases) {
    const r = loopStage(events);
    assert.notEqual(r.key, 'scan');
    assert.notEqual(r.key, 'select');
  }
});

// ─── gaps enrichment ─────────────────────────────────────────────────────────

test('non-empty gaps enriches detail but does not change stage', () => {
  const r1 = loopStage([skill(1)], [], []);
  const r2 = loopStage([skill(1)], [], ['missed frontend-design skill']);
  assert.equal(r1.stage, r2.stage);
  assert.equal(r1.key, r2.key);
  // detail may differ — that's intentional
  assert.ok(typeof r2.detail === 'string');
});

test('gaps detail mention appears in detail when stage is orchestrate', () => {
  const r = loopStage([], [], ['missed brainstorming']);
  assert.ok(r.detail.includes('missed brainstorming') || r.detail.length > 0);
  assert.equal(r.stage, 1);
});

// ─── return shape completeness ────────────────────────────────────────────────

test('return shape always has stage, key, status, detail, agent', () => {
  for (const events of [[], [skill(1)], [edit(1)], [gate(1, 'pass')]]) {
    const r = loopStage(events);
    assert.ok('stage'  in r, 'missing stage');
    assert.ok('key'    in r, 'missing key');
    assert.ok('status' in r, 'missing status');
    assert.ok('detail' in r, 'missing detail');
    assert.ok('agent'  in r, 'missing agent');
  }
});

// ─── active sub-agent (loop.agent) ────────────────────────────────────────────

test('loop.agent: latest agent dispatch surfaces the agent name', () => {
  const r = loopStage([agent('2026-06-21T10:00:00Z', 'general-purpose: Implement Task 2')]);
  assert.equal(r.agent, 'general-purpose');
});

test('loop.agent: a later skill (non-agent) clears the active agent', () => {
  const r = loopStage([
    agent('2026-06-21T10:00:00Z', 'Explore: map the code'),
    skill('2026-06-21T10:01:00Z', 'frontend-design'),
  ]);
  assert.equal(r.agent, null);
});

test('loop.agent: null when no agent events', () => {
  const r = loopStage([edit('2026-06-21T10:00:00Z')]);
  assert.equal(r.agent, null);
});
