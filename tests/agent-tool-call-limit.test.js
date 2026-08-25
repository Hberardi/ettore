import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';

function makeAgent(config = {}) {
  // Trivial client that returns text immediately — the test exercises the
  // tool-call limiter on the iteration loop, not model behavior.
  const client = { async turn() { return { type: 'text', content: 'ok' }; } };
  return new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    ...config,
  });
}

test('Agent: default maxToolCallsPerTurn is 80 (raised from the old 40)', () => {
  const agent = makeAgent();
  assert.equal(agent.maxToolCallsPerTurn, 80);
});

test('Agent: maxToolCallsPerTurn is configurable via config', () => {
  const agent = makeAgent({ maxToolCallsPerTurn: 25 });
  assert.equal(agent.maxToolCallsPerTurn, 25);
});

test('Agent: non-numeric or zero maxToolCallsPerTurn falls back to default', () => {
  assert.equal(makeAgent({ maxToolCallsPerTurn: 0 }).maxToolCallsPerTurn, 80);
  assert.equal(makeAgent({ maxToolCallsPerTurn: 'oops' }).maxToolCallsPerTurn, 80);
  assert.equal(makeAgent({ maxToolCallsPerTurn: null }).maxToolCallsPerTurn, 80);
});

test('Agent: a model that keeps calling tools past the budget is stopped with a helpful error', async () => {
  // Client emits a batch of 5 tool-calls in a single turn; limit is set to 4
  // so the very first batch already overflows. This client ignores the empty
  // tool list it gets for the recovery turn and keeps calling tools, which is
  // what turns the soft landing into a hard stop.
  const client = {
    async turn() {
      return {
        type: 'tool_calls',
        tool_calls: [
          { id: 'c1', function: { name: 'read', arguments: '{}' } },
          { id: 'c2', function: { name: 'read', arguments: '{}' } },
          { id: 'c3', function: { name: 'read', arguments: '{}' } },
          { id: 'c4', function: { name: 'read', arguments: '{}' } },
          { id: 'c5', function: { name: 'read', arguments: '{}' } },
        ],
        message: { role: 'assistant', content: '', tool_calls: [] },
      };
    },
  };
  const agent = new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    maxToolCallsPerTurn: 4,
  });

  // Stub the tool execution so the limiter trips before any actual tool runs.
  agent._executeToolCall = async () => ({ output: 'ok' });

  const emitter = new EventEmitter();
  const errors = [];
  const states = [];
  const recoveries = [];
  emitter.on('error', (msg) => errors.push(msg));
  emitter.on('turnState', (s) => states.push(s));
  emitter.on('loopRecovery', (r) => recoveries.push(r));

  const result = await agent.run('do thing', emitter);
  // The budget is only fatal on the second breach: the first one asks the
  // model to wrap up.
  assert.ok(recoveries.some((r) => r.reason === 'tool_call_limit'));
  // Should NOT have completed normally — should return undefined when limited.
  assert.equal(result, undefined);
  assert.equal(errors.length, 1);
  const err = errors[0];
  // Message must contain the limit, the attempted count, the call names, and
  // a hint about how to raise the limit.
  assert.match(err, /Tool-call limit reached for this turn \(4\)/);
  assert.match(err, /5 tool-calls/);
  assert.match(err, /maxToolCallsPerTurn/);
  assert.match(err, /\.ettore\/config\.json/);
  // Turn should be marked failed.
  assert.ok(states.some((s) => s && s.state === 'failed'));
});


test('Agent: exhausting the tool-call budget lands the turn instead of losing the work', async () => {
  // First batch overflows the budget; on the recovery turn the model complies
  // and answers in prose. The turn must complete with that answer — the whole
  // point is that up to `limit` tool calls of real work are not thrown away.
  let calls = 0;
  const client = {
    async turn() {
      calls++;
      if (calls === 1) {
        return {
          type: 'tool_calls',
          tool_calls: [
            { id: 'c1', function: { name: 'read', arguments: '{}' } },
            { id: 'c2', function: { name: 'read', arguments: '{}' } },
            { id: 'c3', function: { name: 'read', arguments: '{}' } },
            { id: 'c4', function: { name: 'read', arguments: '{}' } },
            { id: 'c5', function: { name: 'read', arguments: '{}' } },
          ],
          message: { role: 'assistant', content: '', tool_calls: [] },
        };
      }
      return { type: 'text', content: 'Ecco cosa ho trovato finora.' };
    },
  };
  const agent = new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    maxToolCallsPerTurn: 4,
  });
  agent._executeToolCall = async () => ({ output: 'ok' });

  const emitter = new EventEmitter();
  const errors = [];
  const states = [];
  const recoveries = [];
  emitter.on('error', (msg) => errors.push(msg));
  emitter.on('turnState', (s) => states.push(s));
  emitter.on('loopRecovery', (r) => recoveries.push(r));

  const result = await agent.run('do thing', emitter);
  assert.equal(result, 'Ecco cosa ho trovato finora.');
  assert.deepEqual(errors, []);
  assert.ok(recoveries.some((r) => r.reason === 'tool_call_limit'));
  assert.ok(!states.some((s) => s && s.state === 'failed'));
});
