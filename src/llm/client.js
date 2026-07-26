import Anthropic from '@anthropic-ai/sdk';
import { setMaxListeners as setTargetMaxListeners } from 'events';
import { connectionManager } from '../providers/index.js';
import { canonicalizeToolTurn } from '../agents/message-ledger.js';

// Hard cap on model output — prevents infinite generation loops
const MAX_OUTPUT_TOKENS = 8192;

// Idle timeout: if no token arrives, abort the stream.
// Reasoning models (M2.7, DeepSeek-R1) can have long pauses between tokens —
// MiniMax M2.7 in particular emits no chunks during internal reasoning, so it
// uses a longer cap than OpenAI-compatible providers.
const STREAMING_IDLE_MS = 120_000;
const STREAMING_IDLE_MS_LONG_REASONING = 300_000;

// Allowlist per-provider dei parametri LLM opzionali. Tutti undefined-by-default
// e omessi dalle request se non impostati — niente default cablati in CLI.
// Rename map trasporta i nomi user-facing (es. `maxTokens` camelCase) a quelli delle SDK.
const OPENAI_MODEL_PARAM_KEYS = new Set(['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'max_tokens']);
const ANTHROPIC_MODEL_PARAM_KEYS = new Set(['temperature', 'top_p', 'top_k', 'max_tokens']);

/**
 * Filtra config.modelParams contro un allowlist per-provider, applica rename
 * (es. `maxTokens` → `max_tokens`) e scarta undefined. Restituisce un nuovo
 * oggetto pronto da spreadere in `params` delle request.
 */
function pickAllowedModelParams(config, allowed, rename = {}) {
  const out = {};
  if (!config) return out;
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined) continue;
    const target = rename[k] || k;
    if (allowed.has(target)) out[target] = v;
  }
  return out;
}

function needsLongReasoningWindow(provider, model) {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (p === 'minimax') return true;
  // Kimi via NVIDIA NIM can pause for long internal reasoning phases.
  if (p === 'nvidia' && (m.includes('kimi') || m.includes('moonshot'))) return true;
  return false;
}

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
function makeStreamingSignal(parentSignal, idleMs = STREAMING_IDLE_MS) {
  const ctrl = new AbortController();
  let idleTimer = null;

  const resetTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      ctrl.abort(new Error(`Streaming idle timeout — no token for ${idleMs / 1000}s`));
    }, idleMs);
    // A watchdog must never be the reason the process stays alive.
    idleTimer.unref?.();
  };

  parentSignal?.addEventListener('abort', () => {
    clearTimeout(idleTimer);
    ctrl.abort(parentSignal.reason);
  }, { once: true });

  resetTimer();
  return { signal: ctrl.signal, resetTimer, clear: () => clearTimeout(idleTimer) };
}

// Abort-aware retry wrapper for LLM calls.
// Never retries on: user cancellation, auth errors (401/403), bad request (400),
//                   deliberate request-deadline timeouts.
// Retries on: network errors (incl. socket ETIMEDOUT / ECONNRESET), 429, 5xx.
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

export async function retryLLMCall(fn, signal, _legacyMaxRetries) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      if (e.name === 'AbortError' || signal?.aborted) throw e;
      const status = e.status || e.statusCode;
      if (status === 401 || status === 403 || status === 400) throw e;
      // A socket-level ETIMEDOUT is a transient network failure, not a
      // deliberate request-deadline timeout — let it fall through to the
      // network-error retry branch instead of failing the whole turn.
      const isSocketTimeout = [e.code, e.cause?.code].includes('ETIMEDOUT')
        || /\bETIMEDOUT\b/i.test(e.message || '');
      if (!isSocketTimeout && /timed? ?out|timeout/i.test(e.message)) throw e;

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
    const apiKey = connectionManager.getProvider('anthropic')?.getClient()?.apiKey
      || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Anthropic API key not found');
    return new AnthropicClient(apiKey, model, {
      modelParams: pickAllowedModelParams(config, ANTHROPIC_MODEL_PARAM_KEYS, { maxTokens: 'max_tokens' }),
    });
  }

  // For all OpenAI-compatible providers (ollama, openai, nvidia, groq, openrouter,
  // minimax, etc.) reuse the pre-configured client from the connection manager —
  // it already points at the correct baseURL (MiniMax → /v1).
  const providerInstance = connectionManager.getProvider(provider);
  if (providerInstance?.getClient) {
    // Some reasoning models/providers can pause for long inter-chunk windows.
    const idleMs = needsLongReasoningWindow(provider, model)
      ? STREAMING_IDLE_MS_LONG_REASONING
      : STREAMING_IDLE_MS;
    return new OpenAICompatClient(providerInstance.getClient(), model, {
      idleMs,
      modelParams: pickAllowedModelParams(config, OPENAI_MODEL_PARAM_KEYS, { maxTokens: 'max_tokens' }),
    });
  }

  throw new Error('No active connection. Use /connect to connect a provider.');
}

