import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifierFromEvents, acceptanceCoverage } from '../lib/verifier-signals.js';

test('tests pass/fail keyed off paired result', () => {
  const ev = [
    { kind: 'tool', tool: 'Bash', label: 'npm test', ts: 1 },
    { kind: 'tool_result', ok: true, ts: 2 },
  ];
  assert.equal(verifierFromEvents(ev).tests, true);
  assert.equal(verifierFromEvents(ev).exitOk, true);
});

test('non-zero test exit -> false', () => {
  const ev = [
    { kind: 'tool', tool: 'Bash', label: 'npm test', ts: 1 },
    { kind: 'tool_result', ok: false, ts: 2 },
  ];
  assert.equal(verifierFromEvents(ev).tests, false);
  assert.equal(verifierFromEvents(ev).exitOk, false);
});

test('no commands -> all null', () => {
  const v = verifierFromEvents([]);
  assert.deepEqual(v, { tests: null, lint: null, build: null, exitOk: null });
});

test('mixed: build pass + lint fail -> exitOk false', () => {
  const ev = [
    { kind: 'tool', tool: 'Bash', label: 'npm run build', ts: 1 },
    { kind: 'tool_result', ok: true, ts: 2 },
    { kind: 'tool', tool: 'Bash', label: 'eslint .', ts: 3 },
    { kind: 'tool_result', ok: false, ts: 4 },
  ];
  const v = verifierFromEvents(ev);
  assert.equal(v.build, true);
  assert.equal(v.lint, false);
  assert.equal(v.tests, null);
  assert.equal(v.exitOk, false);
});

test('acceptance coverage counts checklist lines', () => {
  const text = '# acceptance\n- [ ] tests pass\n- [x] builds\n- [X] lint clean\n';
  const c = acceptanceCoverage(text, []);
  assert.equal(c.stated, 3);
  assert.equal(c.met, 2);
});

test('empty acceptance -> nulls', () => {
  assert.deepEqual(acceptanceCoverage('', []), { stated: null, met: null });
});
