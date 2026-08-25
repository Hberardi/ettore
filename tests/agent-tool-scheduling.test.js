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

test('Agent runs exploration after repo_map, then parallelizes the remaining reads', async () => {
  const originals = {
    repo_map: toolHandlers.repo_map,
    grep: toolHandlers.grep,
    file_info: toolHandlers.file_info,
  };
  const events = [];
  const delay = (ms) => new Promise(resolve => {
    setTimeout(resolve, ms);
  });

  toolHandlers.repo_map = async () => {
    events.push(['repo_map:start', Date.now()]);
    await delay(25);
    events.push(['repo_map:end', Date.now()]);
    return 'map';
  };
  toolHandlers.grep = async () => {
    events.push(['grep:start', Date.now()]);
    await delay(25);
    events.push(['grep:end', Date.now()]);
    return 'grep';
  };
  toolHandlers.file_info = async () => {
    events.push(['file_info:start', Date.now()]);
    await delay(25);
    events.push(['file_info:end', Date.now()]);
    return 'info';
  };

  try {
    let turns = 0;
    const client = {
      async turn(messages) {
        turns++;
        if (turns === 1) {
          const repoMap = {
            id: 'm1', type: 'function',
            function: { name: 'repo_map', arguments: '{}' },
          };
          const grep = {
            id: 'g1', type: 'function',
            function: { name: 'grep', arguments: JSON.stringify({ pattern: 'needle' }) },
          };
          const fileInfo = {
            id: 'f1', type: 'function',
            function: { name: 'file_info', arguments: JSON.stringify({ path: '.' }) },
          };
          const calls = [repoMap, grep, fileInfo];
          return { type: 'tool_calls', tool_calls: calls, message: { role: 'assistant', content: '', tool_calls: calls } };
        }
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

    const emitter = new EventEmitter();
    const waves = [];
    emitter.on('toolWaveStart', event => waves.push(['start', event.index, event.tools.map(tool => tool.name)]));
    emitter.on('toolWaveEnd', event => waves.push(['end', event.index, event.tools.map(tool => tool.name)]));
    const result = await agent.run('inspect the repository', emitter);
    assert.equal(result, 'done');
    const at = new Map(events);
    assert.ok(at.get('repo_map:end') <= at.get('grep:start'));
    assert.ok(at.get('repo_map:end') <= at.get('file_info:start'));
    assert.ok(Math.abs(at.get('grep:start') - at.get('file_info:start')) < 15);
    assert.deepEqual(waves, [
      ['start', 0, ['repo_map']],
      ['end', 0, ['repo_map']],
      ['start', 1, ['grep', 'file_info']],
      ['end', 1, ['grep', 'file_info']],
    ]);
  } finally {
    toolHandlers.repo_map = originals.repo_map;
    toolHandlers.grep = originals.grep;
    toolHandlers.file_info = originals.file_info;
  }
});
