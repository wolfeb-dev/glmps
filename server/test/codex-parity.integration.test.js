// server/test/codex-parity.integration.test.js
// End-to-end: a Codex 0.139 rollout fixture surfaces with cwd, model status,
// git feed events, and usage analytics — parity with Claude Code sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const ROLLOUT_LINES = [
  { timestamp: '2026-06-10T15:05:03.019Z', type: 'session_meta',
    payload: { id: '019eb391', cwd: 'D:\\proj', model_provider: 'openai', cli_version: '0.139.0' } },
  { timestamp: '2026-06-10T15:05:03.020Z', type: 'turn_context',
    payload: { turn_id: 't1', cwd: 'D:\\proj', model: 'gpt-5.5' } },
  { timestamp: '2026-06-10T15:05:03.021Z', type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Commit the staged changes please' }] } },
  { timestamp: '2026-06-10T15:05:05.000Z', type: 'response_item',
    payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"git commit -m \\"feat: x\\"","workdir":"D:\\\\proj"}' } },
  { timestamp: '2026-06-10T15:05:08.000Z', type: 'event_msg',
    payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 13302, cached_input_tokens: 1920, output_tokens: 44, total_tokens: 13346 },
      last_token_usage: { input_tokens: 13302, cached_input_tokens: 1920, output_tokens: 44, total_tokens: 13346 },
      model_context_window: 258400 } } },
];

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-codexpar-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const codexDir = path.join(tmp, 'codex');
  const day = path.join(codexDir, 'sessions', '2026', '06', '10');
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, 'rollout-2026-06-10T15-05-03-test1.jsonl');
  fs.writeFileSync(rollout, ROLLOUT_LINES.map(l => JSON.stringify(l)).join('\n') + '\n');
  return {
    rollout,
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
           GLMPS_STATE_DIR: path.join(tmp, 'state'), GLMPS_CODEX_DIR: codexDir,
           GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
           GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
           GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
           GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
           GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode') },
  };
}

const SID = 'codex:rollout-2026-06-10T15-05-03-test1';

test('codex session surfaces cwd, model status, git event; meta events excluded', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    await new Promise(r => setTimeout(r, 300)); // let poll discover + tail
    const state = await (await fetch(`${base}/api/state`)).json();
    const s = state.sessions.find(x => x.id === SID);
    assert.ok(s, 'codex session listed');
    assert.equal(s.cwd, 'D:\\proj');
    assert.ok(s.status, 'status synthesized');
    assert.equal(s.status.model.id, 'gpt-5.5');
    assert.equal(s.status.context.usedPercent, Math.round(100 * 13346 / 258400)); // 5
    assert.equal(s.status.cost.totalUsd, null);

    const detail = await (await fetch(`${base}/api/state?session=${encodeURIComponent(SID)}`)).json();
    assert.ok(detail.events.some(e => e.kind === 'git'), 'git event present');
    assert.ok(detail.events.every(e => e.kind !== 'meta'), 'meta events not in log');
  } finally { await srv.close(); }
});

test('codex tokens bridge into the usage store', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    await new Promise(r => setTimeout(r, 300));
    const usage = await (await fetch(`${base}/api/usage`)).json();
    const row = (usage.perSession ?? []).find(r => r.sid === SID);
    assert.ok(row, 'codex session present in usage perSession');
    assert.equal(row.model, 'gpt-5.5');
    assert.equal(row.input, 13302);
    assert.equal(row.output, 44);
    assert.equal(row.cacheRead, 1920);
    assert.equal(row.costUsd, null);
    assert.ok(usage.totals.inputTokens > 0);
  } finally { await srv.close(); }
});

test('cwd and status survive server restart (replay path)', async () => {
  const { env } = mkEnv();
  const srv1 = await startServer({ port: 0, pollMs: 50, env });
  await new Promise(r => setTimeout(r, 300));
  await srv1.close();
  const srv2 = await startServer({ port: 0, pollMs: 50, env });
  try {
    await new Promise(r => setTimeout(r, 300));
    const state = await (await fetch(`http://127.0.0.1:${srv2.port}/api/state`)).json();
    const s = state.sessions.find(x => x.id === SID);
    assert.ok(s, 'codex session listed after restart');
    assert.equal(s.cwd, 'D:\\proj');
    assert.equal(s.status?.model?.id, 'gpt-5.5');
    const detail = await (await fetch(`http://127.0.0.1:${srv2.port}/api/state?session=${encodeURIComponent(SID)}`)).json();
    assert.ok(detail.events.every(e => e.kind !== 'meta'), 'meta events not in replayed log');
  } finally { await srv2.close(); }
});
