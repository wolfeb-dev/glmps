// server/test/file-graph.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateToFiles, layoutPills } from '../../web/file-graph.js';

const sym = (id, source_file, extra = {}) => ({ id, source_file, community: 0, ...extra });

test('aggregateToFiles: one node per file, symbolCount sums', () => {
  const g = {
    nodes: [
      sym('f1',  'lib/a.js', { zone: 'lib', env: 'dev', community: 1 }),
      sym('f1b', 'lib/a.js', { zone: 'lib', env: 'dev', community: 1 }),
      sym('f2',  'lib/b.js', { zone: 'lib', env: 'dev', community: 2 }),
    ],
    links: [],
  };
  const out = aggregateToFiles(g);
  assert.equal(out.nodes.length, 2);
  const a = out.nodes.find(n => n.id === 'lib/a.js');
  assert.equal(a.label, 'a.js');
  assert.equal(a.dir, 'lib');
  assert.equal(a.symbolCount, 2);
  assert.equal(a.community, 1);
});

test('aggregateToFiles: intra-file links dropped, cross-file deduped with weight', () => {
  const g = {
    nodes: [
      sym('f1',  'lib/a.js'),
      sym('f1b', 'lib/a.js'),
      sym('f2',  'lib/b.js'),
    ],
    links: [
      { source: 'f1',  target: 'f2' },   // a.js -> b.js
      { source: 'f1b', target: 'f2' },   // a.js -> b.js (same file pair)
      { source: 'f1',  target: 'f1b' },  // intra-file (dropped)
    ],
  };
  const out = aggregateToFiles(g);
  assert.equal(out.links.length, 1);
  assert.deepEqual(out.links[0], { source: 'lib/a.js', target: 'lib/b.js', weight: 2 });
});

test('aggregateToFiles: degree = distinct file neighbors (both directions)', () => {
  const g = {
    nodes: [sym('a', 'a.js'), sym('b', 'b.js'), sym('c', 'c.js')],
    links: [
      { source: 'a', target: 'b' },
      { source: 'c', target: 'b' },
    ],
  };
  const out = aggregateToFiles(g);
  const by = Object.fromEntries(out.nodes.map(n => [n.id, n]));
  assert.equal(by['b.js'].degree, 2); // neighbors a.js, c.js
  assert.equal(by['a.js'].degree, 1);
  assert.equal(by['c.js'].degree, 1);
});

test('aggregateToFiles: protected if any symbol protected/prod', () => {
  const g = {
    nodes: [
      sym('p1', 'prod/p.js', { zone: 'prod', env: 'prod', protected: true }),
      sym('p2', 'prod/p.js', { zone: 'prod', env: 'dev' }),
    ],
    links: [],
  };
  const out = aggregateToFiles(g);
  assert.equal(out.nodes[0].protected, true);
});

test('aggregateToFiles: god flags the high-degree hub', () => {
  // star: hub linked to 4 leaves -> hub degree 4
  const g = {
    nodes: [sym('h', 'hub.js'), sym('l1', 'l1.js'), sym('l2', 'l2.js'), sym('l3', 'l3.js'), sym('l4', 'l4.js')],
    links: [
      { source: 'h', target: 'l1' },
      { source: 'h', target: 'l2' },
      { source: 'h', target: 'l3' },
      { source: 'h', target: 'l4' },
    ],
  };
  const out = aggregateToFiles(g);
  const by = Object.fromEntries(out.nodes.map(n => [n.id, n]));
  assert.equal(by['hub.js'].god, true);
  assert.equal(by['l1.js'].god, false);
});

test('aggregateToFiles: empty/garbage input → empty graph', () => {
  assert.deepEqual(aggregateToFiles(null), { nodes: [], links: [] });
  assert.deepEqual(aggregateToFiles({}), { nodes: [], links: [] });
});

test('aggregateToFiles: link key survives spaces in file paths', () => {
  const g = {
    nodes: [sym('a', 'lib/my utils.js'), sym('b', 'lib/b.js')],
    links: [{ source: 'a', target: 'b' }],
  };
  const out = aggregateToFiles(g);
  assert.equal(out.links.length, 1);
  assert.deepEqual(out.links[0], { source: 'lib/my utils.js', target: 'lib/b.js', weight: 1 });
});

test('aggregateToFiles: community tie → first-seen wins', () => {
  const g = {
    nodes: [
      sym('a', 'lib/x.js', { community: 2 }),
      sym('b', 'lib/x.js', { community: 5 }),
    ],
    links: [],
  };
  assert.equal(aggregateToFiles(g).nodes[0].community, 2);
});

test('layoutPills: empty → zero content', () => {
  assert.deepEqual(layoutPills([]), { pills: [], contentW: 0, contentH: 0 });
});

test('layoutPills: single short label sits at origin', () => {
  const { pills, contentH } = layoutPills(['a.js']);
  assert.equal(pills.length, 1);
  assert.equal(pills[0].x, 0);
  assert.equal(pills[0].y, 0);
  assert.equal(pills[0].text, 'a.js');
  assert.equal(pills[0].full, 'a.js');
  assert.equal(pills[0].h, 18);
  assert.equal(contentH, 18);
});

test('layoutPills: long label truncates with … and stays within maxPillW; full retained', () => {
  const long = 'a-really-very-extremely-long-filename-that-overflows.js';
  const { pills } = layoutPills([long], { maxPillW: 180 });
  assert.ok(pills[0].text.endsWith('…'));
  assert.ok(pills[0].w <= 180);
  assert.equal(pills[0].full, long);
});

test('layoutPills: rows wrap and no pill exceeds maxContentW', () => {
  const labels = Array.from({ length: 5 }, () => 'xxxxxxxxxx'); // 10 chars each
  const { pills } = layoutPills(labels, { maxContentW: 160 });
  // 10-char pill ≈ ceil(10*6.2)+14 = 76px → 2 per 160px row
  assert.equal(pills[0].y, 0);
  assert.equal(pills[1].y, 0);
  assert.equal(pills[2].y, 18 + 7); // wrapped to row 2
  for (const p of pills) assert.ok(p.x + p.w <= 160, `pill within maxContentW: ${p.x}+${p.w}`);
});

test('layoutPills: contentH counts rows', () => {
  const labels = Array.from({ length: 4 }, () => 'xxxxxxxxxx');
  const { contentH } = layoutPills(labels, { maxContentW: 160 }); // 2 per row → 2 rows
  assert.equal(contentH, (18 + 7) + 18); // row1 advance + row2 height
});
