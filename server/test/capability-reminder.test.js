// Tests for the UserPromptSubmit capability-reminder rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityReminders } from '../../hooks/capability-reminder.js';

test('UI/design prompts → frontend-design reminder', () => {
  for (const p of [
    'restyle the dashboard with a nicer color palette',
    'fix the CSS spacing on this component',
    'update the layout of app.js and styles.css',
    'make the UI more colorful',
  ]) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /frontend-design/.test(x)), `expected frontend-design for: ${p}`);
  }
});

test('bug prompts → systematic-debugging reminder', () => {
  for (const p of [
    'this is failing with an error',
    'the diff popup is broken',
    'why is the agy session not working',
  ]) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /systematic-debugging/.test(x)), `expected debugging for: ${p}`);
  }
});

test('feature prompts → brainstorm/plan reminder', () => {
  const r = capabilityReminders('implement a new feature to track git pushes');
  assert.ok(r.some(x => /brainstorm/.test(x)));
});

test('parallel work → subagents reminder', () => {
  const r = capabilityReminders('do this across all the projects in parallel');
  assert.ok(r.some(x => /subagents/.test(x)));
});

test('unrelated prompt → no reminders (low noise)', () => {
  assert.deepEqual(capabilityReminders('what time does the market open'), []);
  assert.deepEqual(capabilityReminders('push to origin'), []);
});

test('non-string input → empty, never throws', () => {
  assert.deepEqual(capabilityReminders(null), []);
  assert.deepEqual(capabilityReminders(undefined), []);
  assert.deepEqual(capabilityReminders(42), []);
});

test('caps at 3 reminders', () => {
  const r = capabilityReminders('build a new UI component, it is broken, do it across all projects in parallel');
  assert.ok(r.length <= 3);
});

test('backtest/trading prompts → backtest-skeptic reminder', () => {
  for (const p of [
    'the sortino ratio improved after the backtest',
    'check the sharpe and drawdown on this equity curve',
    'run a walk-forward to validate the win rate',
    'out-of-sample results look good',
  ]) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /backtest-skeptic/.test(x)), `expected backtest-skeptic for: ${p}`);
  }
});

test('NinjaScript prompts → headless compile reminder', () => {
  for (const p of [
    'update the NinjaScript indicator logic',
    'fix this NinjaTrader strategy',
    'edit the .cs file for the new stop rule',
  ]) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /test_ninjascript_compile/.test(x)), `expected compile reminder for: ${p}`);
  }
});

test('codebase-orientation prompts → graphify reminder', () => {
  for (const p of [
    'how does the event pipeline work',
    'where is the session list rendered',
    'refresh yourself on the architecture before we start',
    'trace the data flow from tap to UI',
  ]) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /graphify/.test(x)), `expected graphify for: ${p}`);
  }
});

test('done-claim prompts → verification-before-completion reminder', () => {
  for (const p of [
    'is it done?',
    'are we done here',
    'ship it',
    'it works now, ready to commit',
  ]) {
    const r = capabilityReminders(p);
    assert.ok(r.some(x => /verification-before-completion/.test(x)), `expected done-check for: ${p}`);
  }
});

test('new rules - unrelated prompts still return [] (low noise)', () => {
  assert.deepEqual(capabilityReminders('show me the session list'), []);
  assert.deepEqual(capabilityReminders('what is the current branch'), []);
});
