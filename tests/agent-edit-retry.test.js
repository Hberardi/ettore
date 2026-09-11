import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';

test('Agent retries with tools when a build request gets code-only text first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-agent-'));
  try {
    const target = join(dir, 'hello.txt');
    let turns = 0;
    const client = {
      async turn(messages) {
        turns++;
        if (turns === 1) {
          return {
            type: 'text',
            content: '```txt\nok\n```',
          };
        }
        if (turns === 2) {
          const last = messages[messages.length - 1];
          assert.equal(last.role, 'user');
          assert.match(String(last.content || ''), /real workspace changes/i, 'expected the workspace-edit retry overlay as the trailing message');
          assert.doesNotMatch(String(messages[0].content || ''), /TURN RECOVERY OVERLAY/, 'the overlay must not touch the cached system prompt');
          const toolCall = {
            id: 'call_write_1',
            function: {
              name: 'write',
              arguments: JSON.stringify({ file_path: target, content: 'ok\n' }),
            },
          };
          return {
            type: 'tool_calls',
            tool_calls: [toolCall],
            message: { role: 'assistant', content: '', tool_calls: [toolCall] },
          };
        }
        return {
          type: 'text',
          content: 'File creato.',
        };
      },
    };

    const agent = new Agent(client, {
      provider: 'test',
      model: 'gpt-4o',
      modelCapability: 'full',
      workdir: dir,
      contextWindow: 128000,
      verifyAfterEdit: false,
    }, 'build');
    const emitter = new EventEmitter();

    const result = await agent.run('crea il file hello.txt con contenuto ok', emitter);
    assert.equal(await readFile(target, 'utf-8'), 'ok\n');
    assert.equal(turns, 3);
    assert.match(String(result), /File creato/);
  } finally {
    // The agent's memory writes into <workdir>/.ettore are fire-and-forget and
    // can land after run() resolves, so a plain rm races them with ENOTEMPTY.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('a model that keeps announcing gets a second, escalated nudge', async () => {
  // The exact shape from the failing session: tools run, then the turn ends on
  // "Piano: … / Prossimo passo: …". One retry used to be all there was, so
  // every announcement after the first ended the run in silence.
  let turns = 0;
  const overlays = [];
  const client = {
    async turn(messages) {
      turns++;
      const last = messages[messages.length - 1];
      const text = last?.role === 'user' ? String(last.content || '') : '';
      overlays.push(text.startsWith('TURN RECOVERY OVERLAY') ? text : '');
      return {
        type: 'text',
        content: 'Piano: Trovare i punti di codice rilevanti\nProssimo passo: cerco "\\.kw-"',
      };
    },
  };

  const agent = new Agent(client, {
    provider: 'minimax',
    model: 'MiniMax-M3',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    verifyAfterEdit: false,
  }, 'build');
  const emitter = new EventEmitter();
  const stalls = [];
  emitter.on('announcementStall', info => stalls.push(info));

  await agent.run('affina la ricerca', emitter);

  assert.equal(turns, 3, 'one initial turn plus two retries');
  assert.match(overlays[1], /did not perform it/i, 'first retry uses the standard nudge');
  assert.match(overlays[2], /two turns in a row/i, 'second retry must escalate, not repeat');
  assert.match(overlays[2], /Prossimo passo: cerco/, 'the escalation quotes the announcement back');

  assert.equal(stalls.length, 1, 'the user must be told why the run stopped');
  assert.equal(stalls[0].attempts, 2);
});

test('an announcement followed by real work does not warn', async () => {
  const target = join(tmpdir(), `ettore-announce-${Date.now()}.txt`);
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      if (turns === 1) return { type: 'text', content: 'Ora creo il file.' };
      if (turns === 2) {
        const call = {
          id: 'call_w1',
          function: { name: 'write', arguments: JSON.stringify({ file_path: target, content: 'ok\n' }) },
        };
        return { type: 'tool_calls', tool_calls: [call], message: { role: 'assistant', content: '', tool_calls: [call] } };
      }
      return { type: 'text', content: 'Creato.' };
    },
  };
  const agent = new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: tmpdir(),
    contextWindow: 128000,
    verifyAfterEdit: false,
  }, 'build');
  const emitter = new EventEmitter();
  const stalls = [];
  emitter.on('announcementStall', info => stalls.push(info));

  const answer = await agent.run('crea il file', emitter);
  assert.equal(answer, 'Creato.');
  assert.equal(stalls.length, 0, 'a model that acts after the nudge must not be flagged');
  await rm(target, { force: true });
});
