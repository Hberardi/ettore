import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateProviderError, stripAnsi } from '../src/agents/error-translator.js';

test('stripAnsi removes CSI escape sequences', () => {
  assert.equal(stripAnsi('hello \x1b[31mred\x1b[0m'), 'hello red');
});

test('translateProviderError handles 429 via status', () => {
  const msg = translateProviderError({ status: 429, message: 'too many requests' });
  assert.match(msg, /Rate limit/);
});

test('translateProviderError handles 401', () => {
  const msg = translateProviderError({ status: 401, message: 'unauthorized' });
  assert.match(msg, /Authentication failed/);
});

test('translateProviderError handles 503', () => {
  const msg = translateProviderError({ statusCode: 503, message: 'down' });
  assert.match(msg, /Provider unavailable/);
});

test('translateProviderError handles ECONNREFUSED in message', () => {
  const msg = translateProviderError({ message: 'connect ECONNREFUSED 127.0.0.1:80' });
  assert.match(msg, /Connection refused/);
});

test('translateProviderError handles ETIMEDOUT in message', () => {
  const msg = translateProviderError({ message: 'socket ETIMEDOUT' });
  assert.match(msg, /timed out/);
});

test('translateProviderError handles ECONNRESET', () => {
  const msg = translateProviderError({ message: 'ECONNRESET' });
  assert.match(msg, /Connection reset/);
});

test('translateProviderError strips ANSI from raw message', () => {
  const msg = translateProviderError({ message: '\x1b[31merror happened\x1b[0m' });
  assert.equal(msg, 'error happened');
});

test('translateProviderError passes through unknown errors', () => {
  const msg = translateProviderError({ message: 'something else' });
  assert.equal(msg, 'something else');
});

test('translateProviderError handles tool schema 400', () => {
  const msg = translateProviderError({ status: 400, message: 'invalid tool definition' });
  assert.match(msg, /tool schema/);
});

test('translateProviderError distinguishes mismatched tool-call history from schema errors', () => {
  const msg = translateProviderError({
    status: 400,
    message: 'invalid params, tool call and result not match (2013)',
  });
  assert.match(msg, /mismatched tool-call history/i);
  assert.doesNotMatch(msg, /tool schema/i);
});
