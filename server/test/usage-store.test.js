// server/test/usage-store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUsage, appendSnapshot } from '../lib/usage-store.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

// Write synthetic ndjson directly into <stateDir>/usage/<date>.ndjson.
function writeDay(stateDir, date, records) {
  const usageDir = path.join(stateDir, 'usage');
  fs.mkdirSync(usageDir, { recursive: true });
  fs.writeFileSync(path.join(usageDir, `${date}.ndjson`),
    records.map(r => JSON.stringify(r)).join('\n') + '\n');
}
// helper to build a snapshot with capturedAt derived from date + an hour-ish
// ordering offset. We build a LOCAL timestamp (no 'Z') anchored near local noon
// so the record's local date == `date` regardless of the test machine's TZ
// (readUsage re-buckets every record by the LOCAL date of capturedAt).
function snap(date, h, o = {}) {
  const [y, m, d] = date.split('-').map(Number);
  const capturedAt = new Date(y, m - 1, d, 12, h, 0, 0).getTime();
  return { sid: o.sid ?? 's1', ts: capturedAt, capturedAt,
    model: o.model ?? 'claude-opus-4-8', costUsd: o.costUsd ?? null,
    input: o.input ?? null, output: o.output ?? null,
    cacheRead: o.cacheRead ?? null, cacheCreate: o.cacheCreate ?? null,
    ctxUsedPct: o.ctxUsedPct ?? null, cwd: o.cwd ?? null,
    linesAdded: o.linesAdded ?? null, linesRemoved: o.linesRemoved ?? null,
    durationMs: o.durationMs ?? null, apiDurationMs: o.apiDurationMs ?? null };
}

test('readUsage returns empty structure when no usage dir', () => {
  const stateDir = mkTmp();
  const u = readUsage(stateDir);
  assert.deepEqual(u.daily, []);
  assert.deepEqual(u.heatmap, []);
  assert.deepEqual(u.perSession, []);
  assert.deepEqual(u.totals, { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, sessions: 0, days: 0 });
});

test('daily values are cumulative deltas; the day uses the LAST snapshot that day', () => {
  const stateDir = mkTmp();
  // Day 1: session s1 ticks 3 times, cumulative cost rising 1 -> 2 -> 5.
  writeDay(stateDir, '2026-01-01', [
    snap('2026-01-01', 1, { costUsd: 1, input: 100, output: 10, cacheRead: 1000 }),
    snap('2026-01-01', 2, { costUsd: 2, input: 200, output: 20, cacheRead: 2000 }),
    snap('2026-01-01', 3, { costUsd: 5, input: 500, output: 50, cacheRead: 5000 }),
  ]);
  // Day 2: cumulative cost rises 5 -> 8 (delta 3), input 500 -> 900 (delta 400).
  writeDay(stateDir, '2026-01-02', [
    snap('2026-01-02', 1, { costUsd: 8, input: 900, output: 90, cacheRead: 9000 }),
  ]);
  const u = readUsage(stateDir);
  assert.equal(u.daily.length, 2);

  const d1 = u.daily.find(d => d.date === '2026-01-01');
  // First appearance -> delta vs 0 = last value that day.
  assert.equal(d1.costUsd, 5);
  assert.equal(d1.inputTokens, 500);
  assert.equal(d1.outputTokens, 50);
  assert.equal(d1.cacheReadTokens, 5000);
  assert.equal(d1.sessions, 1);

  const d2 = u.daily.find(d => d.date === '2026-01-02');
  assert.equal(d2.costUsd, 3);     // 8 - 5
  assert.equal(d2.inputTokens, 400); // 900 - 500
  assert.equal(d2.outputTokens, 40); // 90 - 50
  assert.equal(d2.cacheReadTokens, 4000); // 9000 - 5000
  assert.equal(d2.sessions, 1);
});

test('daily sums across multiple sessions and clamps negative deltas to 0', () => {
  const stateDir = mkTmp();
  writeDay(stateDir, '2026-02-01', [
    snap('2026-02-01', 1, { sid: 'a', costUsd: 10, input: 1000 }),
    snap('2026-02-01', 1, { sid: 'b', costUsd: 4, input: 400 }),
  ]);
  // Day 2: session a RESETS (cumulative went down -> clamp to 0); session b grows.
  writeDay(stateDir, '2026-02-02', [
    snap('2026-02-02', 1, { sid: 'a', costUsd: 3, input: 100 }), // 3 - 10 = -7 -> 0
    snap('2026-02-02', 1, { sid: 'b', costUsd: 9, input: 900 }), // 9 - 4 = 5
  ]);
  const u = readUsage(stateDir);
  const d1 = u.daily.find(d => d.date === '2026-02-01');
  assert.equal(d1.costUsd, 14);   // 10 + 4
  assert.equal(d1.inputTokens, 1400);
  assert.equal(d1.sessions, 2);

  const d2 = u.daily.find(d => d.date === '2026-02-02');
  assert.equal(d2.costUsd, 5);    // max(0,-7) + 5
  assert.equal(d2.inputTokens, 500); // max(0,-900) + 500
  assert.equal(d2.sessions, 2);
});

