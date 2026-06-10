// server/test/sessions.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverClaudeSessions, discoverAgSessions, livenessOf } from '../lib/sessions.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

test('discoverClaudeSessions merges registry (live) with transcript scan (history)', () => {
  const tmp = mkTmp();
  const projDir = path.join(tmp, 'projects', 'D--');
  fs.mkdirSync(projDir, { recursive: true });
  const liveT = path.join(projDir, 'aaaa.jsonl');
  const oldT = path.join(projDir, 'bbbb.jsonl');
  fs.writeFileSync(liveT, '{}\n'); fs.writeFileSync(oldT, '{}\n');
  const reg = [{ sessionId: 'aaaa', ppid: process.pid, cwd: 'D:\\', transcriptPath: liveT, ts: Date.now() }];
  const regFile = path.join(tmp, 'active-sessions.json');
  fs.writeFileSync(regFile, JSON.stringify(reg));
  const sessions = discoverClaudeSessions({
    activeSessionsFile: regFile, projectsDir: path.join(tmp, 'projects') });
  const byId = Object.fromEntries(sessions.map(s => [s.id, s]));
  assert.equal(byId['aaaa'].live, true);       // pid exists (our own)
  assert.equal(byId['bbbb'].live, false);      // not in registry
  assert.equal(byId['aaaa'].tool, 'claude-code');
  assert.equal(byId['aaaa'].cwd, 'D:\\');
});

test('dead ppid in registry is not live', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const regFile = path.join(tmp, 'active-sessions.json');
  fs.writeFileSync(regFile, JSON.stringify([
    { sessionId: 'cccc', ppid: 999999999, cwd: 'D:\\', transcriptPath: path.join(tmp, 'c.jsonl'), ts: Date.now() }]));
  const sessions = discoverClaudeSessions({
    activeSessionsFile: regFile, projectsDir: path.join(tmp, 'projects') });
  assert.equal(sessions.find(s => s.id === 'cccc').live, false);
});

test('discoverAgSessions finds brain conversations with overview logs', () => {
  const tmp = mkTmp();
  const conv = path.join(tmp, 'brain', 'dddd', '.system_generated', 'logs');
  fs.mkdirSync(conv, { recursive: true });
  fs.writeFileSync(path.join(conv, 'overview.txt'), '{}\n');
  // legacy call via brainDir
  const sessions = discoverAgSessions({ brainDir: path.join(tmp, 'brain') });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'dddd');
  assert.equal(sessions[0].tool, 'antigravity');
  assert.ok(sessions[0].logPath.endsWith('overview.txt'));
  assert.equal(sessions[0].format, 'log');
});

test('discoverAgSessions discovers pb-only conversations', () => {
  const tmp = mkTmp();
  const convsDir = path.join(tmp, 'conversations');
  fs.mkdirSync(convsDir, { recursive: true });
  const pbId = 'eeee1111-0000-0000-0000-000000000001';
  fs.writeFileSync(path.join(convsDir, `${pbId}.pb`), Buffer.from([0x0a, 0x01]));
  const sessions = discoverAgSessions({ antigravityDirs: [tmp] });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, pbId);
  assert.equal(sessions[0].tool, 'antigravity');
  assert.equal(sessions[0].format, 'pb');
  assert.equal(sessions[0].logPath, null);
  assert.ok(sessions[0].pbPath.endsWith(`${pbId}.pb`));
});

test('discoverAgSessions deduplicates same id across two roots, keeps most recent mtime', () => {
  const tmp1 = mkTmp();
  const tmp2 = mkTmp();
  const id = 'ffffffff-0000-0000-0000-000000000001';
  // root1: pb with older mtime
  const convsDir1 = path.join(tmp1, 'conversations');
  fs.mkdirSync(convsDir1, { recursive: true });
  const pb1 = path.join(convsDir1, `${id}.pb`);
  fs.writeFileSync(pb1, Buffer.from([0x01]));
  fs.utimesSync(pb1, new Date(1000000), new Date(1000000)); // old
  // root2: pb with newer mtime
  const convsDir2 = path.join(tmp2, 'conversations');
  fs.mkdirSync(convsDir2, { recursive: true });
  const pb2 = path.join(convsDir2, `${id}.pb`);
  fs.writeFileSync(pb2, Buffer.from([0x02]));
  // pb2 mtime = now (default)
  const sessions = discoverAgSessions({ antigravityDirs: [tmp1, tmp2] });
  assert.equal(sessions.filter(s => s.id === id).length, 1, 'deduped to one entry');
  const s = sessions.find(s => s.id === id);
  const pb2Mtime = fs.statSync(pb2).mtimeMs;
  assert.equal(s.mtimeMs, pb2Mtime, 'keeps newer mtime');
});

test('discoverAgSessions same id as log+pb keeps log format with max mtime', () => {
  const tmp = mkTmp();
  const id = 'logpb111-0000-0000-0000-000000000001';
  // log entry (old)
  const logDir = path.join(tmp, 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'overview.txt');
  fs.writeFileSync(logFile, '{}\n');
  fs.utimesSync(logFile, new Date(1000000), new Date(1000000));
  // pb entry (newer)
  const convsDir = path.join(tmp, 'conversations');
  fs.mkdirSync(convsDir, { recursive: true });
  const pbFile = path.join(convsDir, `${id}.pb`);
  fs.writeFileSync(pbFile, Buffer.from([0x01]));
  // pbFile mtime = now (default)
  const sessions = discoverAgSessions({ antigravityDirs: [tmp] });
  const s = sessions.find(s => s.id === id);
  assert.ok(s, 'session found');
  assert.equal(s.format, 'log', 'log format wins over pb');
  assert.ok(s.mtimeMs >= fs.statSync(pbFile).mtimeMs - 1000, 'mtime updated to max');
});

test('livenessOf maps recency to state', () => {
  const cfg = { workingThresholdMs: 10000, idleThresholdMs: 60000 };
  const now = Date.now();
  assert.equal(livenessOf(true, now - 1000, now, cfg), 'working');
  assert.equal(livenessOf(true, now - 120000, now, cfg), 'idle');
  assert.equal(livenessOf(false, now - 1000, now, cfg), 'ended');
});
