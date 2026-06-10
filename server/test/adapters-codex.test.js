// server/test/adapters-codex.test.js
// Fixture-based tests for the hardened codex-cli adapter (temp dirs, no live data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as codex from '../lib/adapters/codex-cli.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-codex-')); tmpDirs.push(d); return d; }
function makeP(codexDir) { return { codexDir }; }

// ── detect ──────────────────────────────────────────────────────────────────

test('codex detect: installed=false when base missing', () => {
  const { installed } = codex.detect(makeP(path.join(os.tmpdir(), 'nope-codex-xyz')));
  assert.equal(installed, false);
});

test('codex detect: installed=true when sessions/ exists; dataDirs has base', () => {
  const base = mkTmp();
  fs.mkdirSync(path.join(base, 'sessions'), { recursive: true });
  const { installed, dataDirs } = codex.detect(makeP(base));
  assert.equal(installed, true);
  assert.deepEqual(dataDirs, [base]);
});

test('codex detect: installed=true when only archived_sessions/ exists', () => {
  const base = mkTmp();
  fs.mkdirSync(path.join(base, 'archived_sessions'), { recursive: true });
  assert.equal(codex.detect(makeP(base)).installed, true);
});

// ── discover (recursive walk) ───────────────────────────────────────────────

test('codex discover: walks sessions/**/rollout-*.jsonl at arbitrary depth', () => {
  const base = mkTmp();
  const deep = path.join(base, 'sessions', '2026', '02', '19');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'rollout-2026-02-19.jsonl'), '');
  // also a shallow one to prove non-fixed depth
  const shallow = path.join(base, 'sessions');
  fs.writeFileSync(path.join(shallow, 'rollout-flat.jsonl'), '');
  // and an archived one
  const arch = path.join(base, 'archived_sessions', 'x');
  fs.mkdirSync(arch, { recursive: true });
  fs.writeFileSync(path.join(arch, 'rollout-arch.jsonl'), '');
  // a non-rollout file must be ignored
  fs.writeFileSync(path.join(shallow, 'notes.jsonl'), '');

  const descs = codex.discover(makeP(base));
  assert.equal(descs.length, 3);
  for (const d of descs) {
    assert.equal(d.tool, 'codex-cli');
    assert.equal(d.kind, 'jsonl-tail');
    assert.ok(path.basename(d.file).startsWith('rollout-'));
  }
});

test('codex discover: empty when base missing', () => {
  assert.deepEqual(codex.discover(makeP(path.join(os.tmpdir(), 'nope-xyz'))), []);
});

// ── extractLine: meta / users ────────────────────────────────────────────────

test('codex extractLine: session_meta with cwd -> meta event', () => {
  const line = JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/u/proj' } });
  const evs = codex.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'meta');
  assert.equal(evs[0].path, '/home/u/proj');
});

test('codex extractLine: turn_context emits cwd + model meta events', () => {
  const line = JSON.stringify({ type: 'turn_context',
    payload: { cwd: 'D:\\proj', model: 'gpt-5.5' } });
  const evs = codex.extractLine(line, 'sid');
  assert.equal(evs.length, 2);
  const cwdEv = evs.find(e => e.label === 'cwd');
  const modelEv = evs.find(e => e.label === 'model');
  assert.equal(cwdEv.kind, 'meta');
  assert.equal(cwdEv.path, 'D:\\proj');
  assert.equal(modelEv.kind, 'meta');
  assert.equal(modelEv.model, 'gpt-5.5');
});

test('codex extractLine: user message (array content) -> user feed event', () => {
  const line = JSON.stringify({
    timestamp: 't', type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the bug' }] },
  });
  const evs = codex.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].tool, 'user');
  assert.ok(evs[0].label.includes('Fix the bug'));
});

test('codex extractLine: assistant message -> no event', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
  });
  assert.equal(codex.extractLine(line, 'sid').length, 0);
});

test('codex extractLine: strips <environment_context> wrapper from user text', () => {
  const wrapped = '<environment_context>\ncwd: /x\n</environment_context>\nActually do the thing';
  const line = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: wrapped }] },
  });
  const evs = codex.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.ok(evs[0].label.includes('Actually do the thing'));
  assert.ok(!evs[0].label.includes('environment_context'));
});

test('codex extractLine: pure <environment_context> user text -> no event', () => {
  const wrapped = '<environment_context>\ncwd: /x\n</environment_context>';
  const line = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: wrapped }] },
  });
  assert.equal(codex.extractLine(line, 'sid').length, 0);
});

// ── extractLine: tool calls ───────────────────────────────────────────────────

test('codex extractLine: local_shell_call -> Bash command event', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: { type: 'local_shell_call', action: { command: ['bash', '-lc', 'ls -la'] } },
  });
  const evs = codex.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'command');
  assert.equal(evs[0].tool, 'Bash');
  assert.ok(evs[0].label.includes('ls -la'));
});

