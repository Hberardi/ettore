import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';

function makeAgent(client) {
  return new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
  }, 'build');
}

test('Agent auto-continues when a <todo> plan has unfinished steps', async () => {
  let turns = 0;
  const client = {
    async turn(messages) {
      turns++;
      if (turns === 1) {
        return {
          type: 'text',
          content: '<todo>\n1. Step A\n2. Step B\n3. Step C\n</todo>\n<done:1>\nFatto il primo.',
        };
      }
      const system = messages[0]?.content || '';
      assert.match(String(system), /auto-continue 1\/30/i);
      assert.match(String(system), /Step B/);
      assert.match(String(system), /Step C/);
      return { type: 'text', content: '<done:2>\n<done:3>\nFatto tutto.' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const events = [];
  emitter.on('autoContinue', (info) => events.push(info));

  const result = await agent.run('Fai i 3 step', emitter);
  assert.equal(turns, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].remaining, 2);
  assert.match(String(result), /Fatto tutto/);
});

test('Agent does NOT auto-continue when all <todo> steps are marked done', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      return {
        type: 'text',
        content: '<todo>\n1. A\n2. B\n</todo>\n<done:1>\n<done:2>\nTutto fatto.',
      };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const events = [];
  emitter.on('autoContinue', (info) => events.push(info));

  await agent.run('Fai A e B', emitter);
  assert.equal(turns, 1);
  assert.equal(events.length, 0);
});

test('Agent does NOT auto-continue on a markdown numbered list (only explicit <todo>)', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      return {
        type: 'text',
        content: '1. Prima cosa\n2. Seconda cosa\n3. Terza cosa\n\nQueste sono le mie osservazioni.',
      };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const events = [];
  emitter.on('autoContinue', (info) => events.push(info));

  await agent.run('Elenca tre cose', emitter);
  assert.equal(turns, 1);
  assert.equal(events.length, 0);
});

test('Agent caps auto-continues at maxAutoContinues to avoid runaway', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      return {
        type: 'text',
        content: '<todo>\n1. A\n2. B\n</todo>\nNon finisco mai.',
      };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const events = [];
  emitter.on('autoContinue', (info) => events.push(info));

  const exhausted = [];
  emitter.on('autoContinueExhausted', info => exhausted.push(info));

  await agent.run('Fai A e B', emitter);
  // This model repeats the same plan forever: nothing is ever marked done, no
  // file is touched, no tool runs. The cap is therefore never reached — the
  // stall detector stops one turn earlier, after a single escalated nudge.
  assert.equal(turns, 3);
  assert.equal(events.length, 2);
  assert.equal(events[1].attempt, 2);
  assert.equal(events[1].stalled, true);
  assert.equal(exhausted[0]?.reason, 'no_progress');
});

test('Agent forces a retry when the model announces an action but never executes it', async () => {
  let turns = 0;
  const client = {
    async turn(messages) {
      turns++;
      if (turns === 1) {
        // Classic stall: pure prose announcing actions, no tool calls.
        return {
          type: 'text',
          content: 'Piano: Applicare le modifiche richieste\nProssimo passo: scrivo /tmp/foo.py\nOra creo il form padre con il menu Visualizza:',
        };
      }
      // The retry must inject a system overlay before re-asking the model.
      const sysNudge = messages.find(m => m.role === 'system' && /announced an action/i.test(String(m.content || '')));
      assert.ok(sysNudge, 'expected a nudge after the announcement stall');
      return { type: 'text', content: 'Fatto.' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  await agent.run('continua', emitter);
  assert.equal(turns, 2);
});

test('Agent retries a short diagnostic announcement instead of ending the turn', async () => {
  let turns = 0;
  const client = {
    async turn(messages) {
      turns++;
      if (turns === 1) return { type: 'text', content: 'Diagnostico subito.' };
      const nudge = messages.find(m => m.role === 'system' && /announced an action/i.test(String(m.content || '')));
      assert.ok(nudge, 'expected a nudge after the diagnostic announcement');
      return { type: 'text', content: 'Ho trovato il problema.' };
    },
  };

  const agent = makeAgent(client);
  await agent.run('L\'app non funziona', new EventEmitter());
  assert.equal(turns, 2);
});

test('Agent does NOT retry when the model uses a write tool (announcement followed by execution)', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      if (turns === 1) {
        return {
          type: 'tool_calls',
          tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/ettore-test-no-retry.txt', content: 'ok' }) } }],
          message: { role: 'assistant', content: 'Ora scrivo il file.', tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/ettore-test-no-retry.txt', content: 'ok' }) } }] },
        };
      }
      return { type: 'text', content: 'Fatto.' };
    },
  };

  // Disable the post-edit verify guard — this test focuses on the announcement
  // retry, not on debug/verify (covered separately in tests/verify-after-edit.test.js).
  const agent = new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    verifyAfterEdit: false,
  }, 'build');
  const emitter = new EventEmitter();
  await agent.run('scrivi un file', emitter);
  // turn 1 (write tool) + turn 2 (final text) — no extra retry turn
  assert.equal(turns, 2);
});

