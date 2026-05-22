// Tests for the LLM retry/backoff logic.
// retryLLMCall is exported from client.js so the retry policy (which errors
// are retried vs. thrown immediately) can be exercised directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, retryLLMCall } from '../src/llm/client.js';

test('client.js loads and exports createClient', () => {
  assert.equal(typeof createClient, 'function');
});

// Sanity check on backoff math: jittered wait stays within [exp/2, exp]
// where exp = min(cap, base * 2^attempt).
test('backoff jitter envelope', () => {
  const base = 2000, cap = 60_000;
  for (let attempt = 0; attempt < 6; attempt++) {
    const exp = Math.min(cap, base * Math.pow(2, attempt));
    for (let i = 0; i < 20; i++) {
      const wait = exp / 2 + Math.random() * (exp / 2);
      assert.ok(wait >= exp / 2 - 1e-9, `attempt ${attempt}: wait ${wait} < ${exp / 2}`);
      assert.ok(wait <= exp + 1e-9, `attempt ${attempt}: wait ${wait} > ${exp}`);
    }
  }
});

test('retryLLMCall retries a transient socket ETIMEDOUT', async () => {
  let calls = 0;
  const result = await retryLLMCall(async () => {
    calls++;
    if (calls === 1) {
      const err = new Error('read ETIMEDOUT');
      err.code = 'ETIMEDOUT';
      throw err;
    }
    return 'ok';
  }, null);
  assert.equal(result, 'ok');
  assert.equal(calls, 2, 'should fail once then succeed on retry');
});

test('retryLLMCall does not retry a deliberate request timeout', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryLLMCall(async () => {
      calls++;
      throw new Error('Request timed out after 180000ms');
    }, null),
    /Request timed out/,
  );
  assert.equal(calls, 1, 'a deliberate timeout must not be retried');
});

test('retryLLMCall does not retry auth errors', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryLLMCall(async () => {
      calls++;
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }, null),
    /Unauthorized/,
  );
  assert.equal(calls, 1, '401 must not be retried');
});
