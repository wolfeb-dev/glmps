import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paretoDominates, evaluatePromotion } from '../lib/promotion.js';

const dirs = { turns: 'lower', verifierPassRate: 'higher', firstTryRate: 'higher' };

test('challenger dominates -> promote', () => {
  const champ = { turns: 5, verifierPassRate: 0.7, firstTryRate: 0.5 };
  const chal  = { turns: 4, verifierPassRate: 0.7, firstTryRate: 0.6 };
  assert.equal(paretoDominates(chal, champ, dirs), true);
  const e = evaluatePromotion({ champion: champ, challenger: chal, directions: dirs });
  assert.equal(e.verdict, 'promote');
});

test('any regression -> reject', () => {
  const champ = { turns: 5, verifierPassRate: 0.7, firstTryRate: 0.5 };
  const chal  = { turns: 4, verifierPassRate: 0.6, firstTryRate: 0.6 }; // verifier worse
  assert.equal(paretoDominates(chal, champ, dirs), false);
  const e = evaluatePromotion({ champion: champ, challenger: chal, directions: dirs });
  assert.equal(e.verdict, 'reject');
  assert.ok(e.perMetric.verifierPassRate === 'worse');
});

test('no movement -> hold', () => {
  const champ = { turns: 5, verifierPassRate: 0.7, firstTryRate: 0.5 };
  const chal  = { turns: 5, verifierPassRate: 0.7, firstTryRate: 0.5 };
  assert.equal(evaluatePromotion({ champion: champ, challenger: chal, directions: dirs }).verdict, 'hold');
});

test('null fields are na and ignored', () => {
  const champ = { turns: 5, verifierPassRate: null };
  const chal  = { turns: 4, verifierPassRate: 0.7 };
  const e = evaluatePromotion({ champion: champ, challenger: chal, directions: { turns:'lower', verifierPassRate:'higher' } });
  assert.equal(e.perMetric.verifierPassRate, 'na');
  assert.equal(e.verdict, 'promote');
});
