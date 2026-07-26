// Recovery for tool calls a model emitted as RAW TEXT instead of as structured
// tool_calls deltas.
//
// MiniMax M2.x / M3 drive tools with an XML protocol internally:
//
//   ]<]minimax[>[<minimax:tool_call>
//   <invoke name="bash"><command>grep -n foo app.py</command></invoke>
//   </minimax:tool_call>
//
// When their server-side parser fails to convert that into OpenAI
// `tool_calls` deltas — a long argument, an unbalanced quote, a mid-stream
// retry — the raw protocol ships to the client as assistant *content*. The
// agent loop then sees a plain text turn: no tool runs, no error, and the
// session stalls with the model convinced it already called the tool. From
// the user's side the CLI simply stops making progress.
//
// This module parses that leaked blob back into real tool calls so the agent
// loop can execute them through the normal path.
//
// Shapes handled (all case-insensitive and tolerant of the zero-width padding
// these providers insert between delimiters and tag names):
//   <invoke name="tool"><param>value</param></invoke>
//   <invoke name="tool"><parameter name="param">value</parameter></invoke>
//   <tool_call>{"name": "tool", "arguments": {…}}</tool_call>
// with or without a `<tool_call>` / `<minimax:tool_call>` / `<function_calls>`
// wrapper, and tolerating a truncated final `</invoke>`.

import { INVISIBLE_BETWEEN_DELIMS as INV, TAG_NAMESPACE as NS, stripProviderFraming } from './stream-parser.js';

const INVOKE_OPEN_RE = new RegExp(`<[${INV}]*${NS}invoke\\b([^>]*)>`, 'gi');
const INVOKE_CLOSE_RE = new RegExp(`<[${INV}]*\\/[${INV}]*${NS}invoke[${INV}]*>`, 'i');
const NAME_ATTR_RE = /name[\s=]*=?\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const PARAMETER_TAG_RE = new RegExp(
  `<[${INV}]*${NS}parameter\\b([^>]*)>([\\s\\S]*?)<[${INV}]*\\/[${INV}]*${NS}parameter[${INV}]*>`,
  'gi',
);
const CHILD_TAG_RE = /<([A-Za-z_][\w-]{0,63})\s*>([\s\S]*?)<\/\1\s*>/g;
const TOOL_CALL_WRAPPER_RE = new RegExp(
  `<[${INV}]*${NS}(tool_call|tool_use|function_calls)\\b[^>]*>([\\s\\S]*?)` +
  `<[${INV}]*\\/[${INV}]*${NS}\\1[${INV}]*>`,
  'gi',
);
// Any sign that the model was *trying* to call a tool in text. Used to nudge
// the model back onto the native protocol even when nothing parseable came out.
const LEAK_MARKER_RE = new RegExp(
  `<[${INV}]*\\/?[${INV}]*${NS}(?:tool_call|tool_use|invoke|function_calls)\\b`,
  'i',
);

const TOOL_NAME_RE = /^[A-Za-z_][\w.-]{0,63}$/;

// Unique within a process; keeps ids from colliding when the same leaked batch
// is recovered twice in one session.
let callSeq = 0;

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, '&');
}

