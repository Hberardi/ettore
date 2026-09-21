// Stream-parsing helpers for the ETTORE agent loop.
//
// The agent's streaming output may include three kinds of control markers:
//   <think>...</think>     — model chain-of-thought (DeepSeek R1, Qwen3, …)
//   <todo>1. ...</todo>    — multi-step plan that drives the UI progress panel
//   <done:N>               — step-N completion marker
//   <plan>{...}</plan>     — explicit pre-execution plan (parsed separately
//                            and surfaced to the user before the run starts)
//   <decision>...</decision> — important decision the model wants logged
//                            (alternatives considered, reasoning, etc.)
//
// Regexes are compiled once at module load. StreamMarkupParser, at the end of
// this file, is the streaming state machine the agent loop feeds chunks into.

export const THINK_BLOCK_RE = /<\s*(think|thinking|reasoning)\s*>[\s\S]*?<\s*\/\s*(think|thinking|reasoning)\s*>/gi;
export const TODO_BLOCK_RE  = /<\s*todo\s*>[\s\S]*?<\s*\/\s*todo\s*>\n?/gi;
export const DONE_MARKER_RE = /<\s*done\s*:\s*\d+\s*\/?\s*>\n?/gi;
export const TODO_CAPTURE_RE = /<\s*todo\s*>([\s\S]*?)<\s*\/\s*todo\s*>/i;
export const THINK_OPEN_RE   = /<\s*(think|thinking|reasoning)(\s[^>]*)?\s*>/i;
export const THINK_CLOSE_RE  = /<\s*\/\s*(think|thinking|reasoning)\s*>/i;
export const THINK_TAG_RE    = /<\s*\/?\s*(think|thinking|reasoning)(\s[^>]*)?\s*>/gi;
// Plan block — full matcher and capture-only variant. Tolerant of whitespace
// and self-closing-ish shapes; the body is parsed by planner.extractPlan.
export const PLAN_BLOCK_RE    = /<\s*plan\s*>[\s\S]*?<\s*\/\s*plan\s*>\n?/gi;
export const PLAN_CAPTURE_RE  = /<\s*plan\s*>([\s\S]*?)<\s*\/\s*plan\s*>/i;
// Decision block — the model can use this to surface choices it made
// ("I went with X because Y, rejected Z because W"). The body is captured
// verbatim and forwarded to workingMemory.decisions + a `decision` event
// for the TUI to display.
//
// DECISION_BLOCK_RE has NO `g` flag on purpose: it is used with
// `String.prototype.replace()` (which only needs a single match in normal
// use) and is also asserted in tests with `.test()`. A global flag would
// make `.test()` stateful (lastIndex carries across calls) and break
// tests that assert multiple distinct inputs. DECISION_CAPTURE_RE DOES
// need `g` because it is consumed by `String.prototype.matchAll`, which
// requires the global flag.
export const DECISION_BLOCK_RE   = /<\s*decision\s*>[\s\S]*?<\s*\/\s*decision\s*>\n?/i;
export const DECISION_CAPTURE_RE = /<\s*decision\s*>([\s\S]*?)<\s*\/\s*decision\s*>/gi;
// Global twin of DECISION_BLOCK_RE, for stripping. Replacing with the
// single-match regex left every block after the first in the text: visible in
// the reply, and matched again by the next chunk's scan.
export const DECISION_BLOCKS_RE  = /<\s*decision\s*>[\s\S]*?<\s*\/\s*decision\s*>\n?/gi;

// Invisible characters that some providers (notably MiniMax M2.7) insert
// between `<` and the tag name. JavaScript's `\s` does NOT include U+200D
// (ZWJ), U+200B/C (zero-width spaces), U+FE00–U+FE0F (variation selectors),
// or U+FEFF (BOM) — so a naive `<\s*tool_call…` regex misses the real
// `<\u200Dtool_call…` shape that ships from these providers. Build a class
// that includes them.
// The variation-selector range comes first on purpose: those are combining
// marks, and no-misleading-character-class flags them when they sit right
// after another character in the class. Order is irrelevant to matching.
export const INVISIBLE_BETWEEN_DELIMS = '\\uFE00-\\uFE0F\\s\\u200B-\\u200F\\uFEFF';

