import Anthropic from '@anthropic-ai/sdk';
import { setMaxListeners as setTargetMaxListeners } from 'events';
import { connectionManager } from '../providers/index.js';

// Hard cap on model output — prevents infinite generation loops
const MAX_OUTPUT_TOKENS = 8192;

// Idle timeout: if no token arrives for 120s, abort the stream
// Reasoning models (M2.7, DeepSeek-R1) can have long pauses between tokens
const STREAMING_IDLE_MS = 120_000;

// Disable the MaxListenersExceeded warning on an AbortSignal: the SDKs add a
// fresh listener on every call, and our agent reuses one signal across many
// turns inside a single `run()`. `setMaxListeners` on EventEmitter does NOT
// apply to EventTargets like AbortSignal — we must use the standalone helper.
function raiseSignalListenerCap(signal) {
  if (!signal) return;
  try { setTargetMaxListeners(0, signal); } catch {}
}

/**
 * Wraps a parent AbortSignal with a watchdog that fires if no token
 * arrives within STREAMING_IDLE_MS. Call resetTimer() on every token.
 */
function makeStreamingSignal(parentSignal) {
  const ctrl = new AbortController();
  let idleTimer = null;

  const resetTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      ctrl.abort(new Error(`Streaming idle timeout — no token for ${STREAMING_IDLE_MS / 1000}s`));
    }, STREAMING_IDLE_MS);
  };

  parentSignal?.addEventListener('abort', () => {
    clearTimeout(idleTimer);
    ctrl.abort(parentSignal.reason);
  }, { once: true });

  resetTimer();
  return { signal: ctrl.signal, resetTimer, clear: () => clearTimeout(idleTimer) };
}

// Abort-aware retry wrapper for LLM calls.
// Never retries on: user cancellation, auth errors (401/403), bad request (400), timeouts.
// Retries on: network errors, 429 rate limits, 5xx server errors.
//
// Backoff policy:
//   429        → exponential w/ jitter, capped at 60s, 4 retries (rate limits often clear within ~1 min)
//   502/503/504 → exponential w/ jitter, capped at 30s, 3 retries
//   network    → short exponential w/ jitter, capped at 10s, 2 retries
// All waits include random jitter to avoid thundering-herd retries from parallel requests.
function backoffWait(attempt, base, capMs) {
  const exp = Math.min(capMs, base * Math.pow(2, attempt));
  return exp / 2 + Math.random() * (exp / 2); // jitter in [exp/2, exp]
}

async function retryLLMCall(fn, signal, _legacyMaxRetries) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      if (e.name === 'AbortError' || signal?.aborted) throw e;
      const status = e.status || e.statusCode;
      if (status === 401 || status === 403 || status === 400) throw e;
      if (/timed? ?out|timeout/i.test(e.message)) throw e;

      // Honor server-provided Retry-After if present (seconds or HTTP-date).
      let serverRetryMs = null;
      const retryAfter = e?.headers?.['retry-after'] || e?.response?.headers?.['retry-after'];
      if (retryAfter != null) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs)) serverRetryMs = secs * 1000;
        else {
          const when = Date.parse(retryAfter);
          if (!Number.isNaN(when)) serverRetryMs = Math.max(0, when - Date.now());
        }
      }

      let maxRetries, base, cap;
      if (status === 429) { maxRetries = 4; base = 2000; cap = 60_000; }
      else if (status === 502 || status === 503 || status === 504) { maxRetries = 3; base = 1500; cap = 30_000; }
      else { maxRetries = 2; base = 1000; cap = 10_000; }

      if (attempt >= maxRetries) throw e;
      const waitMs = serverRetryMs != null
        ? Math.min(serverRetryMs, cap)
        : backoffWait(attempt, base, cap);
      await new Promise(r => { setTimeout(r, waitMs); });
      attempt++;
    }
  }
}

