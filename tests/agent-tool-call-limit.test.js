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

test('Agent: a model that keeps calling tools past the budget ends the turn with what it has, and advice', async () => {
  // Client emits a batch of 5 tool-calls in a single turn; limit is set to 4
  // so the very first batch already overflows. This client ignores the empty
  // tool list it gets for the landing turn and keeps calling tools. That used
  // to end on a red "Tool-call limit reached" error; the work is kept either
  // way, so the turn now closes normally and says why and what to do next.
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
  assert.ok(recoveries.some((r) => r.reason === 'tool_call_limit'));
  assert.deepEqual(errors, [], 'using the budget is not an error');
  assert.match(result, /tutte le 4 chiamate di tool/);
  assert.match(result, /maxToolCallsPerTurn": 8/, 'a big task is told how to get more room');
  assert.match(result, /\.ettore\/config\.json/);
  assert.ok(states.some((s) => s && s.state === 'completed'));
  assert.ok(!states.some((s) => s && s.state === 'failed'));
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

test('Agent: a turn that spends its budget on one command is called a loop, not a big task', async () => {
  const call = (id) => ({ id, function: { name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } });
  const client = {
    async turn() {
      const calls = [call('a'), call('b')];
      return { type: 'tool_calls', tool_calls: calls, message: { role: 'assistant', content: '', tool_calls: calls } };
    },
  };
  const agent = agentWithClient(client, { maxToolCallsPerTurn: 4, maxIterations: 8 });
  agent._getAllToolHandlers = () => ({ bash: async () => 'ok' });

  const result = await agent.run('lancia i test', new EventEmitter());

  assert.match(result, /ripetuta \d+ volte: bash \(npm test\)/);
  assert.match(result, /un limite più alto lo allungherebbe soltanto/);
  assert.match(result, /Il lavoro già eseguito è conservato/);
  assert.doesNotMatch(result, /maxToolCallsPerTurn/, 'raising the limit is the wrong advice for a loop');
});

test('Agent: repeats from earlier turns and todo bookkeeping are not a loop', async () => {
  // The report that prompted this: a turn that edited six templates hit the
  // budget and was told "the same call ran 5 times: todo_write (set)" — five
  // plans set across the whole session, blamed on this turn as a loop.
  let n = 0;
  const client = {
    async turn() {
      n++;
      const calls = [
        { id: `t${n}`, function: { name: 'todo_write', arguments: JSON.stringify({ action: 'set', items: ['a', 'b'] }) } },
        { id: `r${n}`, function: { name: 'bash', arguments: JSON.stringify({ command: `echo step ${n}` }) } },
      ];
      return { type: 'tool_calls', tool_calls: calls, message: { role: 'assistant', content: '', tool_calls: calls } };
    },
  };
  const agent = agentWithClient(client, { maxToolCallsPerTurn: 12, maxIterations: 20 });
  agent._getAllToolHandlers = () => ({ bash: async () => 'ok', todo_write: async () => 'ok' });
  // What an earlier turn left in the session-wide registry.
  for (let i = 0; i < 5; i++) await agent._recordToolExecution('bash', { command: 'npm test' }, 'ok');

  const result = await agent.run('rifai i template', new EventEmitter());

  assert.doesNotMatch(result, /loop/i, result);
  assert.match(result, /maxToolCallsPerTurn/, 'a big task is advised to get more room');
  assert.match(result, /\(12 tool completati\)|\(\d+ tool completati\)/);
  assert.doesNotMatch(result, /\(1[7-9] tool completati\)/, 'earlier turns are not counted as this turn\'s work');
});
