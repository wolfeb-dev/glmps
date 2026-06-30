// Tests for the Stop-hook done-gate pure decision functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parseAcceptance, decideDoneGate, parsePorcelain, readProdRoots } from '../../hooks/done-gate.js';

// --- readProdRoots: config-driven prod roots for the scope-guard (glmps-22) ---

test('readProdRoots reads prodRoots from config.json one level above the hooks dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-prodroots-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ prodRoots: ['D:/glmps_prod', 'D:/live/bin/Custom'] }));
  assert.deepEqual(readProdRoots(path.join(tmp, 'hooks')), ['D:/glmps_prod', 'D:/live/bin/Custom']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readProdRoots returns [] when config absent, lacks prodRoots, or is invalid', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-prodroots-'));
  assert.deepEqual(readProdRoots(path.join(tmp, 'hooks')), []);                 // absent
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ backtestProjects: ['x'] }));
  assert.deepEqual(readProdRoots(path.join(tmp, 'hooks')), []);                 // no prodRoots key
  fs.writeFileSync(path.join(tmp, 'config.json'), '{not json');
  assert.deepEqual(readProdRoots(path.join(tmp, 'hooks')), []);                 // invalid json
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- parseAcceptance: frontmatter command extraction ---

test('parseAcceptance: extracts frontmatter commands', () => {
  const md = '---\ncommands:\n  - npm test\n  - npm run lint\n---\n# Acceptance\nbody';
  assert.deepEqual(parseAcceptance(md), { commands: ['npm test', 'npm run lint'] });
});

test('parseAcceptance: no frontmatter -> null', () => {
  assert.equal(parseAcceptance('# just a heading\nno fm'), null);
});

test('parseAcceptance: frontmatter without commands -> null', () => {
  assert.equal(parseAcceptance('---\ntitle: x\n---\nbody'), null);
});

test('parseAcceptance: empty commands list -> null', () => {
  assert.equal(parseAcceptance('---\ncommands:\n---\nbody'), null);
});

test('parseAcceptance: a following top-level key ends the list', () => {
  const md = '---\ncommands:\n  - npm test\ntitle: x\n---\nbody';
  assert.deepEqual(parseAcceptance(md), { commands: ['npm test'] });
});

test('parseAcceptance: non-string -> null, never throws', () => {
  assert.equal(parseAcceptance(null), null);
  assert.equal(parseAcceptance(undefined), null);
  assert.equal(parseAcceptance(42), null);
});

// --- decideDoneGate: pure decision matrix ---

const C = { commands: ['npm test'] };

test('decide: no contract -> allow, no run', () => {
  const d = decideDoneGate({ contract: null, dirty: true, skip: false, stopHookActive: false, blockCount: 0 });
  assert.equal(d.action, 'allow');
  assert.equal(d.needsRun, false);
});

test('decide: skip -> allow + skipped flag', () => {
  const d = decideDoneGate({ contract: C, dirty: true, skip: true, stopHookActive: false, blockCount: 0 });
  assert.equal(d.action, 'allow');
  assert.equal(d.skipped, true);
  assert.equal(d.needsRun, false);
});

test('decide: clean tree -> allow, no run', () => {
  const d = decideDoneGate({ contract: C, dirty: false, skip: false, stopHookActive: false, blockCount: 0 });
  assert.equal(d.action, 'allow');
  assert.equal(d.needsRun, false);
});

test('decide: dirty, no runResult -> needsRun', () => {
  const d = decideDoneGate({ contract: C, dirty: true, skip: false, stopHookActive: false, blockCount: 0 });
  assert.equal(d.needsRun, true);
});

test('decide: dirty + pass -> allow, reset counter', () => {
  const d = decideDoneGate({ contract: C, dirty: true, skip: false, stopHookActive: true, blockCount: 2,
    runResult: { ok: true } });
  assert.equal(d.action, 'allow');
  assert.equal(d.nextBlockCount, 0);
  assert.equal(d.result, 'pass');
});

test('decide: dirty + fail under cap -> block, increment', () => {
  const d = decideDoneGate({ contract: C, dirty: true, skip: false, stopHookActive: true, blockCount: 1,
    runResult: { ok: false, failedCommand: 'npm test', tail: 'X' } });
  assert.equal(d.action, 'block');
  assert.equal(d.nextBlockCount, 2);
  assert.equal(d.result, 'block');
  assert.match(d.reason, /npm test/);
});

test('decide: fail at cap (>=3) -> yield (allow), reset', () => {
  const d = decideDoneGate({ contract: C, dirty: true, skip: false, stopHookActive: true, blockCount: 3,
    runResult: { ok: false, failedCommand: 'npm test', tail: 'X' } });
  assert.equal(d.action, 'allow');
  assert.equal(d.result, 'yield');
  assert.equal(d.nextBlockCount, 0);
});

test('decide: stop_hook_active false resets count before deciding', () => {
  const d = decideDoneGate({ contract: C, dirty: true, skip: false, stopHookActive: false, blockCount: 9,
    runResult: { ok: false, failedCommand: 'npm test', tail: 'X' } });
  assert.equal(d.action, 'block');
  assert.equal(d.nextBlockCount, 1); // count reset to 0 first, then +1
});

// --- parsePorcelain: git status --porcelain text -> absolute paths ---

const CWD = process.platform === 'win32' ? 'D:\\repo' : '/repo';

test('parsePorcelain: normal modified and untracked files', () => {
  const result = parsePorcelain(' M web/app.js\n?? new.txt', CWD);
  assert.deepEqual(result, [path.join(CWD, 'web/app.js'), path.join(CWD, 'new.txt')]);
});

test('parsePorcelain: rename - takes destination (lastIndexOf)', () => {
  const result = parsePorcelain('R  old.js -> new.js', CWD);
  assert.equal(result.length, 1);
  assert.ok(result[0].endsWith(path.join(CWD, 'new.js').slice(-6)));
  assert.deepEqual(result, [path.join(CWD, 'new.js')]);
});

test('parsePorcelain: quoted path with spaces - quotes stripped', () => {
  const result = parsePorcelain('?? "a b.js"', CWD);
  assert.deepEqual(result, [path.join(CWD, 'a b.js')]);
});

test('parsePorcelain: empty input -> []', () => {
  assert.deepEqual(parsePorcelain('', CWD), []);
});
