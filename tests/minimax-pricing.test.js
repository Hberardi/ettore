import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModelPricing, calcCost } from '../src/utils/pricing.js';

test('pricing: MiniMax-M3 is in the table and resolves via lowercase lookup', () => {
  const p = getModelPricing('MiniMax-M3');
  // Both input and output rates must be finite numbers (not null).
  assert.equal(typeof p.in, 'number');
  assert.equal(typeof p.out, 'number');
  assert.ok(Number.isFinite(p.in) && p.in > 0, 'in rate must be a positive number');
  assert.ok(Number.isFinite(p.out) && p.out > 0, 'out rate must be a positive number');
  assert.ok(p.ctx >= 8192, 'context window must be reasonable');
});

test('pricing: calcCost returns a finite dollar amount for M3', () => {
  const cost = calcCost(1_000_000, 500_000, 'MiniMax-M3');
  assert.ok(typeof cost === 'number' && Number.isFinite(cost));
  assert.ok(cost > 0);
});

test('pricing: unknown model falls back to default (in:null) — not crash', () => {
  const p = getModelPricing('totally-unknown-model-xyz');
  assert.equal(p.in, null);
  assert.equal(calcCost(100, 100, 'totally-unknown-model-xyz'), null);
});