// Drop the newline that XML-style formatting puts right after the opening tag
// and right before the closing one — but nothing else. A full trim would
// corrupt `write`/`edit` payloads whose leading indentation is significant.
function trimTagBody(text) {
  return String(text).replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

function coerceParamValue(raw) {
  const value = decodeXmlEntities(trimTagBody(raw));
  const probe = value.trim();
  if (!probe) return value;
  if (probe === 'true') return true;
  if (probe === 'false') return false;
  if (probe === 'null') return null;
  // `<offset>1400.0</offset>` — the schema wants a number, and 1400.0 must
  // land as the integer 1400 or the tool's integer check rejects it.
  if (/^-?\d+(?:\.\d+)?$/.test(probe)) {
    const num = Number(probe);
    if (Number.isFinite(num)) return num;
  }
  if (/^[[{]/.test(probe) && /[\]}]$/.test(probe)) {
    try {
      const parsed = JSON.parse(probe);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* not JSON — keep the raw string */ }
  }
  return value;
}

function extractName(attrs) {
  const match = String(attrs || '').match(NAME_ATTR_RE);
  if (!match) return '';
  return String(match[1] ?? match[2] ?? match[3] ?? '').trim();
}

function parseInvokeArgs(body) {
  const args = {};
  let found = 0;

  PARAMETER_TAG_RE.lastIndex = 0;
  for (const match of body.matchAll(PARAMETER_TAG_RE)) {
    const name = extractName(match[1]);
    if (!name) continue;
    args[name] = coerceParamValue(match[2]);
    found++;
  }
  if (found) return args;

  // No <parameter name="…"> wrappers: MiniMax also emits the parameter name
  // directly as the tag (`<file_path>/x.css</file_path>`).
  CHILD_TAG_RE.lastIndex = 0;
  for (const match of body.matchAll(CHILD_TAG_RE)) {
    const name = match[1];
    if (!TOOL_NAME_RE.test(name)) continue;
    args[name] = coerceParamValue(match[2]);
    found++;
  }
  if (found) return args;

  // Last resort: the body is a bare JSON object of arguments.
  const probe = body.trim();
  if (/^\{[\s\S]*\}$/.test(probe)) {
    try {
      const parsed = JSON.parse(probe);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* fall through to empty args */ }
  }
  return args;
}

function pushCall(calls, name, args) {
  const toolName = String(name || '').trim();
  if (!TOOL_NAME_RE.test(toolName)) return;
  calls.push({
    id: `ettore_text_call_${++callSeq}`,
    type: 'function',
    function: {
      name: toolName,
      arguments: JSON.stringify(args && typeof args === 'object' ? args : {}),
    },
  });
}

function parseJsonToolCalls(text, calls) {
  TOOL_CALL_WRAPPER_RE.lastIndex = 0;
  for (const match of text.matchAll(TOOL_CALL_WRAPPER_RE)) {
    const body = match[2];
    // Invoke-shaped bodies are handled by the invoke pass; only JSON bodies
    // reach here.
    if (/<[^>]*invoke\b/i.test(body)) continue;
    const probe = body.trim();
    if (!/^\{[\s\S]*\}$/.test(probe)) continue;
    let payload;
    try { payload = JSON.parse(probe); } catch { continue; }
    if (!payload || typeof payload !== 'object') continue;
    const args = payload.arguments ?? payload.parameters ?? payload.input ?? {};
    pushCall(calls, payload.name, typeof args === 'string' ? safeJson(args) : args);
  }
}

function safeJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Parse tool calls that leaked into assistant text.
//
// Returns:
//   calls    — OpenAI-shaped tool_calls, ready for the normal execution path
//   detected — a tool-call protocol marker was present, even if nothing parsed
//   text     — the visible prose with the leaked protocol removed
export function parseTextToolCalls(rawText) {
  const source = stripProviderFraming(rawText || '');
  const empty = { calls: [], detected: false, text: source };
  if (!source || !LEAK_MARKER_RE.test(source)) return empty;

  const calls = [];
  INVOKE_OPEN_RE.lastIndex = 0;
  let match;
  while ((match = INVOKE_OPEN_RE.exec(source)) !== null) {
    const name = extractName(match[1]);
    if (!name) continue;
    const bodyStart = match.index + match[0].length;
    const rest = source.slice(bodyStart);
    const close = rest.match(INVOKE_CLOSE_RE);
    // A truncated stream loses the final </invoke>; parse up to the next
    // opener (or the end of the blob) rather than dropping the call the model
    // actually intended, and never let one body swallow the calls after it.
    // Whichever comes first wins: a `</invoke>` that sits *after* the next
    // opener belongs to that later call, not to this one.
    const nextOpen = rest.search(new RegExp(`<[${INV}]*${NS}invoke\\b`, 'i'));
    let bodyEnd = rest.length;
    if (close) bodyEnd = Math.min(bodyEnd, close.index);
    if (nextOpen >= 0) bodyEnd = Math.min(bodyEnd, nextOpen);
    pushCall(calls, name, parseInvokeArgs(rest.slice(0, bodyEnd)));
    INVOKE_OPEN_RE.lastIndex = bodyStart + bodyEnd;
  }

  if (!calls.length) parseJsonToolCalls(source, calls);

  return { calls, detected: true, text: source };
}

export const _internal = { coerceParamValue, decodeXmlEntities, parseInvokeArgs, trimTagBody };
