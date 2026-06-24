import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../lib/backlog-store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-backlog-')); }

test('addItem defaults to queued with an id, order, timestamps', () => {
  const r = store.addItem(store.emptyState(), { project: 'nq', title: 'do x' });
  assert.equal(r.item.state, 'queued');
  assert.equal(r.item.project, 'nq');
  assert.equal(r.item.title, 'do x');
  assert.equal(r.item.prompt, 'do x');        // prompt defaults to title
  assert.match(r.item.id, /^glmps-\d+$/);
  assert.equal(typeof r.item.order, 'number');
  assert.ok(r.item.createdAt && r.item.updatedAt);
});

test('listItems filters by project + status, and hides queued when paused', () => {
  let s = store.emptyState();
  s = store.addItem(s, { project: 'nq', title: 'a' }).state;
  s = store.addItem(s, { project: 'other', title: 'b' }).state;
  assert.equal(store.listItems(s, { project: 'nq' }).length, 1);
  assert.equal(store.listItems(s, { status: 'queued' }).length, 2);
  s = store.setPaused(s, true);
  assert.equal(store.listItems(s, { status: 'queued' }).length, 0);
});

test('applyLabelDelta maps AO labels to state and appends comments', () => {
  let s = store.emptyState();
  const id = store.addItem(s, { project: 'nq', title: 'a' }).state.items[0].id;
  s = store.addItem(store.emptyState(), { project: 'nq', title: 'a' }).state;
  const realId = s.items[0].id;
  let r = store.applyLabelDelta(s, realId, { labels: ['agent:in-progress'], removeLabels: ['agent:backlog'], comment: 'Claimed' });
  assert.equal(r.item.state, 'in_progress');
  assert.equal(r.item.activity.at(-1).text, 'Claimed');
  r = store.applyLabelDelta(r.state, realId, { labels: ['merged-unverified'], comment: 'PR merged' });
  assert.equal(r.item.state, 'done');
});

test('applyLabelDelta reopen (agent:backlog) resets state to queued', () => {
  let s = store.addItem(store.emptyState(), { project: 'nq', title: 'a' }).state;
  const id = s.items[0].id;
  s = store.applyLabelDelta(s, id, { labels: ['merged-unverified'], comment: 'merged' }).state;
  assert.equal(s.items[0].state, 'done');
  const r = store.applyLabelDelta(s, id, { labels: ['agent:backlog'], removeLabels: ['agent:done'], comment: 'reopened' });
  assert.equal(r.item.state, 'queued');
});

