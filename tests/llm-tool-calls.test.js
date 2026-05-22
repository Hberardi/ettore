import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiCompatibleTurn } from '../src/llm/client.js';

test('openaiCompatibleTurn accumulates streamed tool_calls across delta chunks', async () => {
  const fakeClient = {
    chat: {
      completions: {
        async create() {
          // Streaming response: the tool name/id and the JSON arguments arrive
          // in separate delta chunks, keyed by tool_calls[].index.
          return (async function* () {
            yield {
              choices: [
                {
                  finish_reason: null,
                  delta: {
                    content: '',
                    tool_calls: [
                      { index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: '' } },
                    ],
                  },
                },
              ],
            };
            yield {
              choices: [
                {
                  finish_reason: null,
                  delta: {
                    tool_calls: [
                      { index: 0, function: { arguments: '{"file_path":"/tmp/example.txt",' } },
                    ],
                  },
                },
              ],
            };
            yield {
              choices: [
                {
                  finish_reason: 'stop',
                  delta: {
                    tool_calls: [
                      { index: 0, function: { arguments: '"content":"hello"}' } },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
          })();
        },
      },
    },
  };

  const result = await openaiCompatibleTurn(
    fakeClient,
    'test-model',
    [{ role: 'user', content: 'create a file' }],
    [{ type: 'function', function: { name: 'write', description: 'write', parameters: { type: 'object' } } }],
    () => {},
    undefined,
  );

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.tool_calls[0].function.name, 'write');
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), {
    file_path: '/tmp/example.txt',
    content: 'hello',
  });
  assert.equal(result.message.tool_calls[0].id, 'call_1');
});
