// Two guards that only matter when something goes wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { modelVisionSupport } from '../src/utils/images.js';

// ── the ceiling ───────────────────────────────────────────────────────────

test('a model that keeps producing output without finishing hits the ceiling', async () => {
  // Every chunk pushes the silence timeout back, which is what it is for. The
  // ceiling is the rule that does not move: this stream would otherwise run
  // forever on a 50ms drip.
  const agent = new Agent({
    async turn(_messages, _tools, onToken, signal) {
      while (!signal?.aborted) {
        onToken?.('.');
        await new Promise(r => { setTimeout(r, 20); });
      }
      throw signal.reason ?? new Error('aborted');
    },
  }, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
    turnIdleTimeoutMs: 100,   // never reached: a chunk lands every 20ms
    turnHardLimitMs: 600,
  }, 'build');

  const emitter = new EventEmitter();
  const errors = [];
  emitter.on('error', e => errors.push(String(e?.message || e)));
  const startedAt = Date.now();
  await agent.run('vai avanti per sempre', emitter);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 5000, `the ceiling must end it, took ${elapsed}ms`);
  assert.ok(errors.some(e => /ceiling|still producing output/i.test(e)),
    `expected a ceiling error, got ${JSON.stringify(errors)}`);
});

test('the ceiling never lands below the silence window', () => {
  const agent = new Agent({ async turn() { return { type: 'text', content: '' }; } }, {
    provider: 'test', model: 'gpt-4o', workdir: process.cwd(),
    turnIdleTimeoutMs: 300_000,
    turnHardLimitMs: 1000,   // nonsense: under the silence window
  }, 'build');
  assert.equal(agent.turnHardLimitMs, 300_000, 'a ceiling under the idle window would make silence unreachable');
});

test('a working model is not cut off by the ceiling', async () => {
  const agent = new Agent({
    async turn(_messages, _tools, onToken) {
      for (let i = 0; i < 5; i++) {
        onToken?.(`chunk${i} `);
        await new Promise(r => { setTimeout(r, 20); });
      }
      return { type: 'text', content: 'finito' };
    },
  }, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
    turnIdleTimeoutMs: 1000, turnHardLimitMs: 5000,
  }, 'build');
  const emitter = new EventEmitter();
  const errors = [];
  emitter.on('error', e => errors.push(String(e?.message || e)));
  const result = await agent.run('rispondi', emitter);
  assert.deepEqual(errors, []);
  assert.match(String(result), /finito/);
});

// ── the vision check ──────────────────────────────────────────────────────

test('vision support is an allowlist, and the unknown stays unknown', () => {
  for (const known of ['gpt-4o', 'claude-opus-5', 'gemini-2.5-pro', 'qwen2.5-vl-7b', 'llava:13b', 'pixtral-12b', 'step-1v-8k']) {
    assert.equal(modelVisionSupport(known), 'yes', known);
  }
  // Not "no": a model released after this list was written is unknown, not
  // blind, and the warning says "may not" for exactly that reason.
  for (const unknown of ['MiniMax-M3', 'deepseek-chat', 'some-future-model', '', null]) {
    assert.equal(modelVisionSupport(unknown), 'unknown', String(unknown));
  }
});