export function createClient(config) {
  const { model, provider } = config;

  if (usesAnthropicTransport(provider)) {
    const providerName = provider === 'minimax' ? 'minimax' : 'anthropic';
    const apiKey = connectionManager.getProvider(providerName)?.getClient()?.apiKey
      || (provider === 'minimax' ? process.env.MINIMAX_API_KEY : process.env.ANTHROPIC_API_KEY);
    if (!apiKey) throw new Error(`${provider === 'minimax' ? 'MiniMax' : 'Anthropic'} API key not found`);
    const baseURL = provider === 'minimax' ? 'https://api.minimax.io/anthropic' : undefined;
    return new AnthropicClient(apiKey, model, { baseURL });
  }

  // For all OpenAI-compatible providers (ollama, openai, nvidia, groq, openrouter, etc.)
  // reuse the pre-configured client from the connection manager (correct baseURL already set)
  const providerInstance = connectionManager.getProvider(provider);
  if (providerInstance?.getClient) {
    return new OpenAICompatClient(providerInstance.getClient(), model);
  }

  throw new Error('No active connection. Use /connect to connect a provider.');
}

export function usesAnthropicTransport(provider) {
  return provider === 'anthropic' || provider === 'minimax';
}

export function normalizeMessagesForAnthropic(messages) {
  const out = [];
  let pendingToolResults = [];

  const flushPendingToolResults = () => {
    if (!pendingToolResults.length) return;
    out.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const msg of messages || []) {
    if (!msg || msg.role === 'system') continue;

    if (msg.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: String(msg.tool_call_id || ''),
        content: String(msg.content || ''),
      });
      continue;
    }

    flushPendingToolResults();

    if (msg.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: Array.isArray(msg.content) ? msg.content : String(msg.content || ''),
      });
      continue;
    }

    if (msg.role === 'user') {
      out.push({
        role: 'user',
        content: Array.isArray(msg.content)
          ? msg.content
          : [{ type: 'text', text: String(msg.content || '') }],
      });
    }
  }

  flushPendingToolResults();
  return out;
}

// ── OpenAI-compatible (OpenAI + Ollama) ─────────────────────────────────────
// Always streams — including tool-calling turns. Assistant text reaches the UI
// token-by-token for immediate feedback; tool-call fragments arrive as
// `delta.tool_calls` chunks keyed by `index` and are accumulated as they stream.
export async function openaiCompatibleTurn(client, model, messages, tools, onToken, signal) {
  const params = {
    model,
    messages,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools?.length) params.tools = tools;

  raiseSignalListenerCap(signal);

  const { signal: streamSignal, resetTimer, clear } = makeStreamingSignal(signal);
  const stream = await retryLLMCall(() => client.chat.completions.create(params, { signal: streamSignal }), signal);

  let content = '';
  let usage = null;
  // Tool-call fragments accumulate here, indexed by delta.tool_calls[].index.
  const toolAcc = [];
  // Track reasoning state to wrap delta.reasoning_content as <think>...</think>
  // Supports: MiniMax M2.7, DeepSeek-R1 API (reasoning_content), OpenRouter (reasoning)
  let inReasoning = false;

  try {
    for await (const chunk of stream) {
      // Final usage chunk (include_usage) carries an empty choices array.
      if (chunk.usage) usage = chunk.usage;
      const d = chunk.choices?.[0]?.delta;
      if (!d) continue;

      // reasoning_content: MiniMax, DeepSeek API direct; reasoning: OpenRouter unified schema
      const reasoning = d.reasoning_content || d.reasoning || '';
      const text      = d.content || '';

      if (reasoning) {
        resetTimer();
        if (!inReasoning) { onToken?.('<think>'); inReasoning = true; }
        onToken?.(reasoning);
      } else if (inReasoning && (text || d.tool_calls)) {
        onToken?.('</think>');
        inReasoning = false;
      }

      if (text) { resetTimer(); onToken?.(text); content += text; }

      if (Array.isArray(d.tool_calls)) {
        resetTimer();
        for (const tc of d.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolAcc[idx]) toolAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          const acc = toolAcc[idx];
          if (tc.id) acc.id = tc.id;
          if (tc.type) acc.type = tc.type;
          if (tc.function?.name) acc.function.name += tc.function.name;
          if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        }
      }
    }
    // Close an unclosed think block (model stopped mid-reasoning).
    if (inReasoning) { onToken?.('</think>'); inReasoning = false; }
  } finally {
    clear();
  }

  const usageObj = usage
    ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
    : null;

  // reasoning_* fields are intentionally never stored on the message: sending
  // them back to MiniMax causes error 2013 ("tool call and result not match").
  const toolCalls = toolAcc.filter(tc => tc && tc.function?.name);
  if (toolCalls.length) {
    return {
      type: 'tool_calls',
      tool_calls: toolCalls,
      message: { role: 'assistant', content: content || null, tool_calls: toolCalls },
      usage: usageObj,
    };
  }

  return { type: 'text', content, usage: usageObj };
}