// Optional XML namespace on a protocol tag. MiniMax M2.x/M3 wrap their tool
// calls in `<minimax:tool_call>` — without this the alternation below misses
// the wrapper and only the inner `<invoke>` is recognised.
export const TAG_NAMESPACE = '(?:[A-Za-z][\\w.-]{0,20}:)?';

// Provider framing delimiters that leak into visible content. MiniMax brackets
// streamed protocol fragments with `]<]minimax[>[`; when its server-side
// tool-call parser gives up mid-stream, those delimiters ship to the client
// verbatim, interleaved with the tool-call XML. They are never legitimate
// output, so they are stripped unconditionally.
export const PROVIDER_FRAMING_RE = /\]<\][ \t]*\/?[ \t]*[A-Za-z0-9_.:-]{0,40}\[>\[?/g;

// Tool-call protocol markers that some models emit as RAW TEXT (instead of as
// structured tool_calls deltas). When the parser sees a real tool_call delta
// (OpenAI d.tool_calls, Anthropic tool_use blocks), it goes through the normal
// path. But providers like MiniMax M2.7 occasionally leak fragments of the
// protocol into visible content — usually with zero-width joiners or variation
// selectors around the tag delimiters. We strip these so the user never sees
// `]<]minimax>[<tool_call…` style garbage.
//
// Matched shapes (case-insensitive, whitespace- AND ZWJ/VS-tolerant):
//   <tool_call>…</tool_call>     (Qwen, Mistral)
//   <invoke name="…">…</invoke>  (Qwen2 / XML-style)
//   <function_calls>…</function_calls>
//   <tool_use>…</tool_use>     (Anthropic-style; only the textual form, NOT
//                                the structured tool_use block from the SDK)
//
// `tool` on its own is intentionally NOT included — it's too generic and
// collides with normal prose (`<tool>answer</tool>` in a discussion about
// tooling) and with the existing think-tag-streaming test that asserts
// `<tool>` flows through unchanged.
export const TOOL_CALL_BLOCK_RE = new RegExp(
  `<[${INVISIBLE_BETWEEN_DELIMS}]*${TAG_NAMESPACE}(tool_call|tool_use|invoke|function_calls)\\b` +
  `[\\s\\S]*?` +
  `<[${INVISIBLE_BETWEEN_DELIMS}]*\\/[${INVISIBLE_BETWEEN_DELIMS}]*${TAG_NAMESPACE}\\1[${INVISIBLE_BETWEEN_DELIMS}]*>`,
  'gi',
);
// Self-closing or single-tag forms (`<tool_call … />`, `<tool_call/>`) without
// a closing pair. Only used as a fallback when the model emits a tag without
// ever sending the close — happens with truncated streams.
// Also matches an orphan CLOSING tag (`</invoke>`, `</minimax:tool_call>`).
// Streaming splits a block across chunks, so the open and close halves are
// rarely in the buffer together — each half has to be strippable on its own.
export const TOOL_CALL_SELF_CLOSE_RE = new RegExp(
  `<[${INVISIBLE_BETWEEN_DELIMS}]*\\/?[${INVISIBLE_BETWEEN_DELIMS}]*` +
  `${TAG_NAMESPACE}(tool_call|tool_use|invoke|function_calls)\\b[^>]*\\/?\\s*>`,
  'gi',
);

// Single protocol tags, split by direction. The streaming path needs these
// separately from the block matchers above: an opening tag arriving without
// its close means everything after it — including the tool's own parameter
// tags, whose names no fixed list can cover — must be held off the screen
// until the matching close shows up in a later chunk.
export const TOOL_CALL_OPEN_TAG_RE = new RegExp(
  `<[${INVISIBLE_BETWEEN_DELIMS}]*${TAG_NAMESPACE}` +
  `(?:tool_call|tool_use|invoke|function_calls)\\b[^>]*>`,
  'i',
);
export const TOOL_CALL_CLOSE_TAG_RE = new RegExp(
  `<[${INVISIBLE_BETWEEN_DELIMS}]*\\/[${INVISIBLE_BETWEEN_DELIMS}]*${TAG_NAMESPACE}` +
  `(?:tool_call|tool_use|invoke|function_calls)[${INVISIBLE_BETWEEN_DELIMS}]*>`,
  'gi',
);

// Index just past the LAST protocol closing tag in `text`, or -1 if there is
// none. Used to resume display after a suppressed tool-call block.
export function endOfLastToolCallClose(text) {
  if (!text) return -1;
  let end = -1;
  TOOL_CALL_CLOSE_TAG_RE.lastIndex = 0;
  for (const match of String(text).matchAll(TOOL_CALL_CLOSE_TAG_RE)) {
    end = match.index + match[0].length;
  }
  return end;
}

// Streaming filter for leaked tool-call protocol.
//
// Stripping complete tags is not enough on its own: the *inner* tags of a
// leaked block are the tool's own parameter names (`<command>`, `<file_path>`,
// `<offset>`), which no fixed list can cover. So an opening tag with no close
// yet flips the stream into suppression until its closing tag arrives in a
// later chunk — that, and only that, keeps the whole block off the screen.
//
// `inLeak` is the suppression state carried between chunks. Returns the text
// that is safe to display plus the updated state.
export function filterToolCallStream(text, inLeak = false) {
  let out = String(text ?? '');
  let leaking = Boolean(inLeak);

  if (leaking) {
    // Runs before any stripping, which would eat the closing tag we need.
    const resumeAt = endOfLastToolCallClose(out);
    if (resumeAt < 0) return { text: '', inLeak: true };
    out = out.slice(resumeAt);
    leaking = false;
  }

  // Blocks whose open and close both landed in this chunk go away outright.
  out = out.replace(TOOL_CALL_BLOCK_RE, '');

  // A remaining opener means the rest of the block is still streaming.
  // A self-closing tag has nothing following it, so it is not an opener.
  const open = out.match(TOOL_CALL_OPEN_TAG_RE);
  if (open && !/\/\s*>$/.test(open[0])) {
    leaking = true;
    out = out.slice(0, out.indexOf(open[0]));
  }

  out = out.replace(TOOL_CALL_SELF_CLOSE_RE, '').replace(PROVIDER_FRAMING_RE, '');
  return { text: out, inLeak: leaking };
}

function escapeRegExp(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPrefixAlternation(words = [], { includeFull = false } = {}) {
  const parts = new Set();
  for (const word of words) {
    const s = String(word || '');
    const end = includeFull ? s.length : Math.max(0, s.length - 1);
    for (let i = 1; i <= end; i++) {
      parts.add(s.slice(0, i));
    }
  }
  if (!parts.size) return '';
  return [...parts]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRegExp)
    .join('|');
}

function buildWordAlternation(words = []) {
  return [...new Set(words.map(w => String(w || '')))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRegExp)
    .join('|');
}

function buildPartialTagRegex({ close = false } = {}) {
  const names = close
    ? ['think', 'thinking', 'reasoning', 'todo', 'plan', 'decision']
    : ['think', 'thinking', 'reasoning', 'todo', 'done', 'plan', 'decision'];
  const partialPattern = buildPrefixAlternation(names, { includeFull: false });
  const fullPattern = buildWordAlternation(names);
  const slash = close ? '\\/\\s*' : '';
  const attrSuffix = close ? '' : '(?:\\s*[:\\w-]*)?';
  // Some models emit closing tags as `<\/plan>` — a literal backslash
  // before the slash — to avoid prematurely closing a `<script>` context.
  // The streaming parser must hold the buffer back for the backslash-escaped
  // shapes too, otherwise a chunk ending in `text <\/pla` could leak
  // partial markup into the visible reply.
  const pieces = close
    ? [
        '<\\s*$',
        '<\\s*\\/\\s*$',
        // Bare backslash (`<`, `< `, `<\`, `<  \`).
        '<\\s*\\\\$',
        // Backslash-escaped slash, with or without a tag name fragment
        // (`<\/`, `<\/plan`, `<\/pla`).
        '<\\s*\\\\\\/\\s*$',
      ]
    : ['<\\s*$'];
  if (partialPattern) {
    pieces.push(`<\\s*${slash}(?:${partialPattern})$`);
    if (close) pieces.push(`<\\s*\\\\${slash}(?:${partialPattern})$`);
  }
  if (fullPattern) {
    pieces.push(`<\\s*${slash}(?:${fullPattern})${attrSuffix}$`);
    if (close) pieces.push(`<\\s*\\\\${slash}(?:${fullPattern})${attrSuffix}$`);
  }
  return new RegExp(`(?:${pieces.join('|')})`, 'i');
}

// Hold back only when emitBuffer ends with a partial control tag that the
// parser actually understands (<think>, <todo>, <done:N>). Generic tags such
// as <tool> should flow through immediately instead of stalling the UI.
export const PARTIAL_TAG_OPEN_RE = buildPartialTagRegex();
export const PARTIAL_TAG_CLOSE_RE = buildPartialTagRegex({ close: true });

// A trailing fragment that could still grow into a tool-call protocol tag
// (`<`, `<inv`, `<minimax:tool_c`, `</too`). Streaming splits these across
// chunks, so without a hold-back the first half renders before the stripper
// ever sees a complete tag — which is exactly how `<invoke name="bash">` ends
// up on the user's screen.
const TOOL_TAG_NAMES = ['tool_call', 'tool_use', 'invoke', 'function_calls'];
export const PARTIAL_TOOL_TAG_RE = (() => {
  const withNamespaces = TOOL_TAG_NAMES.flatMap(name => [
    name,
    `minimax:${name}`,
    `antml:${name}`,
  ]);
  const partial = buildPrefixAlternation(withNamespaces, { includeFull: true });
  return new RegExp(`<\\s*\\/?\\s*(?:${partial})?$`, 'i');
})();

// A trailing fragment of the `]<]minimax[>[` framing. Anchored on the
// distinctive `]<]` opener so ordinary prose ending in `]` is never held back.
export const PARTIAL_FRAMING_RE = /(?:\]<\][A-Za-z0-9_.:-]{0,40}(?:\[>?)?|\]<)$/;

