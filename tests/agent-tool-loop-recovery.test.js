import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { toolHandlers } from '../src/tools/index.js';

function toolTurn(id, url) {
  const call = {
    id,
    type: 'function',
    function: { name: 'webfetch', arguments: JSON.stringify({ url }) },
  };
  return {
    type: 'tool_calls',
    tool_calls: [call],
    message: { role: 'assistant', content: '', tool_calls: [call] },
  };
}

function config(extra = {}) {
  return {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    verifyAfterEdit: false,
    ...extra,
  };
}

test('duplicate-only tool batch forces a final text-only turn', async () => {
  const original = toolHandlers.webfetch;
  toolHandlers.webfetch = async () => 'page content';
  try {
    let turn = 0;
    const routedTools = [];
    const client = {
      async turn(_messages, tools) {
        turn++;
        routedTools.push(tools.map(tool => tool.function.name));
        if (turn <= 2) return toolTurn(`call_${turn}`, 'https://example.com/page');
        assert.equal(tools.length, 0);
        return { type: 'text', content: 'Final answer from earlier result.' };
      },
    };
    const emitter = new EventEmitter();
    const recoveries = [];
    emitter.on('loopRecovery', event => recoveries.push(event));
    const agent = new Agent(client, config());
    const answer = await agent.run('read this online page', emitter);
    assert.equal(answer, 'Final answer from earlier result.');
    assert.equal(turn, 3);
    assert.equal(routedTools[2].length, 0);
    assert.equal(recoveries[0].reason, 'duplicate_tools');
  } finally {
    toolHandlers.webfetch = original;
  }
});

test('read-only batch budget prevents endlessly varied web calls', async () => {
  const original = toolHandlers.webfetch;
  toolHandlers.webfetch = async ({ url }) => `content from ${url}`;
  try {
    let turn = 0;
    const client = {
      async turn(_messages, tools) {
        turn++;
        if (turn <= 2) return toolTurn(`call_${turn}`, `https://example.com/page-${turn}`);
        assert.equal(tools.length, 0);
        return { type: 'text', content: 'Research summary.' };
      },
    };
    const agent = new Agent(client, config({ maxReadOnlyToolBatches: 2 }));
    assert.equal(await agent.run('research online', new EventEmitter()), 'Research summary.');
    assert.equal(turn, 3);
  } finally {
    toolHandlers.webfetch = original;
  }
});

test('last iteration is reserved for a final answer without tools', async () => {
  const original = toolHandlers.webfetch;
  toolHandlers.webfetch = async ({ url }) => `content from ${url}`;
  try {
    let turn = 0;
    const client = {
      async turn(_messages, tools) {
        turn++;
        if (turn < 3) return toolTurn(`call_${turn}`, `https://example.com/${turn}`);
        assert.equal(tools.length, 0);
        return { type: 'text', content: 'Budget-safe final answer.' };
      },
    };
    const agent = new Agent(client, config({ maxReadOnlyToolBatches: 20 }));
    agent.maxIterations = 3;
    assert.equal(await agent.run('research online', new EventEmitter()), 'Budget-safe final answer.');
    assert.equal(turn, 3);
  } finally {
    toolHandlers.webfetch = original;
  }
});