test('perSession is the latest snapshot per sid by capturedAt', () => {
  const stateDir = mkTmp();
  writeDay(stateDir, '2026-03-01', [
    snap('2026-03-01', 1, { sid: 'a', costUsd: 1, model: 'm-old', ctxUsedPct: 10, cwd: 'D:\\a' }),
    snap('2026-03-01', 5, { sid: 'a', costUsd: 7, model: 'm-new', ctxUsedPct: 80, cwd: 'D:\\a',
      input: 700, output: 70, cacheRead: 7000, cacheCreate: 200 }),
    snap('2026-03-01', 2, { sid: 'b', costUsd: 2, model: 'm-b' }),
  ]);
  const u = readUsage(stateDir);
  assert.equal(u.perSession.length, 2);
  // Sorted by lastTs desc -> session a (hour 5) first.
  const a = u.perSession.find(s => s.sid === 'a');
  assert.equal(a.model, 'm-new');
  assert.equal(a.costUsd, 7);
  assert.equal(a.input, 700);
  assert.equal(a.output, 70);
  assert.equal(a.cacheRead, 7000);
  assert.equal(a.cacheCreate, 200);
  assert.equal(a.ctxUsedPct, 80);
  assert.equal(a.cwd, 'D:\\a');
  assert.equal(a.lastTs, new Date(2026, 2, 1, 12, 5, 0, 0).getTime());
  assert.equal(u.perSession[0].sid, 'a'); // latest first
});

test('heatmap count = distinct sessions active per date', () => {
  const stateDir = mkTmp();
  writeDay(stateDir, '2026-04-01', [
    snap('2026-04-01', 1, { sid: 'a', costUsd: 1 }),
    snap('2026-04-01', 2, { sid: 'a', costUsd: 2 }),
    snap('2026-04-01', 3, { sid: 'b', costUsd: 1 }),
  ]);
  writeDay(stateDir, '2026-04-02', [
    snap('2026-04-02', 1, { sid: 'a', costUsd: 3 }),
  ]);
  const u = readUsage(stateDir);
  const h1 = u.heatmap.find(h => h.date === '2026-04-01');
  const h2 = u.heatmap.find(h => h.date === '2026-04-02');
  assert.equal(h1.count, 2); // a, b
  assert.equal(h2.count, 1); // a
  // heatmap aligns with daily.sessions
  assert.equal(u.daily.find(d => d.date === '2026-04-01').sessions, 2);
});

test('totals = sums of daily, distinct sessions, and day count', () => {
  const stateDir = mkTmp();
  writeDay(stateDir, '2026-05-01', [
    snap('2026-05-01', 1, { sid: 'a', costUsd: 5, input: 500, output: 50, cacheRead: 5000 }),
    snap('2026-05-01', 1, { sid: 'b', costUsd: 3, input: 300, output: 30, cacheRead: 3000 }),
  ]);
  writeDay(stateDir, '2026-05-02', [
    snap('2026-05-02', 1, { sid: 'a', costUsd: 9, input: 900, output: 90, cacheRead: 9000 }),
  ]);
  const u = readUsage(stateDir);
  // costUsd: day1 (5+3=8) + day2 (9-5=4) = 12
  assert.equal(u.totals.costUsd, 12);
  assert.equal(u.totals.inputTokens, 800 + 400); // (500+300) + (900-500)
  assert.equal(u.totals.outputTokens, 80 + 40);
  assert.equal(u.totals.cacheReadTokens, 8000 + 4000);
  assert.equal(u.totals.sessions, 2); // a, b
  assert.equal(u.totals.days, 2);
});

test('readUsage tolerates blank lines and malformed/invalid records', () => {
  const stateDir = mkTmp();
  const usageDir = path.join(stateDir, 'usage');
  fs.mkdirSync(usageDir, { recursive: true });
  const good = JSON.stringify(snap('2026-06-01', 1, { sid: 'a', costUsd: 4, input: 400 }));
  fs.writeFileSync(path.join(usageDir, '2026-06-01.ndjson'),
    '\n' + good + '\n' + 'not json\n' + JSON.stringify({ no: 'sid' }) + '\n   \n');
  const u = readUsage(stateDir);
  assert.equal(u.totals.sessions, 1);
  assert.equal(u.daily[0].costUsd, 4);
  assert.equal(u.daily[0].inputTokens, 400);
});

test('appendSnapshot is re-exported and feeds readUsage', () => {
  const stateDir = mkTmp();
  appendSnapshot(stateDir, snap('2026-07-01', 1, { sid: 'z', costUsd: 6, input: 600 }));
  const u = readUsage(stateDir);
  assert.equal(u.totals.sessions, 1);
  assert.equal(u.perSession[0].sid, 'z');
  assert.equal(u.daily[0].costUsd, 6);
});
