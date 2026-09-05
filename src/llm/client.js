import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import { setMaxListeners as setTargetMaxListeners } from 'events';
import { connectionManager } from '../providers/index.js';
import { canonicalizeToolTurn } from '../agents/message-ledger.js';

// Hard cap on model output — prevents infinite generation loops
const MAX_OUTPUT_TOKENS = 8192;

// Claude 3-era models cap `max_tokens` at 4096 and reject anything above it
// with a 400 before generating a single token. Every model since accepts the
// default and beyond, so this is a floor for legacy ids, not a policy.
const LEGACY_4K_OUTPUT_RE = /^claude-3-(opus|sonnet|haiku)\b/i;

export function anthropicOutputCap(model, requested = MAX_OUTPUT_TOKENS) {
  return LEGACY_4K_OUTPUT_RE.test(String(model || '')) ? Math.min(requested, 4096) : requested;
}

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

  if (usesClaudeCodeTransport(provider)) {
    // No key to look up: the local `claude` binary carries the account login.
    return new ClaudeCodeClient(model);
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

export function usesClaudeCodeTransport(provider) {
  return provider === 'claude-code';
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
  // The actual reason, not just "a terminal chunk arrived": `length` means the
  // model was cut off at max_tokens and the turn is unfinished, which the agent
  // loop has to know to avoid presenting a truncated answer as the final one.
  let finishReason = null;

  // Stream creation stays inside the try: if it throws, clear() still runs and
  // disarms the idle watchdog (otherwise the 120s timer would leak).
  try {
    const stream = await retryLLMCall(() => client.chat.completions.create(params, { signal: streamSignal }), signal);
    try {
      for await (const chunk of stream) {
        // Final usage chunk (include_usage) carries an empty choices array.
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) { sawFinishReason = true; finishReason = choice.finish_reason; }
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
      finishReason,
    };
  }

  return { type: 'text', content, usage: usageObj, finishReason };
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

// Anthropic accepts at most four cache breakpoints per request. We spend them
// on, in order of how much they save: the tool list, the system prompt, the
// compressed-context summary, and a rolling one at the end of the transcript.
const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

/**
 * Tags the end of the transcript so the *next* turn reads the whole history
 * back from cache instead of re-sending it at full price.
 *
 * Without this the only cached blocks are the system prompt and the tool list,
 * so every turn pays full input price for the entire conversation again — a
 * cost that grows quadratically over an agentic loop. The breakpoint rolls
 * forward each turn: the prefix it wrote last turn is what this turn hits.
 *
 * Mutates `messages` in place (they are freshly built by the normalizer) and
 * returns the number of breakpoints now present.
 */
export function applyRollingCacheBreakpoint(messages, budget) {
  let used = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block && typeof block === 'object' && block.cache_control) used++;
    }
  }
  if (used >= budget) return used;

  // Walk back to the last message carrying a taggable block. A trailing
  // message with no content blocks (or only unknown shapes) is skipped rather
  // than silently dropping the breakpoint.
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (!Array.isArray(content) || !content.length) continue;
    const block = content[content.length - 1];
    if (!block || typeof block !== 'object') continue;
    if (block.cache_control) return used;
    block.cache_control = { type: 'ephemeral' };
    return used + 1;
  }
  return used;
}

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
    // Applied last so a legacy model is clamped whether the ceiling came from
    // the default or from user config.
    params.max_tokens = anthropicOutputCap(this.model, params.max_tokens);
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
    // Whatever is left of the four-breakpoint budget after the system prompt
    // and the tool list goes to the transcript.
    applyRollingCacheBreakpoint(
      userMessages,
      ANTHROPIC_MAX_CACHE_BREAKPOINTS - (params.system ? 1 : 0) - (params.tools ? 1 : 0),
    );
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

    // Normalized onto the OpenAI spelling so the agent loop has one thing to check.
    const finishReason = final.stop_reason === 'max_tokens' ? 'length' : (final.stop_reason || null);

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
        finishReason,
      };
    }

    const content = final.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    return { type: 'text', content, usage: usageObj, finishReason };
  }
}

