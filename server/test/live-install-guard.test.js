import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardLiveWrite, parseLivePaths } from '../lib/live-install-guard.js';

const LIVE = parseLivePaths('D:\\LiveTrading\\Install');

test('parseLivePaths splits, normalizes slashes/case, trims trailing slash', () => {
  const p = parseLivePaths('D:\\A\\B\\ ; C:/x/y/ \n');
  assert.deepEqual(p, ['d:/a/b', 'c:/x/y']);
  assert.deepEqual(parseLivePaths(''), []);
});

test('blocks an Edit/Write into a live-install path', () => {
  const r = guardLiveWrite({
    tool_name: 'Write',
    tool_input: { file_path: 'D:\\LiveTrading\\Install\\bin\\Custom\\Strategies\\Evil.cs' },
    livePaths: LIVE,
  });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /live-install/i);
});

test('allows a write outside live-install paths', () => {
  const r = guardLiveWrite({
    tool_name: 'Edit',
    tool_input: { file_path: 'D:\\DevProject\\Strategies\\Thing.cs' },
    livePaths: LIVE,
  });
  assert.equal(r.blocked, false);
});

test('blocks a Bash copy INTO a live-install path', () => {
  const r = guardLiveWrite({
    tool_name: 'Bash',
    tool_input: { command: 'cp ./Evil.cs "D:/LiveTrading/Install/bin/Custom/Strategies/"' },
    livePaths: LIVE,
  });
  assert.equal(r.blocked, true);
});

test('allows a read-only Bash reference to a live-install path', () => {
  const r = guardLiveWrite({
    tool_name: 'Bash',
    tool_input: { command: 'cat "D:/LiveTrading/Install/log.txt"' },
    livePaths: LIVE,
  });
  assert.equal(r.blocked, false);
});

test('no live paths configured => never blocks (guard disabled)', () => {
  const r = guardLiveWrite({
    tool_name: 'Write',
    tool_input: { file_path: 'D:\\LiveTrading\\Install\\x.cs' },
    livePaths: [],
  });
  assert.equal(r.blocked, false);
});

test('non-write tools are ignored', () => {
  assert.equal(guardLiveWrite({ tool_name: 'Read', tool_input: { file_path: 'D:/LiveTrading/Install/x.cs' }, livePaths: LIVE }).blocked, false);
});
