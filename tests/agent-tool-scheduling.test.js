import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { toolHandlers } from '../src/tools/index.js';

test('Agent runs mutation-dependent tool batches sequentially', async () => {
  const originalWrite = toolHandlers.write;
  const originalRead = toolHandlers.read;
  let fileValue = 'old';
  const seen = [];

  toolHandlers.write = async () => {
    seen.push('write:start');
    await new Promise(resolve => {
      setTimeout(resolve, 25);
    });
    fileValue = 'new';
    seen.push('write:end');
    return 'ok write';
  };

  toolHandlers.read = async () => {
    seen.push(`read:${fileValue}`);
    return fileValue;
  };

  try {
    let turns = 0;
    const client = {
      async turn(messages) {
        turns++;
        if (turns === 1) {
          const write = {
            id: 'w1',
            type: 'function',
            function: { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/fake.txt', content: 'new' }) },
          };
          const read = {
            id: 'r1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ file_path: '/tmp/fake.txt' }) },
          };
          return { type: 'tool_calls', tool_calls: [write, read], message: { role: 'assistant', content: '', tool_calls: [write, read] } };
        }

        const toolMessages = messages.filter(m => m.role === 'tool');
        assert.equal(toolMessages.length, 2);
        assert.equal(String(toolMessages[1].content), 'new');
        return { type: 'text', content: 'done' };
      },
    };

    const agent = new Agent(client, {
      provider: 'test',
      model: 'gpt-4o',
      modelCapability: 'full',
      workdir: process.cwd(),
      contextWindow: 128000,
      verifyAfterEdit: false,
    }, 'build');

    const result = await agent.run('update file then read it', new EventEmitter());
    assert.equal(result, 'done');
    assert.deepEqual(seen, ['write:start', 'write:end', 'read:new']);
  } finally {
    toolHandlers.write = originalWrite;
    toolHandlers.read = originalRead;
  }
});
