// server/test/ag-labels.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAgSummaries, loadAgLabels } from '../lib/ag-labels.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agl-')); tmpDirs.push(d); return d; }

// Build a synthetic protobuf-like buffer: printable runs separated by 0x00 bytes.
function makeBuf(...runs) {
  const parts = runs.map(r => (typeof r === 'string' ? Buffer.from(r, 'ascii') : r));
  const sep = Buffer.from([0x00]);
  const pieces = [];
  for (let i = 0; i < parts.length; i++) {
    pieces.push(parts[i]);
    if (i < parts.length - 1) pieces.push(sep);
  }
  return Buffer.concat(pieces);
}

const UUID1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UUID2 = 'ffffffff-1111-2222-3333-444444444444';

test('parseAgSummaries extracts title for uuid1', () => {
  // '$<uuid1>' prefix junk, then title, then uuid2 with its workspace + title
  const buf = makeBuf(
    `$${UUID1}`,            // junk-prefixed uuid1
    'My Conversation Title', // title for uuid1
    `$${UUID2}(`,            // junk-prefixed uuid2
    'file:///d:/my-project',  // workspace for uuid2
    'second title',          // title for uuid2
  );
  const labels = parseAgSummaries(buf);
  assert.ok(labels.has(UUID1), 'uuid1 found');
  assert.equal(labels.get(UUID1).title, 'My Conversation Title');
});

test('parseAgSummaries extracts workspace and title for uuid2', () => {
  const buf = makeBuf(
    `$${UUID1}`,
    'My Conversation Title',
    `$${UUID2}(`,
    'file:///d:/my-project',
    'second title',
  );
  const labels = parseAgSummaries(buf);
  assert.ok(labels.has(UUID2), 'uuid2 found');
  const rec2 = labels.get(UUID2);
  // workspace: file:///d:/my-project → d:\my-project (Windows) or d:/my-project (POSIX)
  assert.ok(rec2.workspace != null, 'workspace set');
  assert.match(rec2.workspace, /my-project/);
  // On Windows this should be d:\my-project
  if (process.platform === 'win32') {
    assert.equal(rec2.workspace, 'd:\\my-project');
  }
  assert.equal(rec2.title, 'second title');
});

test('parseAgSummaries never throws on garbage input', () => {
  const garbage = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x00]);
  assert.doesNotThrow(() => parseAgSummaries(garbage));
  const result = parseAgSummaries(garbage);
  assert.ok(result instanceof Map);
});

test('parseAgSummaries returns empty map for empty buffer', () => {
  const result = parseAgSummaries(Buffer.alloc(0));
  assert.equal(result.size, 0);
});

test('loadAgLabels reads from file and returns merged map', () => {
  const tmp = mkTmp();
  const buf = makeBuf(
    `$${UUID1}`,
    'Label From File',
    'file:///d:/some/workspace',
  );
  fs.writeFileSync(path.join(tmp, 'agyhub_summaries_proto.pb'), buf);
  const labels = loadAgLabels([tmp]);
  assert.ok(labels.has(UUID1));
  assert.equal(labels.get(UUID1).title, 'Label From File');
});

test('loadAgLabels skips missing files silently', () => {
  const tmp = mkTmp(); // no pb file written
  assert.doesNotThrow(() => loadAgLabels([tmp]));
  const labels = loadAgLabels([tmp]);
  assert.equal(labels.size, 0);
});

test('loadAgLabels merges across two roots, first non-null wins', () => {
  const tmp1 = mkTmp();
  const tmp2 = mkTmp();
  // root1 has title only for UUID1
  fs.writeFileSync(path.join(tmp1, 'agyhub_summaries_proto.pb'),
    makeBuf(`$${UUID1}`, 'Title From Root1'));
  // root2 has title for UUID2 and also UUID1 (should not override root1)
  fs.writeFileSync(path.join(tmp2, 'agyhub_summaries_proto.pb'),
    makeBuf(`$${UUID1}`, 'Title From Root2', `$${UUID2}`, 'Title Two'));
  const labels = loadAgLabels([tmp1, tmp2]);
  assert.equal(labels.get(UUID1).title, 'Title From Root1', 'root1 wins');
  assert.equal(labels.get(UUID2).title, 'Title Two');
});
