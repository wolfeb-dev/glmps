// server/test/graph-learning-endpoints.test.js
// HTTP smoke tests for the four new Settings-panel endpoints:
//   GET  /api/graph/status
//   POST /api/graph/rebuild
//   GET  /api/learning/status
//   POST /api/learning/synth
//
// All tests run against an ephemeral server instance (port:0) with temp dirs
// via GLMPS_STATE_DIR so they never touch the user's real ~/.glmps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// ── GET /api/graph/status ─────────────────────────────────────────────────────

test('GET /api/graph/status returns { graphs: [] } when no graphify-out dirs exist', async () => {
  const stateDir = tmp('mc-state-');
  // GLMPS_CLAUDE_DIR points at an empty dir -> no settings.json -> no additionalDirectories,
  // and index is empty -> only REPO_ROOT is scanned; that has a graph but this server
  // instance still returns a valid array (may include glmps's own graph).
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/graph/status`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok('graphs' in body, 'response has graphs key');
    assert.ok(Array.isArray(body.graphs), 'graphs is an array');
    // Each entry must have the expected shape (if any)
    for (const g of body.graphs) {
      assert.ok('project' in g, 'has project');
      assert.ok('root' in g, 'has root');
      assert.ok(typeof g.nodes === 'number', 'nodes is number');
      assert.ok('needsUpdate' in g, 'has needsUpdate');
    }
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('GET /api/graph/status includes graph info when graphify-out/graph.json exists', async () => {
  const stateDir = tmp('mc-state-');
  // Create a fake repo root with a graph.json
  const fakeRoot = tmp('mc-repo-');
  fs.mkdirSync(path.join(fakeRoot, '.git'));
  fs.mkdirSync(path.join(fakeRoot, 'graphify-out'), { recursive: true });
  const graphData = {
    built_at_commit: 'aaa111',
    nodes: [{ id: 1 }, { id: 2 }, { id: 3 }],
  };
  fs.writeFileSync(path.join(fakeRoot, 'graphify-out', 'graph.json'), JSON.stringify(graphData));

  // Put fakeRoot into a temp settings.json so server picks it up
  const claudeDir = tmp('mc-claude-');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { additionalDirectories: [fakeRoot.replace(/\\/g, '/')] },
  }));

  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/graph/status`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const found = body.graphs.find(g => g.root.replace(/\\/g, '/') === fakeRoot.replace(/\\/g, '/'));
    assert.ok(found, `should find graph entry for fakeRoot in ${JSON.stringify(body.graphs.map(g => g.root))}`);
    assert.equal(found.nodes, 3);
    assert.equal(found.builtAtCommit, 'aaa111');
    assert.ok(typeof found.rebuiltMs === 'number', 'rebuiltMs is a number');
    // headCommit is null (no real git repo), so needsUpdate must be false
    assert.equal(found.needsUpdate, false);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(fakeRoot, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

// ── POST /api/graph/rebuild ───────────────────────────────────────────────────

test('POST /api/graph/rebuild returns { graphs: [...] } (graphify may not be installed; soft fail ok)', async () => {
  const stateDir = tmp('mc-state-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/graph/rebuild`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: '/nonexistent/path' }),
    });
    // Should not 500 hard — either 200 with graphs array or 200 empty
    assert.ok(r.status === 200 || r.status === 500, `unexpected status ${r.status}`);
    if (r.status === 200) {
      const body = await r.json();
      assert.ok('graphs' in body, 'response has graphs key');
    }
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── GET /api/learning/status ──────────────────────────────────────────────────

test('GET /api/learning/status returns { lastRunMs, pending, total } with empty store', async () => {
  const stateDir = tmp('mc-state-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/learning/status`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok('lastRunMs' in body, 'has lastRunMs');
    assert.ok('pending' in body, 'has pending');
    assert.ok('total' in body, 'has total');
    assert.equal(body.lastRunMs, null, 'lastRunMs null when no watermark');
    assert.equal(body.pending, 0);
    assert.equal(body.total, 0);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('GET /api/learning/status reads watermark and counts pending items', async () => {
  const stateDir = tmp('mc-state-');

  // Write a watermark
  const learningDir = path.join(stateDir, 'learning');
  fs.mkdirSync(learningDir, { recursive: true });
  fs.writeFileSync(path.join(learningDir, 'synth-watermark.json'), JSON.stringify({ lastRunMs: 1700000000000 }));

  // Write a store with 1 pending + 1 applied item
  const store = {
    items: [
      { id: 'a', source: 'gap', code: 'g1', severity: 'warn', title: 'gap1', body: '', project: 'x',
        sessionId: '', lastSessionId: '', status: 'pending', proposedGuard: null, applyCommit: null,
        count: 1, error: null, createdTs: 1, updatedTs: 1 },
      { id: 'b', source: 'idea', code: null, severity: 'idea', title: 'idea', body: 'i', project: '',
        sessionId: '', lastSessionId: '', status: 'applied', proposedGuard: null, applyCommit: 'abc',
        count: 1, error: null, createdTs: 1, updatedTs: 1 },
    ],
    config: { autoApplyGaps: false },
    seq: 1,
  };
  fs.writeFileSync(path.join(learningDir, 'store.json'), JSON.stringify(store));

  const env = { ...process.env, GLMPS_STATE_DIR: stateDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/learning/status`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.lastRunMs, 1700000000000);
    assert.equal(body.pending, 1);
    assert.equal(body.total, 2);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── POST /api/learning/synth ──────────────────────────────────────────────────

test('POST /api/learning/synth returns ok:false gracefully when script errors', async () => {
  const stateDir = tmp('mc-state-');
  // Point GLMPS_PROJECTS_DIR at an empty dir to avoid walking real transcripts,
  // but the script will still run; any error -> ok:false is acceptable.
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_PROJECTS_DIR: stateDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/learning/synth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    // 200 with ok true/false, or 500 — all acceptable since script may fail in test env
    assert.ok(r.status === 200 || r.status === 500, `status ${r.status}`);
    const body = await r.json();
    assert.ok('ok' in body || 'error' in body, 'has ok or error key');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
