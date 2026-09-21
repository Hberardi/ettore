import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { StreamMarkupParser, stripMarkers } from '../src/agents/stream-parser.js';

function recorder(extra = {}) {
  const seen = { visible: '', think: '', todos: [], plans: [], decisions: [], done: [], thinkEvents: [] };
  const parser = new StreamMarkupParser({
    onVisible: t => { seen.visible += t; },
    onThinkStart: () => seen.thinkEvents.push('start'),
    onThinkToken: t => { seen.think += t; },
    onThinkEnd: () => seen.thinkEvents.push('end'),
    onTodo: items => seen.todos.push(items),
    onPlan: block => seen.plans.push(block),
    onDecision: body => seen.decisions.push(body),
    onDone: idx => seen.done.push(idx),
    ...extra,
  });
  return { parser, seen };
}

function feed(parser, chunks) {
  for (const chunk of chunks) parser.push(chunk);
  parser.finish();
}

test('two decisions in one chunk are each reported once and neither is shown', () => {
  const { parser, seen } = recorder();
  feed(parser, ['a <decision>one</decision> b <decision>two</decision> c', ' and more', ' text']);
  assert.deepEqual(seen.decisions, ['one', 'two']);
  assert.doesNotMatch(seen.visible, /decision/);
  assert.match(seen.visible, /a {2}b {2}c and more text/);
});

test('a decision split across chunks is reported once', () => {
  const { parser, seen } = recorder();
  feed(parser, ['start <deci', 'sion>picked ', 'X</deci', 'sion> end']);
  assert.deepEqual(seen.decisions, ['picked X']);
  assert.equal(seen.visible, 'start  end');
});

test('todo, done and think markup across chunk boundaries', () => {
  const { parser, seen } = recorder();
  feed(parser, ['<th', 'ink>plan it</thi', 'nk>', '<todo>1. read\n2. ', 'edit</todo>', 'working <do', 'ne:1> ok']);
  assert.deepEqual(seen.todos, [['read', 'edit']]);
  assert.deepEqual(seen.done, [0]);
  assert.equal(seen.think, 'plan it');
  assert.deepEqual(seen.thinkEvents, ['start', 'end']);
  assert.equal(seen.visible, 'working  ok');
});

test('a todo block is taken only while the hook still wants one', () => {
  const { parser, seen } = recorder({ wantsTodo: () => false });
  feed(parser, ['<todo>1. a\n2. b</todo>']);
  assert.deepEqual(seen.todos, []);
});

test('a plan is handed over whole, and only while planning', () => {
  const planning = recorder({ wantsPlan: () => true });
  feed(planning.parser, ['<plan>{"goal":"g",', '"steps":[]}</plan>after']);
  assert.deepEqual(planning.seen.plans, ['<plan>{"goal":"g","steps":[]}</plan>']);
  assert.equal(planning.seen.visible, 'after');

  const notPlanning = recorder();
  feed(notPlanning.parser, ['<plan>x</plan>']);
  assert.deepEqual(notPlanning.seen.plans, []);
});

test('an unclosed block survives a long stream of text after its opener', () => {
  const { parser, seen } = recorder();
  parser.push('<decision>');
  for (let i = 0; i < 200; i++) parser.push(`word${i} `);
  parser.push('</decision>');
  parser.finish();
  assert.equal(seen.decisions.length, 1);
  assert.match(seen.decisions[0], /^word0 .* word199$/);
});

test('silent mode reports blocks without emitting text or reasoning', () => {
  const { parser, seen } = recorder();
  parser.silent = true;
  parser.push('<think>r</think>shown? <decision>d</decision><done:2>');
  parser.finish();
  assert.deepEqual(seen.decisions, ['d']);
  assert.deepEqual(seen.done, [1]);
  assert.equal(seen.visible, '');
  assert.equal(seen.think, '');
  assert.deepEqual(seen.thinkEvents, []);
});

test('stripMarkers removes every decision block, not just the first', () => {
  assert.equal(stripMarkers('a<decision>1</decision>b<decision>2</decision>c'), 'abc');
});

function agentFor(client) {
  return new Agent(client, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  }, 'build');
}

test('Agent: a streamed decision is logged once, not again from the final content', async () => {
  const chunks = ['Ok. <decision>use A over B</decision>', ' <decision>keep API</decision> done.'];
  const agent = agentFor({
    async turn(_messages, _tools, onToken) {
      for (const c of chunks) onToken?.(c);
      return { type: 'text', content: chunks.join('') };
    },
  });
  const emitter = new EventEmitter();
  const events = [];
  emitter.on('decision', d => events.push(d.text));
  const result = await agent.run('spiegami la scelta', emitter);
  assert.deepEqual(events, ['use A over B', 'keep API']);
  assert.deepEqual(agent.workingMemory.decisions.map(d => d.text), ['use A over B', 'keep API']);
  assert.doesNotMatch(String(result), /decision/);
});

test('Agent: a response that did not stream still has its markup read', async () => {
  let turns = 0;
  const agent = agentFor({
    async turn() {
      turns++;
      return turns === 1
        ? { type: 'text', content: '<todo>1. a\n2. b</todo>Answer <decision>why</decision><done:1><done:2>' }
        : { type: 'text', content: 'Nothing more.' };
    },
  });
  const emitter = new EventEmitter();
  const decisions = [];
  const todos = [];
  const tokens = [];
  emitter.on('decision', d => decisions.push(d.text));
  emitter.on('todoList', items => todos.push(items));
  emitter.on('token', t => tokens.push(t));
  const result = await agent.run('rispondi', emitter);
  assert.deepEqual(decisions, ['why']);
  assert.deepEqual(todos, [['a', 'b']]);
  assert.deepEqual([...agent._todoDoneIdx].sort(), [0, 1]);
  assert.deepEqual(tokens, [], 'a non-streamed reply is not replayed as tokens');
  assert.match(String(result), /Answer/);
});

test('stripReasoning: blocks, an orphan close, and reasoning cut off mid-way', async () => {
  const { stripReasoning } = await import('../src/agents/stream-parser.js');
  assert.equal(stripReasoning('<think>a</think>\nBody <thinking>b</thinking>end'), 'Body end');
  assert.equal(stripReasoning('reasoning sent without opener</think>\nBody'), 'Body');
  assert.equal(stripReasoning('Body\n<think>truncated reasoning'), 'Body');
  assert.equal(stripReasoning('<think>only reasoning'), '');
});
