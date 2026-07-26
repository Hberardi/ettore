import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agents/index.js';
import { validateMessageHistory } from '../src/agents/message-ledger.js';

function makeEmitter() {
  const emitter = new EventEmitter();
  const errors = [];
  const states = [];
  emitter.on('error', error => errors.push(String(error)));
  emitter.on('turnState', event => states.push(event.state));
  return { emitter, errors, states };
}

function agentConfig(workdir, extra = {}) {
  return {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir,
    contextWindow: 128000,
    verifyAfterEdit: false,
    dynamicToolRouting: true,
    maxToolsPerRequest: 16,
    ...extra,
  };
}

test('eval: stale orphaned tool history is repaired before provider dispatch', async () => {
  let calls = 0;
  const client = {
    async turn(messages) {
      calls++;
      assert.equal(validateMessageHistory(messages).valid, true);
      assert.equal(messages.some(message => message.tool_calls?.some(call => call.id === 'orphan')), false);
      return { type: 'text', content: 'history repaired' };
    },
  };
  const agent = new Agent(client, agentConfig(process.cwd()), 'build');
  agent.messages.push({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'orphan', function: { name: 'read', arguments: '{}' } }],
  });

  const { emitter, errors } = makeEmitter();
  const result = await agent.run('continue', emitter);

  assert.equal(result, 'history repaired');
  assert.equal(calls, 1);
  assert.deepEqual(errors, []);
  assert.equal(agent.getWorkingMemorySnapshot().ledgerRepairs, 1);
});

test('eval: edit request receives a compact relevant tool set', async () => {
  let routed = [];
  const client = {
    async turn(_messages, tools) {
      routed = tools.map(tool => tool.function.name);
      return { type: 'text', content: 'Nessuna modifica necessaria.' };
    },
  };
  const agent = new Agent(client, agentConfig(process.cwd()), 'build');
  const { emitter } = makeEmitter();
  await agent.run('modifica il parser e verifica i test', emitter);

  assert.ok(routed.length <= 16);
  assert.ok(routed.length < 28);
  for (const name of ['read', 'write', 'edit', 'run_checks', 'run_tests']) {
    assert.ok(routed.includes(name), `missing routed tool: ${name}`);
  }
  assert.equal(routed.includes('video_transcript'), false);
});

test('eval: safe profile blocks an external write and keeps history valid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ettore-eval-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'ettore-eval-outside-'));
  const target = join(outside, 'blocked.txt');
  let turns = 0;
  try {
    const client = {
      async turn(messages) {
        turns++;
        if (turns === 1) {
          const call = {
            id: 'write_external',
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({ file_path: target, content: 'nope' }),
            },
          };
          return {
            type: 'tool_calls',
            tool_calls: [call],
            message: { role: 'assistant', content: '', tool_calls: [call] },
          };
        }
        assert.equal(validateMessageHistory(messages).valid, true);
        const toolResult = messages.find(message => message.tool_call_id === 'write_external');
        assert.match(String(toolResult?.content), /safe workspace policy/i);
        return { type: 'text', content: 'write blocked' };
      },
    };
    const agent = new Agent(client, agentConfig(root, { safetyProfile: 'safe' }), 'build');
    const { emitter, states } = makeEmitter();
    const result = await agent.run('scrivi un file esterno', emitter);

    assert.equal(result, 'write blocked');
    await assert.rejects(access(target));
    assert.deepEqual(states, ['started', 'model', 'tool_call', 'tool_result', 'model', 'completed']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('eval: duplicate provider tool ids are canonicalized into a valid exchange', async () => {
  let turns = 0;
  const client = {
    async turn(messages) {
      turns++;
      if (turns === 1) {
        const first = {
          id: 'duplicate',
          type: 'function',
          function: { name: 'git_status', arguments: JSON.stringify({ workdir: process.cwd() }) },
        };
        const second = {
          ...first,
          function: { name: 'git_diff', arguments: JSON.stringify({ workdir: process.cwd() }) },
        };
        return {
          type: 'tool_calls',
          tool_calls: [first, second],
          message: { role: 'assistant', content: '', tool_calls: [first, second] },
        };
      }
      assert.equal(validateMessageHistory(messages).valid, true);
      const assistant = messages.find(message => Array.isArray(message.tool_calls));
      assert.equal(new Set(assistant.tool_calls.map(call => call.id)).size, 2);
      return { type: 'text', content: 'canonicalized' };
    },
  };
  const agent = new Agent(client, agentConfig(process.cwd()), 'build');
  const { emitter, errors } = makeEmitter();
  const result = await agent.run('controlla git status e diff', emitter);

  assert.equal(result, 'canonicalized');
  assert.deepEqual(errors, []);
});
