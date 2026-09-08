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
  // Only when they did — the count comes from the client, not from a guess.
  const out = translateProviderError({ status: 429, message: 'Too Many Requests' }, { retriesSpent: 4 });
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

// ─── Not everything containing "429" is a rate limit ─────────────────────────
// Reported from a real session: a turn failed with the rate-limit message and
// the user said "that is not true, there is some problem". They were right —
// /429/ matched the digits anywhere in the provider's text, and the message
// then replaced the only evidence there was with a confident description of
// something that had not happened.

test('a bare number in prose is not read as a status code', () => {
  for (const msg of [
    'model minimax-429b is not available',
    'context length 429000 exceeds the limit',
    'request id 8f429c21 failed',
    'unexpected token at offset 429',
    'read ECONNRESET after 4294 bytes',
  ]) {
    const out = translateProviderError({ message: msg });
    assert.ok(!/rate limit/i.test(out), `misread as a rate limit: ${msg}\n  → ${out}`);
  }
});

test('a real status is still recognised, however it is written', () => {
  for (const err of [
    { status: 429, message: 'nope' },
    { message: 'HTTP 429 returned by upstream' },
    { message: 'status_code: 429' },
    { message: '429 Too Many Requests' },
    { message: 'Rate limit exceeded for this key' },
  ]) {
    assert.match(translateProviderError(err), /rate limit/i, JSON.stringify(err));
  }
});

test('the message only claims to have retried when it actually did', () => {
  const err = { status: 429, message: 'slow down' };

  const noRetries = translateProviderError(err);
  assert.ok(!/already retried/i.test(noRetries), `claimed a retry that never happened: ${noRetries}`);

  const withRetries = translateProviderError(err, { retriesSpent: 4 });
  assert.match(withRetries, /already retried 4 time/i);
});

test('an inferred classification keeps the provider text, so a wrong guess is visible', () => {
  // No status code: the classification came from the words alone, and if that
  // reading is wrong the user still needs what the provider actually said.
  const out = translateProviderError({ message: 'Rate limit exceeded: org quota 5/min' });
  assert.match(out, /provider said: Rate limit exceeded: org quota 5\/min/);

  // With a real status there is nothing to second-guess, so no echo.
  assert.ok(!/provider said/.test(translateProviderError({ status: 429, message: 'x' })));
});

test('the other statuses are just as strict about bare digits', () => {
  assert.ok(!/Authentication failed/.test(translateProviderError({ message: 'token 401abc rejected by policy' })));
  assert.ok(!/gateway/i.test(translateProviderError({ message: 'chunk 502 of 900 written' })));
  assert.match(translateProviderError({ message: 'HTTP 401 Unauthorized' }), /Authentication failed/);
  assert.match(translateProviderError({ message: '502 Bad Gateway' }), /gateway error/i);
});

test('an unclassifiable error is returned as the provider wrote it', () => {
  assert.equal(translateProviderError({ message: 'something entirely new' }), 'something entirely new');
});
