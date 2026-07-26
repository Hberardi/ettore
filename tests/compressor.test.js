import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextCompressor, estimateTokens } from '../src/agents/compressor.js';

// A message array whose estimated token count clearly exceeds the default
// 8000-token threshold (estimateTokens counts ~4 chars per token).
function oversizedMessages() {
  const big = 'x'.repeat(40000);
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'prior summary', __compressed: true },
    { role: 'assistant', content: big },
  ];
}

test('needsCompression triggers even after a prior compression marker', () => {
  const c = new ContextCompressor(null, {});
  const messages = oversizedMessages();
  assert.ok(estimateTokens(messages) > 8000, 'fixture should exceed the threshold');
  // The __compressed marker at index 1 must not permanently disable compression.
  assert.equal(c.needsCompression(messages), true);
});

test('needsCompression stops once the per-session cap is reached', () => {
  const c = new ContextCompressor(null, {});
  c._sessionCount = 8; // MAX_COMPRESSIONS_PER_SESSION
  assert.equal(c.needsCompression(oversizedMessages()), false);
});

test('needsCompression is false for a small context', () => {
  const c = new ContextCompressor(null, {});
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ];
  assert.equal(c.needsCompression(messages), false);
});

test('estimateTokens includes tool schemas in the request budget', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const tools = [{
    type: 'function',
    function: {
      name: 'read',
      description: 'x'.repeat(400),
      parameters: { type: 'object', properties: {} },
    },
  }];
  assert.ok(estimateTokens(messages, tools) > estimateTokens(messages));
});

test('hard guard reserves output space on small context windows', () => {
  const c = new ContextCompressor(null, { contextWindow: 16000 });
  assert.equal(c.getHardGuardLimit(16000, 8192), 8000);
  assert.ok(c.getHardGuardLimit(128000, 8192) < 128000);
});
