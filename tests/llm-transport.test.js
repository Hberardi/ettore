import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usesAnthropicTransport } from '../src/llm/client.js';

test('usesAnthropicTransport routes anthropic and minimax through anthropic transport', () => {
  assert.equal(usesAnthropicTransport('anthropic'), true);
  assert.equal(usesAnthropicTransport('minimax'), true);
  assert.equal(usesAnthropicTransport('openai'), false);
  assert.equal(usesAnthropicTransport('openrouter'), false);
});