test('codex extractLine: local_shell_call with git commit -> git event', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: { type: 'local_shell_call', action: { command: 'git commit -m "feat: x"' } },
  });
  const evs = codex.extractLine(line, 'sid');
  assert.equal(evs[0].kind, 'git');
  assert.equal(evs[0].gitOp, 'commit');
});

test('codex extractLine: function_call exec_command -> Bash command (cmd arg)', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
  });
  const evs = codex.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'command');
  assert.equal(evs[0].tool, 'Bash');
  assert.ok(evs[0].label.includes('pwd'));
});

test('codex extractLine: function_call shell with git command -> git event', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell', arguments: { command: 'git push origin main' } },
  });
  const evs = codex.extractLine(line, 'sid');
  assert.equal(evs[0].kind, 'git');
  assert.equal(evs[0].gitOp, 'push');
});

test('codex extractLine: function_call shell_command -> Bash command event', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell_command',
      arguments: '{"command":"ls -la","workdir":"D:\\\\proj","timeout":120}' },
  });
  const evs = codex.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'command');
  assert.equal(evs[0].tool, 'Bash');
  assert.ok(evs[0].label.includes('ls -la'));
});

test('codex extractLine: shell_command with git command -> git event', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell_command',
      arguments: { command: 'git commit -m "feat: x"' } },
  });
  const evs = codex.extractLine(line, 'sid');
  assert.equal(evs[0].kind, 'git');
  assert.equal(evs[0].gitOp, 'commit');
});

test('codex extractLine: function_call non-shell -> tool event with path', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call', name: 'read_file', arguments: { file_path: '/a/b.js' } },
  });
  const evs = codex.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'tool');
  assert.equal(evs[0].tool, 'read_file');
  assert.equal(evs[0].path, '/a/b.js');
});

test('codex extractLine: function_call_output -> no event (result, not action)', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' },
  });
  assert.equal(codex.extractLine(line, 'sid').length, 0);
});

// ── extractLine: dedup + token deltas ─────────────────────────────────────────

test('codex extractLine: event_msg user_message/agent_message are deduped (no event)', () => {
  const u = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } });
  const a = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'yo' } });
  assert.equal(codex.extractLine(u, 'sid').length, 0);
  assert.equal(codex.extractLine(a, 'sid').length, 0);
});

test('codex extractLine: token_count emits per-turn delta from cumulative totals', () => {
  const sid = 'tok-sid';
  codex.resetTokenState(sid);
  const mk = (input, output, cached) => JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached } } },
  });

  const e1 = codex.extractLine(mk(100, 20, 0), sid);
  assert.equal(e1.length, 1);
  assert.equal(e1[0].kind, 'tokens');
  assert.equal(e1[0].change.input, 100);
  assert.equal(e1[0].change.output, 20);

  // cumulative grows: 250 in (30 cached), 70 out -> delta 150 in, 50 out, 30 cached
  const e2 = codex.extractLine(mk(250, 70, 30), sid);
  assert.equal(e2[0].change.input, 120); // 150 delta minus 30 cached
  assert.equal(e2[0].change.output, 50);
  assert.equal(e2[0].change.cached, 30);
});

test('codex extractLine: token_count uses last_token_usage fallback', () => {
  const sid = 'tok-sid2';
  codex.resetTokenState(sid);
  const line = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 3 } } },
  });
  const evs = codex.extractLine(line, sid);
  assert.equal(evs[0].change.input, 5);
  assert.equal(evs[0].change.output, 3);
});

test('codex extractLine: token_count carries cumulative totals + context window', () => {
  const sid = 'tok-sid3';
  codex.resetTokenState(sid);
  const line = JSON.stringify({
    type: 'event_msg', timestamp: '2026-06-10T15:05:10.000Z',
    payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 13302, cached_input_tokens: 1920, output_tokens: 44, total_tokens: 13346 },
      last_token_usage: { input_tokens: 13302, cached_input_tokens: 1920, output_tokens: 44, total_tokens: 13346 },
      model_context_window: 258400,
    } },
  });
  const evs = codex.extractLine(line, sid);
  assert.equal(evs.length, 1);
  const c = evs[0].change;
  assert.equal(c.totalInput, 13302);
  assert.equal(c.totalOutput, 44);
  assert.equal(c.totalCached, 1920);
  assert.equal(c.contextWindow, 258400);
  assert.equal(c.lastTurnTokens, 13346);
});

// ── robustness ────────────────────────────────────────────────────────────────

test('codex extractLine: malformed JSON -> no throw, no events', () => {
  assert.doesNotThrow(() => assert.equal(codex.extractLine('not json {{', 'sid').length, 0));
});

test('codex extractLine: reasoning / unknown types -> no events', () => {
  assert.equal(codex.extractLine(JSON.stringify({ type: 'response_item', payload: { type: 'reasoning' } }), 'sid').length, 0);
  assert.equal(codex.extractLine(JSON.stringify({ type: 'whatever' }), 'sid').length, 0);
});
