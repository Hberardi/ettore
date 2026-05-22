import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModelCapability } from '../src/providers/model_capability.js';

test('getModelCapability: MiniMax M2 family is full', () => {
  assert.equal(getModelCapability('MiniMax-M2.7'), 'full');
  assert.equal(getModelCapability('MiniMax-M2.7-highspeed'), 'full');
  assert.equal(getModelCapability('MiniMax-M2.5'), 'full');
  assert.equal(getModelCapability('MiniMax-M2'), 'full');
});

test('getModelCapability: explicit tool metadata wins', () => {
  assert.equal(
    getModelCapability('custom-model', { supported_parameters: ['tools'] }),
    'full'
  );
});
