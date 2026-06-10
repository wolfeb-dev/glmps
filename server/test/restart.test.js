// server/test/restart.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-restart-')); tmpDirs.push(d); return d; }

test('POST /api/restart returns 200 and invokes the injected restartFn (no real exit)', async () => {
  const stateDir = mkTmp();
  let called = 0;
  const srv = await startServer({
    port: 0, env: { ...process.env, GLMPS_STATE_DIR: stateDir }, pollMs: 100000,
    restartFn: () => { called++; },
  });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/restart`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).restarting, true);
    await new Promise(res => setTimeout(res, 400)); // restart is scheduled ~200ms out
    assert.equal(called, 1);
  } finally {
    await srv.close();
  }
});

test('GET /api/config exposes port, version and configPath', async () => {
  const stateDir = mkTmp();
  const srv = await startServer({
    port: 0, env: { ...process.env, GLMPS_STATE_DIR: stateDir }, pollMs: 100000,
    restartFn: () => {},
  });
  try {
    const cfg = await (await fetch(`http://127.0.0.1:${srv.port}/api/config`)).json();
    assert.equal(typeof cfg.port, 'number');
    assert.ok('version' in cfg);
    assert.ok('configPath' in cfg);
  } finally {
    await srv.close();
  }
});
