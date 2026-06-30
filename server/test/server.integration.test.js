// server/test/server.integration.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, normalizeStatus, genericLive } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-int-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'D--test');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  const transcript = path.join(projDir, 'sess1.jsonl');
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'),
    JSON.stringify([{ sessionId: 'sess1', ppid: process.pid, cwd: 'D:\\test', transcriptPath: transcript, ts: Date.now() }]));
  return {
    transcript,
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
           GLMPS_STATE_DIR: path.join(tmp, 'state'),
           GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
           GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
           GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
           GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
           GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
           GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode') },
  };
}

test('state endpoint lists session; SSE delivers extracted event on append', async () => {
  const { transcript, env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env }); // port 0 = ephemeral
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    assert.equal((await (await fetch(`${base}/api/health`)).json()).ok, true);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].id, 'sess1');
    assert.equal(state.sessions[0].live, true);

    // listen for SSE, then append a Skill tool_use to the transcript
    const res = await fetch(`${base}/api/events`);
    const reader = res.body.getReader();
    fs.appendFileSync(transcript, JSON.stringify({
      type: 'assistant', timestamp: '2026-06-05T10:00:00Z',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'x:y' } }] },
    }) + '\n');
    const deadline = Date.now() + 5000;
    let text = '';
    while (Date.now() < deadline && !text.includes('"kind":"skill"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf-8');
    }
    assert.match(text, /"kind":"skill"/);
    assert.match(text, /"sessionId":"sess1"/);
  } finally { await srv.close(); }
});

test('SSE sends a hello event carrying the server buildId on connect', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const res = await fetch(`${base}/api/events`);
    const reader = res.body.getReader();
    const deadline = Date.now() + 5000;
    let text = '';
    while (Date.now() < deadline && !text.includes('"type":"hello"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf-8');
    }
    const line = text.split('\n').find(l => l.startsWith('data:') && l.includes('"hello"'));
    assert.ok(line, 'expected a hello data event on connect');
    const payload = JSON.parse(line.slice('data:'.length).trim());
    assert.equal(payload.type, 'hello');
    assert.equal(typeof payload.buildId, 'string');
    assert.ok(payload.buildId.length > 0);
    await reader.cancel();
  } finally { await srv.close(); }
});

test('GET /api/engagement returns 200 JSON with tiers object', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const r = await fetch(`${base}/api/engagement`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /application\/json/);
    const body = await r.json();
    assert.ok(body.tiers && typeof body.tiers === 'object', 'tiers must be an object');
    assert.ok('artifact' in body.tiers, 'tiers.artifact missing');
    assert.ok('brain' in body.tiers, 'tiers.brain missing');
    assert.ok('ephemeral' in body.tiers, 'tiers.ephemeral missing');
  } finally { await srv.close(); }
});

test('SPA fallback serves index.html for client-side routes', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    // A route with no file extension -> the SPA shell (index.html)
    const r = await fetch(`${base}/history`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    assert.match(await r.text(), /<title>GLMPS<\/title>/);
    // A deep link with a param also serves the shell
    const r2 = await fetch(`${base}/detail/abc123`);
    assert.equal(r2.status, 200);
    // Unknown /api path still 404s (must NOT fall back to index.html)
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    // A missing asset (has a file extension) still 404s
    assert.equal((await fetch(`${base}/nope.js`)).status, 404);
  } finally { await srv.close(); }
});

test('file api routes enforce allowlist and conflicts', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const target = path.join(env.GLMPS_CLAUDE_DIR, 'CLAUDE.md');
    fs.writeFileSync(target, 'hello');
    const r1 = await (await fetch(`${base}/api/file?path=${encodeURIComponent(target)}`)).json();
    assert.equal(r1.content, 'hello');
    const put = await fetch(`${base}/api/file`, { method: 'PUT',
      body: JSON.stringify({ path: target, content: 'world', hash: r1.hash }) });
    assert.equal(put.status, 200);
    const conflict = await fetch(`${base}/api/file`, { method: 'PUT',
      body: JSON.stringify({ path: target, content: 'x', hash: r1.hash }) });
    assert.equal(conflict.status, 409);
    const outside = await fetch(`${base}/api/file?path=${encodeURIComponent('C:\\Windows\\system.ini')}`);
    assert.equal((await outside.json()).error !== undefined, true);
  } finally { await srv.close(); }
});

