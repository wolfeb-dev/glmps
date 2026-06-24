// server/test/code-graph.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGraph } from '../lib/code-graph.js';

const tmp = [];
process.on('exit', () => { for (const d of tmp) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
function fixture(graph) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-graph-')); tmp.push(d);
  const f = path.join(d, 'graph.json'); fs.writeFileSync(f, JSON.stringify(graph)); return f;
}

const GRAPH = {
  built_at_commit: '83254e79',
  nodes: [
    { id: 'server', label: 'server.js', source_file: 'server.js', community: 0 },
    { id: 'fleet', label: 'agent-fleet.js', source_file: 'lib/agent-fleet.js', community: 1 },
    { id: 'loop', label: 'loop-stage.js', source_file: 'lib/loop-stage.js', community: 1 },
    { id: 'paths', label: 'paths.js', source_file: 'lib/paths.js', community: 0 },
  ],
  links: [
    { source: 'server', target: 'fleet', relation: 'imports' },
    { source: 'server', target: 'loop', relation: 'imports' },
    { source: 'server', target: 'paths', relation: 'imports' },
    { source: 'fleet', target: 'paths', relation: 'imports' },
  ],
};

test('loadGraph tags zones, degree, god nodes, communities', () => {
  const g = loadGraph(fixture(GRAPH), { headCommit: '83254e79' });
  assert.equal(g.nodes.length, 4);
  assert.equal(g.communities, 2);
  assert.equal(g.stale, false);
  const fleet = g.nodes.find(n => n.id === 'fleet');
  assert.equal(fleet.zone, 'lib'); assert.equal(fleet.env, 'dev');
  const server = g.nodes.find(n => n.id === 'server');
  assert.equal(server.degree, 3);   // highest degree
  assert.equal(server.god, true);   // top hub
  const loop = g.nodes.find(n => n.id === 'loop');
  assert.equal(loop.god, false);
});

test('loadGraph stale=true when commit differs; null on missing file', () => {
  assert.equal(loadGraph(fixture(GRAPH), { headCommit: 'deadbeef' }).stale, true);
  assert.equal(loadGraph('Z:\\nope\\graph.json'), null);
});

test('loadGraph: exactly one god node; fleet and paths are not god', () => {
  const g = loadGraph(fixture(GRAPH), { headCommit: '83254e79' });
  assert.equal(g.nodes.filter(n => n.god).length, 1);
  const fleet = g.nodes.find(n => n.id === 'fleet');
  assert.equal(fleet.god, false);
  const paths = g.nodes.find(n => n.id === 'paths');
  assert.equal(paths.god, false);
});

test('loadGraph: node missing source_file gets zone and env without throwing', () => {
  const graph = {
    built_at_commit: 'abc123',
    nodes: [{ id: 'orphan', label: 'orphan.js', community: 0 }],
    links: [],
  };
  const g = loadGraph(fixture(graph));
  assert.notEqual(g, null);
  const orphan = g.nodes.find(n => n.id === 'orphan');
  assert.equal(typeof orphan.zone, 'string');
  assert.equal(typeof orphan.env, 'string');
});

test('loadGraph: empty graph returns empty nodes/links, communities=0, stale=null', () => {
  const g = loadGraph(fixture({ nodes: [], links: [] }));
  assert.notEqual(g, null);
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.links, []);
  assert.equal(g.communities, 0);
  assert.equal(g.builtAtCommit, null);
  assert.equal(g.stale, null);
});
