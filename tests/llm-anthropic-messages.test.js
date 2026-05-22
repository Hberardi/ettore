import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessagesForAnthropic } from '../src/llm/client.js';

test('normalizeMessagesForAnthropic converts tool messages into user tool_result blocks', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'create file' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I should write a file', signature: 'sig' },
        { type: 'tool_use', id: 'toolu_1', name: 'write', input: { file_path: '/tmp/a.txt', content: 'x' } },
      ],
    },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'ok' },
  ];

  const normalized = normalizeMessagesForAnthropic(messages);
  assert.equal(normalized.length, 3);
  assert.deepEqual(normalized[0], {
    role: 'user',
    content: [{ type: 'text', text: 'create file' }],
  });
  assert.equal(normalized[1].role, 'assistant');
  assert.equal(normalized[2].role, 'user');
  assert.deepEqual(normalized[2].content, [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
  ]);
});

test('normalizeMessagesForAnthropic converts OpenAI-shaped tool_calls into tool_use blocks', () => {
  const messages = [
    { role: 'user', content: 'read the file' },
    {
      role: 'assistant',
      content: 'let me check',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"file_path":"/tmp/a.txt"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
  ];

  const normalized = normalizeMessagesForAnthropic(messages);
  assert.equal(normalized.length, 3);
  assert.deepEqual(normalized[1], {
    role: 'assistant',
    content: [
      { type: 'text', text: 'let me check' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { file_path: '/tmp/a.txt' } },
    ],
  });
  // The tool_result must still resolve against the tool_use id above.
  assert.deepEqual(normalized[2].content, [
    { type: 'tool_result', tool_use_id: 'call_1', content: 'file body' },
  ]);
});

test('normalizeMessagesForAnthropic tolerates tool_calls with empty/invalid arguments', () => {
  const messages = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_2', type: 'function', function: { name: 'git_status', arguments: '' } },
      ],
    },
  ];

  const normalized = normalizeMessagesForAnthropic(messages);
  assert.deepEqual(normalized[0].content, [
    { type: 'tool_use', id: 'call_2', name: 'git_status', input: {} },
  ]);
});
