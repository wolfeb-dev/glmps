import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import * as backlogStore from '../lib/backlog-store.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

async function withServer(fn) {
  const stateDir = tmp('mc-state-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  try {
    await fn({ get, stateDir });
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test('GET /api/projects returns summarized known repos', async () => {
  await withServer(async ({ get, stateDir }) => {
    // Seed a backlog item under the server's own repo basename so backlogOpen >= 1
    const selfKey = path.basename(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..'));
    backlogStore.addItemTo(stateDir, { project: selfKey, title: 'seeded test item' });

    const res = await get('/api/projects');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.projects), 'projects is an array');

    const self = res.body.projects.find(p => p.key === selfKey);
    assert.ok(self, `server own repo present (key=${selfKey})`);
    assert.equal(typeof self.sessionCount, 'number');
    assert.ok('branch' in self, 'branch field present');
    assert.ok(self.graph && 'nodes' in self.graph, 'graph.nodes present');
    assert.ok(self.backlogOpen >= 1, `backlogOpen=${self.backlogOpen} should be >= 1`);

    // Structural checks on all entries
    for (const p of res.body.projects) {
      assert.ok(typeof p.key === 'string' && p.key.length > 0, 'key is non-empty string');
      assert.ok(typeof p.name === 'string', 'name is string');
      assert.ok(typeof p.path === 'string', 'path is string');
      assert.ok(typeof p.sessionCount === 'number', 'sessionCount is number');
      assert.ok(typeof p.liveCount === 'number', 'liveCount is number');
      assert.ok('lastTs' in p, 'lastTs field present');
      assert.ok('branch' in p, 'branch field present');
      assert.ok(p.graph && typeof p.graph.nodes === 'number', 'graph.nodes is number');
      assert.ok(typeof p.graph.needsUpdate === 'boolean', 'graph.needsUpdate is boolean');
      assert.ok(typeof p.backlogOpen === 'number', 'backlogOpen is number');
    }
  });
});
