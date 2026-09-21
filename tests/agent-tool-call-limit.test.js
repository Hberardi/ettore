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
          { id: 'c1', function: { name: 'bash', arguments: '{"command":"echo 1"}' } },
          { id: 'c2', function: { name: 'bash', arguments: '{"command":"echo 2"}' } },
          { id: 'c3', function: { name: 'bash', arguments: '{"command":"echo 3"}' } },
          { id: 'c4', function: { name: 'bash', arguments: '{"command":"echo 4"}' } },
          { id: 'c5', function: { name: 'bash', arguments: '{"command":"echo 5"}' } },
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
            { id: 'c1', function: { name: 'bash', arguments: '{"command":"echo 1"}' } },
            { id: 'c2', function: { name: 'bash', arguments: '{"command":"echo 2"}' } },
            { id: 'c3', function: { name: 'bash', arguments: '{"command":"echo 3"}' } },
            { id: 'c4', function: { name: 'bash', arguments: '{"command":"echo 4"}' } },
            { id: 'c5', function: { name: 'bash', arguments: '{"command":"echo 5"}' } },
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

test('Agent: identical reads in one batch run once and do not exhaust the tool budget', async () => {
  let reads = 0;
  let turns = 0;
  const calls = Array.from({ length: 6 }, (_, index) => ({
    id: `read-${index}`,
    function: { name: 'read', arguments: JSON.stringify({ file_path: '/tmp/repeated.js', offset: 0, limit: 20 }) },
  }));
  const client = {
    async turn(messages) {
      turns++;
      if (turns === 1) {
        return { type: 'tool_calls', tool_calls: calls, message: { role: 'assistant', content: '', tool_calls: calls } };
      }
      const toolMessages = messages.filter(message => message.role === 'tool');
      assert.equal(toolMessages.length, 6, 'every provider tool call must still receive a result');
      assert.equal(toolMessages.filter(message => /Skipped duplicate read call/.test(String(message.content))).length, 5);
      return { type: 'text', content: 'done' };
    },
  };
  const agent = agentWithClient(client, { maxToolCallsPerTurn: 1, verifyAfterEdit: false });
  agent._getAllToolHandlers = () => ({ read: async () => { reads++; return 'file contents'; } });

  const errors = [];
  const emitter = new EventEmitter();
  emitter.on('error', error => errors.push(error));
  assert.equal(await agent.run('read the file', emitter), 'done');
  assert.equal(reads, 1);
  assert.deepEqual(errors, []);
});

// Agent with a client of our own — the helper above always answers in prose,
// which is the opposite of what a tool-loop test needs.
function agentWithClient(client, config = {}) {
  return new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    ...config,
  });
}

// 83 shell calls in one turn is what sent a real session into the hard stop.
// Only `read` had a repeat budget, so an identical command could run until the
// per-turn ceiling caught it — by which point the turn was already lost.
test('Agent: a command repeated with nothing changed in between is refused early', async () => {
  let ran = 0;
  const call = { id: 'b1', function: { name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) } };
  const client = {
    async turn() {
      return { type: 'tool_calls', tool_calls: [call], message: { role: 'assistant', content: '', tool_calls: [call] } };
    },
  };
  const agent = agentWithClient(client, { maxIterations: 8 });
  agent._getAllToolHandlers = () => ({ bash: async () => { ran++; return 'total 0'; } });

  const emitter = new EventEmitter();
  const outputs = [];
  emitter.on('toolEnd', ({ output }) => outputs.push(String(output)));

  await agent.run('guarda la cartella', emitter);

  assert.equal(ran, 3, 'the shell command runs up to its budget, not once per iteration');
  assert.ok(outputs.some(o => /already ran 3 times/.test(o)), `expected a refusal telling the model why: ${outputs.slice(-1)}`);
});

test('Agent: the hard stop names the repeated command instead of advising a bigger budget', async () => {
  const call = (id) => ({ id, function: { name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } });
  const client = {
    async turn() {
      const calls = [call('a'), call('b')];
      return { type: 'tool_calls', tool_calls: calls, message: { role: 'assistant', content: '', tool_calls: calls } };
    },
  };
  const agent = agentWithClient(client, { maxToolCallsPerTurn: 4, maxIterations: 8 });
  agent._getAllToolHandlers = () => ({ bash: async () => 'ok' });

  const emitter = new EventEmitter();
  const errors = [];
  emitter.on('error', (msg) => errors.push(msg));

  await agent.run('lancia i test', emitter);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /The same call ran \d+ times: bash \(npm test\)/);
  assert.match(errors[0], /a bigger budget would only make it longer/);
  assert.match(errors[0], /Il lavoro già eseguito è conservato/);
  assert.doesNotMatch(errors[0], /maxToolCallsPerTurn/, 'raising the limit is the wrong advice for a loop');
});