test('Agent aborts after consecutive invalid tool calls (MiniMax loop guard)', async () => {
  let turns = 0;
  const overlays = [];
  const client = {
    async turn(messages) {
      turns++;
      overlays.push(String(messages[0]?.content || ''));
      // Always return an invalid tool_call: read with empty args
      return {
        type: 'tool_calls',
        tool_calls: [{ id: `tu_${turns}`, type: 'function', function: { name: 'read', arguments: '{}' } }],
        message: { role: 'assistant', content: null, tool_calls: [{ id: `tu_${turns}`, type: 'function', function: { name: 'read', arguments: '{}' } }] },
      };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const errors = [];
  emitter.on('error', (msg) => errors.push(msg));

  await agent.run('Leggi il file', emitter);
  // 3 consecutive invalid tool batches → abort
  assert.equal(turns, 3);
  assert.equal(errors.length, 1);
  // Turn 1: invalid → "invalid_tool_call" overlay pushed into the system prompt
  // before turn 2's client call. So the system prompt seen by the client on
  // turn 2 contains the warning.
  assert.match(overlays[1], /last tool call batch was invalid/i);
  // Turn 2: still invalid → upgrade to "tool_loop_finalize" overlay (force
  // text-only for the next turn). The system prompt seen by the client on
  // turn 3 reflects this gentler nudge.
  assert.match(overlays[2], /respond in prose without calling more tools/i);
  // Final error after the 3rd invalid batch.
  assert.match(errors[0], /argomenti vuoti o non validi/);
});

test('a stalled auto-continue escalates once, then stops with an explanation', async () => {
  // The model declares a plan, marks nothing done, and never touches a file or
  // calls a tool — so every retry starts from exactly the same state. Repeating
  // the identical nudge three times is what left the CLI looking frozen on an
  // announcement it never acted on.
  let turns = 0;
  const overlays = [];
  const client = {
    async turn(messages) {
      turns++;
      overlays.push(String(messages[0]?.content || ''));
      if (turns === 1) {
        return { type: 'text', content: '<todo>\n1. Step A\n2. Step B\n3. Step C\n</todo>\nInizio.' };
      }
      return { type: 'text', content: 'Prossimo passo: leggo app.py' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const attempts = [];
  const exhausted = [];
  emitter.on('autoContinue', info => attempts.push(info));
  emitter.on('autoContinueExhausted', info => exhausted.push(info));

  await agent.run('Fai i 3 step', emitter);

  // First retry uses the normal nudge; the second sees an unchanged state and
  // escalates; there is no third, because nothing is changing.
  assert.equal(attempts.length, 2, `expected 2 attempts, got ${JSON.stringify(attempts)}`);
  assert.equal(attempts[0].stalled, false);
  assert.equal(attempts[1].stalled, true);
  assert.ok(
    overlays.some(o => /produced no progress/i.test(o)),
    'the second retry must escalate to a different nudge, not repeat the first',
  );

  assert.equal(exhausted.length, 1, 'the user must be told why the run stopped');
  assert.equal(exhausted[0].reason, 'no_progress');
  assert.equal(exhausted[0].remaining, 3);
  assert.deepEqual(exhausted[0].pending, ['1. Step A', '2. Step B', '3. Step C']);
});

test('auto-continue keeps going while the model is still making progress', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      if (turns === 1) return { type: 'text', content: '<todo>\n1. A\n2. B\n3. C\n</todo>\nVia.' };
      if (turns === 2) return { type: 'text', content: '<done:1>\nFatto A.' };
      if (turns === 3) return { type: 'text', content: '<done:2>\nFatto B.' };
      return { type: 'text', content: '<done:3>\nFatto C.' };
    },
  };
  const emitter = new EventEmitter();
  const exhausted = [];
  emitter.on('autoContinueExhausted', info => exhausted.push(info));
  const agent = makeAgent(client);
  const answer = await agent.run('Fai i 3 step', emitter);

  assert.equal(answer, 'Fatto C.');
  assert.equal(turns, 4, 'progress on every turn must never be mistaken for a stall');
  assert.equal(exhausted.length, 0, 'a completed plan must not warn about open steps');
});