// Remove all ETTORE control markers from a string.
export function stripMarkers(text) {
  if (!text) return text;
  return String(text)
    .replace(THINK_BLOCK_RE, '')
    .replace(THINK_TAG_RE, '')
    .replace(TODO_BLOCK_RE, '')
    .replace(DONE_MARKER_RE, '')
    .replace(PLAN_BLOCK_RE, '')
    .replace(DECISION_BLOCKS_RE, '');
}

// Remove just the <plan>...</plan> block, leaving every other marker alone.
// Used by the streaming path so the UI can keep rendering think/todo tags
// while the plan block is being captured.
export function stripPlanBlock(text) {
  if (!text) return text;
  return String(text).replace(PLAN_BLOCK_RE, '');
}

// Remove model reasoning from a finished text, content included: complete
// blocks, an unclosed opener and everything after it (reasoning cut off by the
// token limit), and everything before an orphan close tag (providers that send
// the opener out of band). For text that is kept and re-sent — a compression
// summary carried the summarizer's own <think> into every later request, and
// each re-compression stacked another one on top.
export function stripReasoning(text) {
  if (!text) return text;
  let out = String(text).replace(THINK_BLOCK_RE, '');
  const orphanClose = [...out.matchAll(new RegExp(THINK_CLOSE_RE.source, 'gi'))].pop();
  if (orphanClose) out = out.slice(orphanClose.index + orphanClose[0].length);
  const unclosedOpen = out.match(THINK_OPEN_RE);
  if (unclosedOpen) out = out.slice(0, unclosedOpen.index);
  return out.trim();
}