// ── Claude Code bridge ───────────────────────────────────────────────────────
// Drives the locally installed, already-logged-in `claude` binary in headless
// mode so Ettore can reach the user's Anthropic account without an API key.
// Claude Code runs as a *raw model*: its own tools, MCP servers, settings and
// slash commands are all switched off, and Ettore's system prompt replaces the
// built-in one. Since that transport exposes no structured tool schema, tools
// are declared in the prompt and called back through the textual `<tool_call>`
// protocol the stream parser already understands.
//
// Trade-offs vs. the API-key transports: no prompt caching (each turn is a
// fresh headless session carrying the whole transcript), no temperature /
// max_tokens control, and image attachments are dropped.

// Claude Code adds process startup plus its own internal retries on top of the
// model's own pauses, so it gets the long idle window.
const CLAUDE_CODE_IDLE_MS = STREAMING_IDLE_MS_LONG_REASONING;

const CLAUDE_CODE_TOOL_PROTOCOL = `## Tool calling protocol

This transport has no native tool API. To call a tool, emit a block shaped
exactly like this and nothing else around it:

<tool_call>{"name": "TOOL_NAME", "arguments": {"arg": "value"}}</tool_call>

Rules:
- The block body must be valid JSON. No markdown fences, no comments, no trailing text inside the block.
- To run several tools at once, emit the blocks back to back.
- Stop generating right after the last block: results come back as the next turn.
- Only the tools listed below exist. Never invent a tool or a parameter.
- When no tool is needed, just answer normally and emit no block.`;

const CLAUDE_CODE_CONTINUATION = `Continue the conversation above: produce only the next assistant turn. `
  + `Do not repeat or summarise earlier turns, and do not re-emit a tool call whose result is already present.`;

