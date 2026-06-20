// Integration: GET /api/budget returns the real Claude.ai usage shape.
// Hermetic: a temp GLMPS_CLAUDE_DIR with a statusline.json but NO .credentials.json,
// so readBudget takes the statusline-fallback path and makes no network call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('/api/budget returns real-usage shape (statusline fallback, no creds)', async () => {
  const stateDir = tmp('mc-state-');
  const claudeDir = tmp('mc-claude-');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'statusline.json'),
    JSON.stringify({
      model: { displayName: 'Opus 4.8' }, context: { usedPercent: 58 }, cost: { totalUsd: 143.19 },
      rateLimits: { fiveHour: { usedPercent: 31, resetsAt: 1781332200 }, sevenDay: { usedPercent: 3, resetsAt: 1781762400 } },
    }));
  // No .credentials.json -> no token -> no authed call -> statusline fallback.
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/budget`);
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.available, true);
    assert.equal(b.source, 'statusline-fallback');
    assert.equal(b.usage.fiveHour.usedPercent, 31);
    assert.equal(b.usage.sevenDay.usedPercent, 3);
    assert.equal(b.usage.sevenDaySonnet, null);
    assert.equal(b.meta.model, 'Opus 4.8');
    assert.ok(Array.isArray(b.flags));
    assert.equal(typeof b.updatedTs, 'number');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
