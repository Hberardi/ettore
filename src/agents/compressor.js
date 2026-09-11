import { getConfig, saveConfig } from '../config/index.js';
import { safeHistoryKeepStart } from './message-ledger.js';

const DEFAULT_THRESHOLD = 8000;
const DEFAULT_KEEP_LAST = 10;
// Was 5: each compression does cost one LLM call but saves exponentially
// more on subsequent turns. Letting it run further keeps the session cost
// curve flat for long coding sessions.
const MAX_COMPRESSIONS_PER_SESSION = 8;
// Was 0.7: every tool result is re-sent on every subsequent turn, so the
// marginal cost of an extra 1000 history tokens compounds. 0.3 means we
// compress well before the model is at risk of forgetting recent context.
const DYNAMIC_THRESHOLD_RATIO = 0.3;
const MIN_DYNAMIC_THRESHOLD = 4000;
// The ratio above was tuned against 128k-200k windows, where 30% lands around
// 40-60k. Applied to a million-token model it would let the transcript reach
// 300k before compressing — and since every turn re-sends the whole thing,
// "we have room" is not the same as "this is free". A model with a bigger
// window buys headroom against truncation, not licence to spend. Cap at what
// a 200k window already produced.
const MAX_DYNAMIC_THRESHOLD = 60_000;
const HARD_GUARD_RATIO = 0.92;
// Hard ceiling on the compression LLM call. Without it, a provider stall
// hangs the agent loop indefinitely — the main turn has its own
// `Promise.race` against `AGENT_TURN_TIMEOUT_MS`, but the compressor's
// inner `client.turn` was previously called with `null` as the abort
// signal and no timeout, so a network stall at exactly this point froze
// the CLI forever. 90s is well above any healthy compression latency and
// well below "the user has already given up and re-launched".
const COMPRESS_TURN_TIMEOUT_MS = 90_000;

const COMPRESSION_PROMPT = `You are a context compression assistant. Analyze the conversation below and produce a dense, structured summary for an AI coding assistant to continue the session seamlessly.

Produce a summary following EXACTLY this structure. Be terse and factual. Omit pleasantries, verbose tool outputs, and redundant exchanges.

## PROJECT
- Stack: [languages, frameworks, key deps]
- Entry points: [main files identified]

## FILES MODIFIED
- path/to/file — [what changed and why]

## DECISIONS MADE
- [concrete technical decisions taken during session]

## PENDING / IN PROGRESS
- [tasks mentioned but not completed]

## USER PREFERENCES
- [style preferences, naming conventions, explicit requests]

## LAST ACTION
- [the very last thing done or said, to resume smoothly]

CONVERSATION TO COMPRESS:
`;

// Patterns to remove from tool results before compression (injection mitigation)
const INJECTION_PATTERNS = [
  /\b(ignore|forget|disregard)\s+(all\s+)?(previous|prior|above)\s+(instructions?|context|rules?)/gi,
  /you\s+are\s+now\s+/gi,
  /<\|.*?\|>/g,
];

export function estimateTokens(messages, tools = []) {
  const messageTokens = messages.reduce((acc, m) => {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(block => block?.type === 'text' ? block.text || '' : '[image]').join(' ')
        : m.content ? JSON.stringify(m.content) : '';
    let tokens = Math.ceil(text.length / 4);
    if (Array.isArray(m.content)) tokens += m.content.filter(block => block?.type === 'image' || block?.type === 'image_url').length * 1200;
    // Include tool_calls payload (function name + arguments) which can be
    // substantial and is otherwise invisible to the estimator.
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc.function;
        if (fn) tokens += Math.ceil(((fn.name?.length || 0) + (fn.arguments?.length || 0)) / 4);
      }
    }
    return acc + tokens;
  }, 0);
  const toolTokens = (tools || []).reduce((acc, tool) => {
    const serialized = JSON.stringify(tool || {});
    return acc + Math.ceil(serialized.length / 4);
  }, 0);
  return messageTokens + toolTokens;
}