test('load/save round-trips through disk', () => {
  const dir = tmp();
  const { item } = store.addItemTo(dir, { project: 'nq', title: 'persist me' });
  const loaded = store.load(dir);
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0].id, item.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── source field ──────────────────────────────────────────────────────────────

test('addItem without source defaults item.source to manual', () => {
  const r = store.addItem(store.emptyState(), { project: 'nq', title: 'no-src' });
  assert.equal(r.item.source, 'manual');
});

test('addItem with explicit source persists it', () => {
  const r = store.addItem(store.emptyState(), { project: 'nq', title: 'deferred one', source: 'deferred' });
  assert.equal(r.item.source, 'deferred');
});

// ── priority field ────────────────────────────────────────────────────────────

test('addItem with priority persists it on the item', () => {
  const r = store.addItem(store.emptyState(), { project: 'nq', title: 'high pri', priority: 1 });
  assert.equal(r.item.priority, 1);
});

test('addItem without priority defaults to null', () => {
  const r = store.addItem(store.emptyState(), { project: 'nq', title: 'no pri' });
  assert.equal(r.item.priority, null);
});

// ── dedup on create ───────────────────────────────────────────────────────────

test('creating same (project,title,source) while open returns same item and isNew false', () => {
  let s = store.emptyState();
  const r1 = store.addItem(s, { project: 'nq', title: 'dup me', source: 'manual' });
  assert.equal(r1.isNew, true);
  s = r1.state;
  const r2 = store.addItem(s, { project: 'nq', title: 'dup me', source: 'manual' });
  assert.equal(r2.isNew, false);
  assert.equal(r2.item.id, r1.item.id);
  assert.equal(r2.state.items.length, 1, 'store must still hold exactly one item');
});

test('same title but different source creates a second item', () => {
  let s = store.emptyState();
  s = store.addItem(s, { project: 'nq', title: 'shared title', source: 'manual' }).state;
  const r2 = store.addItem(s, { project: 'nq', title: 'shared title', source: 'deferred' });
  assert.equal(r2.isNew, true);
  assert.equal(r2.state.items.length, 2);
});

test('same (project,title,source) but first is done allows new item', () => {
  let s = store.emptyState();
  const r1 = store.addItem(s, { project: 'nq', title: 'was done', source: 'manual' });
  s = r1.state;
  s = store.updateItem(s, r1.item.id, { state: 'done' }).state;
  const r2 = store.addItem(s, { project: 'nq', title: 'was done', source: 'manual' });
  assert.equal(r2.isNew, true);
  assert.notEqual(r2.item.id, r1.item.id);
  assert.equal(r2.state.items.length, 2);
});

test('same (project,title,source) but first is cancelled allows new item', () => {
  let s = store.emptyState();
  const r1 = store.addItem(s, { project: 'nq', title: 'was cancelled', source: 'manual' });
  s = r1.state;
  s = store.updateItem(s, r1.item.id, { state: 'cancelled' }).state;
  const r2 = store.addItem(s, { project: 'nq', title: 'was cancelled', source: 'manual' });
  assert.equal(r2.isNew, true);
  assert.notEqual(r2.item.id, r1.item.id);
  assert.equal(r2.state.items.length, 2);
});

test('addItemTo dedup: disk round-trip preserves dedup across calls', () => {
  const dir = tmp();
  const r1 = store.addItemTo(dir, { project: 'nq', title: 'disk-dup', source: 'manual' });
  assert.equal(r1.isNew, true);
  const r2 = store.addItemTo(dir, { project: 'nq', title: 'disk-dup', source: 'manual' });
  assert.equal(r2.isNew, false);
  assert.equal(r2.item.id, r1.item.id);
  const loaded = store.load(dir);
  assert.equal(loaded.items.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reorderItems sets order to index and applies status', () => {
  let s = store.emptyState();
  s = store.addItem(s, { title: 'a' }).state; // glmps-1
  s = store.addItem(s, { title: 'b' }).state; // glmps-2
  s = store.addItem(s, { title: 'c' }).state; // glmps-3
  const r = store.reorderItems(s, { ids: ['glmps-3', 'glmps-1'], status: 'in_progress' });
  const byId = Object.fromEntries(r.state.items.map(i => [i.id, i]));
  assert.equal(byId['glmps-3'].order, 0);
  assert.equal(byId['glmps-3'].state, 'in_progress');
  assert.equal(byId['glmps-1'].order, 1);
  assert.equal(byId['glmps-1'].state, 'in_progress');
  assert.equal(byId['glmps-2'].state, 'queued'); // untouched
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].id, 'glmps-3');
});

test('reorderItems ignores invalid status', () => {
  let s = store.emptyState();
  s = store.addItem(s, { title: 'a' }).state;
  const r = store.reorderItems(s, { ids: ['glmps-1'], status: 'bogus' });
  assert.equal(r.state.items[0].state, 'queued');
  assert.equal(r.state.items[0].order, 0);
});

test('removeItem drops an item and is a no-op for unknown id', () => {
  let s = store.emptyState();
  s = store.addItem(s, { title: 'a' }).state;
  const r1 = store.removeItem(s, 'glmps-1');
  assert.equal(r1.removed, true);
  assert.equal(r1.state.items.length, 0);
  const r2 = store.removeItem(s, 'nope');
  assert.equal(r2.removed, false);
  assert.equal(r2.state.items.length, 1);
});

test('reorderItemsIn and removeItemIn round-trip to disk', () => {
  const dir = tmp();
  store.addItemTo(dir, { title: 'a' });
  store.addItemTo(dir, { title: 'b' });
  store.reorderItemsIn(dir, { ids: ['glmps-2', 'glmps-1'], status: 'done' });
  const items = store.listFrom(dir, {});
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  assert.equal(byId['glmps-2'].order, 0);
  assert.equal(byId['glmps-2'].state, 'done');
  assert.equal(store.removeItemIn(dir, 'glmps-1').removed, true);
  assert.equal(store.listFrom(dir, {}).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
