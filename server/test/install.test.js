// server/test/install.test.js — unit tests for the PURE installer helpers.
// These never touch the real ~/.claude / ~/.gemini / ~/.glmps: every
// case passes in-memory objects and asserts on the returned values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHookPatch, removeHookPatch } from '../../scripts/install-lib.mjs';

const CMD = 'node "C:/repo/hooks/capability-reminder.js"';
const group = (cmd) => ({ hooks: [{ type: 'command', command: cmd }] });

// ---------------------------------------------------------------------------
// buildHookPatch
// ---------------------------------------------------------------------------

test('buildHookPatch: empty settings gets the UserPromptSubmit group', () => {
  const { patched, alreadyInstalled } = buildHookPatch({}, CMD);
  assert.equal(alreadyInstalled, false);
  assert.deepEqual(patched, {
    hooks: { UserPromptSubmit: [group(CMD)] },
  });
});

test('buildHookPatch: null/undefined settings treated as empty object', () => {
  for (const s of [null, undefined]) {
    const { patched, alreadyInstalled } = buildHookPatch(s, CMD);
    assert.equal(alreadyInstalled, false);
    assert.deepEqual(patched.hooks.UserPromptSubmit, [group(CMD)]);
  }
});

test('buildHookPatch: appends to existing UserPromptSubmit groups', () => {
  const existing = group('node "other.js"');
  const { patched, alreadyInstalled } = buildHookPatch(
    { hooks: { UserPromptSubmit: [existing] } },
    CMD,
  );
  assert.equal(alreadyInstalled, false);
  assert.equal(patched.hooks.UserPromptSubmit.length, 2);
  assert.deepEqual(patched.hooks.UserPromptSubmit[0], existing);
  assert.deepEqual(patched.hooks.UserPromptSubmit[1], group(CMD));
});

test('buildHookPatch: preserves unrelated events and settings keys', () => {
  const input = {
    statusLine: { type: 'command', command: 'node "chain.js"' },
    hooks: {
      Stop: [group('node "stop.js"')],
    },
    permissions: { allow: ['Bash'] },
  };
  const { patched } = buildHookPatch(input, CMD);
  // Unrelated top-level + hook events survive untouched.
  assert.deepEqual(patched.statusLine, input.statusLine);
  assert.deepEqual(patched.permissions, input.permissions);
  assert.deepEqual(patched.hooks.Stop, input.hooks.Stop);
  // New event added alongside.
  assert.deepEqual(patched.hooks.UserPromptSubmit, [group(CMD)]);
});

test('buildHookPatch: idempotent — already installed leaves settings unchanged', () => {
  const input = { hooks: { UserPromptSubmit: [group(CMD)] } };
  const { patched, alreadyInstalled } = buildHookPatch(input, CMD);
  assert.equal(alreadyInstalled, true);
  assert.equal(patched, input); // same reference, no mutation
});

test('buildHookPatch: detects install even if command path differs but marker matches', () => {
  const input = {
    hooks: { UserPromptSubmit: [group('node "D:/elsewhere/capability-reminder.js"')] },
  };
  const { alreadyInstalled } = buildHookPatch(input, CMD);
  assert.equal(alreadyInstalled, true);
});

test('buildHookPatch: does not mutate the input object', () => {
  const input = { hooks: { UserPromptSubmit: [group('node "other.js"')] } };
  const snapshot = JSON.parse(JSON.stringify(input));
  buildHookPatch(input, CMD);
  assert.deepEqual(input, snapshot);
});

// ---------------------------------------------------------------------------
// removeHookPatch
// ---------------------------------------------------------------------------

test('removeHookPatch: removes the capability-reminder group', () => {
  const input = { hooks: { UserPromptSubmit: [group(CMD)] } };
  const { patched, removed } = removeHookPatch(input, 'capability-reminder.js');
  assert.equal(removed, 1);
  // Empty array and empty hooks cleaned up.
  assert.deepEqual(patched, {});
});

test('removeHookPatch: keeps other UserPromptSubmit groups', () => {
  const other = group('node "other.js"');
  const input = { hooks: { UserPromptSubmit: [other, group(CMD)] } };
  const { patched, removed } = removeHookPatch(input, 'capability-reminder.js');
  assert.equal(removed, 1);
  assert.deepEqual(patched.hooks.UserPromptSubmit, [other]);
});

test('removeHookPatch: keeps other events when removing the group', () => {
  const stop = group('node "stop.js"');
  const input = {
    permissions: { allow: ['Bash'] },
    hooks: { Stop: [stop], UserPromptSubmit: [group(CMD)] },
  };
  const { patched, removed } = removeHookPatch(input, 'capability-reminder.js');
  assert.equal(removed, 1);
  assert.deepEqual(patched.permissions, input.permissions);
  assert.deepEqual(patched.hooks, { Stop: [stop] });
});

test('removeHookPatch: no-op when nothing matches', () => {
  const input = { hooks: { UserPromptSubmit: [group('node "other.js"')] } };
  const { patched, removed } = removeHookPatch(input, 'capability-reminder.js');
  assert.equal(removed, 0);
  assert.equal(patched, input);
});

test('removeHookPatch: no-op on settings without hooks', () => {
  const input = { permissions: { allow: ['Bash'] } };
  const { patched, removed } = removeHookPatch(input, 'capability-reminder.js');
  assert.equal(removed, 0);
  assert.equal(patched, input);
});

test('removeHookPatch: null/undefined settings is a safe no-op', () => {
  for (const s of [null, undefined]) {
    const { patched, removed } = removeHookPatch(s, 'capability-reminder.js');
    assert.equal(removed, 0);
    assert.equal(patched, s);
  }
});

test('removeHookPatch: does not mutate the input object', () => {
  const input = { hooks: { UserPromptSubmit: [group(CMD), group('node "other.js"')] } };
  const snapshot = JSON.parse(JSON.stringify(input));
  removeHookPatch(input, 'capability-reminder.js');
  assert.deepEqual(input, snapshot);
});

// ---------------------------------------------------------------------------
// Round-trip: build then remove returns to the original
// ---------------------------------------------------------------------------

test('round-trip: buildHookPatch then removeHookPatch restores the original', () => {
  const original = {
    statusLine: { type: 'command', command: 'node "chain.js"' },
    hooks: { Stop: [group('node "stop.js"')] },
    permissions: { allow: ['Bash'] },
  };
  const { patched } = buildHookPatch(original, CMD);
  const { patched: restored, removed } = removeHookPatch(patched, 'capability-reminder.js');
  assert.equal(removed, 1);
  assert.deepEqual(restored, original);
});

test('round-trip: build then remove from empty settings yields empty object', () => {
  const { patched } = buildHookPatch({}, CMD);
  const { patched: restored } = removeHookPatch(patched, 'capability-reminder.js');
  assert.deepEqual(restored, {});
});