export function stripThinkTags(text) {
  if (!text) return text;
  return String(text).replace(THINK_TAG_RE, '');
}

// Strip tool-call protocol fragments that the model leaked as raw text. The
// structured tool_calls path is unaffected — this only removes the visible
// garbage (e.g. `]<]minimax>[<tool_call>` patterns from MiniMax M2.7).
export function stripToolCallTags(text) {
  if (!text) return text;
  return String(text)
    .replace(TOOL_CALL_BLOCK_RE, '')
    .replace(TOOL_CALL_SELF_CLOSE_RE, '')
    .replace(PROVIDER_FRAMING_RE, '');
}

// Remove only the provider's streaming framing delimiters, leaving everything
// else untouched. Used on the raw content before tool-call recovery so the
// leaked XML can be parsed as well-formed markup.
export function stripProviderFraming(text) {
  if (!text) return text;
  return String(text).replace(PROVIDER_FRAMING_RE, '');
}

// Parse the items inside a <todo>...</todo> block.
export function parseTodoBlock(blockBody) {
  return String(blockBody || '')
    .split('\n')
    .map(l => l.replace(/^\s*\d+\.\s*/, '').trim())
    .filter(Boolean);
}

// Fallback parser: detect a markdown numbered list (≥3 sequential items) at the
// top of a response. Used when the model emits a plan without <todo> tags.
export function extractMarkdownTodoList(content) {
  if (!content || typeof content !== 'string') return null;
  const lines = content.split('\n');
  const items = [];
  let expected = 1;
  let started = false;
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^(\d+)[.)]\s+(.+?)\s*$/);
    if (m) {
      const num = parseInt(m[1], 10);
      if (!started) {
        if (num !== 1) continue; // list must start at 1
        started = true;
        items.push(m[2]);
        expected = 2;
      } else if (num === expected) {
        items.push(m[2]);
        expected++;
      } else {
        break; // sequence broken
      }
    } else if (started && line === '') {
      continue; // tolerate blank lines between items
    } else if (started) {
      break; // prose breaks the list
    }
  }
  return items.length >= 3 ? items.map(s => s.slice(0, 120)) : null;
}

