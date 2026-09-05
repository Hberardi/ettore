import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOutputCap,
  modelOutputLimit,
  effortFor,
  supportsEffort,
  normalizeEffort,
  DEFAULT_OUTPUT_TOKENS,
  AGENTIC_OUTPUT_TOKENS,
} from '../src/llm/model-limits.js';
import { buildClaudeCodeArgs } from '../src/llm/client.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ── Output ceiling ───────────────────────────────────────────────────────────

test('a model we know gets room to think, not the one-size default', () => {
  // The point of the change: 8192 was a ceiling over reasoning *and* answer
  // together on a thinking model.
  assert.equal(resolveOutputCap('claude-opus-5'), AGENTIC_OUTPUT_TOKENS);
  assert.equal(resolveOutputCap('claude-opus-4-7'), AGENTIC_OUTPUT_TOKENS);
  assert.equal(resolveOutputCap('opus'), AGENTIC_OUTPUT_TOKENS);
});

test('a model we know nothing about keeps the conservative default', () => {
  assert.equal(resolveOutputCap('MiniMax-M3'), DEFAULT_OUTPUT_TOKENS);
  assert.equal(resolveOutputCap('some-local-gguf'), DEFAULT_OUTPUT_TOKENS);
  assert.equal(resolveOutputCap(''), DEFAULT_OUTPUT_TOKENS);
  assert.equal(resolveOutputCap(null), DEFAULT_OUTPUT_TOKENS);
});

test('a model with a low ceiling is never asked for more than it takes', () => {
  // Claude 3 rejects anything above 4096 with a 400 before generating a token.
  assert.equal(resolveOutputCap('claude-3-opus-20240229'), 4096);
  assert.equal(resolveOutputCap('claude-3-opus-20240229', 64_000), 4096);
  assert.equal(resolveOutputCap('claude-3-5-sonnet-20241022'), 8192);
});

test('a user ceiling is honoured, then clamped to the model', () => {
  assert.equal(resolveOutputCap('claude-opus-5', 4096), 4096);
  assert.equal(resolveOutputCap('claude-opus-5', 120_000), 120_000);
  // Above the model's own maximum it is a 400, not a longer answer.
  assert.equal(resolveOutputCap('claude-opus-4-5', 120_000), 64_000);
  // Nonsense falls back rather than reaching the API.
  assert.equal(resolveOutputCap('claude-opus-5', 0), AGENTIC_OUTPUT_TOKENS);
  assert.equal(resolveOutputCap('claude-opus-5', 'abc'), AGENTIC_OUTPUT_TOKENS);
});

test('the longest matching key wins, as in the pricing lookup', () => {
  // `claude-opus-4-5` must not read off `claude-opus-4-7`'s row or vice versa.
  assert.equal(modelOutputLimit('claude-opus-4-5'), 64_000);
  assert.equal(modelOutputLimit('claude-opus-4-7'), 128_000);
  assert.equal(modelOutputLimit('nothing-like-a-claude'), null);
});

// ── Effort ───────────────────────────────────────────────────────────────────

test('effort is sent only where the model accepts it', () => {
  assert.equal(effortFor('claude-opus-5', 'xhigh'), 'xhigh');
  assert.equal(effortFor('opus', 'low'), 'low');
  // Sonnet 4.5 and Haiku 4.5 reject the parameter — sending it turns a working
  // request into a 400, so the gate is on the model, not the provider.
  assert.equal(effortFor('claude-haiku-4-5', 'high'), null);
  assert.equal(effortFor('claude-sonnet-4-5', 'high'), null);
  assert.equal(effortFor('MiniMax-M3', 'high'), null);
});

test('a model with a shorter ladder is clamped, not refused', () => {
  assert.equal(effortFor('claude-opus-4-5', 'xhigh'), 'high');
  assert.equal(effortFor('claude-opus-4-5', 'max'), 'high');
  assert.equal(effortFor('claude-opus-4-5', 'medium'), 'medium');
});

test('no opinion means no parameter, so the API default stands', () => {
  assert.equal(effortFor('claude-opus-5', null), null);
  assert.equal(effortFor('claude-opus-5', ''), null);
  assert.equal(effortFor('claude-opus-5', 'ludicrous'), null);
});

test('normalizeEffort accepts the ladder and nothing else', () => {
  assert.equal(normalizeEffort('LOW'), 'low');
  assert.equal(normalizeEffort('  xhigh '), 'xhigh');
  assert.equal(normalizeEffort('turbo'), null);
  assert.equal(normalizeEffort(undefined), null);
});

test('supportsEffort covers the aliases the bridge resolves', () => {
  assert.equal(supportsEffort('opus'), true);
  assert.equal(supportsEffort('sonnet'), true);
  assert.equal(supportsEffort('opusplan'), true);
  // `haiku` resolves to Haiku 4.5, which rejects the parameter.
  assert.equal(supportsEffort('haiku'), false);
  assert.equal(supportsEffort(''), false);
});

// ── The bridge's command line ────────────────────────────────────────────────

test('the bridge passes an effort level through, and omits it otherwise', () => {
  const withEffort = buildClaudeCodeArgs('opus', 'sys', 'xhigh');
  assert.deepEqual(withEffort.slice(0, 2), ['--effort', 'xhigh']);

  assert.ok(!buildClaudeCodeArgs('opus', 'sys').includes('--effort'));
  assert.ok(!buildClaudeCodeArgs('opus', 'sys', null).includes('--effort'));
  // A model that would reject it never sees the flag.
  assert.ok(!buildClaudeCodeArgs('haiku', 'sys', 'high').includes('--effort'));
  // Nor does a level the CLI would refuse.
  assert.ok(!buildClaudeCodeArgs('opus', 'sys', 'turbo').includes('--effort'));
});

test('the bridge keeps its isolation flags whatever the effort', () => {
  const args = buildClaudeCodeArgs('opus', 'sys', 'low');
  for (const flag of ['--print', '--strict-mcp-config', '--no-session-persistence', '--tools']) {
    assert.ok(args.includes(flag), `lost ${flag}`);
  }
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
});

test('the bridge raises the child output ceiling, and yields to the user', async () => {
  const { ClaudeCodeClient } = await import('../src/llm/client.js');
  const seen = [];
  const spawn = (_bin, _args, opts) => {
    seen.push(opts.env);
    // Minimal child: emit a result line and close, so turn() resolves.
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = { on() {}, end() {
      setImmediate(() => {
        child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, usage: {} }) + '\n');
        child.emit('close', 0);
      });
    } };
    child.kill = () => {};
    return child;
  };

  const client = new ClaudeCodeClient('opus', { spawn });
  await client.turn([{ role: 'user', content: 'hi' }], [], () => {}, null);
  assert.equal(seen[0].CLAUDE_CODE_MAX_OUTPUT_TOKENS, String(AGENTIC_OUTPUT_TOKENS));

  const saved = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '4321';
  try {
    await new ClaudeCodeClient('opus', { spawn }).turn([{ role: 'user', content: 'hi' }], [], () => {}, null);
    assert.equal(seen[1].CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4321', 'the user ceiling was overwritten');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    else process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = saved;
  }
});
