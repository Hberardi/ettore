import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { toolHandlers } from '../src/tools/index.js';

function makeAgent(client, extra = {}) {
  return new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    verifyAfterEdit: false,
    ...extra,
  }, 'build');
}

// The sub-agent is told what it is in its prompt; that is how a shared fake
// client tells the two loops apart.
function isSubagentTurn(messages) {
  return messages.some(m => String(m?.content || '').includes('exploration sub-agent'));
}

function exploreCall(args) {
  return {
    type: 'tool_calls',
    tool_calls: [{
      id: 'e1',
      type: 'function',
      function: { name: 'explore', arguments: JSON.stringify(args) },
    }],
  };
}

test('explore is inert outside an agent turn', async () => {
  const out = await toolHandlers.explore({ question: 'dove sta il parser?' });
  assert.match(out, /only available during an agent turn/i);
});

test('explore rejects a call with no question', async () => {
  const client = { async turn() { return { type: 'text', content: 'ok' }; } };
  const agent = makeAgent(client);
  let result = '';
  const emitter = new EventEmitter();
  emitter.on('toolEnd', info => { if (info.name === 'explore') result = String(info.output); });

  let turns = 0;
  client.turn = async () => {
    turns++;
    if (turns === 1) return exploreCall({ question: '   ' });
    return { type: 'text', content: 'chiedo meglio' };
  };
  await agent.run('capisci come funziona il parser', emitter);
  assert.match(result, /requires a "question"/i);
});

test('the sub-agent answers in its own read-only context and reports back', async () => {
  const seen = { subTools: null, subPrompt: '', parentSawReport: '' };
  let parentTurns = 0;

  const client = {
    async turn(messages, tools) {
      if (isSubagentTurn(messages)) {
        seen.subTools = (tools || []).map(t => t.function.name);
        seen.subPrompt = String(messages[messages.length - 1]?.content || '');
        return { type: 'text', content: 'Il parser sta in src/agents/stream-parser.js:25.' };
      }
      parentTurns++;
      if (parentTurns === 1) {
        return exploreCall({ question: 'dove sta il parser?', context: 'mi serve per una modifica' });
      }
      const toolMessage = messages.filter(m => m.role === 'tool').pop();
      seen.parentSawReport = String(toolMessage?.content || '');
      return { type: 'text', content: 'Trovato.' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const events = [];
  emitter.on('subagentStart', () => events.push('start'));
  emitter.on('subagentEnd', () => events.push('end'));

  const out = await agent.run('capisci come funziona il parser', emitter);

  assert.equal(out, 'Trovato.');
  assert.deepEqual(events, ['start', 'end']);
  // The question and the briefing both reach the sub-agent, which sees none of
  // the parent's conversation.
  assert.match(seen.subPrompt, /dove sta il parser\?/);
  assert.match(seen.subPrompt, /mi serve per una modifica/);
  // Read-only by construction, not by instruction.
  for (const forbidden of ['write', 'edit', 'apply_patch_structured', 'bash', 'run_tests']) {
    assert.equal(seen.subTools.includes(forbidden), false, `sub-agent was handed ${forbidden}`);
  }
  assert.ok(seen.subTools.includes('read'));
  assert.ok(seen.subTools.includes('grep'));
  // And it cannot delegate again.
  assert.equal(seen.subTools.includes('explore'), false);
  // The parent gets the answer, plus the warning that the evidence is not in
  // its own context.
  assert.match(seen.parentSawReport, /stream-parser\.js:25/);
  assert.match(seen.parentSawReport, /NOT in your conversation/);
});

test('a sub-agent run leaves the parent turn its abort signal and todo sink', async () => {
  let parentTurns = 0;
  let todoResult = '';
  const client = {
    async turn(messages) {
      if (isSubagentTurn(messages)) return { type: 'text', content: 'Sta in src/a.js:1.' };
      parentTurns++;
      if (parentTurns === 1) return exploreCall({ question: 'dove?' });
      // A nested run() clears the module-level singletons on its way out. If
      // the parent's are not put back, this call fails instead of recording.
      if (parentTurns === 2) {
        return {
          type: 'tool_calls',
          tool_calls: [{
            id: 't1',
            type: 'function',
            function: {
              name: 'todo_write',
              arguments: JSON.stringify({ action: 'set', items: ['uno', 'due'] }),
            },
          }],
        };
      }
      return { type: 'text', content: '<done:1>\n<done:2>\nFatto.' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const todoLists = [];
  emitter.on('todoList', items => todoLists.push(items));
  emitter.on('toolEnd', info => { if (info.name === 'todo_write') todoResult = String(info.output); });

  await agent.run('capisci come funziona il parser', emitter);

  assert.doesNotMatch(todoResult, /only available during an agent turn/i);
  assert.deepEqual(todoLists.at(-1), ['uno', 'due']);
});

test('a sub-agent that is working keeps the parent turn looking alive', async () => {
  // The stall watchdog counts from the moment the user pressed enter, and a
  // sub-agent's output never reaches the parent. Without a sign of life, a
  // long exploration was cancelled as a stalled turn.
  const client = {
    async turn(messages, tools, onToken) {
      if (isSubagentTurn(messages)) {
        onToken?.('sto ');
        onToken?.('cercando…');
        return { type: 'text', content: 'Sta in src/a.js:1.' };
      }
      return exploreCall({ question: 'dove sta il parser?' });
    },
  };
  const emitter = new EventEmitter();
  let alive = 0;
  emitter.on('subagentProgress', () => { alive++; });

  await makeAgent(client).run('dove sta il parser?', emitter);

  assert.ok(alive > 0, 'the parent must hear that the sub-agent is getting somewhere');
});
