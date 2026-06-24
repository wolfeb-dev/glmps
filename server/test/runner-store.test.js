import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../lib/runner-store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-runner-')); }

test('loadConfig returns defaults when no file', () => {
  const dir = tmp();
  assert.deepEqual(store.loadConfig(dir), store.DEFAULTS);
});

test('saveConfig merges partial onto current and persists', () => {
  const dir = tmp();
  const merged = store.saveConfig(dir, { enabled: true, lastTarget: 'cursor' });
  assert.equal(merged.enabled, true);
  assert.equal(merged.lastTarget, 'cursor');
  assert.equal(merged.maxConcurrent, 1);
  assert.equal(store.loadConfig(dir).enabled, true);
});

test('ledger round-trips and prompt file is written', () => {
  const dir = tmp();
  store.saveLedger(dir, { 'glmps-1': { pid: 42, startedAt: 100, target: 'cursor', retries: 0 } });
  assert.equal(store.loadLedger(dir)['glmps-1'].pid, 42);
  const p = store.writePrompt(dir, 'glmps-1', 'do the thing');
  assert.equal(fs.readFileSync(p, 'utf-8'), 'do the thing');
  assert.ok(path.isAbsolute(p));
});