function sanitizeToolResult(content) {
  if (typeof content !== 'string') return String(content || '');
  let safe = content;
  for (const p of INJECTION_PATTERNS) {
    safe = safe.replace(p, '[SANITIZED]');
  }
  return safe.slice(0, 3000); // hard cap on individual tool outputs
}

function serializeForCompression(messages) {
  return messages.map(m => {
    if (m.role === 'tool') {
      return `[tool result: ${sanitizeToolResult(m.content)}]`;
    }
    if (m.role === 'assistant' && m.tool_calls) {
      const calls = m.tool_calls.map(tc => `${tc.function?.name}(${tc.function?.arguments?.slice(0, 100) || ''})`).join(', ');
      return `[assistant called tools: ${calls}]`;
    }
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(block => block?.type === 'text' ? block.text || '' : '[image attachment]').join(' ')
        : JSON.stringify(m.content);
    return `[${m.role}]: ${content.slice(0, 500)}`;
  }).join('\n');
}

export class ContextCompressor {
  constructor(client, config = {}) {
    this.client = client;
    this.contextWindow = Number(config.contextWindow) || null;
    this.threshold = config.threshold || getConfig('compressionThreshold') || this._deriveThreshold(this.contextWindow);
    this.keepLast = DEFAULT_KEEP_LAST;
    // Default ON: only an explicit false in config disables auto-compact.
    // The privacy notice fires once per profile via [[compressPrivacyNotice]].
    this.autoEnabled = getConfig('compressionAutoEnabled') !== false;
    this._sessionCount = 0;
    this._totalSaved = 0;
    this._history = [];
    this._snapshot = null; // for undo
    this._privacyWarned = getConfig('compressionPrivacyWarned') || false;
    // Builds the client that writes summaries — a fast model of the same
    // provider — or returns null to use the session's own. Resolved lazily
    // and cached: `undefined` means not asked yet, `null` means none usable.
    this._summaryClientFactory = typeof config.summaryClientFactory === 'function'
      ? config.summaryClientFactory
      : null;
    this._fastClient = undefined;
    // A summary started in the background once the transcript nears the
    // threshold, so the compression that follows does not stall the loop.
    this.prefetchRatio = 0.75;
    this._prefetchJob = null;
  }

  _deriveThreshold(contextWindow) {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return DEFAULT_THRESHOLD;
    return Math.max(
      MIN_DYNAMIC_THRESHOLD,
      Math.min(MAX_DYNAMIC_THRESHOLD, Math.floor(contextWindow * DYNAMIC_THRESHOLD_RATIO)),
    );
  }

  getHardGuardLimit(contextWindowOverride = null, outputReserve = 8192) {
    const ctx = Number(contextWindowOverride) || this.contextWindow;
    if (!Number.isFinite(ctx) || ctx <= 0) return null;
    const reserve = Math.min(
      Math.max(1024, Number(outputReserve) || 8192),
      Math.floor(ctx * 0.5),
    );
    return Math.max(1000, Math.min(
      Math.floor(ctx * HARD_GUARD_RATIO),
      ctx - reserve,
    ));
  }

  updateContextWindow(contextWindow) {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
    this.contextWindow = contextWindow;
    const savedThreshold = getConfig('compressionThreshold');
    // If user did not set a custom threshold, keep threshold aligned to context size.
    if (!savedThreshold) {
      this.threshold = this._deriveThreshold(contextWindow);
    }
  }

  // No __compressed short-circuit here: after a compression the token count
  // drops below threshold on its own, and climbs again only as new messages
  // accumulate — at which point a further compression (up to the session cap)
  // is exactly what we want. A permanent marker check would disable every
  // compression after the first.
  needsCompression(messages, thresholdOverride = null) {
    if (this._sessionCount >= MAX_COMPRESSIONS_PER_SESSION) return false;
    const threshold = Number.isFinite(thresholdOverride) && thresholdOverride > 0
      ? thresholdOverride
      : this.threshold;
    return estimateTokens(messages) > threshold;
  }

