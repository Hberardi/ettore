import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';

test('Agent does not replay rejected exploration tool calls without results', async () => {
  const turns = [];
  const grepCall = {
    id: 'call_grep_1',
    type: 'function',
    function: {
      name: 'grep',
      arguments: JSON.stringify({ pattern: 'needle', path: '.' }),
    },
  };
  const repoMapCall = {
    id: 'call_repo_map_1',
    type: 'function',
    function: {
      name: 'repo_map',
      arguments: '{}',
    },
  };

  const client = {
    async turn(messages) {
      turns.push(messages.map(message => structuredClone(message)));

      if (turns.length === 1) {
        return {
          type: 'tool_calls',
          tool_calls: [grepCall],
          message: { role: 'assistant', content: '', tool_calls: [grepCall] },
        };
      }

      if (turns.length === 2) {
        const orphanedCall = messages.find(message =>
          message.role === 'assistant' &&
          message.tool_calls?.some(call => call.id === grepCall.id)
        );
        assert.equal(orphanedCall, undefined);
        assert.match(messages[0].content, /call repo_map first/i);
        return {
          type: 'tool_calls',
          tool_calls: [repoMapCall],
          message: { role: 'assistant', content: '', tool_calls: [repoMapCall] },
        };
      }

      const repoMapResult = messages.find(message =>
        message.role === 'tool' && message.tool_call_id === repoMapCall.id
      );
      assert.ok(repoMapResult);
      return { type: 'text', content: 'done' };
    },
  };

  const agent = new Agent(client, {
    provider: 'minimax',
    model: 'MiniMax-M3',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    verifyAfterEdit: false,
  }, 'build');

  const result = await agent.run('inspect the repository', new EventEmitter());

  assert.equal(result, 'done');
  assert.equal(turns.length, 3);
});