export function usesAnthropicTransport(provider) {
  return provider === 'anthropic';
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

    if (msg.role === 'user') {
      const blocks = Array.isArray(msg.content)
        ? msg.content.map(block => {
            if (block?.type !== 'image_url') return block;
            const match = String(block.image_url?.url || '').match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s);
            if (!match) return { type: 'text', text: '[Invalid image attachment omitted]' };
            return {
              type: 'image',
              source: { type: 'base64', media_type: match[1], data: match[2] },
            };
          })
        : [{ type: 'text', text: String(msg.content || '') }];
      // The compressor stamps _cacheControl on the compressed-context
      // summary; tag the resulting text block so Anthropic caches it across
      // the rest of the session. Falls through harmlessly on other providers.
      if (msg._cacheControl) {
        for (const block of blocks) {
          if (block && typeof block === 'object' && block.type === 'text' && !block.cache_control) {
            block.cache_control = msg._cacheControl;
          }
        }
      }
      out.push({ role: 'user', content: [...pendingToolResults, ...blocks] });
      pendingToolResults = [];
      continue;
    }

    flushPendingToolResults();

    if (msg.role === 'assistant') {
      // Anthropic content blocks (from a prior Anthropic turn) pass through.
      if (Array.isArray(msg.content)) {
        out.push({ role: 'assistant', content: msg.content });
        continue;
      }
      // OpenAI-shaped assistant message carrying tool_calls: rebuild it as
      // Anthropic content blocks, converting each tool_call into a tool_use
      // block so the following tool_result messages still resolve. Without
      // this the tool_calls would be dropped and Anthropic would reject the
      // orphaned tool_result blocks.
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const blocks = [];
        const text = String(msg.content || '');
        if (text) blocks.push({ type: 'text', text });
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
          blocks.push({
            type: 'tool_use',
            id: String(tc.id || ''),
            name: tc.function?.name || '',
            input,
          });
        }
        out.push({ role: 'assistant', content: blocks });
        continue;
      }
      out.push({ role: 'assistant', content: String(msg.content || '') });
      continue;
    }

  }

  flushPendingToolResults();
  return out;
}

export function normalizeMessagesForOpenAICompat(messages) {
  const out = [];

  for (const msg of messages || []) {
    if (!msg?.role) continue;

    if (msg.role === 'system' || msg.role === 'user') {
      out.push({
        role: msg.role,
        content: Array.isArray(msg.content)
          ? msg.content.map(block => {
              if (block?.type !== 'image' || block.source?.type !== 'base64') return block;
              return {
                type: 'image_url',
                image_url: { url: `data:${block.source.media_type};base64,${block.source.data}`, detail: 'auto' },
              };
            })
          : String(msg.content || ''),
      });
      continue;
    }

    if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: String(msg.tool_call_id || ''),
        content: String(msg.content || ''),
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const next = { role: 'assistant' };
      const toolCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls
            .filter(tc => tc?.function?.name)
            .map(tc => ({
              id: String(tc.id || ''),
              type: tc.type || 'function',
              function: {
                name: String(tc.function?.name || ''),
                arguments: String(tc.function?.arguments || ''),
              },
            }))
        : null;

      if (toolCalls?.length) {
        // Some OpenAI-compatible providers (notably MiniMax) are stricter than
        // OpenAI about replayed assistant tool-call messages: keep content as an
        // empty string instead of null and strip any extra internal fields.
        next.content = typeof msg.content === 'string' ? msg.content : '';
        next.tool_calls = toolCalls;
      } else {
        next.content = Array.isArray(msg.content) ? JSON.stringify(msg.content) : String(msg.content || '');
      }

      out.push(next);
    }
  }

  return out;
}