  // Heuristic, zero-cost token reduction applied opportunistically between
  // turns, well before the full LLM-based compression is justified.
  //
  // Strategy: for tool-result messages older than the last `keepLast` turns,
  // replace the body with a 200-char head + metadata so the model still has
  // the function name, key arguments, and a hint of what came back, but the
  // body of the result (often the bulk of a session) is gone.
  //
  // Activates at half the compression threshold — keeps the LLM-driven
  // compressor as the heavier hammer for when this isn't enough.
  lossyShrink(messages, { keepLast = this.keepLast, maxChars = 200, headTail = 150 } = {}) {
    const halfThreshold = Math.max(2000, Math.floor(this.threshold / 2));
    const tokens = estimateTokens(messages);
    if (tokens <= halfThreshold) return messages;

    const sys = messages[0];
    const rest = messages.slice(1);
    if (rest.length <= keepLast + 2) return messages;

    const head = rest.slice(0, rest.length - keepLast);
    const tail = rest.slice(-keepLast);

    // With a prompt cache in play, every elision rewrites a message the cache
    // already holds, and everything after it is prefilled again at full price.
    // A steady loop moves one result out of the tail per iteration, so eager
    // elision paid that on the recent tail every single call. Batch it: wait
    // until a few results have piled up and elide them in one go; close to the
    // threshold, elide regardless. Without an observed cache there is nothing
    // to protect, and eager elision stays the cheaper choice.
    const LOSSY_BATCH = 4;
    const LOSSY_FORCE_RATIO = 0.9;
    if (this.cacheObserved && tokens < this.threshold * LOSSY_FORCE_RATIO) {
      const pending = head.filter(m => m.role === 'tool' && String(m.content || '').length > maxChars * 2).length;
      if (pending < LOSSY_BATCH) return messages;
    }

    const shrunkenHead = head.map((m) => {
      if (m.role !== 'tool') return m;
      const text = String(m.content || '');
      if (text.length <= maxChars * 2) return m;
      const firstNL = text.indexOf('\n');
      const firstLine = firstNL >= 0 ? text.slice(0, firstNL) : text.slice(0, headTail);
      return {
        ...m,
        content: `[elided — original ${text.length} chars] ${firstLine.slice(0, headTail)}…`,
        __lossyShrunk: true,
      };
    });

    return [sys, ...shrunkenHead, ...tail];
  }

  async buildPreview(messages) {
    const tokensBefore = estimateTokens(messages);
    const rest = messages.slice(1);
    const keepStart = safeHistoryKeepStart(rest, this.keepLast);
    const keepCount = rest.length - keepStart;
    const eligible = rest.length > keepCount + 2;
    return {
      eligible,
      currentTokens: tokensBefore,
      threshold: this.threshold,
      msgCount: messages.length - 1,
      compressCount: rest.length - keepCount,
    };
  }

