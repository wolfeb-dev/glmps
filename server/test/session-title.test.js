// server/test/session-title.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeCode,
  cleanFirstPrompt,
  deriveSessionTitle,
  pickTitle,
} from '../lib/session-title.js';

// ---------------------------------------------------------------------------
// looksLikeCode
// ---------------------------------------------------------------------------

test('looksLikeCode: missing/empty values are code-like', () => {
  assert.equal(looksLikeCode(null), true);
  assert.equal(looksLikeCode(undefined), true);
  assert.equal(looksLikeCode(''), true);
  assert.equal(looksLikeCode('   '), true);
  assert.equal(looksLikeCode(42), true);
});

test('looksLikeCode: uuid is code-like', () => {
  assert.equal(looksLikeCode('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true);
  assert.equal(looksLikeCode('3F2504E0-4F89-41D3-9A0C-0305E82C3301'), true);
});

test('looksLikeCode: all-hex blob is code-like', () => {
  assert.equal(looksLikeCode('a1b2c3d4e5f6'), true);
  assert.equal(looksLikeCode('deadbeef'), true);
  assert.equal(looksLikeCode('0a9f3c'), true);
});

test('looksLikeCode: all-numeric is code-like', () => {
  assert.equal(looksLikeCode('1717891200000'), true);
  assert.equal(looksLikeCode('42'), true);
});

test('looksLikeCode: short opaque / id-shaped tokens are code-like', () => {
  assert.equal(looksLikeCode('sess_8fA2'), true);   // underscore -> id-shaped
  assert.equal(looksLikeCode('ag-9f2c1'), true);    // hyphen + digit
  assert.equal(looksLikeCode('01HX9K'), true);      // digit + no space, short-ish ulid frag
  assert.equal(looksLikeCode('abc'), true);         // too short
});

test('looksLikeCode: real prose is NOT code-like', () => {
  assert.equal(looksLikeCode('Refactor the session tailer'), false);
  assert.equal(looksLikeCode('Fix the failing antigravity adapter'), false);
  assert.equal(looksLikeCode('add tests for paths.js'), false);
  // A single longer all-alpha word is acceptable prose.
  assert.equal(looksLikeCode('Refactor'), false);
  assert.equal(looksLikeCode('Deploy'), false);
});

// ---------------------------------------------------------------------------
// cleanFirstPrompt
// ---------------------------------------------------------------------------

test('cleanFirstPrompt: non-string returns null', () => {
  assert.equal(cleanFirstPrompt(null), null);
  assert.equal(cleanFirstPrompt(42), null);
});

test('cleanFirstPrompt: empty/whitespace-only returns null', () => {
  assert.equal(cleanFirstPrompt(''), null);
  assert.equal(cleanFirstPrompt('   \n  '), null);
});

test('cleanFirstPrompt: strips environment_context wrapper block', () => {
  const input =
    '<environment_context>cwd: D:/x\nplatform: win32</environment_context>\nFix the build script';
  const out = cleanFirstPrompt(input);
  assert.equal(out, 'Fix the build script');
});

test('cleanFirstPrompt: strips system-reminder wrapper block', () => {
  const input = '<system-reminder>blah blah</system-reminder> Refactor the tailer';
  const out = cleanFirstPrompt(input);
  assert.equal(out, 'Refactor the tailer');
});

test('cleanFirstPrompt: unwraps USER_REQUEST', () => {
  const input = '<USER_REQUEST>\n  convert this into a strategy\n</USER_REQUEST>';
  assert.equal(cleanFirstPrompt(input), 'convert this into a strategy');
});

test('cleanFirstPrompt: strips stray tags and markdown, collapses whitespace', () => {
  const input = 'Set up `autoresearch` in the **current** directory <b>now</b>';
  const out = cleanFirstPrompt(input);
  assert.ok(!out.includes('`'));
  assert.ok(!out.includes('*'));
  assert.ok(!out.includes('<'));
  assert.ok(out.includes('autoresearch'));
  assert.ok(out.includes('current'));
});

test('cleanFirstPrompt: truncates to <=80 chars', () => {
  const out = cleanFirstPrompt('A'.repeat(200));
  assert.equal(out.length, 80);
});

// ---------------------------------------------------------------------------
// deriveSessionTitle — first user prompt from events
// ---------------------------------------------------------------------------

test('deriveSessionTitle: prefers a clean first user prompt from events', () => {
  const events = [
    { kind: 'tool', lane: 'feed', tool: 'user', label: 'User: Refactor the session tailer to use async' },
    { kind: 'file-edit', lane: 'feed', label: 'tailer.js', path: 'D:/mc/server/lib/tailer.js' },
  ];
  const out = deriveSessionTitle({ record: { id: 'abcd1234', tool: 'antigravity' }, events });
  assert.equal(out, 'Refactor the session tailer to use async');
});

test('deriveSessionTitle: skips (input) placeholder user events', () => {
  const events = [
    { kind: 'tool', lane: 'feed', tool: 'user', label: 'User: (input)' },
    { kind: 'file-edit', lane: 'feed', label: 'server.js', path: 'D:/mc/server/server.js' },
  ];
  const out = deriveSessionTitle({ record: { id: 'abcd1234', tool: 'antigravity' }, events });
  assert.ok(out.startsWith('Edit server.js'), `got: ${out}`);
});

// ---------------------------------------------------------------------------
// deriveSessionTitle — edit-heavy synthesis
// ---------------------------------------------------------------------------

test('deriveSessionTitle: edit-heavy session names primary file + count', () => {
  const events = [
    { kind: 'file-edit', lane: 'feed', label: 'server.js', path: 'D:/mc/server/server.js' },
    { kind: 'file-edit', lane: 'feed', label: 'app.js', path: 'D:/mc/web/app.js' },
    { kind: 'file-edit', lane: 'feed', label: 'grid.js', path: 'D:/mc/web/grid.js' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code' }, events });
  assert.equal(out, 'Edit server.js (+2 files)');
});

test('deriveSessionTitle: single edit has no (+N) suffix', () => {
  const events = [
    { kind: 'file-edit', lane: 'feed', label: 'server.js', path: 'D:/mc/server/server.js' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code' }, events });
  assert.equal(out, 'Edit server.js');
});

test('deriveSessionTitle: repeated edits to same file dedupe in the count', () => {
  const events = [
    { kind: 'file-edit', lane: 'feed', label: 'server.js', path: 'D:/mc/server/server.js' },
    { kind: 'file-edit', lane: 'feed', label: 'server.js', path: 'D:/mc/server/server.js' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code' }, events });
  assert.equal(out, 'Edit server.js');
});

test('deriveSessionTitle: cwd last segment prefixes synthesized title', () => {
  const events = [
    { kind: 'file-edit', lane: 'feed', label: 'server.js', path: 'D:/glmps/server/server.js' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code', cwd: 'D:/glmps' }, events });
  assert.equal(out, 'glmps: Edit server.js');
});

test('deriveSessionTitle: drive-root cwd infers project from file paths', () => {
  const events = [
    { kind: 'file-edit', lane: 'feed', label: 'server.js', path: 'D:/glmps/server/server.js' },
    { kind: 'file-edit', lane: 'feed', label: 'detail.js', path: 'D:/glmps/web/detail.js' },
    { kind: 'file-edit', lane: 'feed', label: 'grid.js', path: 'D:/glmps/web/grid.js' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code', cwd: 'D:\\' }, events });
  assert.ok(out.startsWith('glmps: Edit '), `got: ${out}`);
});

test('deriveSessionTitle: substantial activity preempts a stale opening prompt', () => {
  const events = [
    { kind: 'tool', lane: 'feed', tool: 'user', label: 'User: uninstall the spglobal plugin' },
    { kind: 'file-edit', lane: 'feed', label: 'a.js', path: 'D:/proj/a.js' },
    { kind: 'file-edit', lane: 'feed', label: 'b.js', path: 'D:/proj/b.js' },
    { kind: 'file-edit', lane: 'feed', label: 'c.js', path: 'D:/proj/c.js' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code' }, events });
  assert.ok(out.startsWith('Edit a.js'), `got: ${out}`);
  assert.ok(!/spglobal/.test(out), `should not echo stale prompt: ${out}`);
});

// ---------------------------------------------------------------------------
// deriveSessionTitle — debug synthesis (grep + git)
// ---------------------------------------------------------------------------

test('deriveSessionTitle: debug session = grep + git commit', () => {
  const events = [
    { kind: 'command', lane: 'feed', tool: 'Bash', label: 'grep -rn TODO server' },
    { kind: 'git', lane: 'context', gitOp: 'commit', label: 'commit: fix bug' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code' }, events });
  assert.equal(out, 'Debug: grep + git commit');
});

test('deriveSessionTitle: git-only session', () => {
  const events = [
    { kind: 'git', lane: 'context', gitOp: 'push', label: 'push → origin/main' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code' }, events });
  assert.equal(out, 'Debug: git push');
});

// ---------------------------------------------------------------------------
// deriveSessionTitle — skill synthesis
// ---------------------------------------------------------------------------

test('deriveSessionTitle: skill + key file', () => {
  const events = [
    { kind: 'skill', lane: 'context', label: 'frontend-design' },
    { kind: 'file-edit', lane: 'feed', label: 'styles.css', path: 'D:/mc/web/styles.css' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code' }, events });
  assert.equal(out, 'frontend-design — styles.css');
});

test('deriveSessionTitle: skill from a path label uses last segment', () => {
  const events = [
    { kind: 'skill', lane: 'context', label: 'D:/x/.agents/skills/diagnose' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'antigravity' }, events });
  assert.equal(out, 'diagnose');
});

test('deriveSessionTitle: multiple skills, no file -> (+N skills)', () => {
  const events = [
    { kind: 'skill', lane: 'context', label: 'tdd' },
    { kind: 'skill', lane: 'context', label: 'diagnose' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code' }, events });
  assert.equal(out, 'tdd (+1 skills)');
});

test('deriveSessionTitle: falls back to record.skillsUsed when events have no skill kind', () => {
  const out = deriveSessionTitle({
    record: { id: 'x', tool: 'claude-code', skillsUsed: ['review'] },
    events: [],
  });
  assert.equal(out, 'review');
});

// ---------------------------------------------------------------------------
// deriveSessionTitle — explore / memory / agent / fallback
// ---------------------------------------------------------------------------

test('deriveSessionTitle: generic command -> Explore: <topic>', () => {
  const events = [
    { kind: 'command', lane: 'feed', tool: 'Bash', label: 'npm run build and check the output bundle' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code' }, events });
  assert.equal(out, 'Explore: npm run build and check the');
});

test('deriveSessionTitle: memory-only activity', () => {
  const events = [
    { kind: 'memory', lane: 'context', op: 'write', label: 'D:/x/memory/notes.md' },
    { kind: 'memory', lane: 'context', op: 'write', label: 'D:/x/memory/more.md' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code' }, events });
  assert.equal(out, 'Memory updates (2)');
});

test('deriveSessionTitle: agent delegation when no other signal', () => {
  const events = [
    { kind: 'agent', lane: 'context', label: 'general: do a thing' },
    { kind: 'agent', lane: 'context', label: 'general: do another' },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code' }, events });
  assert.equal(out, 'Delegated to 2 agents');
});

test('deriveSessionTitle: empty/pb-only fallback uses tool + id8', () => {
  const out = deriveSessionTitle({ record: { id: '0a9f3c1d2e4b5678', tool: 'antigravity' }, events: [] });
  assert.equal(out, 'antigravity session 0a9f3c1d');
});

test('deriveSessionTitle: handles no record/events args gracefully', () => {
  const out = deriveSessionTitle();
  assert.equal(out, 'session session session');
});

test('deriveSessionTitle: never exceeds 80 chars', () => {
  const events = [
    { kind: 'tool', lane: 'feed', tool: 'user', label: 'User: ' + 'word '.repeat(50) },
  ];
  const out = deriveSessionTitle({ record: { id: 'x', tool: 'claude-code' }, events });
  assert.ok(out.length <= 80, `length was ${out.length}`);
});

// ---------------------------------------------------------------------------
// pickTitle
// ---------------------------------------------------------------------------

test('pickTitle: uses a good record.title (cleaned)', () => {
  const rec = { id: 'x', tool: 'claude-code', title: '<environment_context>x</environment_context>Add dark mode toggle' };
  assert.equal(pickTitle(rec, []), 'Add dark mode toggle');
});

test('pickTitle: ignores code-like record.title and derives from events', () => {
  const rec = { id: 'abcd1234ef', tool: 'antigravity', title: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' };
  const events = [
    { kind: 'file-edit', lane: 'feed', label: 'app.js', path: 'D:/mc/web/app.js' },
  ];
  assert.equal(pickTitle(rec, events), 'Edit app.js');
});

test('pickTitle: empty title, no events -> tool + id8 fallback', () => {
  const rec = { id: '9f2c1a8b7d6e', tool: 'agy-cli', title: '' };
  assert.equal(pickTitle(rec, []), 'agy-cli session 9f2c1a8b');
});

test('pickTitle: tolerates missing events arg', () => {
  const rec = { id: 'abcdef12', tool: 'claude-code', title: 'Rename the variable' };
  assert.equal(pickTitle(rec), 'Rename the variable');
});
