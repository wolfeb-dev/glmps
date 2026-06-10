// server/test/git-events.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGit } from '../lib/git-events.js';

test('classifyGit: null/non-string returns null', () => {
  assert.equal(classifyGit(null), null);
  assert.equal(classifyGit(42), null);
  assert.equal(classifyGit(undefined), null);
});

test('classifyGit: plain git status -> null (not a save op)', () => {
  assert.equal(classifyGit('git status'), null);
  assert.equal(classifyGit('git diff HEAD'), null);
  assert.equal(classifyGit('git log --oneline'), null);
});

test('classifyGit: git commit with -m double-quote message', () => {
  const r = classifyGit('git commit -m "feat: add thing"');
  assert.ok(r, 'should return event');
  assert.equal(r.kind, 'git');
  assert.equal(r.lane, 'context');
  assert.equal(r.gitOp, 'commit');
  assert.equal(r.label, 'commit: feat: add thing');
});

test('classifyGit: git commit with -m single-quote message', () => {
  const r = classifyGit("git commit -m 'fix: memory leak'");
  assert.equal(r.gitOp, 'commit');
  assert.equal(r.label, 'commit: fix: memory leak');
});

test('classifyGit: git commit with --message=... ', () => {
  const r = classifyGit('git commit --message="refactor: split module"');
  assert.equal(r.gitOp, 'commit');
  assert.ok(r.label.includes('refactor'));
});

test('classifyGit: git commit with no -m falls back to (commit)', () => {
  const r = classifyGit('git commit --amend');
  assert.equal(r.gitOp, 'commit');
  assert.equal(r.label, 'commit: (commit)');
});

test('classifyGit: commit message truncated to 100 chars', () => {
  const longMsg = 'a'.repeat(150);
  const r = classifyGit(`git commit -m "${longMsg}"`);
  assert.equal(r.label.length, 'commit: '.length + 100);
});

test('classifyGit: git push with remote+branch', () => {
  const r = classifyGit('git push origin main');
  assert.equal(r.kind, 'git');
  assert.equal(r.gitOp, 'push');
  assert.equal(r.label, 'push → origin/main');
});

test('classifyGit: git push with no args -> plain push label', () => {
  const r = classifyGit('git push');
  assert.equal(r.gitOp, 'push');
  assert.equal(r.label, 'push');
});

test('classifyGit: gh pr create', () => {
  const r = classifyGit('gh pr create --title "My PR" --body "details"');
  assert.equal(r.kind, 'git');
  assert.equal(r.gitOp, 'pr');
  assert.equal(r.label, 'gh pr create');
});

test('classifyGit: git fetch, git pull -> null', () => {
  assert.equal(classifyGit('git fetch origin'), null);
  assert.equal(classifyGit('git pull --rebase'), null);
});

test('classifyGit: gh issue create (not pr create) -> null', () => {
  assert.equal(classifyGit('gh issue create --title "Bug"'), null);
});

test('classifyGit: leading/trailing whitespace handled', () => {
  const r = classifyGit('  git commit -m "trim test"  ');
  assert.ok(r);
  assert.equal(r.gitOp, 'commit');
});

test('classifyGit: push with leading flags captures remote/branch', () => {
  assert.equal(classifyGit('git push --force-with-lease origin main').label, 'push → origin/main');
  assert.equal(classifyGit('git push origin main').label, 'push → origin/main');
});

test('classifyGit: hyphenated filename is not a commit', () => {
  assert.equal(classifyGit('cp git-commit-template.txt ~/.gitmessage'), null);
});

test('classifyGit: multiline -m message does not embed newlines in label', () => {
  const r = classifyGit('git commit -m "line1\nline2"');
  assert.equal(r.gitOp, 'commit');
  assert.ok(!r.label.includes('\n'));
});
