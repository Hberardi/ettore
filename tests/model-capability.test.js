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

// A capability list pinned to today's version numbers rots silently: the model
// is not recognised, and nothing says so — it just quietly loses the treatment
// its family gets. This has now happened twice, with MiniMax M3 and with
// Kimi K3 on NVIDIA NIM, so the patterns are version-agnostic.

test('a new version of a known family is recognised on the day it ships', () => {
  for (const id of [
    'moonshotai/kimi-k3', 'kimi-k3', 'kimi-k4-preview', 'moonshotai/kimi-latest',
    'MiniMax-M3', 'MiniMax-M4', 'minimax-m2.7-highspeed',
    'deepseek-r3', 'deepseek-v4',
  ]) {
    assert.equal(getModelCapability(id), 'full', `${id} was not recognised`);
  }
});

test('the vendor prefix on a routed id does not defeat the match', () => {
  // `\bmoonshot\b` never matched `moonshotai`: there is no word boundary
  // between `t` and `a`, and `moonshotai/…` is the form every router uses.
  assert.equal(getModelCapability('moonshotai/kimi-k2'), 'full');
  assert.equal(getModelCapability('moonshotai/moonshot-v1-128k'), 'full');
});

test('small models are still lite, so the broader patterns did not swallow them', () => {
  for (const id of ['phi-3-mini', 'qwen-2.5-0.5b', 'llama-3.2-1b', 'gemma-2-2b', 'tinyllama']) {
    assert.equal(getModelCapability(id), 'lite', `${id} should still be lite`);
  }
});

test('broadening the family patterns did not promote unrelated ids', () => {
  // `minimax-text-01` is a chat-only model in the same vendor namespace, so
  // the M-series marker has to stay mandatory rather than matching a bare
  // vendor name.
  assert.notEqual(getModelCapability('minimax-text-01'), 'full');
  assert.notEqual(getModelCapability('minimax-abab6'), 'full');
});
