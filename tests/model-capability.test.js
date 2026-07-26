import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModelCapability } from '../src/providers/model_capability.js';

test('getModelCapability: MiniMax M2 family is full', () => {
  assert.equal(getModelCapability('MiniMax-M2.7'), 'full');
  assert.equal(getModelCapability('MiniMax-M2.7-highspeed'), 'full');
  assert.equal(getModelCapability('MiniMax-M2.5'), 'full');
  assert.equal(getModelCapability('MiniMax-M2'), 'full');
});

test('getModelCapability: MiniMax M3 is full (matches the M[23] family pattern)', () => {
  // Regression: prior regex `minimax[-_]?m2(?:\.(?:1|5|7))?...` excluded M3,
  // letting it fall through to 'unknown'. M3 must be detected as 'full'
  // so it gets the full system prompt + tool schemas.
  assert.equal(getModelCapability('MiniMax-M3'), 'full');
  // Lowercase, dot-separated aliases should also work.
  assert.equal(getModelCapability('minimax-m3'), 'full');
  // The pattern must not over-match unrelated ids.
  assert.notEqual(getModelCapability('minimax-text-01'), 'full');
});

test('getModelCapability: explicit tool metadata wins', () => {
  assert.equal(
    getModelCapability('custom-model', { supported_parameters: ['tools'] }),
    'full'
  );
});
