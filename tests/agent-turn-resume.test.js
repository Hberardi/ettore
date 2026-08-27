import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';

function makeAgent(client, config = {}) {
  return new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    ...config,
  }, 'build');
}

test('Agent resumes a reply the provider cut off at max_tokens', async () => {
  let turns = 0;
  const client = {
    async turn(messages) {
      turns++;
      if (turns === 1) {
        return { type: 'text', content: 'Ho aggiornato il primo file e ora sto scriv', finishReason: 'length' };
      }
      const system = String(messages[0]?.content || '');
      assert.match(system, /cut off by the output token limit/i);
      assert.match(system, /resume 1\/3/i);
      return { type: 'text', content: 'endo il secondo. Fatto.' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const events = [];
  emitter.on('outputTruncated', info => events.push(info));

  const result = await agent.run('Aggiorna i due file', emitter);
  assert.equal(turns, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].attempt, 1);
  assert.match(String(result), /endo il secondo/);
});

test('Agent stops resuming a truncated reply once the budget runs out', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      return { type: 'text', content: `frammento ${turns}`, finishReason: 'length' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const events = [];
  emitter.on('outputTruncated', info => events.push(info));

  await agent.run('Scrivi qualcosa di lunghissimo', emitter);
  // Three resumes, then the fourth truncated reply is accepted as the answer.
  assert.equal(events.length, 3);
  assert.equal(turns, 4);
});

test('Agent leaves a normal finish_reason alone', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      return { type: 'text', content: 'Risposta breve.', finishReason: 'stop' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  let truncated = 0;
  emitter.on('outputTruncated', () => { truncated++; });

  await agent.run('Domanda semplice', emitter);
  assert.equal(turns, 1);
  assert.equal(truncated, 0);
});

test('Agent auto-continues a markdown plan once the turn has actually run tools', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      if (turns === 1) {
        return {
          type: 'tool_calls',
          // Not an exploration tool: those get bounced by the repo_map-first
          // nudge, which never reaches the tool counter.
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"file_path":"package.json","limit":1}' } }],
          message: { role: 'assistant', content: '' },
        };
      }
      if (turns === 2) {
        return {
          type: 'text',
          content: '1. Leggere la configurazione\n2. Aggiornare le dipendenze\n3. Lanciare i test',
        };
      }
      return { type: 'text', content: '<done:1>\n<done:2>\n<done:3>\nOra è tutto sistemato.' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const events = [];
  emitter.on('autoContinue', info => events.push(info));

  await agent.run('Controlla la configurazione', emitter);
  assert.equal(events.length, 1);
  assert.equal(events[0].remaining, 3);
  assert.equal(turns, 3);
});

test('Agent does NOT auto-continue a markdown list from a turn that ran nothing', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      return {
        type: 'text',
        content: 'I tre modi sono:\n1. Con npm\n2. Con pnpm\n3. Con yarn',
      };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const events = [];
  emitter.on('autoContinue', info => events.push(info));

  await agent.run('In quanti modi posso installarlo?', emitter);
  assert.equal(events.length, 0);
  assert.equal(turns, 1);
});

test('Agent does NOT auto-continue when the model declared the task complete', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      return {
        type: 'text',
        content: '<todo>\n1. A\n2. B\n</todo>\n<done:1>\nHo finito, il resto non serviva.',
      };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const events = [];
  emitter.on('autoContinue', info => events.push(info));

  await agent.run('Fai A e B', emitter);
  assert.equal(events.length, 0);
  assert.equal(turns, 1);
});

test('A "continua" prompt keeps the previous plan instead of wiping it', async () => {
  const seenSystems = [];
  let turns = 0;
  const client = {
    async turn(messages) {
      turns++;
      seenSystems.push(String(messages[0]?.content || ''));
      if (turns === 1) {
        return { type: 'text', content: '<todo>\n1. Primo passo\n2. Secondo passo\n</todo>\n<done:1>\nPrimo passo chiuso.' };
      }
      return { type: 'text', content: 'Sto ancora lavorando.' };
    },
  };

  // One auto-continue per turn, so the first run ends with step 2 still open.
  const agent = makeAgent(client, { maxAutoContinues: 1 });
  const first = new EventEmitter();
  const firstEvents = [];
  first.on('autoContinue', info => firstEvents.push(info));
  await agent.run('Fai i due passi', first);
  assert.equal(firstEvents.length, 1);

  const second = new EventEmitter();
  const secondEvents = [];
  second.on('autoContinue', info => secondEvents.push(info));
  await agent.run('continua', second);

  // The plan survived the continuation prompt, so the resumed turn had
  // something to auto-continue against.
  assert.equal(secondEvents.length, 1);
  assert.equal(secondEvents[0].remaining, 1);
  assert.match(seenSystems[seenSystems.length - 1], /Secondo passo/);
});

test('A fresh, unrelated prompt still clears the previous plan', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      if (turns === 1) {
        return { type: 'text', content: '<todo>\n1. Primo passo\n2. Secondo passo\n</todo>\n<done:1>\nPrimo passo chiuso.' };
      }
      return { type: 'text', content: 'Ecco la risposta.' };
    },
  };

  const agent = makeAgent(client, { maxAutoContinues: 1 });
  const first = new EventEmitter();
  await agent.run('Fai i due passi', first);

  const second = new EventEmitter();
  const secondEvents = [];
  second.on('autoContinue', info => secondEvents.push(info));
  await agent.run('quanti file ci sono nel repo?', second);
  assert.equal(secondEvents.length, 0);
});