test('open-in-editor returns 400 when not configured', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const target = path.join(env.GLMPS_CLAUDE_DIR, 'CLAUDE.md');
    fs.writeFileSync(target, 'x');
    const r = await fetch(`${base}/api/open-in-editor`, { method: 'POST',
      body: JSON.stringify({ path: target }) });
    assert.equal(r.status, 400);
  } finally { await srv.close(); }
});

test('dead-ppid session with fresh transcript still reports live', async () => {
  const { transcript, env } = mkEnv();
  // rewrite registry with a dead ppid; transcript mtime is fresh (just created)
  fs.writeFileSync(path.join(env.GLMPS_CLAUDE_DIR, '.claude-manager', 'active-sessions.json'),
    JSON.stringify([{ sessionId: 'sess1', ppid: 999999999, cwd: 'D:\\test', transcriptPath: transcript, ts: Date.now() }]));
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const state = await (await fetch(`http://127.0.0.1:${srv.port}/api/state`)).json();
    assert.equal(state.sessions.find(s => s.id === 'sess1').live, true);
  } finally { await srv.close(); }
});

test('normalizeStatus maps raw snake_case statusline fields', () => {
  const n = normalizeStatus({ session_name: 'My session',
    model: { id: 'm1', display_name: 'Model One' },
    context_window: { used_percentage: 40 },
    cost: { total_cost_usd: 39.79 },
    rate_limits: { five_hour: { used_percentage: 4 } }, capturedAt: 5 });
  assert.equal(n.model.displayName, 'Model One');
  assert.equal(n.context.usedPercent, 40);
  assert.equal(n.cost.totalUsd, 39.79);
  assert.equal(n.sessionName, 'My session');
  assert.equal(n.rateLimits.five_hour.used_percentage, 4);
  assert.equal(normalizeStatus(null), null);
});

test('cloud-only AG sessions surface as history-only remote entries', async () => {
  const { env } = mkEnv();
  const agDir = env.GLMPS_ANTIGRAVITY_DIR;
  // Build a fake agyhub_summaries_proto.pb with one cloud-only conversation.
  // Format: printable runs separated by 0x00 — '$<uuid>' NUL 'Cloud Conv Title' NUL 'file:///d:/proj'
  const cloudId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const parts = [`$${cloudId}`, 'Cloud Conv Title', 'file:///d:/proj'];
  const chunks = parts.map(p => Buffer.from(p, 'ascii'));
  const sep = Buffer.alloc(1, 0x00);
  const pbBuf = Buffer.concat(
    chunks.flatMap((c, i) => i < chunks.length - 1 ? [c, sep] : [c])
  );
  fs.writeFileSync(path.join(agDir, 'agyhub_summaries_proto.pb'), pbBuf);

  const srv = await startServer({ port: 0, pollMs: 50, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const state = await (await fetch(`${base}/api/state`)).json();

    // history index must contain the cloud id
    const histEntry = (state.history ?? []).find(h => h.id === cloudId);
    assert.ok(histEntry, 'cloud session present in history');
    assert.equal(histEntry.tool, 'antigravity');
    assert.equal(histEntry.title, 'Cloud Conv Title');

    // sessions list must contain it with live=false and format='remote'
    const sessionEntry = (state.sessions ?? []).find(s => s.id === cloudId);
    assert.ok(sessionEntry, 'cloud session present in sessions');
    assert.equal(sessionEntry.live, false);
    assert.equal(sessionEntry.format, 'remote');
    assert.equal(sessionEntry.title, 'Cloud Conv Title');
  } finally { await srv.close(); }
});

test('event history replays after server restart (offsets at EOF)', async () => {
  const { transcript, env } = mkEnv();
  fs.appendFileSync(transcript, JSON.stringify({
    type: 'assistant', timestamp: '2026-06-05T10:00:00Z',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'a:b' } }] },
  }) + '\n');
  // first server consumes the line and persists offsets at EOF
  const srv1 = await startServer({ port: 0, pollMs: 50, env });
  await new Promise(r => setTimeout(r, 300));
  await srv1.close();
  // second server starts with offsets at EOF — must still rehydrate history
  const srv2 = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const state = await (await fetch(`http://127.0.0.1:${srv2.port}/api/state?session=sess1`)).json();
    assert.ok(state.events.some(e => e.kind === 'skill'), 'replayed skill event present');
  } finally { await srv2.close(); }
});

