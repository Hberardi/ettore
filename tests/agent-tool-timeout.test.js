import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeToolWithTimeout, getToolTimeoutMs } from '../src/agents/index.js';

test('getToolTimeoutMs defines bounded timeouts for tool execution', () => {
  assert.equal(getToolTimeoutMs('read'), 20_000);
  assert.equal(getToolTimeoutMs('write'), 20_000);
  assert.equal(getToolTimeoutMs('edit'), 20_000);
  assert.equal(getToolTimeoutMs('grep'), 60_000);
  assert.equal(getToolTimeoutMs('webfetch'), 120_000);
  assert.equal(getToolTimeoutMs('bash'), 300_000);
  assert.equal(getToolTimeoutMs('ask_user'), 0);
});

test('executeToolWithTimeout aborts the per-tool signal on timeout', async () => {
  let aborted = false;
  const output = await executeToolWithTimeout('read', (signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => {
      aborted = true;
      resolve('stopped');
    }, { once: true });
  }), null, 20);

  assert.match(output, /^Error: tool "read" timed out/);
  assert.equal(aborted, true);
});

test('executeToolWithTimeout propagates parent cancellation', async () => {
  const controller = new AbortController();
  const promise = executeToolWithTimeout('read', (signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve('stopped'), { once: true });
  }), controller.signal, 1000);

  controller.abort(new Error('cancelled by user'));
  assert.equal(await promise, 'Error: tool "read" aborted');
});
