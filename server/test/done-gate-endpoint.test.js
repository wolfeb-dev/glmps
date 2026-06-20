// Integration: /api/state?session merges the session's done-gate JSONL into its events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('/api/state?session merges done-gate results as shared-shape events', async () => {
  const stateDir = tmp('mc-state-');
  const dgDir = tmp('mc-dg-');
  const sid = 'sess-xyz';
  fs.writeFileSync(path.join(dgDir, `${sid}.jsonl`),
    JSON.stringify({ ts: 1, result: 'block', failedCommand: 'npm test', sessionId: sid }) + '\n' +
    JSON.stringify({ ts: 2, result: 'pass', sessionId: sid }) + '\n');

  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_DONE_GATE_DIR: dgDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/state?session=${sid}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const dg = body.events.filter(e => e.kind === 'done-gate');
    assert.equal(dg.length, 2, `expected 2 done-gate events: ${JSON.stringify(body.events)}`);
    assert.ok(dg.some(e => /blocked/.test(e.label) && /npm test/.test(e.label)), 'block event present');
    assert.ok(dg.some(e => /passed/.test(e.label)), 'pass event present');
    assert.ok(dg.every(e => e.sessionId === sid && e.tool === 'done-gate'));
  } finally {
    await h.close?.();
  }
});
