import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { toolHandlers, setAgentTodoSink } from '../src/tools/index.js';

function makeAgent(client) {
  return new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
  }, 'build');
}

function mkToolCall(id, args) {
  const argsJson = JSON.stringify(args);
  return {
    id,
    type: 'function',
    function: { name: 'todo_write', arguments: argsJson },
  };
}

test('todo_write returns an error when called outside an agent run', async () => {
  setAgentTodoSink(null);
  const out = await toolHandlers.todo_write({ action: 'set', items: ['a', 'b'] });
  assert.match(String(out), /only available during an agent turn/i);
});

test('todo_write set updates agent state and emits todoList', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      if (turns === 1) {
        const tc = mkToolCall('tw_1', { action: 'set', items: ['Step uno', 'Step due', 'Step tre'] });
        return {
          type: 'tool_calls',
          tool_calls: [tc],
          message: { role: 'assistant', content: '', tool_calls: [tc] },
        };
      }
      return { type: 'text', content: '<done:1>\n<done:2>\n<done:3>\nFatto.' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const todoLists = [];
  emitter.on('todoList', (items) => todoLists.push(items));
  await agent.run('Fai tre cose', emitter);
  assert.equal(todoLists.length, 1);
  assert.deepEqual(todoLists[0], ['Step uno', 'Step due', 'Step tre']);
  assert.equal(agent._todoFromBlock, true);
});

test('todo_write complete emits todoDone for the right index', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      if (turns === 1) {
        const tc = mkToolCall('tw_set', { action: 'set', items: ['a', 'b'] });
        return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
      }
      if (turns === 2) {
        const tc = mkToolCall('tw_done', { action: 'complete', index: 1 });
        return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
      }
      if (turns === 3) {
        const tc = mkToolCall('tw_done2', { action: 'complete', index: 2 });
        return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
      }
      return { type: 'text', content: 'Tutto fatto.' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const doneIdx = [];
  emitter.on('todoDone', (i) => doneIdx.push(i));
  await agent.run('Fai a e b', emitter);
  assert.deepEqual(doneIdx, [0, 1]);
});

test('todo_write complete with out-of-range index returns an error', async () => {
  let turns = 0;
  let toolOutput = '';
  const client = {
    async turn(messages) {
      turns++;
      if (turns === 1) {
        const tc = mkToolCall('tw_set', { action: 'set', items: ['only one'] });
        return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
      }
      if (turns === 2) {
        const tc = mkToolCall('tw_bad', { action: 'complete', index: 99 });
        return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
      }
      // capture the tool result that came back
      const lastTool = [...messages].reverse().find(m => m.role === 'tool');
      toolOutput = String(lastTool?.content || '');
      return { type: 'text', content: 'ok' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  await agent.run('test', emitter);
  assert.match(toolOutput, /out of range/i);
});

test('todo_write append extends the list and re-emits todoList', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      if (turns === 1) {
        const tc = mkToolCall('tw_set', { action: 'set', items: ['a', 'b'] });
        return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
      }
      if (turns === 2) {
        const tc = mkToolCall('tw_app', { action: 'append', items: ['c'] });
        return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
      }
      return { type: 'text', content: '<done:1>\n<done:2>\n<done:3>\nfatto' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const lists = [];
  emitter.on('todoList', (items) => lists.push(items));
  await agent.run('test', emitter);
  assert.equal(lists.length, 2);
  assert.deepEqual(lists[1], ['a', 'b', 'c']);
});

test('Agent auto-continues when todos come from todo_write and are unfinished', async () => {
  let turns = 0;
  const client = {
    async turn(messages) {
      turns++;
      if (turns === 1) {
        const tc = mkToolCall('tw_set', { action: 'set', items: ['X', 'Y', 'Z'] });
        return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
      }
      if (turns === 2) {
        // Stop with text but only step 1 marked done — auto-continue should kick in.
        return { type: 'text', content: '<done:1>\nFermato qui.' };
      }
      const system = messages[0]?.content || '';
      assert.match(String(system), /auto-continue/i);
      return { type: 'text', content: '<done:2>\n<done:3>\nfatto tutto' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  const events = [];
  emitter.on('autoContinue', (info) => events.push(info));
  await agent.run('Fai X Y Z', emitter);
  assert.equal(turns, 3);
  assert.equal(events.length, 1);
});

test('todo_write set with empty items returns an error', async () => {
  let turns = 0;
  let toolOutput = '';
  const client = {
    async turn(messages) {
      turns++;
      if (turns === 1) {
        const tc = mkToolCall('tw_bad', { action: 'set', items: [] });
        return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
      }
      const lastTool = [...messages].reverse().find(m => m.role === 'tool');
      toolOutput = String(lastTool?.content || '');
      return { type: 'text', content: 'ok' };
    },
  };

  const agent = makeAgent(client);
  const emitter = new EventEmitter();
  await agent.run('test', emitter);
  assert.match(toolOutput, /at least one non-empty item/i);
});