// Openers of the blocks the parser consumes whole. While one is unclosed the
// buffer has to keep it; otherwise only a short tail can still matter.
const OPEN_TODO_RE = /<\s*todo\s*>/i;
const OPEN_PLAN_RE = /<\s*plan\s*>/i;
const OPEN_DECISION_RE = /<\s*decision\s*>/i;
// Long enough for any partial marker (`<  decision  >`, `<done : 12 />`).
const PARSE_TAIL_CHARS = 48;

/**
 * The streaming state machine for one provider response.
 *
 * Fed raw chunks, it separates what the user should see from the control
 * markup around it: reasoning goes to the think hooks, protocol leaks are
 * suppressed, and each complete <todo>, <plan>, <decision> or <done:N> is
 * reported exactly once and removed from the visible text. The agent owns what
 * those blocks mean; this class only finds them.
 *
 * A response that arrived in one piece (no streaming) goes through `push` as
 * well, with `silent` set, so both paths share one parser and cannot drift.
 *
 * hooks: onVisible(text), onThinkStart(), onThinkToken(text), onThinkEnd(),
 *   wantsTodo() → bool, onTodo(items), wantsPlan() → bool, onPlan(blockText),
 *   onDecision(body), onDone(index)   — every hook is optional.
 */
export class StreamMarkupParser {
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.reset();
  }

  reset() {
    // Text scanned for control blocks. Consumed blocks are removed and the
    // rest is trimmed after each chunk, so the scan stays proportional to
    // what can still form a block rather than to the whole response.
    this.parseBuffer = '';
    // Text that is safe to show once no partial tag is pending at its end.
    this.emitBuffer = '';
    this.inThink = false;
    this.pendingThinkClose = '';
    // Set once the model starts printing tool-call protocol as visible text.
    this.inToolLeak = false;
    this.silent = false;
    this.sawText = false;
  }

  _call(name, ...args) {
    if (this.silent && (name === 'onVisible' || name.startsWith('onThink'))) return undefined;
    return this.hooks[name]?.(...args);
  }

  push(text) {
    if (!text) return;
    this.sawText = true;
    this.parseBuffer += text;
    this.emitBuffer += text;
    if (this.inThink && this.pendingThinkClose) {
      this.emitBuffer = this.pendingThinkClose + this.emitBuffer;
      this.pendingThinkClose = '';
    }
    this._filterThink();
    if (!this.inThink) {
      // Some providers emit a raw closing tag in visible content after
      // sending reasoning through a dedicated reasoning_content field.
      this.emitBuffer = stripThinkTags(this.emitBuffer);
      // Stripping complete tool-call tags is not enough: the blob's inner
      // tags are the tool's own parameter names, which no fixed list covers,
      // so an unclosed opener suppresses display until its close arrives.
      // The raw content still reaches parseTextToolCalls in the agent.
      const filtered = filterToolCallStream(this.emitBuffer, this.inToolLeak);
      this.emitBuffer = filtered.text;
      this.inToolLeak = filtered.inLeak;
      this.parseBuffer = stripToolCallTags(this.parseBuffer);
    }
    this._consumeBlocks();
    this._compactParseBuffer();
    this._flushSafe();
  }

  /** End of the response: emit what is left, minus unclosed markup. */
  finish() {
    if (this.emitBuffer) {
      const finalChunk = this.inThink || this.inToolLeak
        ? '' // discard an unclosed think block / leaked tool-call protocol
        : stripMarkers(stripToolCallTags(this.emitBuffer));
      if (finalChunk) this._call('onVisible', finalChunk);
    }
    this.reset();
  }

  _filterThink() {
    // Handles <think>, <thinking>, <reasoning>; a tag may be split across
    // chunks, so a trailing partial close is held until the next one.
    if (!this.inThink) {
      const openMatch = this.emitBuffer.match(THINK_OPEN_RE);
      if (!openMatch) return;
      const openIdx = openMatch.index;
      const before = this.emitBuffer.slice(0, openIdx);
      const after = this.emitBuffer.slice(openIdx + openMatch[0].length);
      this.inThink = true;
      this._call('onThinkStart');
      const closeMatch = after.match(THINK_CLOSE_RE);
      if (closeMatch) {
        this.emitBuffer = before + after.slice(closeMatch.index + closeMatch[0].length);
        this.inThink = false;
        this._call('onThinkEnd');
      } else {
        const holdFrom = after.match(PARTIAL_TAG_CLOSE_RE)?.index ?? after.length;
        this.emitBuffer = before;
        this.pendingThinkClose = after.slice(holdFrom);
        const thinkContent = after.slice(0, holdFrom);
        if (thinkContent) this._call('onThinkToken', thinkContent);
      }
      return;
    }
    const closeMatch = this.emitBuffer.match(THINK_CLOSE_RE);
    if (closeMatch) {
      const thinkContent = this.emitBuffer.slice(0, closeMatch.index);
      if (thinkContent) this._call('onThinkToken', thinkContent);
      this.emitBuffer = this.emitBuffer.slice(closeMatch.index + closeMatch[0].length);
      this.inThink = false;
      this._call('onThinkEnd');
    } else {
      // Consuming a trailing "</thi" as reasoning would make the split close
      // tag impossible to recognize on the next chunk.
      const holdFrom = this.emitBuffer.match(PARTIAL_TAG_CLOSE_RE)?.index ?? this.emitBuffer.length;
      const thinkContent = this.emitBuffer.slice(0, holdFrom);
      if (thinkContent) this._call('onThinkToken', thinkContent);
      this.pendingThinkClose = this.emitBuffer.slice(holdFrom);
      this.emitBuffer = '';
    }
  }

  _strip(re) {
    this.parseBuffer = this.parseBuffer.replace(re, '');
    this.emitBuffer = this.emitBuffer.replace(re, '');
  }

  _consumeBlocks() {
    if (this.hooks.wantsTodo?.() !== false) {
      const match = this.parseBuffer.match(TODO_CAPTURE_RE);
      if (match) {
        const items = parseTodoBlock(match[1]);
        if (items.length) this._call('onTodo', items);
        this._strip(TODO_BLOCK_RE);
      }
    }
    if (this.hooks.wantsPlan?.()) {
      const match = this.parseBuffer.match(PLAN_CAPTURE_RE);
      if (match) {
        this._call('onPlan', match[0]);
        // Stripped whether or not it parsed, so a malformed plan does not
        // leak its JSON scaffolding into the reply.
        this._strip(PLAN_BLOCK_RE);
      }
    }
    // A block nobody wants any more is still markup, not reply: the final
    // text drops it through stripMarkers, so the stream has to as well.
    this.emitBuffer = this.emitBuffer.replace(TODO_BLOCK_RE, '').replace(PLAN_BLOCK_RE, '');
    const decisions = [...this.parseBuffer.matchAll(DECISION_CAPTURE_RE)];
    if (decisions.length) {
      for (const m of decisions) {
        const body = String(m[1] || '').trim();
        if (body) this._call('onDecision', body);
      }
      this._strip(DECISION_BLOCKS_RE);
    }
    const doneMarkers = [...this.parseBuffer.matchAll(DONE_MARKER_RE)];
    if (doneMarkers.length) {
      for (const m of doneMarkers) this._call('onDone', parseInt(m[0].match(/\d+/)[0], 10) - 1);
      this._strip(DONE_MARKER_RE);
    }
  }

  _compactParseBuffer() {
    const openers = [OPEN_DECISION_RE];
    if (this.hooks.wantsTodo?.() !== false) openers.push(OPEN_TODO_RE);
    if (this.hooks.wantsPlan?.()) openers.push(OPEN_PLAN_RE);
    let keepFrom = Math.max(0, this.parseBuffer.length - PARSE_TAIL_CHARS);
    for (const re of openers) {
      const match = this.parseBuffer.match(re);
      if (match && match.index < keepFrom) keepFrom = match.index;
    }
    if (keepFrom > 0) this.parseBuffer = this.parseBuffer.slice(keepFrom);
  }

  _flushSafe() {
    if (!this.emitBuffer) return;
    // Complete blocks are gone from emitBuffer by now, so an opener still in
    // it has not closed yet. Show what precedes it and hold the rest: with
    // token-by-token streaming nearly every block spans chunks, and flushing
    // past the opener put `<todo>1. …` into the reply.
    let openAt = -1;
    for (const re of [OPEN_TODO_RE, OPEN_PLAN_RE, OPEN_DECISION_RE]) {
      const match = this.emitBuffer.match(re);
      if (match && (openAt < 0 || match.index < openAt)) openAt = match.index;
    }
    if (openAt >= 0) {
      const before = this.emitBuffer.slice(0, openAt);
      this.emitBuffer = this.emitBuffer.slice(openAt);
      if (before) this._call('onVisible', before);
      return;
    }
    // Hold the last bytes only while they could still grow into a control
    // tag this parser suppresses.
    const holdBack = PARTIAL_TAG_OPEN_RE.test(this.emitBuffer)
      || PARTIAL_TAG_CLOSE_RE.test(this.emitBuffer)
      || PARTIAL_TOOL_TAG_RE.test(this.emitBuffer)
      || PARTIAL_FRAMING_RE.test(this.emitBuffer);
    if (holdBack) return;
    const chunk = this.emitBuffer;
    this.emitBuffer = '';
    this._call('onVisible', chunk);
  }
}
