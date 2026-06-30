import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

async function withServer(fn) {
  const stateDir = tmp('mc-state-');
  const od = path.join(stateDir, 'outcomes');
  fs.mkdirSync(od, { recursive: true });
  fs.writeFileSync(path.join(od, 'rows.ndjson'),
    JSON.stringify({ id: 'session-a', unit: 'session', taskClass: 'feature', turns: 3, firstTry: true, verifier: { exitOk: true }, contextUsageRatio: 0.4 }) + '\n' +
    JSON.stringify({ id: 'session-b', unit: 'session', taskClass: 'feature', turns: 7, firstTry: false, verifier: { exitOk: false }, contextUsageRatio: 0.6 }) + '\n' +
    JSON.stringify({ id: 'trade-1', unit: 'trade', taskClass: 'other' }) + '\n');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  const post = async (p, obj) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }); return { status: r.status, body: await r.json() }; };
  try { await fn({ get, post }); } finally { await h.close?.(); fs.rmSync(stateDir, { recursive: true, force: true }); }
}

test('GET /api/outcomes returns rows and filters', async () => {
  await withServer(async ({ get }) => {
    const all = await get('/api/outcomes');
    assert.equal(all.status, 200);
    assert.equal(all.body.outcomes.length, 3);
    assert.equal((await get('/api/outcomes?unit=trade')).body.outcomes.length, 1);
    assert.equal((await get('/api/outcomes?taskClass=feature')).body.outcomes.length, 2);
  });
});

test('GET /api/outcomes/summary aggregates by taskClass', async () => {
  await withServer(async ({ get }) => {
    const s = await get('/api/outcomes/summary');
    assert.equal(s.status, 200);
    assert.equal(s.body.byClass.feature.n, 2);
    assert.equal(s.body.byClass.feature.medianTurns, 5);
    assert.equal(s.body.byClass.feature.verifierPassRate, 0.5);
    assert.equal(s.body.byClass.feature.firstTryRate, 0.5);
  });
});

test('GET /api/replay returns empty set when none registered', async () => {
  await withServer(async ({ get }) => {
    const r = await get('/api/replay');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tasks, []);
  });
});

test('GET /api/replay lists the registered eval/replay tasks', async () => {
  const stateDir = tmp('mc-state-');
  fs.mkdirSync(path.join(stateDir, 'replay'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'replay', 'tasks.json'),
    JSON.stringify({ tasks: [{ id: 't1', project: 'p', promptFile: null, baseline: null }] }));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/replay`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].id, 't1');
  } finally { await h.close?.(); fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('GET /api/promotion returns a verdict over per-unit aggregates', async () => {
  await withServer(async ({ get }) => {
    const r = await get('/api/promotion');
    assert.equal(r.status, 200);
    assert.equal(r.body.available, true);
    assert.equal(r.body.champion.unit, 'session'); // n=2, the incumbent
    assert.equal(r.body.challenger.unit, 'trade');  // n=1
    assert.ok(['promote', 'hold', 'reject'].includes(r.body.verdict));
  });
});

test('POST /api/outcomes/finalize appends idempotently; 400 without session', async () => {
  await withServer(async ({ get, post }) => {
    const r1 = await post('/api/outcomes/finalize', { session: 'newsess' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.appended, true);
    assert.equal(r1.body.row.id, 'session-newsess');
    const r2 = await post('/api/outcomes/finalize', { session: 'newsess' });
    assert.equal(r2.body.appended, false);
    assert.equal((await get('/api/outcomes?unit=session')).body.outcomes.length, 3);
    assert.equal((await post('/api/outcomes/finalize', {})).status, 400);
  });
});
