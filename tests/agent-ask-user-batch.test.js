import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { uiBridge } from '../src/tools/bridge.js';

test('Agent matches every tool_call_id when ask_user appears with sibling tools', async () => {
  const turns = [];
  const client = {
    async turn(messages) {
      turns.push(messages.map(m => ({
        role: m.role,
        tool_call_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : '[complex]',
      })));

      if (turns.length === 1) {
        const ask = {
          id: 'call_ask_1',
          function: {
            name: 'ask_user',
            arguments: JSON.stringify({ question: 'Proceed?', options: ['yes', 'no'] }),
          },
        };
        const write = {
          id: 'call_write_1',
          function: {
            name: 'write',
            arguments: JSON.stringify({ file_path: '/tmp/x.txt', content: 'x' }),
          },
        };
        return {
          type: 'tool_calls',
          tool_calls: [ask, write],
          message: { role: 'assistant', content: '', tool_calls: [ask, write] },
        };
      }

      const toolMsgs = messages.filter(m => m.role === 'tool');
      assert.equal(toolMsgs.length, 2);
      assert.equal(toolMsgs[0].tool_call_id, 'call_ask_1');
      assert.equal(toolMsgs[1].tool_call_id, 'call_write_1');
      assert.match(String(toolMsgs[1].content), /Deferred:/);
      return { type: 'text', content: 'done' };
    },
  };

  const handler = ({ resolve }) => resolve('yes');
  uiBridge.on('askUser', handler);
  try {
    const agent = new Agent(client, {
      provider: 'test',
      model: 'gpt-4o',
      modelCapability: 'full',
      workdir: process.cwd(),
      contextWindow: 128000,
    }, 'build');

    const result = await agent.run('modifica il progetto', new EventEmitter());
    assert.equal(result, 'done');
    assert.equal(turns.length, 2);
  } finally {
    uiBridge.off('askUser', handler);
  }
});
