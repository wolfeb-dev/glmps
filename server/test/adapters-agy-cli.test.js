// server/test/adapters-agy-cli.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Try to load DatabaseSync — skip the DB-creation tests if unavailable
let DatabaseSync = null;
try {
  const mod = await import('node:sqlite');
  DatabaseSync = mod.DatabaseSync;
} catch {}

import * as adapter from '../lib/adapters/agy-cli.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agy-'));
  tmpDirs.push(d);
  return d;
}

// Helper: build a synthetic binary payload containing printable ASCII runs
// separated by null bytes, mimicking the protobuf structure.
function makePayload(...runs) {
  const sep = Buffer.from([0x00, 0x01, 0x02]); // non-printable separators
  const parts = runs.map(r => Buffer.from(r, 'ascii'));
  const pieces = [];
  for (let i = 0; i < parts.length; i++) {
    pieces.push(parts[i]);
    if (i < parts.length - 1) pieces.push(sep);
  }
  return Buffer.concat(pieces);
}

// Encode an unsigned int as a protobuf varint.
function varint(n) {
  const bytes = [];
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) bytes.push(b | 0x80);
    else { bytes.push(b); break; }
  }
  return Buffer.from(bytes);
}

// Build a steps.metadata protobuf blob whose top-level field 1 is a
// google.protobuf.Timestamp (inner field 1 = seconds). Mirrors the real
// Antigravity CLI schema where field 1 is the step's creation time.
function makeTimestampMetadata(seconds) {
  const inner = Buffer.concat([Buffer.from([0x08]), varint(seconds)]); // Timestamp field 1 (varint)
  return Buffer.concat([Buffer.from([0x0a]), varint(inner.length), inner]); // metadata field 1 (len-delimited msg)
}

// ── detect ────────────────────────────────────────────────────────────────────

test('agy-cli detect: installed=false when agyCliDir missing', () => {
  const P = { agyCliDir: path.join(os.tmpdir(), 'nonexistent-agy-xyz-999') };
  const { installed } = adapter.detect(P);
  assert.equal(installed, false);
});

test('agy-cli detect: installed=true when agyCliDir exists', () => {
  const tmp = mkTmp();
  const P = { agyCliDir: tmp };
  const { installed, dataDirs } = adapter.detect(P);
  assert.equal(installed, true);
  assert.deepEqual(dataDirs, [tmp]);
});

// ── discover ──────────────────────────────────────────────────────────────────

test('agy-cli discover: returns empty when conversations dir missing', () => {
  const tmp = mkTmp();
  const P = { agyCliDir: tmp }; // no conversations/ subdir
  const descs = adapter.discover(P);
  assert.deepEqual(descs, []);
});

test('agy-cli discover: returns empty when no .db files', () => {
  const tmp = mkTmp();
  const convDir = path.join(tmp, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  fs.writeFileSync(path.join(convDir, 'readme.txt'), 'hi');
  const P = { agyCliDir: tmp };
  const descs = adapter.discover(P);
  assert.deepEqual(descs, []);
});

test('agy-cli discover: finds .db files and returns sqlite-steps descriptors', () => {
  const tmp = mkTmp();
  const convDir = path.join(tmp, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const dbPath = path.join(convDir, 'fd57afa2-d639-4bac-be9b-4a754555db54.db');
  fs.writeFileSync(dbPath, ''); // empty placeholder
  const P = { agyCliDir: tmp };
  const descs = adapter.discover(P);
  assert.equal(descs.length, 1);
  assert.equal(descs[0].id, 'agy:fd57afa2-d639-4bac-be9b-4a754555db54');
  assert.equal(descs[0].tool, 'agy-cli');
  assert.equal(descs[0].kind, 'sqlite-steps');
  assert.equal(descs[0].file, dbPath);
  assert.equal(descs[0].cwd, null);
  assert.equal(descs[0].label, null);
  assert.equal(typeof descs[0].mtimeMs, 'number');
});

// ── extractSteps (requires DatabaseSync) ──────────────────────────────────────

function skipIfNoSqlite(t) {
  if (!DatabaseSync) t.skip('node:sqlite not available');
}

test('agy-cli extractSteps: tool event from synthetic payload', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  // Build payload: junk8 + tool_name + JSON-with-toolSummary, separated by non-printable bytes
  const payload = makePayload(
    'abc12345',           // junk identifier (8 chars)
    'search_web',         // tool name
    '{"query":"x","toolAction":"Searching for y","toolSummary":"Web search"}', // json
  );

  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 21, payload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.ok(Array.isArray(result.events), 'events is array');
  assert.equal(result.events.length, 1);
  const ev = result.events[0];
  assert.equal(ev.kind, 'tool');
  assert.equal(ev.lane, 'feed');
  assert.equal(ev.label, 'Web search');
});

test('agy-cli extractSteps: run_command tool gets kind=command', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'test2.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  const payload = makePayload(
    'zz112233',
    'run_command',
    '{"CommandLine":"dir","toolAction":"List files","toolSummary":"Directory listing"}',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 21, payload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].kind, 'command');
});

