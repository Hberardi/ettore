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
