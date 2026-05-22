import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getToolTimeoutMs } from '../src/agents/index.js';

test('getToolTimeoutMs defines bounded timeouts for tool execution', () => {
  assert.equal(getToolTimeoutMs('read'), 20_000);
  assert.equal(getToolTimeoutMs('write'), 20_000);
  assert.equal(getToolTimeoutMs('edit'), 20_000);
  assert.equal(getToolTimeoutMs('grep'), 60_000);
  assert.equal(getToolTimeoutMs('webfetch'), 120_000);
  assert.equal(getToolTimeoutMs('bash'), 300_000);
  assert.equal(getToolTimeoutMs('ask_user'), 0);
});
