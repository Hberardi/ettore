import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeToolHandler } from '../src/agents/tool-executor.js';

test('tool executor retries transient failures and reports progress', async () => {
  let calls = 0;
  const progress = [];
  const result = await executeToolHandler({
    name: 'read',
    args: { file_path: 'a.js' },
    handler: async () => (++calls < 3 ? 'Error: timed out' : 'contents'),
    signal: null,
    executeWithTimeout: async (_name, fn) => fn(null),
    isTransientError: output => output === 'Error: timed out',
    wait: async () => {},
    onProgress: event => progress.push(event),
  });

  assert.deepEqual(result, { output: 'contents', retries: 2 });
  assert.equal(calls, 3);
  assert.deepEqual(progress.map(event => event.key), ['a.js', 'a.js']);
});

test('tool executor returns handler errors and unknown tools as tool output', async () => {
  const executeWithTimeout = async (_name, fn) => fn(null);
  const base = {
    name: 'read', args: {}, signal: null, executeWithTimeout,
    isTransientError: () => false, wait: async () => {},
  };

  assert.deepEqual(await executeToolHandler({ ...base }), { output: 'Unknown tool: read', retries: 0 });
  assert.deepEqual(await executeToolHandler({
    ...base,
    handler: async () => { throw new Error('broken'); },
  }), { output: 'Error: broken', retries: 0 });
});
