// Regressions for stream-parser handling of <think> tags. These reproduce
// real bugs reported with MiniMax M2.7 where the tag leaked into the visible
// output because chunks split mid-tag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import {
  THINK_OPEN_RE,
  THINK_CLOSE_RE,
  PARTIAL_TAG_OPEN_RE,
  PARTIAL_TAG_CLOSE_RE,
} from '../src/agents/stream-parser.js';

test('THINK_OPEN_RE is case-insensitive and tolerates whitespace', () => {
  assert.match('<think>', THINK_OPEN_RE);
  assert.match('<Think>', THINK_OPEN_RE);
  assert.match('<THINK>', THINK_OPEN_RE);
  assert.match('< think >', THINK_OPEN_RE);
  assert.match('<thinking>', THINK_OPEN_RE);
  assert.match('<reasoning>', THINK_OPEN_RE);
  assert.match('<think attr="x">', THINK_OPEN_RE);
});

test('THINK_CLOSE_RE is case-insensitive and tolerates whitespace', () => {
  assert.match('</think>', THINK_CLOSE_RE);
  assert.match('</Think>', THINK_CLOSE_RE);
  assert.match('< / think >', THINK_CLOSE_RE);
});

test('PARTIAL_TAG_OPEN_RE catches a bare `<` at end of buffer', () => {
  assert.match('hello <', PARTIAL_TAG_OPEN_RE);
  assert.match('hello <t', PARTIAL_TAG_OPEN_RE);
  assert.match('hello <thi', PARTIAL_TAG_OPEN_RE);
  // Tags that are not control tags should not be held back
  assert.doesNotMatch('hello <tool', PARTIAL_TAG_OPEN_RE);
  assert.doesNotMatch('hello < world', PARTIAL_TAG_OPEN_RE);
});

test('PARTIAL_TAG_CLOSE_RE catches `</` and grows', () => {
  assert.match('text </', PARTIAL_TAG_CLOSE_RE);
  assert.match('text </t', PARTIAL_TAG_CLOSE_RE);
  assert.match('text </think', PARTIAL_TAG_CLOSE_RE);
  assert.doesNotMatch('text </tool', PARTIAL_TAG_CLOSE_RE);
});

// ── End-to-end: streaming with split tags ─────────────────────────────────

function makeAgentClient(chunks, finalText = '') {
  return {
    async turn(_messages, _tools, onToken) {
      for (const c of chunks) onToken?.(c);
      return { type: 'text', content: finalText || chunks.join('') };
    },
  };
}

test('Streaming `<` then `think>` separately routes content into the reasoning panel, not the main output', async () => {
  // Reproduces the MiniMax-style split where the tag arrives across chunks.
  // The bug was: a lone `<` slipped through, then `think>` arrived as plain
  // text, making the tag visible to the user.
  const chunks = ['<', 'think', '>', 'reasoning content', '</think>', 'visible answer'];
  const agent = new Agent(makeAgentClient(chunks), {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000,
    verifyAfterEdit: false,
  }, 'build');

  const emitter = new EventEmitter();
  const tokens = [];
  const thinkTokens = [];
  let thinkStarted = false;
  let thinkEnded = false;
  emitter.on('token', t => tokens.push(t));
  emitter.on('thinkStart', () => { thinkStarted = true; });
  emitter.on('thinkToken', t => thinkTokens.push(t));
  emitter.on('thinkEnd', () => { thinkEnded = true; });

  await agent.run('test', emitter);
  const visible = tokens.join('');
  assert.equal(thinkStarted, true, 'should detect <think>');
  assert.equal(thinkEnded, true, 'should detect </think>');
  assert.equal(visible.includes('<think>'), false, 'tag should never leak into visible output');
  assert.equal(visible.includes('</think>'), false, 'closing tag should never leak into visible output');
  assert.match(thinkTokens.join(''), /reasoning content/);
  assert.match(visible, /visible answer/);
});

test('Streaming <think> with mixed case is still suppressed', async () => {
  const chunks = ['<Think>', 'inner', '</think>', 'rest'];
  const agent = new Agent(makeAgentClient(chunks), {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  }, 'build');
  const emitter = new EventEmitter();
  const tokens = [];
  emitter.on('token', t => tokens.push(t));
  await agent.run('test', emitter);
  const visible = tokens.join('');
  assert.equal(visible.includes('<Think>'), false);
  assert.equal(visible.includes('</think>'), false);
  assert.match(visible, /rest/);
});

test('Visible text before <think> is emitted, not held back forever', async () => {
  const chunks = ['Hello ', '<think>', 'inner', '</think>', ' done'];
  const agent = new Agent(makeAgentClient(chunks), {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  }, 'build');
  const emitter = new EventEmitter();
  const tokens = [];
  emitter.on('token', t => tokens.push(t));
  await agent.run('test', emitter);
  const visible = tokens.join('');
  assert.match(visible, /Hello/);
  assert.match(visible, /done/);
  assert.equal(visible.includes('<think>'), false);
});

test('Streaming a split closing think tag does not leak it or swallow visible text', async () => {
  const chunks = ['<think>', 'inner', '<', '/think>', 'visible'];
  const agent = new Agent(makeAgentClient(chunks), {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  }, 'build');
  const emitter = new EventEmitter();
  const tokens = [];
  const thinkTokens = [];
  emitter.on('token', t => tokens.push(t));
  emitter.on('thinkToken', t => thinkTokens.push(t));

  await agent.run('test', emitter);

  assert.equal(tokens.join(''), 'visible');
  assert.equal(thinkTokens.join(''), 'inner');
});

test('Streaming reasoning and a partial closing tag in the same chunk remains safe', async () => {
  const chunks = ['prefix <think>inner<', '/think>', 'visible'];
  const agent = new Agent(makeAgentClient(chunks), {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  }, 'build');
  const emitter = new EventEmitter();
  const tokens = [];
  const thinkTokens = [];
  emitter.on('token', t => tokens.push(t));
  emitter.on('thinkToken', t => thinkTokens.push(t));

  await agent.run('test', emitter);

  assert.equal(tokens.join(''), 'prefix visible');
  assert.equal(thinkTokens.join(''), 'inner');
});

test('Streaming an orphan closing think tag never displays it', async () => {
  const chunks = ['visible', '<', '/think>'];
  const agent = new Agent(makeAgentClient(chunks), {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  }, 'build');
  const emitter = new EventEmitter();
  const tokens = [];
  emitter.on('token', t => tokens.push(t));

  const result = await agent.run('test', emitter);

  assert.equal(tokens.join(''), 'visible');
  assert.equal(result, 'visible');
});

test('Streaming `<tool>` stays visible instead of stalling the buffer', async () => {
  const chunks = ['<tool', '>', 'answer'];
  const agent = new Agent(makeAgentClient(chunks), {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  }, 'build');
  const emitter = new EventEmitter();
  const tokens = [];
  emitter.on('token', t => tokens.push(t));

  await agent.run('test', emitter);

  assert.equal(tokens.join(''), '<tool>answer');
});