test('POST /api/runner/run returns 409 observe-only when no controllable harness installed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gate-'));
  tmpDirs.push(tmp);
  // GLMPS_CLAUDE_DIR must not exist so claude-code detect() returns installed=false
  // (the only adapter with controllable=true). No GLMPS_ALLOW_ACT, no GLMPS_RUNNER_DRYRUN.
  const env = {
    GLMPS_CLAUDE_DIR:        path.join(tmp, 'no-claude'),
    GLMPS_ANTIGRAVITY_DIR:   path.join(tmp, 'ag'),
    GLMPS_STATE_DIR:         path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR:    path.join(tmp, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR:       path.join(tmp, 'agy-cli'),
    GLMPS_CODEX_DIR:         path.join(tmp, 'codex'),
    GLMPS_HERMES_DIR:        path.join(tmp, 'hermes'),
    GLMPS_OPENCODE_DIR:      path.join(tmp, 'opencode'),
  };
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/runner/run/any-id`, { method: 'POST' });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.error, 'observe-only');
  } finally { await srv.close(); }
});

// ── genericLive pure-function tests ──────────────────────────────────────────

const cfgStub = { idleThresholdMs: 60_000 }; // heartbeat window = 600s = 10min

test('genericLive: fresh heartbeat + 1h-old db → live=true', () => {
  const now = Date.now();
  const heartbeatMs = now - 30_000;        // 30s ago — well within 10x idleThreshold (600s)
  const mtimeMs = now - 3_600_000;         // 1h ago — within 8h window
  assert.equal(genericLive(heartbeatMs, mtimeMs, now, cfgStub), true);
});

test('genericLive: stale heartbeat → live=false regardless of db freshness', () => {
  const now = Date.now();
  const heartbeatMs = now - 700_000;       // 700s ago — beyond 10x idleThreshold (600s)
  const mtimeMs = now - 60_000;            // 1min ago — fresh db
  assert.equal(genericLive(heartbeatMs, mtimeMs, now, cfgStub), false);
});

test('genericLive: fresh heartbeat + 9h-old db → live=false (outside 8h window)', () => {
  const now = Date.now();
  const heartbeatMs = now - 30_000;        // 30s ago — fresh heartbeat
  const mtimeMs = now - 9 * 3_600_000;    // 9h ago — beyond 8h window
  assert.equal(genericLive(heartbeatMs, mtimeMs, now, cfgStub), false);
});

test('genericLive: heartbeat exactly at boundary (10x idleThresholdMs) → live=true', () => {
  const now = Date.now();
  const heartbeatMs = now - cfgStub.idleThresholdMs * 10; // exactly at boundary
  const mtimeMs = now - 3_600_000;
  assert.equal(genericLive(heartbeatMs, mtimeMs, now, cfgStub), true);
});

test('genericLive: db exactly at 8h boundary → live=true', () => {
  const now = Date.now();
  const heartbeatMs = now - 30_000;
  const mtimeMs = now - 8 * 3_600_000;    // exactly at 8h boundary
  assert.equal(genericLive(heartbeatMs, mtimeMs, now, cfgStub), true);
});

test('GLMPS_PROFILE: engagement profile loads at bootstrap and surfaces via /api/engagement', async () => {
  const { env } = mkEnv();
  // Write a minimal profile file in a dedicated temp dir (registered for cleanup).
  const profileTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-profile-'));
  tmpDirs.push(profileTmp);
  const repoRoot = path.join(profileTmp, 'acme-repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const profileFile = path.join(profileTmp, 'glmps.profile.json');
  fs.writeFileSync(profileFile, JSON.stringify({ engagement: 'acme-test', repoRoots: [repoRoot] }));

  const srv = await startServer({ port: 0, pollMs: 1000, env: { ...env, GLMPS_PROFILE: profileFile } });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const r = await fetch(`${base}/api/engagement`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.engagement, 'acme-test', 'engagement name must match profile');
    assert.ok(
      Array.isArray(body.tiers?.artifact?.roots) && body.tiers.artifact.roots.includes(repoRoot),
      `tiers.artifact.roots must include ${repoRoot}; got ${JSON.stringify(body.tiers?.artifact?.roots)}`,
    );
  } finally { await srv.close(); }
});
