import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeToolTurn,
  repairMessageHistory,
  safeHistoryKeepStart,
  validateMessageHistory,
} from '../src/agents/message-ledger.js';

test('message ledger accepts a complete ordered tool exchange', () => {
  const messages = [
    { role: 'user', content: 'read it' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'body' },
  ];
  assert.deepEqual(validateMessageHistory(messages), { valid: true, issues: [] });
});

test('message ledger detects orphaned and out-of-order tool results', () => {
  const messages = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'a', function: { name: 'read', arguments: '{}' } },
        { id: 'b', function: { name: 'grep', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'b', content: 'second' },
    { role: 'tool', tool_call_id: 'a', content: 'first' },
    { role: 'tool', tool_call_id: 'orphan', content: 'bad' },
  ];
  const result = validateMessageHistory(messages);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.code === 'tool_result_mismatch'));
  assert.ok(result.issues.some(issue => issue.code === 'orphan_tool_result'));
});

test('repairMessageHistory removes unmatched calls and restores strict order', () => {
  const messages = [
    { role: 'system', content: 'system' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'a', function: { name: 'read', arguments: '{}' } },
        { id: 'b', function: { name: 'grep', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'b', content: 'second' },
    { role: 'tool', tool_call_id: 'orphan', content: 'bad' },
  ];
  const result = repairMessageHistory(messages);
  assert.equal(result.repaired, true);
  assert.equal(result.valid, true);
  assert.deepEqual(result.messages[1].tool_calls.map(call => call.id), ['b']);
  assert.equal(result.messages[2].tool_call_id, 'b');
  assert.equal(result.messages.some(message => message.tool_call_id === 'orphan'), false);
});

test('canonicalizeToolTurn repairs missing and duplicate ids', () => {
  const result = canonicalizeToolTurn({
    tool_calls: [
      { function: { name: 'read', arguments: '{}' } },
      { id: 'same', function: { name: 'grep', arguments: '{}' } },
      { id: 'same', function: { name: 'glob', arguments: '{}' } },
    ],
    message: { content: null },
  });
  assert.equal(result.calls.length, 3);
  assert.equal(new Set(result.calls.map(call => call.id)).size, 3);
  assert.ok(result.issues.some(issue => issue.code === 'missing_tool_call_id'));
  assert.ok(result.issues.some(issue => issue.code === 'duplicate_tool_call_id'));
});

test('safeHistoryKeepStart never starts inside tool results', () => {
  const messages = [
    { role: 'user', content: 'old' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'a', function: { name: 'read', arguments: '{}' } },
        { id: 'b', function: { name: 'grep', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'a', content: 'a' },
    { role: 'tool', tool_call_id: 'b', content: 'b' },
    { role: 'assistant', content: 'done' },
  ];
  assert.equal(safeHistoryKeepStart(messages, 2), 1);
});
