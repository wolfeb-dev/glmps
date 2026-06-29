import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addReplayTask, listReplayTasks, replayFile } from '../lib/replay-set.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-replay-')); }

test('add then list round-trips with baseline', () => {
  const d = tmp();
  const baseline = { id: 'session-a', unit: 'session', taskClass: 'feature', turns: 3 };
  const r = addReplayTask(d, { id: 't1', project: 'mc', promptFile: '/p/t1.txt', baseline });
  assert.equal(r.isNew, true);
  const list = listReplayTasks(d);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 't1');
  assert.equal(list[0].baseline.turns, 3);
});

test('dedup by id', () => {
  const d = tmp();
  addReplayTask(d, { id: 't1' });
  const again = addReplayTask(d, { id: 't1' });
  assert.equal(again.isNew, false);
  assert.equal(listReplayTasks(d).length, 1);
});

test('missing dir lists empty', () => {
  assert.deepEqual(listReplayTasks(tmp()), []);
});

test('replayFile path shape', () => {
  const d = tmp();
  assert.ok(replayFile(d).endsWith(path.join('replay', 'tasks.json')));
});
