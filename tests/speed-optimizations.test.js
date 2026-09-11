import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  reasoningParamsFor,
  openaiCompatibleTurn,
  OpenAICompatClient,
  normalizeMessagesForAnthropic,
  applyRollingCacheBreakpoint,
} from '../src/llm/client.js';
import { Agent } from '../src/agents/index.js';

// A streaming chat.completions stub that records every request it receives.
function fakeOpenAI({ fail = null, usage = { prompt_tokens: 10, completion_tokens: 2 } } = {}) {
  const requests = [];
  return {
    requests,
    chat: {
      completions: {
        async create(params) {
          requests.push({ ...params });
          if (fail && fail(params)) throw fail.error;
          return (async function* () {
            yield { choices: [{ finish_reason: null, delta: { content: 'ok' } }] };
            yield { choices: [{ finish_reason: 'stop', delta: {} }], usage };
          })();
        },
      },
    },
  };
}

// ── Reasoning effort on OpenAI-compatible transports ─────────────────────────

test('reasoning effort is sent to models that always reason', () => {
  assert.deepEqual(reasoningParamsFor('openai', 'gpt-5-mini', 'low'), { reasoning_effort: 'low' });
  assert.deepEqual(reasoningParamsFor('openai', 'o4-mini', 'medium'), { reasoning_effort: 'medium' });
  assert.deepEqual(reasoningParamsFor('groq', 'openai/gpt-oss-120b', 'low'), { reasoning_effort: 'low' });
  assert.deepEqual(reasoningParamsFor('google', 'gemini-2.5-flash', 'low'), { reasoning_effort: 'low' });
  // OpenRouter speaks its own unified shape.
  assert.deepEqual(reasoningParamsFor('openrouter', 'openai/gpt-5', 'low'), { reasoning: { effort: 'low' } });
});

test('levels above high are capped to what the OpenAI field accepts', () => {
  assert.deepEqual(reasoningParamsFor('openai', 'gpt-5', 'max'), { reasoning_effort: 'high' });
  assert.deepEqual(reasoningParamsFor('openai', 'gpt-5', 'xhigh'), { reasoning_effort: 'high' });
});

test('no effort is sent where it would switch thinking on or is not understood', () => {
  // Hybrid or non-reasoning models: any effort would enable thinking, or 400.
  assert.deepEqual(reasoningParamsFor('openrouter', 'anthropic/claude-sonnet-4.5', 'low'), {});
  assert.deepEqual(reasoningParamsFor('openai', 'gpt-4o', 'low'), {});
  assert.deepEqual(reasoningParamsFor('openai', 'gpt-5-chat-latest', 'low'), {});
  assert.deepEqual(reasoningParamsFor('google', 'gemini-2.5-flash-lite', 'low'), {});
  assert.deepEqual(reasoningParamsFor('minimax', 'MiniMax-M2.7', 'low'), {});
  assert.deepEqual(reasoningParamsFor('deepseek', 'deepseek-reasoner', 'low'), {});
  // No opinion, no field.
  assert.deepEqual(reasoningParamsFor('openai', 'gpt-5', null), {});
  assert.deepEqual(reasoningParamsFor('openai', 'gpt-5', 'bogus'), {});
});

test('an endpoint that rejects the reasoning field gets the request again without it', async () => {
  const error = Object.assign(new Error('400 Unrecognized request argument supplied: reasoning_effort'), { status: 400 });
  const client = fakeOpenAI({ fail: Object.assign(p => 'reasoning_effort' in p, { error }) });
  let rejected = 0;
  const result = await openaiCompatibleTurn(
    client, 'gpt-oss-20b', [{ role: 'user', content: 'hi' }], [], null, null, undefined, {},
    { reasoning: { reasoning_effort: 'low' }, onReasoningRejected: () => { rejected++; } },
  );
  assert.equal(result.content, 'ok');
  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[0].reasoning_effort, 'low');
  assert.equal('reasoning_effort' in client.requests[1], false);
  assert.equal(rejected, 1);
});

test('an unrelated 400 is not retried without reasoning', async () => {
  const error = Object.assign(new Error('400 context length exceeded'), { status: 400 });
  const client = fakeOpenAI({ fail: Object.assign(() => true, { error }) });
  await assert.rejects(
    openaiCompatibleTurn(client, 'gpt-5', [{ role: 'user', content: 'hi' }], [], null, null, undefined, {},
      { reasoning: { reasoning_effort: 'low' } }),
    /context length/,
  );
  assert.equal(client.requests.length, 1);
});

