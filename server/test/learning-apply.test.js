// server/test/learning-apply.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGuard, buildIdeaApplyCommand, enqueueIdeaApply, ingestResults } from '../lib/learning-apply.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// applyGuard — verbatim from plan Task 3 Step 1
// ---------------------------------------------------------------------------

test('applyGuard transforms file, commits via injected runner, returns sha', () => {
  let written = null; const calls = [];
  const res = applyGuard({
    assetsDir: '/A', file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- r', message: 'm',
    readFile: () => '# T\n',
    writeFile: (p, c) => { written = { p, c }; },
    runGit: (args) => { calls.push(args); return args[0] === 'rev-parse' ? 'abc123' : ''; },
  });
  assert.match(written.c, /## Learned guards\n- r/);
  assert.deepEqual(calls[0], ['add', 'CLAUDE.global.md']);
  assert.equal(calls[1][0], 'commit');
  assert.equal(res.commit, 'abc123'); assert.equal(res.changed, true);
});

test('buildIdeaApplyCommand references the id and assets dir', () => {
  const cmd = buildIdeaApplyCommand('idea-1', '/A', { requestPath: '/R/idea-1.json', resultPath: '/Res/idea-1.json' });
  assert.match(cmd, /^claude -p /);
  assert.match(cmd, /idea-1/);
});

test('enqueueIdeaApply appends one terminal request line; ingestResults reads+clears', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
  const reqFile = path.join(dir, 'resume.jsonl');
  enqueueIdeaApply({ requestsFile: reqFile, command: 'claude -p "x"', cwd: '/A' });
  const line = JSON.parse(fs.readFileSync(reqFile, 'utf-8').trim());
  assert.equal(line.type, 'terminal'); assert.equal(line.command, 'claude -p "x"');
  const resDir = path.join(dir, 'learning', 'results'); fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(resDir, 'idea-1.json'), JSON.stringify({ status: 'applied', commit: 'z' }));
  const out = ingestResults(dir);
  assert.equal(out[0].id, 'idea-1'); assert.equal(out[0].commit, 'z');
  assert.equal(fs.existsSync(path.join(resDir, 'idea-1.json')), false); // consumed
});

// ---------------------------------------------------------------------------
// applyGuard — changed:false path (rule already present)
// ---------------------------------------------------------------------------

test('applyGuard (default git runner) throws when assetsDir is not a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nogit-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.global.md'), '# G\n');
  // No injected runGit -> uses the real spawnSync git, which must fail loudly
  // (not silently report success) when the dir is not a git repository.
  assert.throws(
    () => applyGuard({ assetsDir: dir, file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- x', message: 'm' }),
    /git/i,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyGuard with changed:false returns HEAD sha without committing', () => {
  const calls = [];
  const existingContent = '# Title\n\n## Learned guards\n- r\n';
  const res = applyGuard({
    assetsDir: '/A', file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- r', message: 'm',
    readFile: () => existingContent,
    writeFile: (_p, _c) => { throw new Error('writeFile should not be called when unchanged'); },
    runGit: (args) => { calls.push(args); return args[0] === 'rev-parse' ? 'HEAD123' : ''; },
  });
  assert.equal(res.changed, false);
  assert.equal(res.commit, 'HEAD123');
  // Only rev-parse should have been called (no add, no commit)
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['rev-parse', 'HEAD']);
});
