// server/test/clean-title.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle } from '../lib/adapters/clean-title.js';

test('cleanTitle: markdown context block + separator stripped, real sentence returned', () => {
  const input = [
    'Current File Path:',
    '---',
    'convert this into a ninja trader 8 strategy',
  ].join('\n');
  const result = cleanTitle(input, 80);
  assert.equal(result, 'convert this into a ninja trader 8 strategy');
});

test('cleanTitle: markdown bullet context block stripped before first real line', () => {
  const input = [
    '- **Key**: value',
    '- **Another**: item',
    '',
    'Please refactor this function',
  ].join('\n');
  const result = cleanTitle(input, 80);
  assert.equal(result, 'Please refactor this function');
});

test('cleanTitle: newlines collapsed into single line', () => {
  const input = 'Hello\nworld\nthis is one sentence';
  const result = cleanTitle(input, 80);
  assert.equal(result, 'Hello world this is one sentence');
});

test('cleanTitle: markdown syntax stripped (backticks, asterisks, hashes)', () => {
  const input = 'Set up `autoresearch` in the **current** directory';
  const result = cleanTitle(input, 80);
  // backticks and asterisks replaced with spaces, then collapsed
  assert.ok(!result.includes('`'), 'should not contain backticks');
  assert.ok(!result.includes('*'), 'should not contain asterisks');
  assert.ok(result.includes('autoresearch'));
  assert.ok(result.includes('current'));
});

test('cleanTitle: truncates to max length', () => {
  const input = 'A'.repeat(200);
  const result = cleanTitle(input, 80);
  assert.equal(result.length, 80);
});

test('cleanTitle: all-context fallback when every line is a context marker', () => {
  const input = [
    'Current File Path:',
    '---',
    'Another Key:',
    '',
  ].join('\n');
  const result = cleanTitle(input, 80);
  // Everything was context lines; fall back to collapsed raw text
  assert.ok(typeof result === 'string' && result.length > 0, 'should fall back to non-empty string');
});

test('cleanTitle: non-string input returns null', () => {
  assert.equal(cleanTitle(null), null);
  assert.equal(cleanTitle(undefined), null);
  assert.equal(cleanTitle(42), null);
  assert.equal(cleanTitle([]), null);
});

test('cleanTitle: empty string returns null', () => {
  assert.equal(cleanTitle(''), null);
});

test('cleanTitle: simple single-line text passes through unchanged', () => {
  const input = 'set up autoresearch in the current directory';
  const result = cleanTitle(input, 80);
  assert.equal(result, input);
});