// ── OpenAI-compatible (OpenAI + Ollama) ─────────────────────────────────────
// Always streams — including tool-calling turns. Assistant text reaches the UI
// token-by-token for immediate feedback; tool-call fragments arrive as
// `delta.tool_calls` chunks keyed by `index` and are accumulated as they stream.
export async function openaiCompatibleTurn(client, model, messages, tools, onToken, signal, idleMs = STREAMING_IDLE_MS, modelParams = {}) {
  const params = {
    model,
    messages: normalizeMessagesForOpenAICompat(messages),
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools?.length) params.tools = tools;
  // User-config LLM params (es. temperature, top_p, max_tokens) — sovrascrivono
  // i default cablati (es. MAX_OUTPUT_TOKENS) se esplicitamente impostati.
  Object.assign(params, modelParams);

  raiseSignalListenerCap(signal);

  const { signal: streamSignal, resetTimer, clear } = makeStreamingSignal(signal, idleMs);

  let content = '';
  let usage = null;
  // Tool-call fragments accumulate here, indexed by delta.tool_calls[].index.
  const toolAcc = [];
  // Track reasoning state to wrap delta.reasoning_content as <think>...</think>
  // Supports: MiniMax M2.7, DeepSeek-R1 API (reasoning_content), OpenRouter (reasoning)
  let inReasoning = false;
  let sawFinishReason = false;

  // Stream creation stays inside the try: if it throws, clear() still runs and
  // disarms the idle watchdog (otherwise the 120s timer would leak).
  try {
    const stream = await retryLLMCall(() => client.chat.completions.create(params, { signal: streamSignal }), signal);
    try {
      for await (const chunk of stream) {
        // Final usage chunk (include_usage) carries an empty choices array.
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) sawFinishReason = true;
        const d = choice?.delta;
        if (!d) continue;

        // reasoning_content: MiniMax, DeepSeek API direct; reasoning: OpenRouter unified schema
        const reasoning = d.reasoning_content || d.reasoning || '';
        const text      = d.content || '';

        if (reasoning) {
          resetTimer();
          if (!inReasoning) { onToken?.('<think>'); inReasoning = true; }
          onToken?.(reasoning);
        }
        // Close think BEFORE emitting any visible content/tool_calls — even when
        // the same chunk also carried reasoning. Otherwise the visible text gets
        // routed into the reasoning panel by the agent's stream parser.
        if (inReasoning && (text || d.tool_calls)) {
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
    } catch (error) {
      // Some OpenAI-compatible endpoints close SSE immediately after their
      // terminal finish_reason chunk instead of sending the optional [DONE]
      // sentinel. The SDK reports "Premature close" even though the turn is
      // complete. Never suppress the same error before a terminal chunk.
      if (!(sawFinishReason && /premature close/i.test(error?.message || ''))) throw error;
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
    const canonical = canonicalizeToolTurn({
      tool_calls: toolCalls,
      message: { role: 'assistant', content: content || '' },
    });
    return {
      type: 'tool_calls',
      tool_calls: canonical.calls,
      message: canonical.message,
      usage: usageObj,
    };
  }

  return { type: 'text', content, usage: usageObj };
}

export class OpenAICompatClient {
  constructor(client, model, options = {}) {
    this.client = client;
    this.model = model;
    this._idleMs = options.idleMs || STREAMING_IDLE_MS;
    this._modelParams = options.modelParams || {};
  }
  async turn(messages, tools, onToken, signal) {
    return openaiCompatibleTurn(this.client, this.model, messages, tools, onToken, signal, this._idleMs, this._modelParams);
  }
}

// ── Anthropic ────────────────────────────────────────────────────────────────
// Beta header required by SDK 0.21.x for cache_control. Newer SDKs accept it natively.
const ANTHROPIC_CACHE_HEADER = { 'anthropic-beta': 'prompt-caching-2024-07-31' };

export class AnthropicClient {
  constructor(apiKey, model, options = {}) {
    this.client = new Anthropic({
      apiKey,
      timeout: 180_000,
      maxRetries: 2,
    });
    this.model = model;
    this._idleMs = STREAMING_IDLE_MS;
    this._modelParams = options.modelParams || {};
  }
  async turn(messages, tools, onToken, signal) {
    const system = messages.find(m => m.role === 'system')?.content || '';
    const userMessages = normalizeMessagesForAnthropic(messages);
    const params = { model: this.model, max_tokens: MAX_OUTPUT_TOKENS, messages: userMessages };
    // User-config LLM params (es. temperature, top_p, max_tokens) — sovrascrivono
    // i default cablati (es. MAX_OUTPUT_TOKENS) se esplicitamente impostati.
    Object.assign(params, this._modelParams);
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
    const { signal: streamSignal, resetTimer, clear } = makeStreamingSignal(signal, this._idleMs);

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreate = 0;
    let cacheRead = 0;
    let final;
    // Stream creation stays inside the try: if it throws, clear() still runs and
    // disarms the idle watchdog (otherwise the 120s timer would leak).
    try {
      const stream = await retryLLMCall(
        () => this.client.messages.stream(params, { ...reqOpts, signal: streamSignal }),
        signal,
      );
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
      const canonical = canonicalizeToolTurn({
        tool_calls,
        message: { role: 'assistant', content: final.content },
      });
      return {
        type: 'tool_calls',
        tool_calls: canonical.calls,
        message: canonical.message,
        usage: usageObj,
      };
    }

    const content = final.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    return { type: 'text', content, usage: usageObj };
  }
}
