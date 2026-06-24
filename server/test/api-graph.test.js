// server/test/api-graph.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { sessionScope } from '../lib/zones.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-graph-')); tmpDirs.push(tmp);
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
    projectDir: tmp,
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

test('GET /api/graph returns { project, graph: null, zoneConfig } for a project with no graph file', async () => {
  const { projectDir, env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    // projectDir has no graphify-out/graph.json, so graph must be null
    const res = await fetch(`${base}/api/graph?project=${encodeURIComponent(projectDir)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('project' in body, 'response has project field');
    assert.ok('graph' in body, 'response has graph field');
    assert.ok('zoneConfig' in body, 'response has zoneConfig field');
    assert.equal(body.project, projectDir);
    assert.equal(body.graph, null, 'graph is null when no graph file exists');
    assert.ok('graphRoot' in body, 'response has graphRoot field');
    assert.equal(body.graphRoot, null, 'graphRoot is null when no graph file exists');
    assert.ok(Array.isArray(body.zoneConfig.prefixes), 'zoneConfig has prefixes array');
  } finally { await srv.close(); }
});

test('GET /api/graph includes graphRoot = parent of the loaded graphify-out dir', async () => {
  const { projectDir, env } = mkEnv();
  const goDir = path.join(projectDir, 'graphify-out');
  fs.mkdirSync(goDir, { recursive: true });
  fs.writeFileSync(path.join(goDir, 'graph.json'), JSON.stringify({
    nodes: [{ id: 'a', label: 'a.js', source_file: 'a.js', community: 0 }],
    links: [],
  }));
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const res = await fetch(`${base}/api/graph?project=${encodeURIComponent(projectDir)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('graphRoot' in body, 'response has graphRoot field');
    assert.equal(body.graphRoot, projectDir.replace(/\\/g, '/'),
      'graphRoot is the parent of graphify-out, forward-slashed');
    assert.ok(body.graph, 'graph loaded');
  } finally { await srv.close(); }
});

test('session.scope is sessionScope over file-edit paths', () => {
  const scope = sessionScope(['D:\\mc\\web\\a.js'], { projectRoot: 'D:\\mc' });
  assert.equal(scope.allDev, true);
  assert.ok(Array.isArray(scope.zones), 'zones is an array');
  assert.ok(Array.isArray(scope.protected), 'protected is an array');
  assert.equal(typeof scope.touched, 'number');
  assert.equal(scope.touched, 1);
});