  async compress(messages, emitter, signal = null) {
    if (!this._privacyWarned) {
      emitter?.emit('compressPrivacyNotice');
      this._privacyWarned = true;
      saveConfig('compressionPrivacyWarned', true);
    }

    const system = messages[0];
    const rest = messages.slice(1);
    const keepStart = safeHistoryKeepStart(rest, this.keepLast);

    // A summary prefetched in the background is used when the messages it
    // covers are still, object for object, the head of this transcript. It
    // may cover a little less than a fresh split would; the rest is kept. A
    // user cancel stops the wait, not the loop: the fresh path below then
    // unwinds on the same signal.
    let prefetched = this._takePrefetched(rest);
    if (prefetched) {
      const aborted = new Promise(resolve => {
        if (!signal) return;
        if (signal.aborted) resolve({ degraded: 'aborted' });
        else signal.addEventListener('abort', () => resolve({ degraded: 'aborted' }), { once: true });
      });
      const outcome = await Promise.race([prefetched.promise, aborted]);
      prefetched = outcome.degraded ? null : { ...prefetched, summary: outcome.summary };
    }

    const toCompress = prefetched ? prefetched.prefix : rest.slice(0, keepStart);
    const toKeep = rest.slice(toCompress.length);

    if (toCompress.length === 0) return messages;

    const tokensBefore = estimateTokens(messages);

    // Save snapshot for undo
    this._snapshot = messages.slice();

    let summary = prefetched ? prefetched.summary : '';
    let degraded = null;
    if (!prefetched) ({ summary, degraded } = await this._summarize(toCompress, signal));
    if (degraded) {
      // Surface the degraded path to the UI so the user knows the summary is
      // a low-quality fallback, not an LLM-produced one.
      emitter?.emit('compressionFallback', { reason: degraded });
    }

    const summaryMsg = {
      role: 'user',
      content: `[COMPRESSED CONTEXT — previous conversation]\n${summary.trim()}\n[END COMPRESSED CONTEXT]`,
      __compressed: true,
      // Hint to Anthropic's prompt cache: the summary is identical across the
      // remaining turns of the session, so caching it cuts input tokens for
      // every subsequent model call. The OpenAI-compatible path ignores this
      // field (the messages normalizer doesn't forward it), so it's free for
      // providers that don't use cache_control.
      _cacheControl: { type: 'ephemeral' },
    };
    const ackMsg = {
      role: 'assistant',
      content: 'Context loaded. Continuing from where we left off.',
    };

    const compressed = [system, summaryMsg, ackMsg, ...toKeep];
    const tokensAfter = estimateTokens(compressed);
    const saved = tokensBefore - tokensAfter;

    this._sessionCount++;
    this._totalSaved += saved;
    this._history.push({
      timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
      before: tokensBefore,
      after: tokensAfter,
      savedPct: Math.round((saved / tokensBefore) * 100),
    });

    emitter?.emit('contextCompressed', {
      fromCount: messages.length - 1,
      toCount: compressed.length - 1,
      savedTokens: saved,
      tokensBefore,
      tokensAfter,
    });

    return compressed;
  }

  undo(_currentMessages) {
    if (!this._snapshot) return { success: false, reason: 'No snapshot available' };
    const restored = this._snapshot;
    this._snapshot = null;
    this._sessionCount = Math.max(0, this._sessionCount - 1);
    return { success: true, messages: restored, restoredTokens: estimateTokens(restored) };
  }

  // ── Summary client ────────────────────────────────────────────────────────

  _getFastClient() {
    if (this._fastClient === undefined) {
      // A factory that throws (provider not connected, say) means "none".
      try { this._fastClient = this._summaryClientFactory?.() || null; } catch { this._fastClient = null; }
    }
    return this._fastClient;
  }

  /** Forget the cached summary client, after /compress model changes it. */
  resetSummaryClient() {
    this._fastClient = undefined;
    this._prefetchJob = null;
  }

  summaryModelLabel() {
    const fast = this._getFastClient();
    return fast ? (fast.label || fast.model || 'fast model') : 'main model';
  }

  async _callSummary(client, prompt, signal) {
    let summary = '';
    // Compression is summarisation, and it is an extra call on top of the
    // turn that triggered it. Spending the session's effort setting on it
    // pays for depth the task does not need.
    const innerTurn = client.turn([{ role: 'user', content: prompt }], [], (token) => { summary += token; }, signal, { effort: 'low' });
    // Hard ceiling so a provider stall cannot freeze the agent loop.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`compression LLM call timed out after ${Math.round(COMPRESS_TURN_TIMEOUT_MS / 1000)}s`)),
        COMPRESS_TURN_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    try {
      const result = await Promise.race([innerTurn, timeout]);
      if (result?.type === 'text') summary = result.content;
    } finally {
      clearTimeout(timer);
    }
    return summary;
  }

