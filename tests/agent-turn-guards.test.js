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

test('the invalid-tool-args retry ends the turn out loud, not in silence', async () => {
  // The retry deliberately stops the turn and leaves a nudge in history for
  // the next prompt. It used to do that without emitting anything, so the TUI
  // never learned the turn was over: it stayed "running" with the last tool
  // frozen on screen for the rest of the session.
  const providerRejection = Object.assign(
    new Error('invalid function arguments json string'),
    { status: 400 },
  );
  const agent = agentFor({
    async turn() { throw providerRejection; },
  });
  const emitter = new EventEmitter();
  const terminal = [];
  for (const name of ['complete', 'error', 'cancelled']) {
    emitter.on(name, payload => terminal.push({ name, payload }));
  }
  const states = collect(emitter, 'turnState');

  const result = await agent.run('leggi tmp/launch_wine.sh', emitter);

  assert.equal(terminal.length, 1, `exactly one terminal event, got ${JSON.stringify(terminal.map(t => t.name))}`);
  assert.equal(terminal[0].name, 'complete');
  assert.match(String(result), /tool call/i);
  assert.ok(
    states.some(s => s.state === 'completed'),
    'the turn state must reach a terminal value too',
  );
  // The nudge is left where the next prompt will pick it up.
  assert.ok(agent.messages.some(m => m.role === 'user' && /JSON/i.test(String(m.content || ''))));
});

test('every run() that returns has emitted a terminal event first', async () => {
  // A sweep over the ordinary shapes a turn can take. The point is the
  // invariant, not any one of them: the UI unfreezes on these events, so a
  // path that returns without one strands the session.
  const cases = {
    'plain answer': { async turn() { return { type: 'text', content: 'Ecco.' }; } },
    'provider throws': { async turn() { throw new Error('connessione persa'); } },
    'empty tool batch': {
      async turn() {
        return { type: 'tool_calls', tool_calls: [], message: { role: 'assistant', content: '', tool_calls: [] } };
      },
    },
  };
  for (const [label, client] of Object.entries(cases)) {
    const emitter = new EventEmitter();
    const terminal = [];
    for (const name of ['complete', 'error', 'cancelled']) emitter.on(name, () => terminal.push(name));
    await agentFor(client).run('fai qualcosa', emitter);
    assert.ok(terminal.length >= 1, `"${label}" returned without a terminal event`);
  }
});

test('a provider that reports the cancel in its own words is a cancel, not an error', async () => {
  // The OpenAI client throws `APIUserAbortError: Request was aborted.` when the
  // signal fires. That fell through to the generic error path, so the stall
  // watchdog's own explanation was followed by a second red line saying only
  // "Error: Request was aborted.".
  let agent;
  const client = {
    async turn() {
      agent.cancel();
      const error = new Error('Request was aborted.');
      error.name = 'APIUserAbortError';
      throw error;
    },
  };
  agent = new Agent(client, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  }, 'build');

  const emitter = new EventEmitter();
  const errors = [];
  let cancelled = 0;
  emitter.on('error', msg => errors.push(msg));
  emitter.on('cancelled', () => { cancelled++; });

  await agent.run('fai qualcosa', emitter);

  assert.equal(cancelled, 1);
  assert.deepEqual(errors, []);
});
