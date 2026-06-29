import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, criticDisagreement } from '../lib/cross-model-eval.js';

test('evaluate without apiKey is fail-open null', async () => {
  assert.equal(await evaluate({ prompt: 'hi', apiKey: '' }), null);
});

test('evaluate parses injected response', async () => {
  const httpPost = async () => ({ content: [{ type: 'text', text: 'hello' }] });
  assert.deepEqual(await evaluate({ prompt: 'x', apiKey: 'k', httpPost }), { text: 'hello' });
});

test('evaluate fails open on thrown httpPost', async () => {
  const httpPost = async () => { throw new Error('net'); };
  assert.equal(await evaluate({ prompt: 'x', apiKey: 'k', httpPost }), null);
});

test('criticDisagreement parses a float', async () => {
  const httpPost = async () => ({ content: [{ type: 'text', text: 'disagreement: 0.8' }] });
  assert.equal(await criticDisagreement({ question: 'q', answer: 'a', apiKey: 'k', httpPost }), 0.8);
});

test('criticDisagreement without key is null', async () => {
  assert.equal(await criticDisagreement({ question: 'q', answer: 'a', apiKey: '' }), null);
});