  /**
   * A summary of `toCompress` from the fast client when there is one, else
   * from the session's client, plus `degraded` when neither could write it.
   * Never rejects.
   */
  async _summarize(toCompress, signal) {
    const prompt = COMPRESSION_PROMPT + serializeForCompression(toCompress);
    const fast = this._getFastClient();
    if (fast && fast !== this.client) {
      try {
        const summary = await this._callSummary(fast, prompt, signal);
        if (String(summary || '').trim()) return { summary, degraded: null };
      } catch (e) {
        // A model the provider refuses will be refused again: stop asking
        // for the rest of the session. A timeout or a 5xx may not recur.
        const status = e?.status || e?.statusCode;
        if ([400, 401, 403, 404].includes(status) || /model.*not.*(found|exist)/i.test(e?.message || '')) {
          this._fastClient = null;
        }
      }
    }
    try {
      return { summary: await this._callSummary(this.client, prompt, signal), degraded: null };
    } catch (e) {
      return {
        summary: toCompress
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(-5)
          .map(m => `[${m.role}]: ${String(m.content || '').slice(0, 150)}`)
          .join('\n'),
        degraded: e?.message || 'compression LLM call failed',
      };
    }
  }

  /**
   * Fed each turn's usage. Any cached read or write proves the provider keeps
   * a prefix cache for this session, which makes lossyShrink batch its
   * elisions instead of rewriting the cached history every iteration.
   */
  noteCacheActivity(usage) {
    if ((Number(usage?.cacheRead) || 0) + (Number(usage?.cacheCreate) || 0) > 0) {
      this.cacheObserved = true;
    }
  }

  // ── Background prefetch ───────────────────────────────────────────────────

  /**
   * Starts summarising the compressible head in the background once the
   * transcript passes `prefetchRatio` of the threshold, so the compression
   * that follows finds the summary ready instead of holding the loop for a
   * whole model call. Returns true when a job was started.
   */
  prefetch(messages) {
    if (!this.autoEnabled || this._prefetchJob) return false;
    if (this._sessionCount >= MAX_COMPRESSIONS_PER_SESSION) return false;
    const tokens = estimateTokens(messages);
    if (tokens < this.threshold * this.prefetchRatio || tokens > this.threshold) return false;
    const rest = messages.slice(1);
    const prefix = rest.slice(0, safeHistoryKeepStart(rest, this.keepLast));
    if (prefix.length === 0) return false;
    // No signal: the job outlives the run that started it, and a cancelled
    // run is no reason to throw away a summary the next compression can use.
    this._prefetchJob = { prefix, promise: this._summarize(prefix, null) };
    return true;
  }

  // The prefetched job, when the messages it summarised are still the exact
  // head of `rest` — the same objects, so nothing under it was rewritten.
  _takePrefetched(rest) {
    const job = this._prefetchJob;
    this._prefetchJob = null;
    if (!job || job.prefix.length > rest.length) return null;
    for (let i = 0; i < job.prefix.length; i++) {
      if (rest[i] !== job.prefix[i]) return null;
    }
    return job;
  }

  getStats(messages) {
    return {
      summaryModel: this.summaryModelLabel(),
      usedTokens: messages ? estimateTokens(messages) : 0,
      maxTokens: this.threshold,
      compressionCount: this._sessionCount,
      totalSaved: this._totalSaved,
      autoEnabled: this.autoEnabled,
      threshold: this.threshold,
    };
  }

  getHistory() {
    return this._history;
  }

  async setAuto(enabled) {
    this.autoEnabled = enabled;
    saveConfig('compressionAutoEnabled', enabled);
  }

  async setThreshold(n) {
    this.threshold = n;
    saveConfig('compressionThreshold', n);
  }
}
