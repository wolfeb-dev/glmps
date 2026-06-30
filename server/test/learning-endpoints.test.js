// server/test/learning-endpoints.test.js
// HTTP smoke of the /api/learning* routes against a real server instance on an
// ephemeral port, with a temp GLMPS_STATE_DIR and a temp git GLMPS_ASSETS_DIR so the
// deterministic apply path produces an actual commit. Covers the wired approve
// branch + applied/failed/404 + toggle persistence the unit tests can't reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { startServer } from '../server.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function gitAssetsRepo() {
  const d = tmp('mc-assets-');
  fs.writeFileSync(path.join(d, 'CLAUDE.global.md'), '# Global\n');
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: d });
  return d;
}

test('learning HTTP endpoints: idea, config, alternative, approve->applied, discard, 404', async () => {
  const stateDir = tmp('mc-state-');
  const assetsDir = gitAssetsRepo();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_ASSETS_DIR: assetsDir, GLMPS_ALLOW_ACT: '1' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

  try {
    // Empty queue + default config
    let r = await j('/api/learning');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, []);
    assert.equal(r.body.config.autoApplyGaps, false);

    // Add an idea
    const idea = await post('/api/learning/idea', { text: 'always run lint before committing' });
    assert.equal(idea.status, 200);
    assert.equal(idea.body.source, 'idea');
    assert.equal(idea.body.status, 'pending');
    const id = idea.body.id;

    // It persists
    assert.equal((await j('/api/learning')).body.items.length, 1);

    // Empty idea is rejected
    assert.equal((await post('/api/learning/idea', { text: '   ' })).status, 400);

    // Toggle persists
    const cfg = await post('/api/learning/config', { autoApplyGaps: true });
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.autoApplyGaps, true);
    assert.equal((await j('/api/learning')).body.config.autoApplyGaps, true);

    // Alternative gives the idea a user-authored guard rule, still pending
    const alt = await post(`/api/learning/item/${id}/alternative`, { rule: '- Run the linter before every commit.' });
    assert.equal(alt.body.status, 'pending');
    assert.equal(alt.body.proposedGuard.rule, '- Run the linter before every commit.');

    // Approve now applies deterministically against the temp git repo
    const ap = await post(`/api/learning/item/${id}/approve`, {});
    assert.equal(ap.body.status, 'applied');
    assert.ok(typeof ap.body.applyCommit === 'string' && ap.body.applyCommit.length >= 7);
    const guard = fs.readFileSync(path.join(assetsDir, 'CLAUDE.global.md'), 'utf-8');
    assert.match(guard, /## Learned guards/);
    assert.match(guard, /Run the linter before every commit/);

    // Discard
    const d2 = await post('/api/learning/idea', { text: 'to discard' });
    const disc = await post(`/api/learning/item/${d2.body.id}/discard`, {});
    assert.equal(disc.body.status, 'discarded');

    // Unknown item -> 404
    assert.equal((await post('/api/learning/item/does-not-exist/approve', {})).status, 404);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});

test('promote: target global commits a guard; target memory dispatches a memory-compose', async () => {
  const stateDir = tmp('mc-state-');
  const assetsDir = gitAssetsRepo();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_ASSETS_DIR: assetsDir, GLMPS_ALLOW_ACT: '1' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

  try {
    // promote to global -> deterministic guard commit into the assets repo
    const i1 = await post('/api/learning/idea', { text: 'prefer parallel subagents for independent work' });
    const pg = await post(`/api/learning/item/${i1.body.id}/promote`, { target: 'global' });
    assert.equal(pg.status, 200);
    assert.equal(pg.body.status, 'applied');
    assert.ok(typeof pg.body.applyCommit === 'string' && pg.body.applyCommit.length >= 7);
    const guard = fs.readFileSync(path.join(assetsDir, 'CLAUDE.global.md'), 'utf-8');
    assert.match(guard, /## Learned guards/);
    assert.match(guard, /prefer parallel subagents/);

    // promote to memory -> dispatched + a terminal request enqueued mentioning MEMORY.md
    const i2 = await post('/api/learning/idea', { text: 'managed exit already absorbs the morning edge' });
    const pm = await post(`/api/learning/item/${i2.body.id}/promote`, { target: 'memory' });
    assert.equal(pm.status, 200);
    assert.equal(pm.body.status, 'dispatched');
    const reqLines = fs.readFileSync(path.join(stateDir, 'requests', 'resume.jsonl'), 'utf-8').trim().split('\n');
    const last = JSON.parse(reqLines[reqLines.length - 1]);
    assert.equal(last.type, 'terminal');
    assert.match(last.command, /MEMORY\.md/);

    // unknown item -> 404
    assert.equal((await post('/api/learning/item/nope/promote', { target: 'global' })).status, 404);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});