class OpenAICompatClient {
  constructor(client, model) {
    this.client = client;
    this.model = model;
  }
  async turn(messages, tools, onToken, signal) {
    return openaiCompatibleTurn(this.client, this.model, messages, tools, onToken, signal);
  }
}

// ── Anthropic ────────────────────────────────────────────────────────────────
// Beta header required by SDK 0.21.x for cache_control. Newer SDKs accept it natively.
const ANTHROPIC_CACHE_HEADER = { 'anthropic-beta': 'prompt-caching-2024-07-31' };

class AnthropicClient {
  constructor(apiKey, model, options = {}) {
    this.client = new Anthropic({
      apiKey,
      baseURL: options.baseURL,
      timeout: 180_000,
      maxRetries: 2,
    });
    this.model = model;
  }
  async turn(messages, tools, onToken, signal) {
    const system = messages.find(m => m.role === 'system')?.content || '';
    const userMessages = normalizeMessagesForAnthropic(messages);
    const params = { model: this.model, max_tokens: MAX_OUTPUT_TOKENS, messages: userMessages };
    // System prompt is stable across turns — cache it.
    if (system) {
      params.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    if (tools?.length) {
      const mapped = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters
      }));
      // Cache the tool list by tagging the last entry — caches all tools above it.
      mapped[mapped.length - 1].cache_control = { type: 'ephemeral' };
      params.tools = mapped;
    }
    const reqOpts = { headers: ANTHROPIC_CACHE_HEADER };

    raiseSignalListenerCap(signal);

    // Always stream — including tool-calling turns. Text deltas reach the UI
    // immediately; the full message (with any tool_use blocks) is assembled by
    // the SDK and retrieved via finalMessage() once the stream completes.
    const { signal: streamSignal, resetTimer, clear } = makeStreamingSignal(signal);
    const stream = await retryLLMCall(
      () => this.client.messages.stream(params, { ...reqOpts, signal: streamSignal }),
      signal,
    );

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreate = 0;
    let cacheRead = 0;
    let final;
    try {
      for await (const chunk of stream) {
        resetTimer();
        if (chunk.type === 'message_start') {
          const u = chunk.message?.usage;
          inputTokens = u?.input_tokens || 0;
          cacheCreate = u?.cache_creation_input_tokens || 0;
          cacheRead   = u?.cache_read_input_tokens || 0;
        } else if (chunk.type === 'message_delta') {
          outputTokens = chunk.usage?.output_tokens || outputTokens;
        } else if (chunk.type === 'content_block_delta') {
          // text_delta → assistant text; input_json_delta (tool args) is not displayed.
          if (chunk.delta?.type === 'text_delta' && chunk.delta.text) {
            onToken?.(chunk.delta.text);
          }
        }
      }
      final = await stream.finalMessage();
    } finally {
      clear();
    }

    const usageObj = {
      inputTokens:  final.usage?.input_tokens ?? inputTokens,
      outputTokens: final.usage?.output_tokens ?? outputTokens,
      cacheCreate:  final.usage?.cache_creation_input_tokens ?? cacheCreate,
      cacheRead:    final.usage?.cache_read_input_tokens ?? cacheRead,
    };

    if (final.stop_reason === 'tool_use') {
      const tool_calls = final.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      return { type: 'tool_calls', tool_calls, message: { role: 'assistant', content: final.content }, usage: usageObj };
    }

    const content = final.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    return { type: 'text', content, usage: usageObj };
  }
}