function flattenContentForClaudeCode(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .map(block => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text') return String(block.text || '');
      // The CLI takes a single text prompt — image blocks cannot be forwarded.
      if (block?.type === 'image' || block?.type === 'image_url') {
        return '[image attachment omitted — not supported by the Claude Code bridge]';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function buildClaudeCodeSystemPrompt(systemText, tools) {
  const base = String(systemText || '').trim();
  if (!tools?.length) return base;
  const catalog = tools
    .map(t => {
      const fn = t.function || {};
      const schema = JSON.stringify(fn.parameters ?? { type: 'object', properties: {} });
      return `### ${fn.name}\n${fn.description || ''}\ninput schema: ${schema}`;
    })
    .join('\n\n');
  return [base, CLAUDE_CODE_TOOL_PROTOCOL, `## Available tools\n\n${catalog}`]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Headless `claude -p` is stateless, so the whole conversation travels in the
 * prompt. Assistant tool calls are replayed in the same textual shape the model
 * is asked to produce, keeping the transcript self-consistent.
 */
export function serializeTranscriptForClaudeCode(messages) {
  const parts = [];

  for (const msg of messages || []) {
    if (!msg || msg.role === 'system') continue;

    if (msg.role === 'user') {
      parts.push(`<user>\n${flattenContentForClaudeCode(msg.content)}\n</user>`);
      continue;
    }

    if (msg.role === 'tool') {
      const id = String(msg.tool_call_id || '');
      parts.push(`<tool_result id="${id}">\n${String(msg.content ?? '')}\n</tool_result>`);
      continue;
    }

    if (msg.role === 'assistant') {
      const text = flattenContentForClaudeCode(msg.content);
      const calls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
        .filter(tc => tc?.function?.name)
        .map(tc => {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
          return `<tool_call>${JSON.stringify({ id: tc.id, name: tc.function.name, arguments: args })}</tool_call>`;
        })
        .join('\n');
      const body = [text, calls].filter(Boolean).join('\n');
      parts.push(`<assistant>\n${body}\n</assistant>`);
    }
  }

  return `<conversation>\n${parts.join('\n')}\n</conversation>\n\n${CLAUDE_CODE_CONTINUATION}`;
}

const CLAUDE_CODE_TOOL_CALL_RE = /<\s*(tool_call|tool_use)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;

/**
 * Pulls textual tool calls out of a completed reply. Returns the OpenAI-shaped
 * calls plus the visible text with the blocks removed.
 */
export function parseClaudeCodeToolCalls(text) {
  const raw = String(text || '');
  const calls = [];
  let index = 0;

  for (const match of raw.matchAll(CLAUDE_CODE_TOOL_CALL_RE)) {
    // Models occasionally wrap the JSON in a markdown fence despite the rules.
    const body = match[2].trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(body); } catch { continue; }
    const name = String(parsed?.name || parsed?.tool || '').trim();
    if (!name) continue;
    const args = parsed.arguments ?? parsed.parameters ?? parsed.input ?? {};
    calls.push({
      id: String(parsed.id || '').trim() || `toolu_cc_${Date.now().toString(36)}_${index}`,
      type: 'function',
      function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
    });
    index++;
  }

  const content = raw.replace(CLAUDE_CODE_TOOL_CALL_RE, '').trim();
  return { calls, content };
}

export function buildClaudeCodeArgs(model, systemPrompt) {
  return [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--no-session-persistence',
    '--disable-slash-commands',
    // Isolation: no user/project settings, no MCP servers, no built-in tools —
    // Claude Code must behave as a bare model, not as a second coding agent.
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--tools', '',
    '--model', String(model || 'sonnet'),
    '--system-prompt', String(systemPrompt || ''),
  ];
}

/**
 * Drops the session variables Claude Code exports to its own children. Without
 * this, running Ettore from inside a Claude Code session would leak that
 * session's identity into the bridge. The OAuth token is deliberately kept —
 * it is a credential, not session state.
 */
export function sanitizeClaudeEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'CLAUDECODE') continue;
    if (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CODE_OAUTH_TOKEN') continue;
    out[key] = value;
  }
  return out;
}

export class ClaudeCodeClient {
  constructor(model, options = {}) {
    this.model = model || 'sonnet';
    this.bin = options.bin || process.env.ETTORE_CLAUDE_BIN || 'claude';
    this.cwd = options.cwd || process.cwd();
    this._idleMs = options.idleMs || CLAUDE_CODE_IDLE_MS;
    this._spawn = options.spawn || spawn;
  }

  async turn(messages, tools, onToken, signal) {
    const system = buildClaudeCodeSystemPrompt(
      messages.find(m => m.role === 'system')?.content || '',
      tools,
    );
    const prompt = serializeTranscriptForClaudeCode(messages);

    raiseSignalListenerCap(signal);
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }

    const child = this._spawn(this.bin, buildClaudeCodeArgs(this.model, system), {
      cwd: this.cwd,
      env: sanitizeClaudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let content = '';
    let usage = null;
    let resultError = null;
    let apiErrorStatus = null;
    let stopReason = null;
    let turnModel = null;
    let inThinking = false;
    let stderrTail = '';
    let buffer = '';

    const emit = token => { if (token) onToken?.(token); };

    const handleEvent = obj => {
      if (obj.type === 'stream_event') {
        const event = obj.event;
        // The only authoritative name for the model answering this turn.
        // `modelUsage` in the result event is keyed by *every* model the CLI
        // touched, side tasks of its own included, so its first key is
        // routinely some other model entirely.
        if (event?.type === 'message_start' && event.message?.model) {
          turnModel = String(event.message.model);
          return;
        }
        if (event?.type !== 'content_block_delta') return;
        const delta = event.delta || {};
        if (delta.type === 'thinking_delta' && delta.thinking) {
          if (!inThinking) { emit('<think>'); inThinking = true; }
          emit(delta.thinking);
          return;
        }
        if (delta.type === 'text_delta' && delta.text) {
          if (inThinking) { emit('</think>'); inThinking = false; }
          emit(delta.text);
          content += delta.text;
        }
        return;
      }

      if (obj.type === 'result') {
        const u = obj.usage || {};
        // `modelUsage` carries the window of each model the CLI resolved: the
        // `opus` alias lands on a pinned id whose context window is nothing
        // like the 128k the pricing table guesses for an unknown name. Reading
        // it lets the compressor size itself against the real window instead
        // of compressing far too early — but only the entry for *this* turn's
        // model, never simply the first one.
        const byModel = obj.modelUsage || {};
        const resolvedName = turnModel && byModel[turnModel]
          ? turnModel
          : Object.keys(byModel).length === 1 ? Object.keys(byModel)[0] : turnModel;
        const resolvedMeta = resolvedName ? byModel[resolvedName] : null;
        usage = {
          inputTokens:  u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheCreate:  u.cache_creation_input_tokens ?? 0,
          cacheRead:    u.cache_read_input_tokens ?? 0,
          // The subscription is prepaid, so this is not a bill — it is the
          // API-equivalent spend, which is the only honest way to answer
          // "how much did that turn cost me" on a plan.
          costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
          resolvedModel: resolvedName || null,
          contextWindow: Number(resolvedMeta?.contextWindow) || null,
        };
        stopReason = obj.stop_reason || null;
        if (obj.is_error) {
          resultError = String(obj.result || obj.subtype || 'Claude Code returned an error');
          // Carried onto the thrown error so the shared provider-error
          // translator can classify it — a 429 here is a Pro/Max usage limit,
          // and without the status it reaches the user as raw CLI prose.
          apiErrorStatus = obj.api_error_status ?? null;
        }
      }
    };

    await new Promise((resolve, reject) => {
      let settled = false;
      let idleTimer = null;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      };

      const kill = () => { try { child.kill('SIGTERM'); } catch {} };

      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          kill();
          finish(new Error(`Streaming idle timeout — no token for ${this._idleMs / 1000}s`));
        }, this._idleMs);
        idleTimer.unref?.();
      };

      function onAbort() {
        kill();
        const err = new Error('Aborted');
        err.name = 'AbortError';
        finish(err);
      }

      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', chunk => {
        armIdle();
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try { handleEvent(JSON.parse(line)); } catch { /* non-JSON noise */ }
        }
      });

      child.stderr?.setEncoding('utf-8');
      child.stderr?.on('data', chunk => {
        stderrTail = (stderrTail + chunk).slice(-2000);
      });

      child.on('error', err => {
        finish(new Error(
          `Failed to run the Claude Code CLI ("${this.bin}"): ${err.message}. `
          + 'Install it with `npm i -g @anthropic-ai/claude-code`, or set ETTORE_CLAUDE_BIN.',
        ));
      });

      child.on('close', code => {
        if (buffer.trim()) {
          try { handleEvent(JSON.parse(buffer.trim())); } catch { /* partial line */ }
        }
        if (code === 0) return finish();
        finish(new Error(
          `Claude Code exited with code ${code}${stderrTail ? `: ${stderrTail.trim()}` : ''}`,
        ));
      });

      armIdle();
      child.stdin.on('error', () => {}); // child may exit before the prompt lands
      child.stdin.end(prompt);
    });

    if (inThinking) emit('</think>');
    if (resultError) {
      const err = new Error(`Claude Code: ${resultError}`);
      if (apiErrorStatus != null) err.status = Number(apiErrorStatus) || apiErrorStatus;
      throw err;
    }

    // Normalized onto the OpenAI spelling, as the other transports do, so the
    // agent's truncation handling is not blind on this one.
    const finishReason = stopReason === 'max_tokens' ? 'length' : (stopReason || null);

    const { calls, content: visible } = parseClaudeCodeToolCalls(content);
    if (calls.length) {
      const canonical = canonicalizeToolTurn({
        tool_calls: calls,
        message: { role: 'assistant', content: visible },
      });
      return {
        type: 'tool_calls',
        tool_calls: canonical.calls,
        message: canonical.message,
        usage,
        finishReason,
      };
    }

    return { type: 'text', content: visible, usage, finishReason };
  }
}
