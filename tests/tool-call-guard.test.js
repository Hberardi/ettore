import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardToolCall, parseToolCall } from '../src/agents/tool-call-guard.js';

test('tool-call parser coerces and normalizes a valid argument object', () => {
  const result = parseToolCall({
    id: 'r1', function: { name: 'read', arguments: '{"offset":"2"}' },
  }, {
    coerceArgs: (_name, args) => ({ ...args, offset: Number(args.offset) }),
    normalizeArgs: (_name, args) => ({ ...args, path: '/workspace/a.js' }),
  });
  assert.deepEqual(result, {
    id: 'r1', name: 'read', args: { offset: 2, path: '/workspace/a.js' }, parseError: false,
  });
});

test('tool-call parser returns safe output for malformed arguments', () => {
  const result = parseToolCall({
    id: 'w1', function: { name: 'write', arguments: '{"content":' },
  });
  assert.equal(result.parseError, true);
  assert.match(result.displayError, /malformed JSON/);
  assert.match(result.output, /Raw: \{"content":/);
});

test('tool-call guard distinguishes validation and policy denials', async () => {
  const invalid = await guardToolCall({
    name: 'write', args: {},
    validate: () => ({ valid: false, error: 'Missing file_path' }),
    authorize: async () => ({ allowed: true }),
  });
  assert.deepEqual(invalid, { allowed: false, reason: 'invalid', output: 'Missing file_path' });

  const blocked = await guardToolCall({
    name: 'write', args: {},
    validate: () => ({ valid: true }),
    authorize: async () => ({ allowed: false, error: 'Blocked outside workspace' }),
  });
  assert.deepEqual(blocked, { allowed: false, reason: 'policy', output: 'Error: Blocked outside workspace' });
});