test('agy-cli extractSteps: run_command git commit → git/context (from CommandLine, not toolAction)', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'test-git.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  // toolAction is a human phrase ("Committing work"); the real command lives in CommandLine.
  const payload = makePayload(
    'yy998877',
    'run_command',
    '{"CommandLine":"git add . && git commit -m \\"feat: ship it\\"","Cwd":"D:/x","toolAction":"Committing work","toolSummary":"Run command"}',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 21, payload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  const git = result.events.filter(e => e.kind === 'git');
  assert.equal(git.length, 1);
  assert.equal(git[0].lane, 'context');
  assert.equal(git[0].gitOp, 'commit');
  assert.match(git[0].label, /feat: ship it/);
});

test('agy-cli extractSteps: incremental — only returns rows with idx > sinceIdx', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'incr.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  const makeRow = (toolName, summary) => makePayload(
    'xx112233', toolName,
    `{"toolAction":"act","toolSummary":"${summary}"}`,
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 21, makeRow('search_web', 'First'));
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(1, 21, makeRow('read_file', 'Second'));
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(2, 21, makeRow('write_file', 'Third'));
  db.close();

  // First call: get rows after idx -1 = all 3
  const r1 = adapter.extractSteps(dbPath, -1);
  assert.equal(r1.events.length, 3);
  assert.equal(r1.lastIdx, 2);

  // Second call: only rows after idx 0 = 2 rows
  const r2 = adapter.extractSteps(dbPath, 0);
  assert.equal(r2.events.length, 2);
  assert.equal(r2.events[0].label, 'Second');
  assert.equal(r2.lastIdx, 2);

  // Third call: only after idx 2 = 0 rows
  const r3 = adapter.extractSteps(dbPath, 2);
  assert.equal(r3.events.length, 0);
  assert.equal(r3.lastIdx, 2);
});

