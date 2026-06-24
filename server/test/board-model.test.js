import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as bm from '../../web/board-model.js';

test('groupByColumn buckets and sorts by order', () => {
  const items = [
    { id: 'a', state: 'queued', order: 2 },
    { id: 'b', state: 'queued', order: 1 },
    { id: 'c', state: 'done', order: 5 },
    { id: 'd', state: 'held', order: 1 },
  ];
  const g = bm.groupByColumn(items);
  assert.deepEqual(g.queued.map(i => i.id), ['b', 'a']);
  assert.deepEqual(g.done.map(i => i.id), ['c']);
  assert.deepEqual(g.held.map(i => i.id), ['d']);
});

test('nextOrder returns max+1', () => {
  assert.equal(bm.nextOrder([{ order: 3 }, { order: 7 }]), 8);
  assert.equal(bm.nextOrder([]), 1);
});

test('orderedColumns puts held first and gates cancelled on showArchived', () => {
  assert.deepEqual(bm.orderedColumns(false), ['held','queued','in_progress','in_review','done']);
  assert.deepEqual(bm.orderedColumns(true), ['held','queued','in_progress','in_review','done','cancelled']);
});

test('filterItems by project, query, minPriority, showCancelled', () => {
  const items = [
    { id:'1', project:'a', title:'fix bug', prompt:'', state:'queued', priority:2 },
    { id:'2', project:'b', title:'new feature', prompt:'add thing', state:'queued', priority:null },
    { id:'3', project:'a', title:'old', prompt:'', state:'cancelled', priority:0 },
  ];
  assert.deepEqual(bm.filterItems(items, { project:'a' }).map(i=>i.id), ['1']); // cancelled hidden by default
  assert.deepEqual(bm.filterItems(items, { query:'thing' }).map(i=>i.id), ['2']);
  assert.deepEqual(bm.filterItems(items, { minPriority:1 }).map(i=>i.id), ['1']);
  assert.deepEqual(bm.filterItems(items, { project:'a', showCancelled:true }).map(i=>i.id), ['1','3']);
});

test('joinRunner marks ledger-tracked cards live and surfaces target as agent', () => {
  const items = [
    { id: 'glmps-1', state: 'in_progress', project: 'mc' },
    { id: 'glmps-2', state: 'queued', project: 'mc' },
  ];
  const runner = { ledger: { 'glmps-1': { pid: 4242, startedAt: 1, target: 'antigravity', retries: 0 } } };
  const out = bm.joinRunner(items, runner);
  assert.equal(out[0].live, true);
  assert.equal(out[0].agent, 'antigravity');
  assert.equal(out[1].live, undefined); // no ledger entry -> untouched
  assert.equal(out[1].agent, undefined);
});

test('joinRunner is pure and fail-soft on missing/empty runner', () => {
  const items = [{ id: 'a', state: 'queued' }];
  // No runner / no ledger -> items pass through unchanged
  assert.deepEqual(bm.joinRunner(items, null), items);
  assert.deepEqual(bm.joinRunner(items, {}), items);
  assert.deepEqual(bm.joinRunner(items, { ledger: {} }), items);
  assert.deepEqual(bm.joinRunner(undefined, { ledger: {} }), []);
  // Does not mutate the input array or its items
  const original = JSON.parse(JSON.stringify(items));
  bm.joinRunner(items, { ledger: { a: { target: 'vscode' } } });
  assert.deepEqual(items, original);
});

test('groupByLane none/project/priority', () => {
  const items = [
    { id:'1', project:'a', priority:2, state:'queued' },
    { id:'2', project:'b', priority:null, state:'queued' },
  ];
  assert.equal(bm.groupByLane(items, null).length, 1);
  assert.deepEqual(bm.groupByLane(items, 'project').map(l=>l.lane), ['a','b']);
  const byPri = bm.groupByLane(items, 'priority');
  assert.ok(byPri.find(l => l.lane === '2'));
});
