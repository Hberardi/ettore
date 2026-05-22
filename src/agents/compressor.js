import { getConfig, saveConfig } from '../config/index.js';

const DEFAULT_THRESHOLD = 8000;
const DEFAULT_KEEP_LAST = 10;
const MAX_COMPRESSIONS_PER_SESSION = 5;
const DYNAMIC_THRESHOLD_RATIO = 0.7;
const MIN_DYNAMIC_THRESHOLD = 6000;
const HARD_GUARD_RATIO = 0.92;
const MIN_HARD_GUARD = 12000;

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

export function estimateTokens(messages) {
  return messages.reduce((acc, m) => {
    const text = typeof m.content === 'string'
      ? m.content
      : m.content ? JSON.stringify(m.content) : '';
    return acc + Math.ceil(text.length / 4);
  }, 0);
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
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return `[${m.role}]: ${content.slice(0, 500)}`;
  }).join('\n');
}

// Ensure we never split a tool_call / tool pair across the keep boundary
function safeKeepCount(messages, keepLast) {
  let count = keepLast;
  while (count < messages.length) {
    const firstKept = messages[messages.length - count];
    if (firstKept?.role === 'tool') {
      count++; // expand to include the matching assistant turn
    } else {
      break;
    }
  }
  return count;
}

export class ContextCompressor {
  constructor(client, config = {}) {
    this.client = client;
    this.contextWindow = Number(config.contextWindow) || null;
    this.threshold = config.threshold || getConfig('compressionThreshold') || this._deriveThreshold(this.contextWindow);
    this.keepLast = DEFAULT_KEEP_LAST;
    this.autoEnabled = getConfig('compressionAutoEnabled') || false;
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

  getHardGuardLimit(contextWindowOverride = null) {
    const ctx = Number(contextWindowOverride) || this.contextWindow;
    if (!Number.isFinite(ctx) || ctx <= 0) return null;
    return Math.max(MIN_HARD_GUARD, Math.floor(ctx * HARD_GUARD_RATIO));
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

  needsCompression(messages, thresholdOverride = null) {
    if (this._sessionCount >= MAX_COMPRESSIONS_PER_SESSION) return false;
    // Skip if already has a compression marker at index 1
    if (messages[1]?.__compressed) return false;
    const threshold = Number.isFinite(thresholdOverride) && thresholdOverride > 0
      ? thresholdOverride
      : this.threshold;
    return estimateTokens(messages) > threshold;
  }

  async buildPreview(messages) {
    const tokensBefore = estimateTokens(messages);
    const rest = messages.slice(1);
    const keepCount = safeKeepCount(rest, this.keepLast);
    const eligible = rest.length > keepCount + 2;
    return {
      eligible,
      currentTokens: tokensBefore,
      threshold: this.threshold,
      msgCount: messages.length - 1,
      compressCount: rest.length - keepCount,
    };
  }

  async compress(messages, emitter) {
    if (!this._privacyWarned) {
      emitter?.emit('compressPrivacyNotice');
      this._privacyWarned = true;
      saveConfig('compressionPrivacyWarned', true);
    }

    const system = messages[0];
    const rest = messages.slice(1);
    const keepCount = safeKeepCount(rest, this.keepLast);
    const toCompress = rest.slice(0, rest.length - keepCount);
    const toKeep = rest.slice(rest.length - keepCount);

    if (toCompress.length === 0) return messages;

    const tokensBefore = estimateTokens(messages);

    // Save snapshot for undo
    this._snapshot = messages.slice();

    // Call LLM for summary (low temperature, concise)
    const summaryPrompt = COMPRESSION_PROMPT + serializeForCompression(toCompress);
    let summary = '';
    let degraded = null;
    try {
      const summaryMessages = [
        { role: 'user', content: summaryPrompt }
      ];
      const result = await this.client.turn(summaryMessages, [], (token) => { summary += token; }, null);
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
