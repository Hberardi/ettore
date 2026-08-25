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
  }

  _deriveThreshold(contextWindow) {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return DEFAULT_THRESHOLD;
    return Math.max(MIN_DYNAMIC_THRESHOLD, Math.floor(contextWindow * DYNAMIC_THRESHOLD_RATIO));
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
    if (estimateTokens(messages) <= halfThreshold) return messages;

    const sys = messages[0];
    const rest = messages.slice(1);
    if (rest.length <= keepLast + 2) return messages;

    const head = rest.slice(0, rest.length - keepLast);
    const tail = rest.slice(-keepLast);

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
    const toCompress = rest.slice(0, keepStart);
    const toKeep = rest.slice(keepStart);

    if (toCompress.length === 0) return messages;

    const tokensBefore = estimateTokens(messages);

    // Save snapshot for undo
    this._snapshot = messages.slice();

    // Call LLM for summary (low temperature, concise). Wrap in a
    // Promise.race against a hard timeout so a provider stall cannot
    // freeze the agent loop forever, and forward any caller-supplied
    // abort signal so a user cancel during compression also unwinds.
    const summaryPrompt = COMPRESSION_PROMPT + serializeForCompression(toCompress);
    let summary = '';
    let degraded = null;
    try {
      const summaryMessages = [
        { role: 'user', content: summaryPrompt }
      ];
      const innerTurn = this.client.turn(summaryMessages, [], (token) => { summary += token; }, signal);
      let timeoutTimer;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new Error(`compression LLM call timed out after ${Math.round(COMPRESS_TURN_TIMEOUT_MS / 1000)}s`)),
          COMPRESS_TURN_TIMEOUT_MS,
        );
      });
      let result;
      try {
        result = await Promise.race([innerTurn, timeoutPromise]);
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
      if (result?.type === 'text') summary = result.content;
    } catch (e) {
      degraded = e?.message || 'compression LLM call failed';
      summary = toCompress
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-5)
        .map(m => `[${m.role}]: ${String(m.content || '').slice(0, 150)}`)
        .join('\n');
    }
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

  getStats(messages) {
    return {
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
