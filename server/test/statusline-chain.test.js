// server/test/statusline-chain.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordStatus, buildSettingsPatch, usageRecordFrom, appendSnapshot } from '../../taps/statusline-chain-lib.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

function todayBucket() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function readUsageLines(stateDir) {
  const usageDir = path.join(stateDir, 'usage');
  const out = [];
  for (const f of fs.readdirSync(usageDir).filter(x => x.endsWith('.ndjson'))) {
    for (const line of fs.readFileSync(path.join(usageDir, f), 'utf-8').split('\n')) {
      const t = line.trim(); if (t) out.push(JSON.parse(t));
    }
  }
  return out;
}

const RAW = {
  session_id: 'sess1',
  model: { id: 'claude-opus-4-8', display_name: 'Opus' },
  cwd: 'D:\\proj',
  cost: { total_cost_usd: 2.5, total_duration_ms: 1000, total_api_duration_ms: 800,
    total_lines_added: 40, total_lines_removed: 5 },
  context_window: { total_input_tokens: 1200, total_output_tokens: 300, used_percentage: 42 },
  current_usage: { input: 100, output: 50, cache_creation_input_tokens: 70, cache_read_input_tokens: 900 },
};

test('recordStatus writes per-session file keyed by session_id', () => {
  const dir = mkTmp();
  const input = { session_id: 'abc', model: { id: 'claude-opus-4-8' },
    context: { usedPercent: 7 }, cost: { totalUsd: 1.23 } };
  recordStatus(input, dir);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'abc.json'), 'utf-8'));
  assert.equal(written.model.id, 'claude-opus-4-8');
  assert.ok(typeof written.capturedAt === 'number');
});

test('recordStatus ignores input without session_id and sanitizes weird ids', () => {
  const dir = mkTmp();
  recordStatus({ model: {} }, dir);
  assert.deepEqual(fs.readdirSync(dir), []);
  recordStatus({ session_id: '..\\evil' }, dir);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes('..'));
});

test('buildSettingsPatch swaps command and remembers the old one', () => {
  const settings = { statusLine: { type: 'command', command: 'node "C:\\old\\tap.js"', padding: 0 } };
  const { patched, previousCommand } = buildSettingsPatch(settings, 'C:\\mc\\taps\\statusline-chain.js');
  assert.equal(previousCommand, 'node "C:\\old\\tap.js"');
  assert.match(patched.statusLine.command, /statusline-chain\.js/);
  assert.equal(patched.statusLine.padding, 0);
});

test('buildSettingsPatch handles settings without statusLine', () => {
  const { patched, previousCommand } = buildSettingsPatch({}, 'C:\\mc\\taps\\statusline-chain.js');
  assert.equal(previousCommand, null);
  assert.equal(patched.statusLine.type, 'command');
  assert.match(patched.statusLine.command, /statusline-chain\.js/);
});

test('usageRecordFrom maps the raw payload to the snapshot shape', () => {
  const rec = usageRecordFrom(RAW, 1700000000000);
  assert.equal(rec.sid, 'sess1');
  assert.equal(rec.capturedAt, 1700000000000);
  assert.equal(rec.ts, 1700000000000); // no raw.ts -> falls back to capturedAt
  assert.equal(rec.model, 'claude-opus-4-8');
  assert.equal(rec.costUsd, 2.5);
  assert.equal(rec.durationMs, 1000);
  assert.equal(rec.apiDurationMs, 800);
  assert.equal(rec.linesAdded, 40);
  assert.equal(rec.linesRemoved, 5);
  assert.equal(rec.input, 1200);
  assert.equal(rec.output, 300);
  assert.equal(rec.cacheRead, 900);
  assert.equal(rec.cacheCreate, 70);
  assert.equal(rec.ctxUsedPct, 42);
  assert.equal(rec.cwd, 'D:\\proj');
});

test('usageRecordFrom is defensive: missing fields become null', () => {
  const rec = usageRecordFrom({ session_id: 'x' });
  assert.equal(rec.sid, 'x');
  assert.equal(rec.model, null);
  assert.equal(rec.costUsd, null);
  assert.equal(rec.input, null);
  assert.equal(rec.cacheRead, null);
  assert.equal(rec.ctxUsedPct, null);
  assert.equal(rec.cwd, null);
  assert.equal(usageRecordFrom(null), null);
  assert.equal(usageRecordFrom('nope'), null);
});

test('appendSnapshot writes one NDJSON line per call into usage/<date>.ndjson', () => {
  const stateDir = mkTmp();
  appendSnapshot(stateDir, usageRecordFrom(RAW));
  appendSnapshot(stateDir, usageRecordFrom({ ...RAW, cost: { total_cost_usd: 3.0 } }));
  const file = path.join(stateDir, 'usage', `${todayBucket()}.ndjson`);
  assert.ok(fs.existsSync(file));
  const lines = readUsageLines(stateDir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].costUsd, 2.5);
  assert.equal(lines[1].costUsd, 3.0);
});

test('recordStatus appends a usage NDJSON line AND still writes status', () => {
  const stateDir = mkTmp();
  const statusDir = path.join(stateDir, 'status');
  recordStatus(RAW, statusDir);

  // status file still written, unchanged behavior
  const written = JSON.parse(fs.readFileSync(path.join(statusDir, 'sess1.json'), 'utf-8'));
  assert.equal(written.model.id, 'claude-opus-4-8');
  assert.ok(typeof written.capturedAt === 'number');

  // usage line appended with mapped fields
  const lines = readUsageLines(stateDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].sid, 'sess1');
  assert.equal(lines[0].costUsd, 2.5);
  assert.equal(lines[0].input, 1200);
  assert.equal(lines[0].cacheRead, 900);
  assert.equal(lines[0].capturedAt, written.capturedAt); // same capturedAt as status
});

test('recordStatus without session_id writes neither status nor usage', () => {
  const stateDir = mkTmp();
  const statusDir = path.join(stateDir, 'status');
  recordStatus({ model: {} }, statusDir);
  // status dir not created (no write) -> empty/absent
  let statusFiles = [];
  try { statusFiles = fs.readdirSync(statusDir); } catch {}
  assert.deepEqual(statusFiles, []);
  // no usage dir created
  assert.equal(fs.existsSync(path.join(stateDir, 'usage')), false);
});

test('buildSettingsPatch preserves delegation by chaining to the previous command', () => {
  // The previous statusline command is remembered so the tap can delegate to it.
  const settings = { statusLine: { type: 'command', command: 'node "C:\\cm\\tap.js"' } };
  const { patched, previousCommand } = buildSettingsPatch(settings, 'C:\\mc\\taps\\statusline-chain.js');
  assert.equal(previousCommand, 'node "C:\\cm\\tap.js"');
  assert.match(patched.statusLine.command, /statusline-chain\.js/);
});