test('the client remembers a rejection and stops sending the field', async () => {
  const error = Object.assign(new Error('400 reasoning_effort is not supported'), { status: 400 });
  const raw = fakeOpenAI({ fail: Object.assign(p => 'reasoning_effort' in p, { error }) });
  const client = new OpenAICompatClient(raw, 'gpt-oss-20b', { provider: 'together' });
  await client.turn([{ role: 'user', content: 'a' }], [], null, null, { effort: 'low' });
  await client.turn([{ role: 'user', content: 'b' }], [], null, null, { effort: 'low' });
  // First turn: rejected + retried. Second turn: sent without the field at once.
  assert.equal(raw.requests.length, 3);
  assert.equal('reasoning_effort' in raw.requests[2], false);
});

test('the compressor\'s low effort now reaches an OpenAI reasoning model', async () => {
  const raw = fakeOpenAI();
  const client = new OpenAICompatClient(raw, 'gpt-5-mini', { provider: 'openai' });
  await client.turn([{ role: 'user', content: 'summarise' }], [], null, null, { effort: 'low' });
  assert.equal(raw.requests[0].reasoning_effort, 'low');
});

// ── Cache accounting and timing ──────────────────────────────────────────────

test('cached prompt tokens are split out the Anthropic way', async () => {
  const client = fakeOpenAI({
    usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 800 } },
  });
  const result = await openaiCompatibleTurn(client, 'gpt-4o', [{ role: 'user', content: 'hi' }], [], null, null);
  assert.equal(result.usage.inputTokens, 200);
  assert.equal(result.usage.cacheRead, 800);
  assert.equal(typeof result.usage.firstChunkMs, 'number');
});

test('DeepSeek\'s cache counter is read too', async () => {
  const client = fakeOpenAI({ usage: { prompt_tokens: 500, completion_tokens: 5, prompt_cache_hit_tokens: 300 } });
  const result = await openaiCompatibleTurn(client, 'deepseek-chat', [{ role: 'user', content: 'hi' }], [], null, null);
  assert.equal(result.usage.inputTokens, 200);
  assert.equal(result.usage.cacheRead, 300);
});

// ── Recovery overlay stays out of the cached prefix ──────────────────────────

test('a recovery overlay leaves the system prompt byte-identical', async () => {
  const systems = [];
  const trailing = [];
  let turns = 0;
  const client = {
    async turn(messages) {
      turns++;
      systems.push(String(messages[0].content));
      trailing.push(messages[messages.length - 1]);
      if (turns === 1) return { type: 'text', content: 'Ora creo il file.' };
      return { type: 'text', content: 'Fatto.' };
    },
  };
  const agent = new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    verifyAfterEdit: false,
  }, 'build');

  await agent.run('crea il file', new EventEmitter());

  assert.ok(turns >= 2, 'the announcement must trigger a retry');
  assert.ok(systems.every(s => s === systems[0]), 'the system prompt must not change between provider calls');
  assert.doesNotMatch(systems[0], /TURN RECOVERY OVERLAY/);
  assert.equal(trailing[1].role, 'user');
  assert.match(String(trailing[1].content), /^TURN RECOVERY OVERLAY/);
  // Sent once, never stored: the next request's prefix is the same as before.
  assert.ok(!agent.messages.some(m => /TURN RECOVERY OVERLAY/.test(String(m.content || ''))));
});

test('the Anthropic rolling breakpoint skips a one-request overlay block', () => {
  const messages = normalizeMessagesForAnthropic([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"file_path":"a"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    { role: 'user', content: 'TURN RECOVERY OVERLAY\nverify', _ephemeral: true },
  ]);
  const last = messages[messages.length - 1];
  assert.equal(last.content.length, 2, 'tool result and overlay share one user turn');
  applyRollingCacheBreakpoint(messages, 2);
  assert.deepEqual(last.content[0].cache_control, { type: 'ephemeral' }, 'the tool result carries the breakpoint');
  assert.equal(last.content[1].cache_control, undefined, 'the overlay does not');
});