test('agy-cli extractSteps: title extracted from early user-text run', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'title.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  // User message row: payload contains a long readable text run (no '{')
  const userPayload = makePayload(
    'uuid-junk-stuff',
    'what gemini models are available here today',  // >= 20 chars, not {, not uuid/url
    'other-junk',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 14, userPayload);

  const toolPayload = makePayload(
    'xy223344', 'search_web',
    '{"toolAction":"Searching","toolSummary":"Web search"}',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(1, 21, toolPayload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.ok(result.title, 'title should be extracted');
  assert.ok(result.title.includes('gemini'), 'title should contain user text');
  assert.ok(result.title.length <= 80, 'title capped at 80');
});

test('agy-cli extractSteps: locked/missing file returns empty, no throw', (t) => {
  const result = adapter.extractSteps('/nonexistent/path/fake.db', -1);
  assert.deepEqual(result.events, []);
  assert.equal(result.lastIdx, -1);
});

test('agy-cli extractSteps: rejects junk-prefixed UUID like b$7a374dfe-2aa8-4959-b188-92bccbe087e0', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'uuid-junk.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  // Row with junk-prefixed UUID that should be rejected
  const junkUuidPayload = makePayload(
    'b$7a374dfe-2aa8-4959-b188-92bccbe087e0',  // junk prefix 'b$' + UUID
    'research the grill-me skill and summarize it', // real title (>= 20 chars)
    'other-junk',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 14, junkUuidPayload);

  const toolPayload = makePayload(
    'xy223344', 'search_web',
    '{"toolAction":"Searching","toolSummary":"Web search"}',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(1, 21, toolPayload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.ok(result.title, 'title should be extracted');
  assert.ok(result.title.includes('research'), 'title should contain the real user text, not the UUID');
  assert.ok(!result.title.includes('7a374dfe'), 'title should not contain UUID');
});

test('agy-cli extractSteps: rejects runs with sessionID in them', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'sessionid.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  // Row with sessionID should be rejected
  const sessionIdPayload = makePayload(
    'sessionID=abc1234567890123456789012345678901234567', // long but contains sessionID
    'real user question about what is the grill skill here today',  // real title
    'other-junk',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 14, sessionIdPayload);

  const toolPayload = makePayload(
    'xy223344', 'search_web',
    '{"toolAction":"Searching","toolSummary":"Web search"}',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(1, 21, toolPayload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.ok(result.title, 'title should be extracted');
  assert.ok(result.title.includes('real user'), 'title should contain the real user text');
  assert.ok(!result.title.includes('sessionID'), 'title should not contain sessionID');
});

test('agy-cli extractSteps: rejects runs with mostly non-letter characters', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'nonletter.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  // Row with run that is mostly non-letters (< 50% letters)
  const nonLetterPayload = makePayload(
    '1234567890---___$$$%%%&&&***((())))))))))))', // >= 20 chars but mostly non-letter
    'what is the best grill technique for summer cooking',  // real title
    'other-junk',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 14, nonLetterPayload);

  const toolPayload = makePayload(
    'xy223344', 'search_web',
    '{"toolAction":"Searching","toolSummary":"Web search"}',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(1, 21, toolPayload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.ok(result.title, 'title should be extracted');
  assert.ok(result.title.includes('grill'), 'title should contain the real user text');
  assert.ok(!result.title.match(/[\d\-_$%&*()]/), 'title should not be mostly junk characters');
});

test('agy-cli extractSteps: run_command with git commit payload -> git event', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'git-test.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  // toolAction contains the git command
  const payload = makePayload(
    'ab123456',
    'run_command',
    '{"CommandLine":"git commit -m \\"feat: add cache\\"","toolAction":"git commit -m \\"feat: add cache\\"","toolSummary":"Git commit"}',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 21, payload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.equal(result.events.length, 1);
  const ev = result.events[0];
  assert.equal(ev.kind, 'git');
  assert.equal(ev.lane, 'context');
  assert.equal(ev.gitOp, 'commit');
  assert.ok(ev.label.includes('feat: add cache'));
});

// ── parsePayload pathArg extraction (via extractSteps classify) ────────────────

test('agy-cli extractSteps: view_file of SKILL.md -> skill/context/read', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'skill-test.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  const payload = makePayload(
    'ab123456',
    'view_file',
    '{"AbsolutePath":"C:\\\\Users\\\\dev\\\\.agents\\\\skills\\\\SKILL.md","toolAction":"view","toolSummary":"Reading skill"}',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 21, payload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.equal(result.events.length, 1);
  const ev = result.events[0];
  assert.equal(ev.kind, 'skill');
  assert.equal(ev.lane, 'context');
  assert.equal(ev.op, 'read');
});

test('agy-cli extractSteps: view_file of ordinary .py -> tool/feed', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'ordinary-test.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  const payload = makePayload(
    'ab123456',
    'view_file',
    '{"AbsolutePath":"D:\\\\project\\\\main.py","toolAction":"view","toolSummary":"Reading python file"}',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 21, payload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.equal(result.events.length, 1);
  const ev = result.events[0];
  assert.equal(ev.kind, 'tool');
  assert.equal(ev.lane, 'feed');
  assert.equal(ev.op, undefined);
});

test('agy-cli extractSteps: write_to_file of memory/*.md -> memory/context/write', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'memory-write-test.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  const payload = makePayload(
    'ab123456',
    'write_to_file',
    '{"TargetFile":"C:\\\\Users\\\\dev\\\\.claude\\\\projects\\\\D--\\\\memory\\\\MEMORY.md","toolAction":"write","toolSummary":"Writing memory"}',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 21, payload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.equal(result.events.length, 1);
  const ev = result.events[0];
  assert.equal(ev.kind, 'memory');
  assert.equal(ev.lane, 'context');
  assert.equal(ev.op, 'write');
});

test('agy-cli extractSteps: run_command git commit -> git/context', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'git-commit-patharg.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');

  const payload = makePayload(
    'ab123456',
    'run_command',
    '{"toolAction":"git commit -m \\"feat: patharg test\\"","toolSummary":"Git commit"}',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 21, payload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.equal(result.events.length, 1);
  const ev = result.events[0];
  assert.equal(ev.kind, 'git');
  assert.equal(ev.lane, 'context');
});

// ── timestamps from steps.metadata ────────────────────────────────────────────

test('agy-cli extractSteps: populates ts (ms) from steps.metadata protobuf timestamp', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'ts.db');
  const db = new DatabaseSync(dbPath);
  // Real DBs carry a metadata BLOB column alongside step_payload.
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, step_payload BLOB)');

  const seconds = 1780630311; // 2026-06-05T...Z
  const metadata = makeTimestampMetadata(seconds);
  const payload = makePayload(
    'abc12345', 'search_web',
    '{"toolAction":"Searching","toolSummary":"Web search"}',
  );
  db.prepare('INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)')
    .run(0, 21, metadata, payload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].ts, seconds * 1000, 'ts is epoch milliseconds');
});

