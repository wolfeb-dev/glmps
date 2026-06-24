// server/test/learning-templates.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardForGap, insertGuard, TEMPLATES } from '../lib/learning-templates.js';

// ---------------------------------------------------------------------------
// guardForGap
// ---------------------------------------------------------------------------

test('guardForGap maps known codes, null otherwise', () => {
  assert.equal(guardForGap('ui-without-frontend-design').file, 'CLAUDE.global.md');
  assert.match(guardForGap('ui-without-frontend-design').rule, /frontend-design/);
  assert.equal(guardForGap('nope'), null);
});

test('guardForGap: heavy-edits-no-subagents is defined', () => {
  const entry = guardForGap('heavy-edits-no-subagents');
  assert.ok(entry, 'heavy-edits-no-subagents should exist');
  assert.equal(entry.file, 'CLAUDE.global.md');
  assert.equal(entry.section, 'Learned guards');
  assert.match(entry.rule, /subagent/);
});

test('TEMPLATES map contains the original two seeded entries plus new ones', () => {
  assert.ok(TEMPLATES.has('ui-without-frontend-design'));
  assert.ok(TEMPLATES.has('heavy-edits-no-subagents'));
  assert.ok(TEMPLATES.size >= 2);
});

// ---------------------------------------------------------------------------
// New TEMPLATES entries (GOAL 2)
// ---------------------------------------------------------------------------

test('guardForGap: ui-design-too-late is defined with correct shape', () => {
  const entry = guardForGap('ui-design-too-late');
  assert.ok(entry, 'ui-design-too-late should exist');
  assert.equal(entry.file, 'CLAUDE.global.md');
  assert.equal(entry.section, 'Learned guards');
  assert.match(entry.rule, /frontend-design/i);
  assert.match(entry.rule, /before/i);
});

test('guardForGap: reread-loop is defined', () => {
  const entry = guardForGap('reread-loop');
  assert.ok(entry, 'reread-loop should exist');
  assert.equal(entry.file, 'CLAUDE.global.md');
  assert.equal(entry.section, 'Learned guards');
  assert.match(entry.rule, /graphify/i);
});

test('guardForGap: done-without-verification is defined', () => {
  const entry = guardForGap('done-without-verification');
  assert.ok(entry, 'done-without-verification should exist');
  assert.equal(entry.file, 'CLAUDE.global.md');
  assert.equal(entry.section, 'Learned guards');
  assert.match(entry.rule, /verification-before-completion/i);
});

test('guardForGap: bash-grep-over-grep-tool is defined', () => {
  const entry = guardForGap('bash-grep-over-grep-tool');
  assert.ok(entry, 'bash-grep-over-grep-tool should exist');
  assert.equal(entry.file, 'CLAUDE.global.md');
  assert.equal(entry.section, 'Learned guards');
  assert.match(entry.rule, /Grep/);
});

test('guardForGap: opus-on-mechanical is defined', () => {
  const entry = guardForGap('opus-on-mechanical');
  assert.ok(entry, 'opus-on-mechanical should exist');
  assert.equal(entry.file, 'CLAUDE.global.md');
  assert.equal(entry.section, 'Learned guards');
  assert.match(entry.rule, /[Oo]pus/);
});

test('guardForGap: serial-agents-no-parallel is defined', () => {
  const entry = guardForGap('serial-agents-no-parallel');
  assert.ok(entry, 'serial-agents-no-parallel should exist');
  assert.equal(entry.file, 'CLAUDE.global.md');
  assert.equal(entry.section, 'Learned guards');
  assert.match(entry.rule, /parallel/i);
});

test('guardForGap: sleep-poll is defined', () => {
  const entry = guardForGap('sleep-poll');
  assert.ok(entry, 'sleep-poll should exist');
  assert.equal(entry.file, 'CLAUDE.global.md');
  assert.equal(entry.section, 'Learned guards');
  assert.match(entry.rule, /sleep/i);
});

test('guardForGap: backtest-result-without-skeptic is defined', () => {
  const entry = guardForGap('backtest-result-without-skeptic');
  assert.ok(entry, 'backtest-result-without-skeptic should exist');
  assert.equal(entry.file, 'CLAUDE.global.md');
  assert.equal(entry.section, 'Learned guards');
  assert.match(entry.rule, /backtest/i);
});

// ---------------------------------------------------------------------------
// insertGuard — verbatim from plan Task 2 Step 1
// ---------------------------------------------------------------------------

test('insertGuard creates section, appends once, idempotent', () => {
  const a = insertGuard('# Title\n', 'Learned guards', '- rule one');
  assert.equal(a.changed, true);
  assert.match(a.content, /## Learned guards\n- rule one/);
  const b = insertGuard(a.content, 'Learned guards', '- rule one'); // already present
  assert.equal(b.changed, false);
  assert.equal(b.content, a.content);
  const c = insertGuard(a.content, 'Learned guards', '- rule two'); // append under same section
  assert.equal(c.changed, true);
  assert.match(c.content, /- rule one\n- rule two/);
});

// ---------------------------------------------------------------------------
// insertGuard — edge cases
// ---------------------------------------------------------------------------

test('insertGuard: preserves content above and below the section', () => {
  const original = '# Title\n\nsome prose\n\n## Other section\n- existing item\n';
  const { content, changed } = insertGuard(original, 'Learned guards', '- new rule');
  assert.equal(changed, true);
  assert.match(content, /some prose/);
  assert.match(content, /## Other section/);
  assert.match(content, /existing item/);
  assert.match(content, /## Learned guards/);
  assert.match(content, /new rule/);
});

test('insertGuard: section present but empty — appends rule inside it', () => {
  const original = '# Title\n\n## Learned guards\n\n## Next section\nsome stuff\n';
  const { content, changed } = insertGuard(original, 'Learned guards', '- my rule');
  assert.equal(changed, true);
  // The rule should appear under the section heading
  assert.match(content, /## Learned guards[\s\S]*- my rule/);
  // The following section should still be present
  assert.match(content, /## Next section/);
});

test('insertGuard: rule already present in the section — no change', () => {
  const original = '# Title\n\n## Learned guards\n- existing rule\n';
  const { content, changed } = insertGuard(original, 'Learned guards', '- existing rule');
  assert.equal(changed, false);
  assert.equal(content, original);
});

test('insertGuard: rule already present in a different section — still no change (idempotent on exact text)', () => {
  // The rule text appears in another section; insertGuard must not add a duplicate
  const original = '## Other section\n- rule one\n\n## Learned guards\n- rule two\n';
  const { content, changed } = insertGuard(original, 'Learned guards', '- rule one');
  // rule one already exists verbatim in the file, so changed should be false
  assert.equal(changed, false);
  assert.equal(content, original);
});

test('insertGuard: empty file — creates section and appends rule', () => {
  const { content, changed } = insertGuard('', 'Learned guards', '- a guard');
  assert.equal(changed, true);
  assert.match(content, /## Learned guards\n- a guard/);
});

test('insertGuard: multiple calls with different rules append in order', () => {
  let state = insertGuard('# Doc\n', 'Learned guards', '- alpha');
  state = insertGuard(state.content, 'Learned guards', '- beta');
  state = insertGuard(state.content, 'Learned guards', '- gamma');
  assert.equal(state.changed, true);
  const idx = (s) => state.content.indexOf(s);
  assert.ok(idx('- alpha') < idx('- beta'), 'alpha before beta');
  assert.ok(idx('- beta') < idx('- gamma'), 'beta before gamma');
});
