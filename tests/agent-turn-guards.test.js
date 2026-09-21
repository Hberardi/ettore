import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { toolHandlers } from '../src/tools/index.js';

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

function agentFor(client, extra = {}) {
  return new Agent(client, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
    ...extra,
  }, 'build');
}

function collect(emitter, name) {
  const seen = [];
  emitter.on(name, value => seen.push(value));
  return seen;
}

test('a response that keeps streaming outlives the idle timeout', async () => {
  const agent = agentFor({
    async turn(_messages, _tools, onToken) {
      let text = '';
      // 400ms in all, never more than 40ms between chunks.
      for (let i = 0; i < 10; i++) {
        await sleep(40);
        onToken?.(`part${i} `);
        text += `part${i} `;
      }
      return { type: 'text', content: text };
    },
  }, { turnIdleTimeoutMs: 150 });
  const emitter = new EventEmitter();
  const errors = collect(emitter, 'error');
  const result = await agent.run('scrivi una risposta lunga', emitter);
  assert.deepEqual(errors, []);
  assert.match(String(result), /part9/);
});

test('a provider that goes silent is still cut off', async () => {
  const agent = agentFor({
    async turn(_messages, _tools, onToken, signal) {
      onToken?.('start ');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2000);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
      });
      return { type: 'text', content: 'too late' };
    },
  }, { turnIdleTimeoutMs: 120 });
  const emitter = new EventEmitter();
  const errors = collect(emitter, 'error');
  const startedAt = Date.now();
  await agent.run('rispondi', emitter);
  assert.ok(Date.now() - startedAt < 1500, 'the idle timeout must fire long before the provider returns');
  assert.ok(errors.some(e => /timeout|no progress/i.test(String(e?.message || e))), `expected a timeout error, got ${JSON.stringify(errors)}`);
});

test('ask_user without a question is refused before it reaches the user', async () => {
  const original = toolHandlers.ask_user;
  let asked = 0;
  toolHandlers.ask_user = async () => { asked++; return 'answer'; };
  try {
    let turns = 0;
    let toolResult = null;
    const agent = agentFor({
      async turn(messages) {
        turns++;
        if (turns === 1) {
          const tc = { id: 'q1', type: 'function', function: { name: 'ask_user', arguments: '{}' } };
          return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
        }
        toolResult = messages.find(m => m.role === 'tool' && m.tool_call_id === 'q1')?.content;
        return { type: 'text', content: 'Ok.' };
      },
    });
    await agent.run('chiedimi qualcosa', new EventEmitter());
    assert.equal(asked, 0);
    assert.match(String(toolResult), /question/i);
  } finally {
    toolHandlers.ask_user = original;
  }
});

test('a failed edit neither touches the file nor moves the workspace revision', async () => {
  const original = toolHandlers.edit;
  toolHandlers.edit = async () => 'Error: old_string not found in file';
  try {
    let turns = 0;
    const agent = agentFor({
      async turn() {
        turns++;
        if (turns === 1) {
          const tc = {
            id: 'e1',
            type: 'function',
            function: { name: 'edit', arguments: JSON.stringify({ file_path: 'src/nowhere.js', old_string: 'a', new_string: 'b' }) },
          };
          return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
        }
        return { type: 'text', content: 'Non sono riuscito a modificare il file.' };
      },
    });
    const emitter = new EventEmitter();
    const gates = collect(emitter, 'releaseGate');
    await agent.run('modifica src/nowhere.js', emitter);
    const memory = agent.getWorkingMemorySnapshot();
    assert.equal(memory.workspaceRevision, 0);
    assert.deepEqual(gates, [], 'nothing changed, so there is nothing for the release gate to check');
  } finally {
    toolHandlers.edit = original;
  }
});
