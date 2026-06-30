// server/test/file-api.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FileApi } from '../lib/file-api.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

function setup() {
  const root = mkTmp();
  const undoDir = mkTmp();
  const f = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(f, 'original');
  return { root, undoDir, f, api: new FileApi([root], undoDir) };
}

test('read returns content + hash; paths outside roots rejected', () => {
  const { api, f } = setup();
  const r = api.read(f);
  assert.equal(r.content, 'original');
  assert.equal(r.hash, crypto.createHash('sha256').update('original').digest('hex'));
  assert.throws(() => api.read('C:\\Windows\\system.ini'), /not allowed/i);
  assert.throws(() => api.read(path.join(f, '..', '..', 'escape.txt')), /not allowed/i);
});

test('case-insensitive root match on Windows-style paths', () => {
  const { api, f } = setup();
  const upper = f.toUpperCase();
  // resolves inside root despite case difference; read should not throw allowlist error
  let threw = false;
  try { api.read(upper); } catch (e) { threw = /not allowed/i.test(e.message); }
  assert.equal(threw, false);
});

test('save with matching hash writes and stores undo; mismatch throws conflict', () => {
  const { api, f } = setup();
  const { hash } = api.read(f);
  api.save(f, 'updated', hash);
  assert.equal(fs.readFileSync(f, 'utf-8'), 'updated');
  assert.throws(() => api.save(f, 'clobber', hash), /conflict/i); // stale hash now
  api.undo(f);
  assert.equal(fs.readFileSync(f, 'utf-8'), 'original');
});

test('save with force=true skips conflict check; new file saves without hash', () => {
  const { api, f, root } = setup();
  api.save(f, 'forced', 'wrong-hash', { force: true });
  assert.equal(fs.readFileSync(f, 'utf-8'), 'forced');
  const fresh = path.join(root, 'new.md');
  api.save(fresh, 'hello', null);
  assert.equal(fs.readFileSync(fresh, 'utf-8'), 'hello');
});

test('alternate data stream paths are rejected', () => {
  const { api, f } = setup();
  assert.throws(() => api.read(f + ':hidden'), /not allowed/i);
  assert.throws(() => api.save(f + ':hidden', 'x', null), /not allowed/i);
});

test('credential/secret files are denied for read and write even inside a root', () => {
  const root = mkTmp();
  const undoDir = mkTmp();
  const api = new FileApi([root], undoDir);
  for (const name of ['.credentials.json', 'id_rsa', 'server.pem', 'private.key', '.env']) {
    const f = path.join(root, name);
    fs.writeFileSync(f, 'secret');
    assert.throws(() => api.read(f), /not allowed/i, `${name} read should be denied`);
    assert.throws(() => api.save(f, 'x', null, { force: true }), /not allowed/i, `${name} write should be denied`);
  }
});

test('files under a sensitive directory segment (.ssh/.aws) are denied', () => {
  const root = mkTmp();
  const undoDir = mkTmp();
  fs.mkdirSync(path.join(root, '.ssh'), { recursive: true });
  const f = path.join(root, '.ssh', 'config');
  fs.writeFileSync(f, 'Host *');
  const api = new FileApi([root], undoDir);
  assert.throws(() => api.read(f), /not allowed/i);
});

test('ordinary editable files (CLAUDE.md) remain allowed', () => {
  const { api, f } = setup();
  assert.doesNotThrow(() => api.read(f));
});

test('undo is one-level: second consecutive undo throws', () => {
  const { api, f } = setup();
  const { hash } = api.read(f);
  api.save(f, 'v2', hash);
  api.undo(f);
  assert.throws(() => api.undo(f));
});
