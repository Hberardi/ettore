import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { connectionManager } from '../src/providers/index.js';
import {
  createClient,
  normalizeMessagesForOpenAICompat,
  openaiCompatibleTurn,
  usesAnthropicTransport,
} from '../src/llm/client.js';

test('usesAnthropicTransport routes only anthropic through anthropic transport', () => {
  // MiniMax was previously routed through the Anthropic-compat endpoint
  // (/anthropic), but that path produced tool_use blocks with input={} in
  // practice. It now uses the OpenAI-compat endpoint (/v1) like every other
  // provider — see [[createClient]] in src/llm/client.js.
  assert.equal(usesAnthropicTransport('anthropic'), true);
  assert.equal(usesAnthropicTransport('minimax'), false);
  assert.equal(usesAnthropicTransport('openai'), false);
  assert.equal(usesAnthropicTransport('openrouter'), false);
});

test('createClient renames maxTokens → max_tokens and passes through OpenAI-compat allowlist', () => {
  const fakeProvider = { getClient: () => ({ /* mock SDK client */ }) };
  mock.method(connectionManager, 'getProvider', () => fakeProvider);
  try {
    const client = createClient({
      provider: 'minimax',
      model: 'MiniMax-M3',
      temperature: 0.3,
      top_p: 0.9,
      maxTokens: 2048,
    });
    assert.equal(client._modelParams.temperature, 0.3);
    assert.equal(client._modelParams.top_p, 0.9);
    assert.equal(client._modelParams.max_tokens, 2048);
    assert.equal(client._modelParams.maxTokens, undefined, 'camelCase key must be renamed, not retained');
  } finally {
    mock.restoreAll();
  }
});

test('createClient filters LLM params against the per-provider allowlist', () => {
  const fakeProvider = { getClient: () => ({}) };
  mock.method(connectionManager, 'getProvider', () => fakeProvider);
  try {
    const client = createClient({
      provider: 'minimax',
      model: 'MiniMax-M3',
      temperature: 0.5,
      frequency_penalty: 0.4,
      some_unsupported_param: 'x',
    });
    assert.equal(client._modelParams.temperature, 0.5);
    assert.equal(client._modelParams.frequency_penalty, 0.4);
    assert.equal(client._modelParams.some_unsupported_param, undefined, 'unsupported params must be filtered out');
  } finally {
    mock.restoreAll();
  }
});

test('openaiCompatibleTurn spreads modelParams into the request payload', async () => {
  let captured = null;
  const fakeClient = {
    chat: {
      completions: {
        create: async (params) => {
          captured = params;
          // Empty async iterable so the for-await loop ends immediately.
          return (async function* () {})();
        },
      },
    },
  };

  await openaiCompatibleTurn(
    fakeClient,
    'gpt-4o',
    [{ role: 'user', content: 'hi' }],
    null, // tools
    null, // onToken
    null, // signal
    undefined, // idleMs — use default
    { temperature: 0.2, max_tokens: 1024 },
  );

  assert.equal(captured.temperature, 0.2);
  assert.equal(captured.max_tokens, 1024, 'modelParams.max_tokens must override the 8192 default');
  assert.equal(captured.model, 'gpt-4o');
  assert.equal(captured.stream, true);
});

test('openaiCompatibleTurn leaves default max_tokens when no modelParams provided', async () => {
  let captured = null;
  const fakeClient = {
    chat: {
      completions: {
        create: async (params) => {
          captured = params;
          return (async function* () {})();
        },
      },
    },
  };

  await openaiCompatibleTurn(
    fakeClient,
    'gpt-4o',
    [{ role: 'user', content: 'hi' }],
    null, null, null,
  );

  assert.equal(captured.max_tokens, 8192, 'default MAX_OUTPUT_TOKENS when no override is given');
  assert.equal(captured.temperature, undefined, 'no LLM params → not included in request');
});

test('openaiCompatibleTurn accepts a premature SSE close after finish_reason', async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: null }] };
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          throw new Error('Premature close');
        })(),
      },
    },
  };

  const result = await openaiCompatibleTurn(
    fakeClient,
    'MiniMax-M3',
    [{ role: 'user', content: 'hi' }],
    null, null, null,
  );

  assert.equal(result.type, 'text');
  assert.equal(result.content, 'ok');
});

test('openaiCompatibleTurn rejects a premature SSE close before finish_reason', async () => {
  const fakeClient = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
          throw new Error('Premature close');
        })(),
      },
    },
  };

  await assert.rejects(
    openaiCompatibleTurn(
      fakeClient,
      'MiniMax-M3',
      [{ role: 'user', content: 'hi' }],
      null, null, null,
    ),
    /Premature close/,
  );
});

test('normalizeMessagesForOpenAICompat strips internal fields and keeps tool-call history provider-safe', () => {
  const normalized = normalizeMessagesForOpenAICompat([
    { role: 'system', content: 'sys', __compressed: true },
    { role: 'user', content: 'inspect this', __compressed: true },
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'hidden',
      tool_calls: [
        { id: 'call_1', function: { name: 'read', arguments: '{"file_path":"a.txt"}' } },
      ],
      __compressed: true,
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file body', extra: 'drop-me' },
  ]);

  assert.deepEqual(normalized, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'inspect this' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read', arguments: '{"file_path":"a.txt"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
  ]);
});

test('openaiCompatibleTurn sends normalized message history to the provider', async () => {
  let captured = null;
  const fakeClient = {
    chat: {
      completions: {
        create: async (params) => {
          captured = params;
          return (async function* () {})();
        },
      },
    },
  };

  await openaiCompatibleTurn(
    fakeClient,
    'MiniMax-M3',
    [
      { role: 'system', content: 'sys', __compressed: true },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'hidden',
        tool_calls: [
          { id: 'call_1', function: { name: 'repo_map', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok', ignored: true },
    ],
    null,
    null,
    null,
  );

  assert.deepEqual(captured.messages, [
    { role: 'system', content: 'sys' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'repo_map', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
  ]);
});

test('openaiCompatibleTurn reports the finish_reason so a truncated turn is recognizable', async () => {
  const makeClient = (reason) => ({
    chat: {
      completions: {
        create: async () => (async function* () {
          yield { choices: [{ delta: { content: 'meta ris' }, finish_reason: null }] };
          yield { choices: [{ delta: {}, finish_reason: reason }] };
        })(),
      },
    },
  });

  // `length` means the model hit max_tokens: the content is a fragment, and the
  // agent loop needs to see that instead of treating it as a finished answer.
  const truncated = await openaiCompatibleTurn(
    makeClient('length'), 'MiniMax-M3', [{ role: 'user', content: 'hi' }], null, null, null,
  );
  assert.equal(truncated.type, 'text');
  assert.equal(truncated.finishReason, 'length');

  const complete = await openaiCompatibleTurn(
    makeClient('stop'), 'MiniMax-M3', [{ role: 'user', content: 'hi' }], null, null, null,
  );
  assert.equal(complete.finishReason, 'stop');
});
