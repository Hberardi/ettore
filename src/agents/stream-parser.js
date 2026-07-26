// Stream-parsing helpers for the ETTORE agent loop.
//
// The agent's streaming output may include three kinds of control markers:
//   <think>...</think>     — model chain-of-thought (DeepSeek R1, Qwen3, …)
//   <todo>1. ...</todo>    — multi-step plan that drives the UI progress panel
//   <done:N>               — step-N completion marker
//
// Regexes are compiled once at module load. Pure functions live here; the
// streaming state machine itself stays in agents/index.js.

export const THINK_BLOCK_RE = /<\s*(think|thinking|reasoning)\s*>[\s\S]*?<\s*\/\s*(think|thinking|reasoning)\s*>/gi;
export const TODO_BLOCK_RE  = /<\s*todo\s*>[\s\S]*?<\s*\/\s*todo\s*>\n?/gi;
export const DONE_MARKER_RE = /<\s*done\s*:\s*\d+\s*\/?\s*>\n?/gi;
export const TODO_CAPTURE_RE = /<\s*todo\s*>([\s\S]*?)<\s*\/\s*todo\s*>/i;
export const THINK_OPEN_RE   = /<\s*(think|thinking|reasoning)(\s[^>]*)?\s*>/i;
export const THINK_CLOSE_RE  = /<\s*\/\s*(think|thinking|reasoning)\s*>/i;
export const THINK_TAG_RE    = /<\s*\/?\s*(think|thinking|reasoning)(\s[^>]*)?\s*>/gi;

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
    ? ['think', 'thinking', 'reasoning', 'todo']
    : ['think', 'thinking', 'reasoning', 'todo', 'done'];
  const partialPattern = buildPrefixAlternation(names, { includeFull: false });
  const fullPattern = buildWordAlternation(names);
  const slash = close ? '\\/\\s*' : '';
  const pieces = close ? ['<\\s*$', '<\\s*\\/\\s*$'] : ['<\\s*$'];
  if (partialPattern) pieces.push(`<\\s*${slash}(?:${partialPattern})$`);
  if (fullPattern) {
    const attrSuffix = close ? '' : '(?:\\s*[:\\w-]*)?';
    pieces.push(`<\\s*${slash}(?:${fullPattern})${attrSuffix}$`);
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
    .replace(DONE_MARKER_RE, '');
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
