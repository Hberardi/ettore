import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';

test('Agent preserves tool result order when a malformed tool call precedes a valid one', async () => {
  const turns = [];
  const client = {
    async turn(messages) {
      turns.push(messages.map(m => ({
        role: m.role,
        tool_call_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : '[complex]',
      })));

      if (turns.length === 1) {
        const badRead = {
          id: 'call_bad_1',
          function: {
            name: 'read',
            arguments: '{"file_path":',
          },
        };
        const goodRepoMap = {
          id: 'call_repo_1',
          function: {
            name: 'repo_map',
            arguments: '{}',
          },
        };
        return {
          type: 'tool_calls',
          tool_calls: [badRead, goodRepoMap],
          message: { role: 'assistant', content: '', tool_calls: [badRead, goodRepoMap] },
        };
      }

      const toolMsgs = messages.filter(m => m.role === 'tool');
      assert.equal(toolMsgs.length, 2);
      assert.equal(toolMsgs[0].tool_call_id, 'call_bad_1');
      assert.equal(toolMsgs[1].tool_call_id, 'call_repo_1');
      assert.match(String(toolMsgs[0].content), /malformed tool call JSON/i);
      return { type: 'text', content: 'done' };
    },
  };

  const agent = new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
  }, 'build');

  const result = await agent.run('inspect the repo', new EventEmitter());
  assert.equal(result, 'done');
  assert.equal(turns.length, 2);
});