test('agy-cli extractSteps: ts present on git events from metadata too', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'ts-git.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, step_payload BLOB)');

  const seconds = 1780630999;
  const metadata = makeTimestampMetadata(seconds);
  const payload = makePayload(
    'yy998877', 'run_command',
    '{"CommandLine":"git commit -m \\"feat: ship it\\"","toolAction":"Committing","toolSummary":"Run command"}',
  );
  db.prepare('INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)')
    .run(0, 21, metadata, payload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  const git = result.events.filter(e => e.kind === 'git');
  assert.equal(git.length, 1);
  assert.equal(git[0].ts, seconds * 1000);
});

test('agy-cli extractSteps: no metadata column -> events still produced, ts null (back-compat)', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'no-metadata.db');
  const db = new DatabaseSync(dbPath);
  // Legacy / test schema with no metadata column must keep working.
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
  const payload = makePayload(
    'abc12345', 'search_web',
    '{"toolAction":"Searching","toolSummary":"Web search"}',
  );
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 21, payload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].ts, null);
});

test('agy-cli extractSteps: malformed metadata -> ts null, no throw', async (t) => {
  skipIfNoSqlite(t);
  if (!DatabaseSync) return;

  const tmp = mkTmp();
  const dbPath = path.join(tmp, 'bad-metadata.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, step_payload BLOB)');
  const payload = makePayload(
    'abc12345', 'search_web',
    '{"toolAction":"Searching","toolSummary":"Web search"}',
  );
  // Garbage that is not a field-1 length-delimited Timestamp.
  db.prepare('INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)')
    .run(0, 21, Buffer.from([0xff, 0x01, 0x02]), payload);
  db.close();

  const result = adapter.extractSteps(dbPath, -1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].ts, null);
});

// ── processAliveMs ────────────────────────────────────────────────────────────

test('agy-cli processAliveMs: returns 0 when agyCliDir missing', () => {
  const P = { agyCliDir: path.join(os.tmpdir(), 'nonexistent-agy-heartbeat-xyz') };
  const result = adapter.processAliveMs(P);
  assert.equal(result, 0);
});

test('agy-cli processAliveMs: returns cli.log mtime when present', () => {
  const tmp = mkTmp();
  const logPath = path.join(tmp, 'cli.log');
  fs.writeFileSync(logPath, 'heartbeat\n');
  const stat = fs.statSync(logPath);
  const P = { agyCliDir: tmp };
  const result = adapter.processAliveMs(P);
  assert.ok(result > 0, 'should return a positive mtime');
  assert.equal(result, stat.mtimeMs);
});

test('agy-cli processAliveMs: returns 0 when cli.log absent and log/ missing', () => {
  const tmp = mkTmp();
  // no cli.log, no log/ dir
  const P = { agyCliDir: tmp };
  const result = adapter.processAliveMs(P);
  assert.equal(result, 0);
});

test('agy-cli processAliveMs: uses newest log/ file when newer than cli.log', async () => {
  const tmp = mkTmp();
  const logDir = path.join(tmp, 'log');
  fs.mkdirSync(logDir);

  // Write cli.log first (older)
  const cliLogPath = path.join(tmp, 'cli.log');
  fs.writeFileSync(cliLogPath, 'old\n');

  // Small delay then write a log/ file so it's clearly newer
  // We fake it by manually setting the mtime using utimes-like approach —
  // just write cli.log, then write log file and check max is log file
  const newerLogPath = path.join(logDir, 'cli-20260605_120000.log');
  fs.writeFileSync(newerLogPath, 'newer session log\n');

  const cliStat = fs.statSync(cliLogPath);
  const logStat = fs.statSync(newerLogPath);

  const P = { agyCliDir: tmp };
  const result = adapter.processAliveMs(P);
  assert.equal(result, Math.max(cliStat.mtimeMs, logStat.mtimeMs));
  assert.ok(result >= cliStat.mtimeMs, 'result should be at least cli.log mtime');
});
