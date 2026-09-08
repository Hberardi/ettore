// A 429 used to be silent: retryLLMCall waits with backoff — up to minutes on
// four attempts — and nothing reached the UI, so the CLI looked frozen and the
// error that followed told the user to retry what had already been retried.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryLLMCall, setRetryNotifier } from '../src/llm/client.js';
import { translateProviderError } from '../src/agents/error-translator.js';

function httpError(status, message = 'boom', headers = undefined) {
  const err = new Error(message);
  err.status = status;
  if (headers) err.headers = headers;
  return err;
}

test('each backoff is announced before the wait, with its attempt number', async () => {
  const seen = [];
  setRetryNotifier(info => seen.push(info));
  try {
    let calls = 0;
    const result = await retryLLMCall(async () => {
      calls++;
      if (calls < 3) throw httpError(429, 'rate limited', { 'retry-after': '0' });
      return 'ok';
    }, null);

    assert.equal(result, 'ok');
    const waits = seen.filter(s => s.phase === 'waiting');
    assert.equal(waits.length, 2, JSON.stringify(seen));
    assert.deepEqual(waits.map(w => w.attempt), [1, 2]);
    assert.equal(waits[0].status, 429);
    assert.equal(waits[0].maxRetries, 4);
    assert.equal(waits[0].fromServer, true, 'Retry-After must be reported as the server-set wait');
  } finally {
    setRetryNotifier(null);
  }
});

test('a recovery after retries is announced too, so the pause is explained', async () => {
  const seen = [];
  setRetryNotifier(info => seen.push(info));
  try {
    let calls = 0;
    await retryLLMCall(async () => {
      if (++calls < 2) throw httpError(429, 'x', { 'retry-after': '0' });
      return 'ok';
    }, null);
    assert.deepEqual(seen.at(-1), { phase: 'recovered', attempt: 1 });
  } finally {
    setRetryNotifier(null);
  }
});

test('a call that never failed announces nothing', async () => {
  const seen = [];
  setRetryNotifier(info => seen.push(info));
  try {
    assert.equal(await retryLLMCall(async () => 'fine', null), 'fine');
    assert.deepEqual(seen, [], 'a clean call must not push noise into the transcript');
  } finally {
    setRetryNotifier(null);
  }
});

test('exhaustion reports how many attempts were spent', async () => {
  const seen = [];
  setRetryNotifier(info => seen.push(info));
  try {
    await assert.rejects(
      () => retryLLMCall(async () => { throw httpError(429, 'nope', { 'retry-after': '0' }); }, null),
      /nope/,
    );
    const done = seen.find(s => s.phase === 'exhausted');
    assert.ok(done, JSON.stringify(seen));
    assert.equal(done.attempts, 5, '4 retries after the first attempt');
  } finally {
    setRetryNotifier(null);
  }
});

test('a notifier that throws never breaks the retry', async () => {
  setRetryNotifier(() => { throw new Error('UI exploded'); });
  try {
    let calls = 0;
    const out = await retryLLMCall(async () => {
      if (++calls < 2) throw httpError(429, 'x', { 'retry-after': '0' });
      return 'survived';
    }, null);
    assert.equal(out, 'survived');
  } finally {
    setRetryNotifier(null);
  }
});

test('clearing the notifier stops the notices', async () => {
  const seen = [];
  setRetryNotifier(info => seen.push(info));
  setRetryNotifier(null);
  let calls = 0;
  await retryLLMCall(async () => {
    if (++calls < 2) throw httpError(429, 'x', { 'retry-after': '0' });
    return 'ok';
  }, null);
  assert.deepEqual(seen, []);
});

// ─── The message the user actually reads ─────────────────────────────────────

test('an exhausted balance is not reported as something waiting will fix', () => {
  // Anthropic's own "credit balance is too low" is deliberately absent: it is
  // matched earlier by the Claude-plan branch, which gives better advice for a
  // subscription than a generic top-up message would.
  for (const msg of [
    'insufficient balance',
    'MiniMax error: {"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}',
    'You exceeded your current quota: insufficient_quota',
    'billing hard limit reached',
  ]) {
    const out = translateProviderError({ status: 429, message: msg });
    assert.match(out, /will not clear|usage page/i, `wrong advice for: ${msg}\ngot: ${out}`);
    assert.ok(!/wait a moment/i.test(out), `told the user to wait for a balance: ${out}`);
  }
});

test('a plain rate limit says the retries already happened', () => {
  const out = translateProviderError({ status: 429, message: 'Too Many Requests' });
  assert.match(out, /already retried/i, out);
  assert.match(out, /per-minute/i, out);
  assert.match(out, /\/use/, 'the user needs the escape hatch named');
});

test('the Claude plan ceiling still takes priority over the generic 429', () => {
  const out = translateProviderError({ status: 429, message: 'usage limit reached' });
  assert.match(out, /Claude plan usage limit/i, out);
});

test('other statuses are untouched', () => {
  assert.match(translateProviderError({ status: 401, message: 'unauthorized' }), /Authentication failed/);
});
