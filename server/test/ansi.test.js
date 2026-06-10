// server/test/ansi.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnsi } from '../../web/ansi.js';

test('plain text with no codes yields a single unstyled token', () => {
  const t = parseAnsi('hello world');
  assert.equal(t.length, 1);
  assert.equal(t[0].text, 'hello world');
  assert.equal(t[0].style.fg, null);
  assert.equal(t[0].style.bg, null);
  assert.equal(t[0].style.bold, false);
});

test('empty string yields no tokens', () => {
  assert.deepEqual(parseAnsi(''), []);
  assert.deepEqual(parseAnsi(null), []);
  assert.deepEqual(parseAnsi(undefined), []);
});

test('foreground color code applies until reset', () => {
  const t = parseAnsi('\x1b[31mred\x1b[0mplain');
  assert.equal(t.length, 2);
  assert.equal(t[0].text, 'red');
  assert.equal(t[0].style.fg, 31);
  assert.equal(t[1].text, 'plain');
  assert.equal(t[1].style.fg, null);
});

test('bright foreground (90-97) is captured', () => {
  const t = parseAnsi('\x1b[92mbright green\x1b[0m');
  assert.equal(t[0].style.fg, 92);
});

test('background color code (40-47) is captured', () => {
  const t = parseAnsi('\x1b[44mon blue\x1b[0m');
  assert.equal(t[0].style.bg, 44);
  assert.equal(t[0].style.fg, null);
});

test('bold flag set and cleared independently of color', () => {
  const t = parseAnsi('\x1b[1;33mbold gold\x1b[22mjust gold\x1b[0m');
  assert.equal(t[0].style.bold, true);
  assert.equal(t[0].style.fg, 33);
  // 22 clears bold but leaves fg
  assert.equal(t[1].style.bold, false);
  assert.equal(t[1].style.fg, 33);
});

test('combined SGR params in one sequence are all applied', () => {
  const t = parseAnsi('\x1b[1;4;34mx\x1b[0m');
  assert.equal(t[0].style.bold, true);
  assert.equal(t[0].style.underline, true);
  assert.equal(t[0].style.fg, 34);
});

test('reset code 0 clears every attribute', () => {
  const t = parseAnsi('\x1b[1;31;44mstyled\x1b[0mreset');
  assert.equal(t[1].style.fg, null);
  assert.equal(t[1].style.bg, null);
  assert.equal(t[1].style.bold, false);
});

test('bare ESC[m is treated as reset', () => {
  const t = parseAnsi('\x1b[33mgold\x1b[mafter');
  assert.equal(t[0].style.fg, 33);
  assert.equal(t[1].style.fg, null);
});

test('39/49 reset only fg/bg respectively', () => {
  const t = parseAnsi('\x1b[31;44mboth\x1b[39mfg-reset\x1b[49mbg-reset');
  assert.equal(t[0].style.fg, 31);
  assert.equal(t[0].style.bg, 44);
  assert.equal(t[1].style.fg, null);
  assert.equal(t[1].style.bg, 44);
  assert.equal(t[2].style.fg, null);
  assert.equal(t[2].style.bg, null);
});

test('text before the first code is emitted as its own unstyled token', () => {
  const t = parseAnsi('start\x1b[32mgreen');
  assert.equal(t.length, 2);
  assert.equal(t[0].text, 'start');
  assert.equal(t[0].style.fg, null);
  assert.equal(t[1].text, 'green');
  assert.equal(t[1].style.fg, 32);
});

test('unknown/unsupported codes are ignored without throwing', () => {
  // 38;5;200 is 256-color (unsupported) — should not crash, fg stays null
  const t = parseAnsi('\x1b[38;5;200mx\x1b[0m');
  assert.equal(t[0].text, 'x');
  assert.equal(t[0].style.fg, null);
});

test('consecutive codes with no text between produce no empty tokens', () => {
  const t = parseAnsi('\x1b[1m\x1b[31mtext\x1b[0m');
  assert.equal(t.length, 1);
  assert.equal(t[0].text, 'text');
  assert.equal(t[0].style.bold, true);
  assert.equal(t[0].style.fg, 31);
});
