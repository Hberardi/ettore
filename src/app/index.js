import React from 'react';
const { createElement: h, useState, useEffect, useRef, useCallback } = React;
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { EventEmitter } from 'events';
import { readdir } from 'fs/promises';
import { join, resolve } from 'path';
import Fuse from 'fuse.js';

import { connectionManager, ConnectionManager } from '../providers/index.js';
import { PROVIDER_REGISTRY } from '../providers/registry.js';
import { loadConfig, saveConfig, getConfig } from '../config/index.js';
import { createClient } from '../llm/client.js';
import { Agent } from '../agents/index.js';
import { createSession, saveSession, listSessions, loadSession } from '../sessions/index.js';
import { uiBridge } from '../tools/bridge.js';
import { toolProgressKey } from '../tools/index.js';
import { truncate, sanitizeLLMText, formatK, toolLabel } from './helpers.js';

// ─── Themes ──────────────────────────────────────────────────────────────────
export const THEMES = {
  default: {
    label: 'Default',
    description: 'Cyan accent on black',
    accent:  'cyan',
    text:    'white',
    dim:     '#999',
    ok:      'green',
    warn:    'yellow',
    err:     'red',
    tool:    'cyan',
    primary: 'cyan',
    muted:   '#999',
  },
  midnight: {
    label: 'Midnight',
    description: 'Blue accent on black',
    accent:  '#5588ff',
    text:    '#ccd6f6',
    dim:     '#8899bb',
    ok:      '#64ffda',
    warn:    '#ffa657',
    err:     '#ff5555',
    tool:    '#5588ff',
    primary: '#5588ff',
    muted:   '#8899bb',
  },
  forest: {
    label: 'Forest',
    description: 'Green accent on black',
    accent:  '#00ff88',
    text:    '#d4f5e2',
    dim:     '#7faa8f',
    ok:      '#00ff88',
    warn:    '#f0e68c',
    err:     '#ff6b6b',
    tool:    '#00ff88',
    primary: '#00ff88',
    muted:   '#7faa8f',
  },
  sunset: {
    label: 'Sunset',
    description: 'Orange accent on black',
    accent:  '#ff7b54',
    text:    '#ffe8d6',
    dim:     '#bb8877',
    ok:      '#a8e063',
    warn:    '#ffd700',
    err:     '#ff4757',
    tool:    '#ff7b54',
    primary: '#ff7b54',
    muted:   '#bb8877',
  },
  lavender: {
    label: 'Lavender',
    description: 'Purple accent on black',
    accent:  '#bd93f9',
    text:    '#f8f8f2',
    dim:     '#9aa5ce',
    ok:      '#50fa7b',
    warn:    '#f1fa8c',
    err:     '#ff5555',
    tool:    '#bd93f9',
    primary: '#bd93f9',
    muted:   '#9aa5ce',
  },
  matrix: {
    label: 'Matrix',
    description: 'Green on black, hacker style',
    accent:  '#00ff00',
    text:    '#00cc00',
    dim:     '#338833',
    ok:      '#00ff00',
    warn:    '#ccff00',
    err:     '#ff0000',
    tool:    '#00ff00',
    primary: '#00ff00',
    muted:   '#338833',
  },
  mono: {
    label: 'Mono',
    description: 'White/grey, no color',
    accent:  'white',
    text:    'white',
    dim:     '#aaa',
    ok:      '#ccc',
    warn:    '#ddd',
    err:     '#bbb',
    tool:    'white',
    primary: 'white',
    muted:   '#aaa',
  },
  blueprint: {
    label: 'Blueprint',
    description: 'Black bg, white text, blue accent',
    accent:  '#4fc3f7',
    text:    'white',
    dim:     '#90a4ae',
    ok:      '#81c784',
    warn:    '#ffb74d',
    err:     '#e57373',
    tool:    '#4fc3f7',
    primary: '#4fc3f7',
    muted:   '#90a4ae',
  },
};

// Active theme (can be updated at runtime, shared across renders via module ref)
let _activeTheme = THEMES.default;
let _savedTheme  = null; // theme saved before preview mode

export function getTheme() { return _activeTheme; }

export function setTheme(name) {
  if (THEMES[name]) {
    _activeTheme = THEMES[name];
    _savedTheme  = null;
    saveConfig('theme', name);
  }
}

export function previewTheme(name) {
  if (!_savedTheme) _savedTheme = _activeTheme; // save original on first preview
  if (THEMES[name]) _activeTheme = THEMES[name];
}

export function cancelPreview() {
  if (_savedTheme) { _activeTheme = _savedTheme; _savedTheme = null; }
}

export function confirmPreview() {
  const confirmed = Object.keys(THEMES).find(k => THEMES[k] === _activeTheme);
  _savedTheme = null;
  if (confirmed) saveConfig('theme', confirmed);
}

// C is a proxy-like getter so components always read the current theme
const C = new Proxy({}, { get: (_, k) => _activeTheme[k] });

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Pure helpers (truncate, sanitizeLLMText, formatK, toolLabel) live in ./helpers.js
// so they can be unit-tested in isolation. Imported below.

// ─── LLM output sanitizer ─────────────────────────────────────────────────────
// Strips ANSI sequences and invisible Unicode chars from LLM-generated text.
// Apply to all text received from the LLM before rendering — NOT to tool output.
// ─── Token helpers ───────────────────────────────────────────────────────────

function tokenColor(used, limit) {
  const ratio = used / limit;
  if (ratio >= 0.85) return C.err;
  if (ratio >= 0.60) return C.warn;
  return C.ok;
}

function TokenBadge({ used, limit, cacheHitRatio }) {
  const color = tokenColor(used, limit);
  const ratio = Math.min(1, used / limit);
  const SLOTS = 5;
  const filled = Math.round(ratio * SLOTS);
  const bar = '█'.repeat(filled) + '░'.repeat(SLOTS - filled);
  const hasCache = Number.isFinite(cacheHitRatio) && cacheHitRatio > 0;
  return h(Box, { flexDirection: 'row' },
    h(Text, { color: C.dim }, '['),
    h(Text, { color: color, bold: ratio >= 0.85 }, formatK(used)),
    h(Text, { color: C.dim }, '/'),
    h(Text, { color: C.dim }, formatK(limit)),
    h(Text, { color: C.dim }, ' '),
    h(Text, { color: color }, bar),
    h(Text, { color: C.dim }, ']'),
    hasCache && h(Text, { color: C.ok }, ` 💾 ${Math.round(cacheHitRatio * 100)}%`),
  );
}

function CompressionNotice({ fromCount, toCount, savedTokens }) {
  return h(Box, { flexDirection: 'row', marginY: 0, paddingX: 1 },
    h(Text, { color: C.dim }, '┄┄  '),
    h(Text, { color: C.dim }, 'contesto compresso: '),
    h(Text, { color: C.accent, bold: true }, String(fromCount)),
    h(Text, { color: C.dim }, ' msg → '),
    h(Text, { color: C.ok, bold: true }, String(toCount)),
    h(Text, { color: C.dim }, ' msg  ('),
    h(Text, { color: C.warn }, `~${formatK(savedTokens)} token risparmiati`),
    h(Text, { color: C.dim }, ')  ┄┄'),
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

function Header({ provider, model, mode, sessionId, memoryInfo, memorySaved, tokenInfo }) {
  const modeLabel = mode === 'plan' ? ' PLAN ' : ' BUILD ';
  const modeColor = mode === 'plan' ? C.warn : C.ok;
  return h(Box, {
    borderStyle: 'bold',
    borderColor: C.accent,
    width: '100%',
    paddingX: 1,
    flexDirection: 'row',
  },
    h(Text, { bold: true, color: C.accent }, '⬡  ETTORE'),
    h(Text, { color: C.dim }, '  ·  '),
    h(Text, { color: C.dim }, truncate(sessionId || '', 10)),
    memoryInfo && h(Text, { color: C.dim }, '  ·  '),
    memoryInfo && h(Text, { color: C.accent }, `📦 ${memoryInfo.projectName}`),
    memorySaved && h(Text, { color: C.ok }, `  💾 ${memorySaved}`),
    tokenInfo && h(Text, { color: C.dim }, '  '),
    tokenInfo && h(TokenBadge, { used: tokenInfo.used, limit: tokenInfo.limit, cacheHitRatio: tokenInfo.cacheHitRatio }),
    h(Box, { flexGrow: 1 }),
    provider && h(Text, { color: C.dim }, `${provider}  `),
    model && h(Text, { color: C.text }, `${truncate(model, 30)}  `),
    h(Text, { color: C.dim }, '['),
    h(Text, { color: modeColor, bold: true }, modeLabel),
    h(Text, { color: C.dim }, ']'),
  );
}

function CodeLines({ lines, extra, color, prefix, prefixColor }) {
  return h(Box, { flexDirection: 'column', marginLeft: 2 },
    ...lines.map((line, i) =>
      h(Box, { key: i, flexDirection: 'row' },
        h(Text, { color: prefixColor || C.dim }, prefix || '│ '),
        h(Text, { color: color || C.dim, wrap: 'truncate-end' }, line || ' '),
      )
    ),
    extra > 0 && h(Box, { flexDirection: 'row' },
      h(Text, { color: C.dim }, prefix || '│ '),
      h(Text, { color: C.dim }, `… +${extra} more lines`),
    ),
  );
}

function ToolCallView({ tool }) {
  const { action, detail } = toolLabel(tool.name, tool.args);
  const isDone    = tool.status === 'done';
  const isError   = tool.output && String(tool.output).startsWith('Error');
  const icon      = isDone ? '✔' : '◌';
  const iconColor = isDone ? (isError ? C.err : C.ok) : C.warn;

  let preview = null;
  const MAX = 5;

  if (isError) {
    const lines = String(tool.output).split('\n').filter(l => l.trim()).slice(0, 3);
    preview = h(CodeLines, { lines, extra: 0, color: C.err, prefix: '✗ ', prefixColor: C.err });

  } else if (tool.name === 'bash' && tool.output) {
    const all = String(tool.output).split('\n').filter(l => l.trim());
    preview = h(CodeLines, { lines: all.slice(0, MAX), extra: Math.max(0, all.length - MAX), color: C.dim });

  } else if (tool.name === 'write' && tool.args?.content) {
    const all = tool.args.content.split('\n');
    const extra = Math.max(0, all.length - MAX);
    preview = h(Box, { flexDirection: 'column' },
      h(Text, { color: C.dim, marginLeft: 2 }, `${all.length} lines`),
      h(CodeLines, { lines: all.slice(0, MAX), extra, color: C.text }),
    );

  } else if (tool.name === 'edit' && (tool.args?.old_string || tool.args?.new_string)) {
    const oldAll  = (tool.args.old_string || '').split('\n');
    const newAll  = (tool.args.new_string || '').split('\n');
    const DIFF_MAX = 3;
    preview = h(Box, { flexDirection: 'column', marginLeft: 2 },
      ...oldAll.slice(0, DIFF_MAX).map((line, i) =>
        h(Box, { key: `o${i}`, flexDirection: 'row' },
          h(Text, { color: C.err }, '- '),
          h(Text, { color: C.err, wrap: 'truncate-end' }, line || ' '),
        )
      ),
      oldAll.length > DIFF_MAX && h(Text, { color: C.dim }, `  … -${oldAll.length - DIFF_MAX} more`),
      ...newAll.slice(0, DIFF_MAX).map((line, i) =>
        h(Box, { key: `n${i}`, flexDirection: 'row' },
          h(Text, { color: C.ok }, '+ '),
          h(Text, { color: C.ok, wrap: 'truncate-end' }, line || ' '),
        )
      ),
      newAll.length > DIFF_MAX && h(Text, { color: C.dim }, `  … +${newAll.length - DIFF_MAX} more`),
    );

  } else if (tool.name === 'read' && tool.output) {
    const all = String(tool.output).split('\n').filter(l => l.trim());
    preview = h(CodeLines, { lines: all.slice(0, MAX), extra: Math.max(0, all.length - MAX), color: C.dim });

  } else if ((tool.name === 'grep' || tool.name === 'glob') && tool.output) {
    const all = String(tool.output).split('\n').filter(l => l.trim());
    preview = h(CodeLines, { lines: all.slice(0, MAX), extra: Math.max(0, all.length - MAX), color: C.text });
  }

  const progressLine = (!isDone && tool.progress)
    ? h(Box, { flexDirection: 'row', marginLeft: 2 },
        h(Text, { color: C.warn }, '↻ '),
        h(Text, { color: C.dim, wrap: 'truncate-end' }, tool.progress),
      )
    : null;

  return h(Box, { flexDirection: 'column', marginLeft: 3, marginBottom: 0 },
    h(Box, { flexDirection: 'row' },
      h(Text, { color: iconColor, bold: true }, `${icon} `),
      h(Text, { color: C.tool, bold: !isDone }, action),
      detail && h(Text, { color: isDone ? C.dim : C.text }, `  ${detail}`),
    ),
    progressLine,
    preview,
  );
}

function TodoBlockView({ items }) {
  const icon = (status) => {
    if (status === 'done')    return h(Text, { color: C.ok,   bold: true }, '✔ ');
    if (status === 'running') return h(Text, { color: C.warn, bold: true }, '◌ ');
    return h(Text, { color: C.dim }, '○ ');
  };
  return h(Box, { flexDirection: 'column', marginBottom: 1, paddingLeft: 2 },
    h(Text, { color: C.accent, bold: true }, 'Tasks'),
    h(Text, { color: C.dim }, '─'.repeat(32)),
    ...(!items || items.length === 0
      ? [h(Text, { color: C.dim }, 'no tasks')]
      : items.map((t, i) =>
          h(Box, { key: i, flexDirection: 'row' },
            h(Text, { color: C.dim }, `${String(i + 1).padStart(2)}. `),
            icon(t.status),
            h(Text, {
              color: t.status === 'done' ? C.dim : C.text,
              strikethrough: t.status === 'done',
              wrap: 'truncate-end',
            }, t.text),
          )
        )
    ),
  );
}

// ─── Markdown renderer ────────────────────────────────────────────────────────
// Renders inline text segments: **bold** and `inline code`.
// Returns a single element (Text) or a Box with multiple Text children.
function renderInlineSegments(text, baseColor) {
  const parts = [];
  let rest = text;
  while (rest.length > 0) {
    const boldIdx = rest.indexOf('**');
    const codeIdx = rest.indexOf('`');
    const first = Math.min(
      boldIdx >= 0 ? boldIdx : Infinity,
      codeIdx >= 0 ? codeIdx : Infinity,
    );
    if (first === Infinity) {
      parts.push(h(Text, { key: parts.length, color: baseColor, wrap: 'wrap' }, rest));
      break;
    }
    if (first > 0) {
      parts.push(h(Text, { key: parts.length, color: baseColor, wrap: 'wrap' }, rest.slice(0, first)));
    }
    if (first === boldIdx) {
      const end = rest.indexOf('**', boldIdx + 2);
      if (end === -1) { parts.push(h(Text, { key: parts.length, color: baseColor, wrap: 'wrap' }, rest.slice(boldIdx))); break; }
      parts.push(h(Text, { key: parts.length, color: baseColor, bold: true }, rest.slice(boldIdx + 2, end)));
      rest = rest.slice(end + 2);
    } else {
      const end = rest.indexOf('`', codeIdx + 1);
      if (end === -1) { parts.push(h(Text, { key: parts.length, color: baseColor, wrap: 'wrap' }, rest.slice(codeIdx))); break; }
      parts.push(h(Text, { key: parts.length, color: C.tool }, rest.slice(codeIdx + 1, end)));
      rest = rest.slice(end + 1);
    }
  }
  if (parts.length === 0) return h(Text, { color: baseColor }, '');
  if (parts.length === 1) return parts[0];
  return h(Box, { flexDirection: 'row', flexWrap: 'wrap' }, ...parts);
}

// Renders a single line with markdown formatting for terminal display.
// isCode = true when inside a ``` code block.
function MarkdownLine({ line, isCode }) {
  if (isCode) {
    return h(Box, { flexDirection: 'row' },
      h(Text, { color: C.dim }, '│ '),
      h(Text, { color: C.tool, wrap: 'truncate-end' }, line || ' '),
    );
  }
  const m1 = line.match(/^#\s+(.*)/);
  if (m1) return h(Box, { flexDirection: 'row' },
    h(Text, { color: C.accent }, '│ '),
    h(Text, { color: C.accent, bold: true }, m1[1]),
  );
  const m2 = line.match(/^##\s+(.*)/);
  if (m2) return h(Box, { flexDirection: 'row' },
    h(Text, { color: C.accent }, '│ '),
    h(Text, { color: C.accent, bold: true }, '▌ '),
    h(Text, { color: C.accent, bold: true }, m2[1]),
  );
  const m3 = line.match(/^###\s+(.*)/);
  if (m3) return h(Box, { flexDirection: 'row' },
    h(Text, { color: C.dim }, '│ '),
    h(Text, { color: C.tool }, '› '),
    h(Text, { color: C.text, bold: true }, m3[1]),
  );
  const bullet = line.match(/^(\s*)([-*•])\s+(.*)/);
  if (bullet) {
    const nested = bullet[1].length > 0;
    return h(Box, { flexDirection: 'row' },
      h(Text, { color: C.dim }, '│ '),
      h(Text, { color: C.accent, bold: true }, nested ? '    ◇ ' : '  ◆ '),
      renderInlineSegments(bullet[3], C.text),
    );
  }
  const numbered = line.match(/^(\d+)\.\s+(.*)/);
  if (numbered) return h(Box, { flexDirection: 'row' },
    h(Text, { color: C.dim }, '│ '),
    h(Text, { color: C.accent, bold: true }, `${numbered[1]}. `),
    renderInlineSegments(numbered[2], C.text),
  );
  if (/^(---+|===+|\*\*\*+)$/.test(line.trim())) return h(Box, { flexDirection: 'row' },
    h(Text, { color: C.dim }, '│ '),
    h(Text, { color: C.dim }, '┄'.repeat(40)),
  );
  return h(Box, { flexDirection: 'row' },
    h(Text, { color: C.dim }, '│ '),
    renderInlineSegments(line, C.text),
  );
}

function MessageView({ msg, maxLines }) {
  const isUser = msg.role === 'user';
  const isAssistant = msg.role === 'assistant';
  const isSystem = msg.role === 'system';
  if (msg.role === 'todos') return h(TodoBlockView, { items: msg.items });
  if (msg.role === 'compression') return h(CompressionNotice, { fromCount: msg.fromCount, toCount: msg.toCount, savedTokens: msg.savedTokens });
  if (!isUser && !isAssistant && !isSystem) return null;

  // Limit lines per message to prevent overflow
  const MAX_LINES = maxLines || 20;
  const allLines = msg.text ? msg.text.split('\n') : [];
  const visibleLines = allLines.slice(0, MAX_LINES);
  const truncatedLines = Math.max(0, allLines.length - MAX_LINES);

  // For assistant messages: render with markdown support
  // Track code-block state across lines
  let codeBlock = false;
  const renderedLines = visibleLines.map((line, i) => {
    if (isAssistant) {
      const isFence = line.trim().startsWith('```');
      if (isFence) {
        codeBlock = !codeBlock;
        const lang = line.trim().slice(3).trim();
        return h(Box, { key: i, flexDirection: 'row' },
          h(Text, { color: C.dim }, '│ '),
          h(Text, { color: C.dim }, lang ? `‹ ${lang} ›` : '‹ code ›'),
        );
      }
      return h(MarkdownLine, { key: i, line, isCode: codeBlock });
    }
    // User / system messages: plain text
    return h(Box, { key: i, flexDirection: 'row' },
      h(Text, { color: C.dim }, '│ '),
      h(Text, { wrap: 'wrap', color: isSystem ? C.dim : C.text }, line),
    );
  });

  return h(Box, { flexDirection: 'column', marginBottom: 1, marginTop: 0 },
    h(Box, { flexDirection: 'row', marginBottom: 0 },
      isUser
        ? h(Text, { color: C.accent, bold: true }, '▸ you')
        : isSystem
        ? h(Text, { color: C.dim, bold: true }, '▸ system')
        : h(Text, { color: C.primary, bold: true }, '⬡ ettore'),
    ),
    msg.text && h(Box, { flexDirection: 'column', paddingLeft: 2 },
      ...renderedLines,
      truncatedLines > 0 && h(Box, { flexDirection: 'row' },
        h(Text, { color: C.dim }, '│ '),
        h(Text, { color: C.dim, italic: true }, `… ${truncatedLines} more lines`),
      ),
    ),
    (msg.tools || []).length > 0 && h(Box, { flexDirection: 'column', marginTop: 0 },
      ...(msg.tools || []).map((tool, i) =>
        h(ToolCallView, { key: i, tool })
      ),
    ),
  );
}

const THINK_MAX_LINES = 8; // max lines of reasoning shown live

function StreamingMessage({ text, tools, thinking, thinkText, thinkTokens }) {
  const hasTools = (tools || []).length > 0;
  const statusLabel = thinking
    ? `  reasoning…${thinkTokens > 0 ? `  (${formatK(thinkTokens)} tok)` : ''}`
    : text && !hasTools ? '  writing…'
    : hasTools          ? '  working…'
    :                     '  thinking…';

  // Show last N lines of the think block live
  const thinkLines = thinkText
    ? thinkText.split('\n').filter(l => l.trim())
    : [];
  const thinkVisible = thinkLines.slice(-THINK_MAX_LINES);
  const thinkHidden  = Math.max(0, thinkLines.length - THINK_MAX_LINES);

  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Box, { flexDirection: 'row' },
      h(BlinkingDot),
      h(Text, { color: C.primary, bold: true }, ' ettore'),
      h(Text, { color: thinking ? C.warn : C.dim }, statusLabel),
    ),
    // ── Reasoning block (shown while thinking OR after thinking ends if there's content) ──
    thinkText && h(Box, { flexDirection: 'column', paddingLeft: 2, marginTop: 0 },
      h(Box, { flexDirection: 'row' },
        h(Text, { color: C.warn }, '◈ '),
        h(Text, { color: C.warn, bold: true }, 'reasoning'),
        thinkTokens > 0 && h(Text, { color: C.dim }, `  ${formatK(thinkTokens)} tok`),
      ),
      thinkHidden > 0 && h(Box, { flexDirection: 'row' },
        h(Text, { color: C.dim }, '  '),
        h(Text, { color: C.dim, italic: true }, `… ${thinkHidden} earlier lines`),
      ),
      ...thinkVisible.map((line, i) =>
        h(Box, { key: i, flexDirection: 'row' },
          h(Text, { color: C.dim }, '┆ '),
          h(Text, { wrap: 'wrap', color: C.dim, italic: true }, line),
        )
      ),
      !thinking && h(Text, { color: C.dim }, '┄'.repeat(32)),
    ),
    // ── Actual response ──
    text && h(Box, { flexDirection: 'column', paddingLeft: 2 },
      ...text.split('\n').map((line, i) =>
        h(Box, { key: i, flexDirection: 'row' },
          h(Text, { color: C.dim }, '│ '),
          h(Text, { wrap: 'wrap', color: C.text }, line),
        )
      ),
    ),
    (tools || []).map((tool, i) =>
      h(ToolCallView, { key: i, tool })
    ),
  );
}

// ─── List item helper ─────────────────────────────────────────────────────────
function ListItem({ isSelected, left, dim }) {
  return h(Box, { flexDirection: 'row' },
    h(Text, { color: C.accent }, isSelected ? ' ❯ ' : '   '),
    h(Text, { color: isSelected ? C.text : C.dim, bold: isSelected, wrap: 'truncate-end' }, left),
    dim && h(Text, { color: C.dim }, `  ${dim}`),
  );
}

// ─── Models Dialog ────────────────────────────────────────────────────────────
function ModelsDialog({ allModels, query, onQueryChange, selectedIdx }) {
  const MAX_VISIBLE = 16;
  const filtered = query.trim()
    ? allModels.filter(m => m.label.toLowerCase().includes(query.toLowerCase()))
    : allModels;
  const safeIdx = Math.max(0, Math.min(selectedIdx, filtered.length - 1));
  const half = Math.floor(MAX_VISIBLE / 2);
  const start = filtered.length <= MAX_VISIBLE ? 0 : Math.max(0, Math.min(safeIdx - half, filtered.length - MAX_VISIBLE));
  const visible = filtered.slice(start, start + MAX_VISIBLE);
  const providerSet = new Set(allModels.map(m => m.provider));

  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: C.accent,
    width: '100%',
    paddingX: 1,
  },
    h(Box, { flexDirection: 'row', marginBottom: 0 },
      h(Text, { color: C.accent, bold: true }, '  Models'),
      h(Text, { color: C.dim }, `  ${[...providerSet].join(', ')}`),
      h(Box, { flexGrow: 1 }),
      h(Text, { color: C.dim }, `${filtered.length}/${allModels.length}  ↑↓ · enter · esc`),
    ),
    h(Box, { flexDirection: 'row', marginBottom: 0 },
      h(Text, { color: C.dim }, '  ╱ '),
        h(Box, { flexGrow: 1 },
          h(TextInput, {
            value: query,
            onChange: onQueryChange,
            placeholder: 'filter…',
          }),
        ),
    ),
    ...visible.map((m, i) => {
      const absIdx = start + i;
      return h(ListItem, { key: absIdx, isSelected: absIdx === safeIdx, left: m.id, dim: m.provider });
    }),
    filtered.length === 0 && h(Text, { color: C.dim }, '   no results'),
    filtered.length > MAX_VISIBLE && h(Text, { color: C.dim },
      `   ${start + 1}–${Math.min(start + MAX_VISIBLE, filtered.length)} of ${filtered.length}`
    ),
  );
}

// ─── Connect Dialog ───────────────────────────────────────────────────────────
function ConnectDialog({ step, selectedIdx, providers, selectedProvider, keyValue, onKeyChange, models, modelIdx, status, connectQuery, onConnectQueryChange }) {
  const MAX_MODELS = 16;
  const stepHints = [
    '↑↓ navigate  enter select  esc close',
    'enter connect  backspace back  esc close',
    '↑↓ page↑↓  enter confirm  backspace back',
  ];

  // Virtual scroll for step 2 model list
  const filtered = (step === 2 && connectQuery?.trim())
    ? models.filter(m => { const id = typeof m === 'string' ? m : m.id; return id.toLowerCase().includes(connectQuery.toLowerCase()); })
    : models;
  const safeIdx = Math.max(0, Math.min(modelIdx, filtered.length - 1));
  const half = Math.floor(MAX_MODELS / 2);
  const start = filtered.length <= MAX_MODELS ? 0 : Math.max(0, Math.min(safeIdx - half, filtered.length - MAX_MODELS));
  const visibleModels = filtered.slice(start, start + MAX_MODELS);

  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: C.accent,
    width: '100%',
    paddingX: 1,
  },
    h(Box, { flexDirection: 'row', marginBottom: 0 },
      h(Text, { color: C.accent, bold: true }, '  Connect'),
      h(Text, { color: C.dim }, `  ${step + 1}/3`),
      h(Box, { flexGrow: 1 }),
      h(Text, { color: C.dim }, stepHints[step] || ''),
    ),
    step === 0 && h(Box, { flexDirection: 'column' },
      ...providers.map((p, i) =>
        h(ListItem, {
          key: p.id,
          isSelected: i === selectedIdx,
          left: p.name,
          dim: p.requiresKey ? p.description : `${p.description}  (no key needed)`,
        })
      ),
    ),
    step === 1 && selectedProvider && h(Box, { flexDirection: 'column' },
      h(Text, { color: C.dim }, `   ${selectedProvider.name}  ·  ${selectedProvider.description}`),
      h(Box, { flexDirection: 'row', marginTop: 0 },
        h(Text, { color: C.accent }, '   key  '),
        h(Box, { flexGrow: 1 },
          h(TextInput, {
            value: keyValue,
            onChange: onKeyChange,
            placeholder: selectedProvider.keyHint || 'paste API key…',
            mask: '●',
            focus: true,
          }),
        ),
      ),
      h(Text, { color: C.dim }, '   enter to connect'),
    ),
    step === 2 && h(Box, { flexDirection: 'column' },
      h(Box, { flexDirection: 'row' },
        h(Text, { color: C.dim }, '  ╱ '),
      h(Box, { flexGrow: 1 },
        h(TextInput, {
          value: connectQuery || '',
          onChange: onConnectQueryChange,
          placeholder: 'filter models…',
        }),
      ),
        h(Text, { color: C.dim }, `  ${filtered.length}/${models.length}`),
      ),
      filtered.length === 0
        ? h(Text, { color: C.err }, '   No models found — check API key or try again')
        : visibleModels.map((m, i) => {
            const absIdx = start + i;
            const id = typeof m === 'string' ? m : m.id;
            return h(ListItem, { key: id || absIdx, isSelected: absIdx === safeIdx, left: id });
          }),
      filtered.length > MAX_MODELS && h(Text, { color: C.dim },
        `   ${start + 1}–${Math.min(start + MAX_MODELS, filtered.length)} of ${filtered.length}`,
      ),
    ),
    status && h(Box, { flexDirection: 'column', marginTop: 0 },
      h(Text, {
        color: status.ok ? C.ok : status.loading ? C.warn : C.err,
        bold: true,
      }, `   ${status.ok ? '✔' : status.loading ? '◌' : '✘'}  ${status.msg}`),
      (!status.ok && !status.loading) && h(Text, { color: C.dim },
        '   Edit key and press enter to retry',
      ),
    ),
  );
}

function Overlay({ title, items, selectedIndex, note }) {
  const MAX = 12;
  const visible = items.slice(0, MAX);
  const hidden = items.length - visible.length;
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: C.accent,
    paddingX: 1,
    width: '100%',
  },
    h(Box, { flexDirection: 'row' },
      h(Text, { color: C.accent, bold: true }, `  ${title}`),
      h(Box, { flexGrow: 1 }),
      note && h(Text, { color: C.dim }, note),
    ),
    ...visible.map((item, i) =>
      h(ListItem, {
        key: i,
        isSelected: i === selectedIndex,
        left: item.label,
        dim: item.sublabel,
      })
    ),
    items.length === 0 && h(Text, { color: C.dim }, '   no results'),
    hidden > 0 && h(Text, { color: C.dim }, `   ↓ ${hidden} more — type to filter`),
  );
}

function ThemesDialog({ selectedIdx }) {
  const themeKeys = Object.keys(THEMES);
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: C.accent,
    paddingX: 1,
    width: '100%',
  },
    h(Box, { flexDirection: 'row' },
      h(Text, { color: C.accent, bold: true }, '  Themes'),
      h(Box, { flexGrow: 1 }),
      h(Text, { color: C.dim }, '↑↓ preview  enter confirm  esc cancel'),
    ),
    ...themeKeys.map((key, i) => {
      const t = THEMES[key];
      const isSelected = i === selectedIdx;
      const isCurrent = _activeTheme === t;
      return h(Box, { key, flexDirection: 'row' },
        h(Text, { color: t.accent }, isSelected ? ' ❯ ' : '   '),
        h(Text, { color: t.accent, bold: isSelected }, t.label.padEnd(13)),
        h(Text, { color: isSelected ? t.text : t.dim }, t.description),
        isCurrent && h(Text, { color: t.ok }, '  ✔'),
      );
    }),
  );
}

// ─── Ask User Dialog ─────────────────────────────────────────────────────────
function AskUserDialog({ question, options, selectedIdx }) {
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: C.warn,
    paddingX: 1,
    width: '100%',
  },
    h(Box, { flexDirection: 'row' },
      h(Text, { color: C.warn, bold: true }, '  ⚑  Agent needs your input'),
      h(Box, { flexGrow: 1 }),
      h(Text, { color: C.dim }, '↑↓ move  enter confirm  esc cancel'),
    ),
    h(Box, { marginTop: 1, paddingX: 1 },
      h(Text, { color: C.text, bold: true }, question),
    ),
    h(Box, { flexDirection: 'column', marginTop: 1 },
      options.length === 0
        ? h(Box, { paddingX: 1 },
            h(Text, { color: C.dim }, '✎  Type your answer below and press Enter'),
          )
        : options.map((opt, i) => {
            const sel = i === selectedIdx;
            return h(Box, { key: i, flexDirection: 'row' },
              h(Text, { color: sel ? C.accent : C.dim, bold: sel }, sel ? ' ❯ ' : '   '),
              h(Text, { color: sel ? C.accent : C.dim, bold: sel }, `${i + 1}. `),
              h(Text, { color: sel ? C.text : C.dim, bold: sel }, opt),
            );
          }),
    ),
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
const SIDEBAR_W = 36;

function Sidebar({ todos, completedMessage, gitBranch, detectedLang, msgCount, isRunning, provider, model }) {
  const todoIcon = (status) => {
    if (status === 'done')    return h(Text, { color: C.ok,   bold: true }, '✔ ');
    if (status === 'running') return h(Text, { color: C.warn, bold: true }, '◌ ');
    return h(Text, { color: C.dim }, '○ ');
  };
  const todoColor = (status) => {
    if (status === 'done')    return C.dim;
    if (status === 'running') return C.text;
    return C.dim;
  };

  return h(Box, {
    flexDirection: 'column',
    width: SIDEBAR_W,
    borderStyle: 'single',
    borderColor: C.dim,
    paddingX: 1,
    flexShrink: 0,
    overflowY: 'hidden',
  },
    // ── Info ──
    h(Text, { color: C.accent, bold: true }, ' Info'),
    h(Box, { flexDirection: 'row' },
      h(Text, { color: C.dim }, ' lang   '),
      h(Text, { color: C.text }, detectedLang || '—'),
    ),
    gitBranch && h(Box, { flexDirection: 'row' },
      h(Text, { color: C.dim }, ' git    '),
      h(Text, { color: C.ok }, gitBranch),
    ),
    h(Box, { flexDirection: 'row' },
      h(Text, { color: C.dim }, ' msgs   '),
      h(Text, { color: C.text }, String(msgCount)),
    ),
    h(Box, { flexDirection: 'row' },
      h(Text, { color: C.dim }, ' status '),
      isRunning
        ? h(Text, { color: C.warn, bold: true }, '● running')
        : h(Text, { color: C.ok }, '● idle'),
    ),

    // ── Divider ──
    h(Text, { color: C.dim }, ' ' + '─'.repeat(SIDEBAR_W - 4)),

    // ── Todo list ──
    h(Text, { color: C.accent, bold: true }, ' Tasks'),
    todos.length === 0
      ? h(Text, { color: C.dim }, ' no tasks yet')
      : todos.map((t, i) =>
          h(Box, { key: i, flexDirection: 'row' },
            h(Text, { color: C.dim }, ` ${String(i + 1).padStart(2)}. `),
            todoIcon(t.status),
            h(Text, {
              color: todoColor(t.status),
              wrap: 'truncate-end',
              bold: t.status === 'running',
              strikethrough: t.status === 'done',
            }, truncate(t.text, SIDEBAR_W - 8)),
          )
        ),
    // ── Completed message ──
    completedMessage && h(Text, { color: C.ok, bold: true, wrap: 'wrap' }, completedMessage),
  );
}

function InputArea({ value, onChange, placeholder, isRunning, focus, onSubmit }) {
  return h(Box, {
    borderStyle: 'round',
    borderColor: isRunning ? C.warn : C.accent,
    paddingX: 2,
    paddingY: 1,
    width: '100%',
  },
    h(Text, { color: isRunning ? C.warn : C.accent, bold: true }, isRunning ? '◌  ' : '❯  '),
    h(Box, { flexGrow: 1 },
      h(TextInput, { value, onChange, placeholder, focus, onSubmit }),
    ),
  );
}

function BlinkingDot() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn(v => !v), 500);
    return () => clearInterval(t);
  }, []);
  return h(Text, { color: C.ok, bold: true }, on ? '●' : ' ');
}

function StatusBar({ mode, isRunning, cwd, gitBranch, detectedLang, msgCount }) {
  const sep = h(Text, { color: C.dim }, '  ·  ');
  return h(Box, { flexDirection: 'column', width: '100%' },
    h(Box, {
      flexDirection: 'row',
      paddingX: 2,
      paddingY: 0,
      borderStyle: 'single',
      borderColor: C.dim,
    },
      isRunning
        ? h(Box, { flexDirection: 'row' },
            h(BlinkingDot),
            h(Text, { color: C.ok, bold: true }, '  thinking'),
            sep,
            h(Text, { color: C.dim }, 'esc stop'),
          )
        : h(Box, { flexDirection: 'row' },
            h(Text, { color: isRunning ? C.warn : C.ok }, '● '),
            h(Text, { color: C.dim }, 'idle'),
            gitBranch ? sep : null,
            gitBranch ? h(Text, { color: C.dim }, 'git ') : null,
            gitBranch ? h(Text, { color: C.ok }, gitBranch) : null,
            detectedLang ? sep : null,
            detectedLang ? h(Text, { color: C.dim }, detectedLang) : null,
            sep,
            h(Text, { color: C.dim }, `msgs ${msgCount || 0}`),
            sep,
            h(Text, { color: C.dim }, 'tab '),
            h(Text, { color: C.text }, mode === 'build' ? 'plan' : 'build'),
            sep,
            h(Text, { color: C.accent }, '@'),
            h(Text, { color: C.dim }, ' files'),
            sep,
            h(Text, { color: C.accent }, '/'),
            h(Text, { color: C.dim }, ' cmds'),
            sep,
            h(Text, { color: C.accent }, '!'),
            h(Text, { color: C.dim }, ' bash'),
            sep,
            h(Text, { color: C.dim }, 'ctrl+c exit'),
          ),
    ),
  );
}

// ─── File search ─────────────────────────────────────────────────────────────
async function getFiles(cwd, query) {
  const { glob: globby } = await import('glob');
  const files = await globby('**/*', {
    cwd,
    absolute: false,
    ignore: ['node_modules/**', '.git/**', 'dist/**', '*.lock'],
    maxDepth: 6,
  }).catch(() => []);

  if (!query) return files.slice(0, 50).map(f => ({ label: f, value: f }));

  const fuse = new Fuse(files, { threshold: 0.4 });
  return fuse.search(query).slice(0, 20).map(r => ({ label: r.item, value: r.item }));
}

// ─── Commands ────────────────────────────────────────────────────────────────
const SLASH_COMMANDS = [
  { label: '/new',                    value: '/new',                    sublabel: 'New session' },
  { label: '/clear',                  value: '/clear',                  sublabel: 'Clear messages' },
  { label: '/sessions',               value: '/sessions',               sublabel: 'List sessions' },
  { label: '/connect',                value: '/connect',                sublabel: 'Change provider/model' },
  { label: '/models',                 value: '/models',                 sublabel: 'Browse and select model' },
  { label: '/themes',                 value: '/themes',                 sublabel: 'Choose color theme' },
  { label: '/init',                   value: '/init',                   sublabel: 'Create AGENTS.md' },
  { label: '/undo',                   value: '/undo',                   sublabel: 'Undo last message' },
  { label: '/compact',                value: '/compact',                sublabel: 'Summarize and compact history' },
  { label: '/compress',               value: '/compress',               sublabel: 'Preview context compression' },
  { label: '/compress apply',         value: '/compress apply',         sublabel: 'Compress context now (save tokens)' },
  { label: '/compress auto on',       value: '/compress auto on',       sublabel: 'Enable auto-compression' },
  { label: '/compress auto off',      value: '/compress auto off',      sublabel: 'Disable auto-compression' },
  { label: '/compress stats',         value: '/compress stats',         sublabel: 'Show token usage stats' },
  { label: '/compress threshold',     value: '/compress threshold ',    sublabel: 'Set compression threshold (tokens)' },
  { label: '/compress history',       value: '/compress history',       sublabel: 'Show compression history' },
  { label: '/compress undo',          value: '/compress undo',          sublabel: 'Undo last compression' },
  { label: '/memory',                 value: '/memory',                 sublabel: 'Show project memory status' },
  { label: '/memory show',            value: '/memory show',            sublabel: 'View full project memory' },
  { label: '/memory add',             value: '/memory add ',            sublabel: 'Add a note to project memory' },
  { label: '/memory clear',           value: '/memory clear',           sublabel: 'Clear project memory' },
  { label: '/memory edit',            value: '/memory edit',            sublabel: 'Edit memory in $EDITOR' },
  { label: '/memory export',          value: '/memory export',          sublabel: 'Export memory to file' },
  { label: '/memory path',            value: '/memory path',            sublabel: 'Show memory file location' },
  { label: '/exit',                   value: '/exit',                   sublabel: 'Quit' },
];

// ─── Main App ─────────────────────────────────────────────────────────────────
function App({ initialConfig, initialAgent }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout?.columns || 80);
  const [rows, setRows] = useState(stdout?.rows || 24);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      // Clear screen before re-render to avoid leftover content from the old size
      process.stdout.write('\x1b[2J\x1b[H');
      setCols(stdout.columns || 80);
      setRows(stdout.rows || 24);
    };
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);

  const [messages, setMessages]       = useState([]);
  const [streaming, setStreaming]     = useState(null); // { text, tools }
  const [inputValue, setInputValue]   = useState('');
  const [isRunning, setIsRunning]     = useState(false);
  const [mode, setMode]               = useState('build');
  const [overlay, setOverlay]         = useState(null); // 'files'|'commands'|'sessions'|'connect'
  const [overlayQuery, setOverlayQuery] = useState('');
  const [overlayItems, setOverlayItems] = useState([]);
  const [overlayIdx, setOverlayIdx]   = useState(0);

  // Models dialog state
  const [modelsAll, setModelsAll]     = useState([]);
  const [modelsQuery, setModelsQuery] = useState('');
  const [modelsIdx, setModelsIdx]     = useState(0);

  // Themes dialog state
  const [themesIdx, setThemesIdx]   = useState(0);
  const [, forceThemeUpdate]        = useState(0);

  // Connect dialog state
  const [connectStep, setConnectStep]           = useState(0); // 0=provider 1=key 2=model
  const [connectProviderIdx, setConnectProviderIdx] = useState(0);
  const [connectKey, setConnectKey]             = useState('');
  const [connectModels, setConnectModels]       = useState([]);
  const [connectModelIdx, setConnectModelIdx]   = useState(0);
  const [connectStatus, setConnectStatus]       = useState(null); // {ok,loading,msg}
  const [connectQuery, setConnectQuery]         = useState(''); // model filter in step 2

  const [provider, setProvider] = useState(connectionManager.activeProvider || '');
  const [model, setModel]       = useState(connectionManager.activeModel || '');
  const [sessionId, setSessionId] = useState('');

  // Sidebar state
  const [todos, setTodos] = useState([]); // [{ text, status: 'pending'|'running'|'done' }]
  const [completedMessage, setCompletedMessage] = useState(null); // completion message
  const [gitBranch, setGitBranch] = useState('');
  const [detectedLang, setDetectedLang] = useState('');
  const [msgCount, setMsgCount] = useState(0);

  // Project memory state
  const [memoryInfo, setMemoryInfo]   = useState(null); // { projectName, root }
  const [memorySaved, setMemorySaved] = useState(null); // section name, shown briefly

  // Token / compression state
  const [tokenInfo, setTokenInfo]     = useState(null); // { used, limit }
  const compressionThreshold = 8000;

  // Ask-user dialog state (driven by the agent via uiBridge)
  const [askUser, setAskUser]       = useState(null); // { question, options, resolve }
  const [askUserIdx, setAskUserIdx] = useState(0);

  const agentRef    = useRef(initialAgent);
  const configRef   = useRef(initialConfig);
  const sessionRef  = useRef(null);
  const emitterRef  = useRef(new EventEmitter());

  // Init session
  useEffect(() => {
    (async () => {
      const p = connectionManager.activeProvider || 'unknown';
      const m = connectionManager.activeModel || 'unknown';
      const session = await createSession(p, m);
      sessionRef.current = session;
      setSessionId(session.id);
    })();
  }, []);

  // Detect git branch + dirty count
  useEffect(() => {
    const detect = async () => {
      try {
        const { readFile, readdir: rd } = await import('fs/promises');
        const head = await readFile(join(process.cwd(), '.git/HEAD'), 'utf8').catch(() => '');
        if (head) {
          const m = head.match(/ref: refs\/heads\/(.+)/);
          setGitBranch(m ? m[1].trim() : head.slice(0, 7));
        } else {
          setGitBranch('');
        }
      } catch {}
    };
    detect();
  }, []);

  // Detect primary language from file extensions
  useEffect(() => {
    const detect = async () => {
      try {
        const { readdir: rd } = await import('fs/promises');
        const files = await rd(process.cwd()).catch(() => []);
        const extMap = { js: 'JavaScript', ts: 'TypeScript', py: 'Python', rs: 'Rust',
          go: 'Go', rb: 'Ruby', java: 'Java', cpp: 'C++', c: 'C', cs: 'C#',
          php: 'PHP', swift: 'Swift', kt: 'Kotlin', dart: 'Dart', vue: 'Vue',
          svelte: 'Svelte', json: 'JSON', md: 'Markdown' };
        const counts = {};
        for (const f of files) {
          const ext = f.split('.').pop()?.toLowerCase();
          if (ext && extMap[ext]) counts[ext] = (counts[ext] || 0) + 1;
        }
        // check package.json / go.mod / Cargo.toml for stronger signal
        if (files.includes('package.json')) { counts['js'] = (counts['js'] || 0) + 5; }
        if (files.includes('go.mod'))        { counts['go'] = (counts['go'] || 0) + 5; }
        if (files.includes('Cargo.toml'))    { counts['rs'] = (counts['rs'] || 0) + 5; }
        if (files.includes('requirements.txt') || files.includes('pyproject.toml')) { counts['py'] = (counts['py'] || 0) + 5; }
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        setDetectedLang(top ? extMap[top[0]] : '');
      } catch {}
    };
    detect();
  }, []);

  // Keep message count in sync
  useEffect(() => { setMsgCount(messages.length); }, [messages]);

  // Wire agent emitter
  useEffect(() => {
    const em = emitterRef.current;

    em.on('token', (text) => {
      setStreaming(prev => ({
        ...prev,
        text: (prev?.text || '') + sanitizeLLMText(text),
        tools: prev?.tools || [],
        thinking: false,
      }));
    });

    em.on('thinkStart', () => {
      setStreaming(prev => ({ ...prev, thinking: true, thinkText: '', thinkTokens: 0 }));
    });

    em.on('thinkToken', (chunk) => {
      setStreaming(prev => ({
        ...prev,
        thinking: true,
        thinkText: (prev?.thinkText || '') + chunk,
        thinkTokens: (prev?.thinkTokens || 0) + Math.ceil(chunk.length / 4),
      }));
    });

    em.on('thinkEnd', () => {
      setStreaming(prev => ({ ...prev, thinking: false }));
    });

    em.on('toolStart', ({ id, name, args }) => {
      setStreaming(prev => ({
        ...prev,
        text: prev?.text || '',
        tools: [...(prev?.tools || []), { id, name, args, status: 'running', output: '' }],
      }));
    });

    em.on('toolEnd', ({ id, name, output }) => {
      setStreaming(prev => ({
        ...prev,
        text: prev?.text || '',
        tools: (prev?.tools || []).map(t =>
          t.id === id ? { ...t, status: 'done', output } : t
        ),
      }));
    });

    em.on('complete', (content) => {
      setIsRunning(false);
      setStreaming(prev => {
        const text = sanitizeLLMText(prev?.text || content || '');
        const tools = prev?.tools || [];
        
        // Avoid adding duplicate message if last message has same content
        setMessages(msgs => {
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg?.role === 'assistant' && lastMsg.text === text && text.length > 0) {
            return msgs; // Skip duplicate
          }
          return [...msgs, { role: 'assistant', text, tools, id: Date.now() }];
        });
        
        return null;
      });
    });

    em.on('cancelled', () => {
      setIsRunning(false);
      setStreaming(prev => {
        if (prev?.text) {
          setMessages(msgs => [...msgs, { role: 'assistant', text: prev.text + ' [cancelled]', tools: prev.tools || [], id: Date.now() }]);
        }
        return null;
      });
    });

    em.on('error', (msg) => {
      setIsRunning(false);
      setStreaming(null);
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: `Error: ${msg}`,
        tools: [],
        id: Date.now(),
      }]);
    });

    em.on('todoList', (items) => {
      const todoItems = items.map(text => ({ text, status: 'pending' }));
      setTodos(todoItems);
      // Insert (or replace) a todos message inline in the chat
      setMessages(prev => {
        const filtered = prev.filter(m => m.role !== 'todos');
        return [...filtered, { role: 'todos', id: Date.now(), items: todoItems }];
      });
    });

    em.on('todoDone', (idx) => {
      setTodos(prev => {
        const updated = prev.map((t, i) => {
          if (i < idx) return t.status === 'pending' ? { ...t, status: 'done' } : t;
          if (i === idx) return { ...t, status: 'done' };
          if (i === idx + 1) return { ...t, status: 'running' };
          return t;
        });
        const allDone = updated.every(t => t.status === 'done');
        if (allDone) setCompletedMessage('✅ All tasks completed!');
        // Keep the inline message in sync
        setMessages(msgs => msgs.map(m =>
          m.role === 'todos' ? { ...m, items: updated } : m
        ));
        return updated;
      });
    });

    em.on('memoryLoaded', ({ projectName, root }) => {
      setMemoryInfo({ projectName, root });
    });

    em.on('tokenCount', (count) => {
      setTokenInfo(prev => ({
        ...(prev || {}),
        used: count,
        limit: compressionThreshold,
      }));
    });

    em.on('usage', (usage) => {
      setTokenInfo(prev => {
        const prevReadTotal = prev?.cacheReadTotal || 0;
        const prevInputTotal = prev?.inputTotal || 0;
        const cacheReadTotal = prevReadTotal + (usage.cacheRead || 0);
        const inputTotal = prevInputTotal + (usage.inputTokens || 0) + (usage.cacheRead || 0) + (usage.cacheCreate || 0);
        const cacheHitRatio = inputTotal > 0 ? cacheReadTotal / inputTotal : 0;
        return {
          ...(prev || {}),
          used: prev?.used ?? 0,
          limit: prev?.limit ?? compressionThreshold,
          cacheReadTotal,
          inputTotal,
          cacheHitRatio,
        };
      });
    });

    em.on('contextCompressed', ({ fromCount, toCount, savedTokens, tokensAfter }) => {
      setTokenInfo(prev => ({ used: tokensAfter, limit: prev?.limit || compressionThreshold }));
      setMessages(prev => [...prev, {
        role: 'compression',
        fromCount,
        toCount,
        savedTokens,
        id: Date.now(),
      }]);
    });

    em.on('compressionFallback', ({ reason }) => {
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: `⚠ Compressione contesto in modalità degradata (LLM fallito: ${reason}). Riassunto basato sugli ultimi 5 messaggi.`,
        tools: [],
        id: Date.now(),
      }]);
    });

    // Mark first task as running when agent starts working
    em.on('toolStart', () => {
      setCompletedMessage(null);
      setTodos(prev => {
        const firstPending = prev.findIndex(t => t.status === 'pending');
        if (firstPending === -1) return prev;
        const updated = prev.map((t, i) =>
          i === firstPending && t.status === 'pending' ? { ...t, status: 'running' } : t
        );
        setMessages(msgs => msgs.map(m =>
          m.role === 'todos' ? { ...m, items: updated } : m
        ));
        return updated;
      });
    });

    return () => em.removeAllListeners();
  }, []);

  // Wire UI bridge (tool → UI)
  useEffect(() => {
    const onAsk = ({ question, options, resolve }) => {
      setAskUserIdx(0);
      setAskUser({ question, options, resolve });
    };

    const onFileChanged = ({ type, path, lines, oldLines, newLines, diff }) => {
      const fileName = path.split('/').pop();
      let msg = '';
      if (type === 'write') {
        msg = `📝 Created ${fileName} (${lines} lines)`;
      } else if (type === 'edit') {
        msg = `✏️ Modified ${fileName} (${oldLines} → ${newLines} lines, ${diff > 0 ? '+' : ''}${diff})`;
      }
      // Non aggiungere il messaggio se già c'è un messaggio simile
      if (msg) {
        setMessages(prev => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg?.role === 'system' && lastMsg?.text === msg) {
            return prev; // Skip duplicate
          }
          return [...prev, {
            role: 'system',
            text: msg,
            tools: [],
            id: Date.now(),
          }];
        });
      }
    };

    const onMemorySaved = ({ section }) => {
      setMemorySaved(section);
      setTimeout(() => setMemorySaved(null), 2500);
    };

    const onToolProgress = ({ name, key, message }) => {
      setStreaming(prev => {
        if (!prev?.tools) return prev;
        return {
          ...prev,
          tools: prev.tools.map(t => {
            if (t.status !== 'running') return t;
            if (t.name !== name) return t;
            if (key && toolProgressKey(t.name, t.args) !== key) return t;
            return { ...t, progress: message };
          }),
        };
      });
    };

    uiBridge.on('askUser', onAsk);
    uiBridge.on('fileChanged', onFileChanged);
    uiBridge.on('memorySaved', onMemorySaved);
    uiBridge.on('toolProgress', onToolProgress);
    return () => {
      uiBridge.off('askUser', onAsk);
      uiBridge.off('fileChanged', onFileChanged);
      uiBridge.off('memorySaved', onMemorySaved);
      uiBridge.off('toolProgress', onToolProgress);
    };
  }, []);

  // When streaming ends, commit it to messages
  const streamingRef = useRef(null);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  // File overlay refresh
  useEffect(() => {
    if (overlay !== 'files') return;
    const query = overlayQuery.replace(/^@/, '');
    getFiles(configRef.current?.workdir || process.cwd(), query).then(items => {
      setOverlayItems(items);
      setOverlayIdx(0);
    });
  }, [overlay, overlayQuery]);

  // Command overlay filter
  useEffect(() => {
    if (overlay !== 'commands') return;
    // Remove leading '/' and any surrounding whitespace, then lowercase for matching.
    const query = overlayQuery.replace(/^\/\s*/, '').trim().toLowerCase();
    const filtered = SLASH_COMMANDS.filter(c =>
      c.label.toLowerCase().includes(query)
    );
    setOverlayItems(filtered);
    setOverlayIdx(0);
  }, [overlay, overlayQuery]);

  // Sessions overlay
  useEffect(() => {
    if (overlay !== 'sessions') return;
    listSessions().then(sessions => {
      setOverlayItems(sessions.map(s => ({
        label: s.id,
        sublabel: new Date(s.updated).toLocaleString(),
        value: s.id,
      })));
      setOverlayIdx(0);
    });
  }, [overlay]);

  // Handle input change
  const handleInputChange = useCallback((val) => {
    setInputValue(val);
    // Determine which overlay (if any) should be active based on the first character.
    // Switch overlay types dynamically: @ → file overlay, / → commands overlay, otherwise hide.
    if (val.startsWith('@')) {
      setOverlay('files');
      setOverlayQuery(val);
    } else if (val.startsWith('/')) {
      setOverlay('commands');
      setOverlayQuery(val);
    } else {
      // No prefix means no overlay should be shown.
      setOverlay(null);
      setOverlayQuery(val);
    }
  }, []);

  // Submit message
  const handleSubmit = useCallback(async (value) => {
    const raw = value.trim();
    if (!raw) return;

    // Free-text ask_user response (options.length === 0 means free-text mode)
    if (askUser && askUser.options.length === 0) {
      askUser.resolve?.(raw);
      setAskUser(null);
      setAskUserIdx(0);
      setInputValue('');
      return;
    }

    if (isRunning) return;

    setInputValue('');
    setOverlay(null);

    // ! prefix = bash shortcut
    const text = raw.startsWith('!') ? `Run this command: \`${raw.slice(1).trim()}\`` : raw;

    // slash commands — lowercase only the command name, preserve argument case
    if (text.startsWith('/') || raw.startsWith('/')) {
      const spaceIdx = raw.indexOf(' ');
      const normalizedCmd = spaceIdx === -1
        ? raw.toLowerCase()
        : raw.slice(0, spaceIdx).toLowerCase() + raw.slice(spaceIdx);
      await handleSlashCommand(normalizedCmd);
      return;
    }

    if (!agentRef.current) {
      setMessages(prev => [...prev, {
        role: 'assistant', text: 'Not connected. Use /connect.', tools: [], id: Date.now(),
      }]);
      return;
    }

    // Add user message
    const userMsg = { role: 'user', text, tools: [], id: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setIsRunning(true);
    setStreaming({ text: '', tools: [] });

    const em = emitterRef.current;

    // Run agent — finalization handled in em.on('complete')
    agentRef.current.run(text, em).then(async () => {
      if (sessionRef.current) {
        sessionRef.current.messages = agentRef.current.messages;
        await saveSession(sessionRef.current).catch(() => {});
      }
    }).catch(() => {});
  }, [isRunning]);

  const openModelsDialog = useCallback(() => {
    // Collect models from ALL connected providers, deduplicated
    const seen = new Set();
    const all = [];
    for (const [provId, conn] of connectionManager.connections) {
      for (const m of (conn.models || [])) {
        const id = typeof m === 'string' ? m : m.id;
        const key = `${provId}::${id}`;
        if (id && !seen.has(key)) {
          seen.add(key);
          all.push({ id, provider: provId, label: `[${provId}]  ${id}` });
        }
      }
    }
    setModelsAll(all);
    setModelsQuery('');
    setModelsIdx(0);
    setOverlay('models');
  }, []);

  const openConnectDialog = useCallback(() => {
    setConnectStep(0);
    setConnectProviderIdx(0);
    setConnectKey('');
    setConnectModels([]);
    setConnectModelIdx(0);
    setConnectStatus(null);
    setConnectQuery('');
    setOverlay('connect');
  }, []);

  const resumeSession = useCallback(async (id) => {
    try {
      const session = await loadSession(id);
      if (!session || !Array.isArray(session.messages)) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: `Session ${id} not found or empty.`,
          tools: [], id: Date.now(),
        }]);
        return;
      }
      if (agentRef.current) {
        agentRef.current.messages = session.messages.slice();
      }
      sessionRef.current = session;
      setSessionId(session.id);
      const turns = session.messages.filter(m => m.role === 'user').length;
      const when = session.updated ? new Date(session.updated).toLocaleString() : 'unknown';
      setMessages([{
        role: 'assistant',
        text: `↻ Resumed session ${session.id} — ${turns} turn${turns === 1 ? '' : 's'}, last activity ${when}. Context fully restored.`,
        tools: [], id: Date.now(),
      }]);
      setStreaming(null);
      setTodos([]);
    } catch (e) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: `Failed to resume session ${id}: ${e.message}`,
        tools: [], id: Date.now(),
      }]);
    }
  }, []);

  const handleSlashCommand = useCallback(async (cmd) => {
    const parts = cmd.split(' ');
    const name = parts[0].toLowerCase(); // command name always lowercase

    if (name === '/exit' || name === '/quit') {
      exit();
      return;
    }

    if (name === '/new') {
      agentRef.current?.reset();
      const p = connectionManager.activeProvider || 'unknown';
      const m = connectionManager.activeModel || 'unknown';
      const session = await createSession(p, m);
      sessionRef.current = session;
      setSessionId(session.id);
      setMessages([]);
      setStreaming(null);
      setTodos([]);
      return;
    }

    if (name === '/clear') {
      setMessages([]);
      return;
    }

    if (name === '/connect') {
      openConnectDialog();
      return;
    }

    if (name === '/models' || name === '/model') {
      openModelsDialog();
      return;
    }

    if (name === '/themes' || name === '/theme') {
      const themeKeys = Object.keys(THEMES);
      const currentKey = Object.keys(THEMES).find(k => THEMES[k] === _activeTheme) || 'default';
      const currentIdx = Math.max(0, themeKeys.indexOf(currentKey));
      setThemesIdx(currentIdx);
      previewTheme(themeKeys[currentIdx]);
      forceThemeUpdate(n => n + 1);
      setOverlay('themes');
      return;
    }

    if (name === '/sessions' || name === '/l') {
      setOverlay('sessions');
      return;
    }

    if (name === '/resume') {
      const id = parts[1];
      if (!id) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: 'Usage: /resume <session-id>  (use /sessions to list)',
          tools: [], id: Date.now(),
        }]);
        return;
      }
      await resumeSession(id);
      return;
    }

    if (name === '/todo') {
      const sub = parts[1];
      const rest = parts.slice(2).join(' ');
      if (!sub || sub === 'list') {
        // Just show sidebar (already visible), no message needed
        return;
      }
      if (sub === 'add' && rest) {
        setTodos(prev => {
          const next = [...prev, { text: rest, done: false, id: Date.now() }];
          saveConfig('todos', next);
          return next;
        });
        return;
      }
      if ((sub === 'done' || sub === 'check') && parts[2]) {
        const idx = parseInt(parts[2]) - 1;
        setTodos(prev => {
          const next = prev.map((t, i) => i === idx ? { ...t, done: !t.done } : t);
          saveConfig('todos', next);
          return next;
        });
        return;
      }
      if ((sub === 'rm' || sub === 'remove' || sub === 'del') && parts[2]) {
        const idx = parseInt(parts[2]) - 1;
        setTodos(prev => {
          const next = prev.filter((_, i) => i !== idx);
          saveConfig('todos', next);
          return next;
        });
        return;
      }
      if (sub === 'clear') {
        setTodos([]);
        saveConfig('todos', []);
        return;
      }
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: '/todo add <text>   — add a task\n/todo done <n>     — toggle done\n/todo rm <n>       — remove\n/todo clear        — clear all',
        tools: [], id: Date.now(),
      }]);
      return;
    }

    if (name === '/undo') {
      setMessages(prev => {
        const copy = [...prev];
        // Remove last user+assistant pair
        while (copy.length && copy[copy.length - 1].role !== 'user') copy.pop();
        if (copy.length) copy.pop();
        return copy;
      });
      agentRef.current?.reset();
      return;
    }

    if (name === '/compact') {
      setMessages(prev => {
        if (prev.length <= 2) return prev;
        return [{ role: 'assistant', text: '[History compacted]', tools: [], id: Date.now() }];
      });
      agentRef.current?.reset();
      return;
    }

    if (name === '/init') {
      setMessages(prev => [...prev, {
        role: 'user', text: '/init — Create AGENTS.md', tools: [], id: Date.now(),
      }]);
      setIsRunning(true);
      setStreaming({ text: '', tools: [] });
      agentRef.current?.run(
        'Create an AGENTS.md file in the current directory that describes the project structure, coding conventions, and how an AI agent should work with this codebase. Read existing files to understand the project first.',
        emitterRef.current
      ).then((response) => {
        const current = streamingRef.current;
        setMessages(prev => [...prev, {
          role: 'assistant',
          text: current?.text || response || '',
          tools: current?.tools || [],
          id: Date.now(),
        }]);
      }).catch(() => {});
      return;
    }

    // /compress — context compression commands
    if (name === '/compress' || name === '/ctx') {
      const sub = parts[1]?.toLowerCase();
      const rest = parts.slice(2);
      const compressor = agentRef.current?.compressor;
      if (!compressor) {
        setMessages(prev => [...prev, { role: 'assistant', text: 'No active session.', tools: [], id: Date.now() }]);
        return;
      }
      if (!sub || sub === 'preview') {
        const preview = await compressor.buildPreview(agentRef.current.messages);
        const text = !preview.eligible
          ? `Nothing to compress yet.\n  Current tokens: ~${preview.currentTokens}  Threshold: ${preview.threshold}`
          : `Context compression preview\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  Messages to compress : ${preview.compressCount} of ${preview.msgCount}\n  Tokens now           : ~${preview.currentTokens}\n  Threshold            : ${preview.threshold}\n\nUse /compress apply to proceed.`;
        setMessages(prev => [...prev, { role: 'assistant', text, tools: [], id: Date.now() }]);
        return;
      }
      if (sub === 'apply') {
        const preview = await compressor.buildPreview(agentRef.current.messages);
        if (!preview.eligible) {
          setMessages(prev => [...prev, { role: 'assistant', text: 'Nothing to compress.', tools: [], id: Date.now() }]);
          return;
        }
        agentRef.current.messages = await compressor.compress(agentRef.current.messages, emitterRef.current);
        return;
      }
      if (sub === 'auto') {
        const toggle = rest[0];
        if (!toggle || !['on', 'off'].includes(toggle)) {
          setMessages(prev => [...prev, { role: 'assistant', text: `Auto-compress is: ${compressor.autoEnabled ? 'ON' : 'OFF'}\nUsage: /compress auto on|off`, tools: [], id: Date.now() }]);
          return;
        }
        await compressor.setAuto(toggle === 'on');
        setMessages(prev => [...prev, { role: 'assistant', text: `Auto-compress: ${toggle.toUpperCase()}`, tools: [], id: Date.now() }]);
        return;
      }
      if (sub === 'stats') {
        const s = compressor.getStats(agentRef.current.messages);
        const pct = Math.min(100, Math.round((s.usedTokens / s.maxTokens) * 100));
        const filled = Math.round(pct / 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        setMessages(prev => [...prev, { role: 'assistant', text: `Context Stats\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  Tokens used     : ~${s.usedTokens} / ${s.maxTokens}  (${pct}%)\n  [${bar}]\n  Compressions run: ${s.compressionCount}\n  Tokens saved    : ~${s.totalSaved}\n  Auto-compress   : ${s.autoEnabled ? 'ON' : 'OFF'}  (threshold: ${s.threshold})`, tools: [], id: Date.now() }]);
        return;
      }
      if (sub === 'threshold') {
        const n = parseInt(rest[0]);
        if (isNaN(n) || n < 500) {
          setMessages(prev => [...prev, { role: 'assistant', text: 'Invalid threshold. Must be a number >= 500.', tools: [], id: Date.now() }]);
          return;
        }
        await compressor.setThreshold(n);
        setMessages(prev => [...prev, { role: 'assistant', text: `✓ Threshold set to: ${n} tokens`, tools: [], id: Date.now() }]);
        return;
      }
      if (sub === 'history') {
        const log = compressor.getHistory();
        const text = !log.length ? 'No compressions yet.' : 'Compression history:\n' + log.map((e, i) => `  ${i + 1}. [${e.timestamp}]  ${e.before} → ${e.after} tokens  (-${e.savedPct}%)`).join('\n');
        setMessages(prev => [...prev, { role: 'assistant', text, tools: [], id: Date.now() }]);
        return;
      }
      if (sub === 'undo') {
        const result = compressor.undo(agentRef.current.messages);
        if (result.success) agentRef.current.messages = result.messages;
        setMessages(prev => [...prev, { role: 'assistant', text: result.success ? `✓ Undone. Context restored to ~${result.restoredTokens} tokens.` : `Cannot undo: ${result.reason}`, tools: [], id: Date.now() }]);
        return;
      }
      setMessages(prev => [...prev, { role: 'assistant', text: 'Usage: /compress [preview|apply|auto on|off|stats|threshold <n>|history|undo]', tools: [], id: Date.now() }]);
      return;
    }

    // /memory — project memory commands
    if (name === '/memory' || name === '/mem') {
      const sub = parts[1]?.toLowerCase();
      const rest = parts.slice(2);
      const { builtinCommands } = await import('../commands/index.js');
      // Pass subcommand lowercased + args with original case
      const handlerArgs = sub ? [sub, ...rest] : [];
      const result = await builtinCommands.memory.handler(handlerArgs, {});
      if (typeof result === 'string') {
        setMessages(prev => [...prev, { role: 'assistant', text: result, tools: [], id: Date.now() }]);
      }
      return;
    }

    // Fallback: try the builtin command registry for commands not handled inline.
    try {
      const { builtinCommands } = await import('../commands/index.js');
      const key = name.replace(/^\//, '');
      const builtin = builtinCommands[key];
      if (builtin?.handler) {
        const args = parts.slice(1);
        const context = {
          agent: agentRef.current,
          emitter: emitterRef.current,
          config: configRef.current,
          provider: connectionManager.activeProvider,
          model: connectionManager.activeModel,
          version: '1.0.0',
          history: messages.filter(m => m.role === 'user').map(m => m.text),
        };
        const result = await builtin.handler(args, context);
        if (result && typeof result === 'object' && result.action === 'exit') {
          exit();
          return;
        }
        if (result && typeof result === 'object' && result.action === 'clear') {
          setMessages([]);
          return;
        }
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        if (text) {
          setMessages(prev => [...prev, { role: 'assistant', text, tools: [], id: Date.now() }]);
        }
        return;
      }
    } catch (e) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: `Error running ${cmd}: ${e.message}`,
        tools: [], id: Date.now(),
      }]);
      return;
    }

    setMessages(prev => [...prev, {
      role: 'assistant',
      text: `Unknown command: ${cmd}`,
      tools: [],
      id: Date.now(),
    }]);
  }, [exit, messages]);

  // Keyboard input (only in TTY)
  useInput((input, key) => {
    // Cancel running agent
    if (key.ctrl && input === 'c') {
      if (isRunning) {
        agentRef.current?.cancel();
      } else {
        exit();
      }
      return;
    }

    // Toggle Plan/Build mode
    if (key.tab && !overlay) {
      const newMode = mode === 'build' ? 'plan' : 'build';
      setMode(newMode);
      agentRef.current?.setMode(newMode);
      return;
    }

    // New session
    if (key.ctrl && input === 'n') {
      handleSlashCommand('/new');
      return;
    }

    // Sessions list
    if (key.ctrl && input === 'l') {
      setOverlay('sessions');
      return;
    }

    // Escape: close ask-user, overlay, or stop agent
    if (key.escape) {
      if (askUser) {
        askUser.resolve?.('__cancelled__');
        setAskUser(null);
        setAskUserIdx(0);
        agentRef.current?.cancel();
        return;
      }
      if (overlay) {
        if (overlay === 'themes') {
          cancelPreview();
          forceThemeUpdate(n => n + 1);
        }
        setOverlay(null);
        setConnectStatus(null);
      } else if (isRunning) {
        agentRef.current?.cancel();
      }
      return;
    }

    // ── Ask-user dialog navigation ───────────────────────────────────────────
    if (askUser) {
      if (key.upArrow) {
        setAskUserIdx(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setAskUserIdx(i => Math.min(askUser.options.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const choice = askUser.options[askUserIdx];
        askUser.resolve?.(choice);
        setAskUser(null);
        setAskUserIdx(0);
        return;
      }
      // Number keys 1–9 to pick directly
      if (/^[1-9]$/.test(input)) {
        const n = parseInt(input, 10) - 1;
        if (n >= 0 && n < askUser.options.length) {
          setAskUserIdx(n);
        }
        return;
      }
      return;
    }

    // ── Connect dialog navigation ──────────────────────────────────────────
    if (overlay === 'connect') {
      if (connectStep === 0) {
        if (key.upArrow) { setConnectProviderIdx(i => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setConnectProviderIdx(i => Math.min(PROVIDER_REGISTRY.length - 1, i + 1)); return; }
        if (key.return) {
          const p = PROVIDER_REGISTRY[connectProviderIdx];
          if (!p.requiresKey) {
            // Ollama — connect immediately
            setConnectStatus({ loading: true, msg: `Connecting to ${p.name}…` });
            connectionManager.connect(p.id, null).then(result => {
              if (result.success) {
                const firstModel = result.models[0] || null;
                connectionManager.setActive(p.id, firstModel);
                setConnectModels(result.models.map(m => (typeof m === 'string' ? { id: m } : m)));
                setConnectModelIdx(0);
                setConnectStep(2);
                setConnectStatus({ ok: true, msg: 'Connected!' });
              } else {
                setConnectStatus({ ok: false, msg: result.error });
              }
            });
          } else {
            setConnectStep(1);
            setConnectKey('');
            setConnectStatus(null);
          }
          return;
        }
      }

      if (connectStep === 1) {
        if (key.backspace && !connectKey) {
          // Empty key field + backspace → go back to provider selection
          setConnectStep(0);
          setConnectStatus(null);
          return;
        }
        if (key.return) {
          const p = PROVIDER_REGISTRY[connectProviderIdx];
          if (!connectKey.trim()) return;
          setConnectStatus({ loading: true, msg: `Connecting to ${p.name}…` });
          connectionManager.connect(p.id, connectKey.trim()).then(result => {
            if (result.success) {
              const firstModel = result.models[0] || null;
              connectionManager.setActive(p.id, firstModel);
              setConnectModels(result.models.map(m => (typeof m === 'string' ? { id: m } : m)));
              setConnectModelIdx(0);
              setConnectStep(2);
              setConnectStatus({ ok: true, msg: 'Connected!' });
            } else {
              setConnectStatus({ ok: false, msg: result.error });
            }
          });
          return;
        }
        // Let TextInput handle other keys
        return;
      }

      if (connectStep === 2) {
        if (key.backspace && !connectQuery) {
          // Empty filter + backspace → go back to key entry
          setConnectStep(1);
          setConnectKey('');
          setConnectQuery('');
          setConnectStatus(null);
          return;
        }
        // Compute filtered list same as ConnectDialog component
        const filteredModels = connectQuery?.trim()
          ? connectModels.filter(m => { const id = typeof m === 'string' ? m : m.id; return id.toLowerCase().includes(connectQuery.toLowerCase()); })
          : connectModels;
        const maxIdx = Math.max(0, filteredModels.length - 1);
        if (key.upArrow)   { setConnectModelIdx(i => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setConnectModelIdx(i => Math.min(maxIdx, i + 1)); return; }
        if (key.pageDown)  { setConnectModelIdx(i => Math.min(maxIdx, i + 16)); return; }
        if (key.pageUp)    { setConnectModelIdx(i => Math.max(0, i - 16)); return; }
        if (key.return) {
          const p = PROVIDER_REGISTRY[connectProviderIdx];
          const m = filteredModels[connectModelIdx];
          const modelId = typeof m === 'string' ? m : m?.id;
          if (!modelId) return;
          connectionManager.setActive(p.id, modelId);
          setProvider(p.id);
          setModel(modelId);
          setConnectQuery('');
          // Rebuild agent with new provider
          loadConfig({}).then(cfg => {
            try {
              agentRef.current = new Agent(createClient(cfg), cfg, mode);
            } catch {}
          });
          setOverlay(null);
          setConnectStatus(null);
          return;
        }
        // Let TextInput handle typing for the filter field
        return;
      }
      return;
    }

    // ── Models dialog ─────────────────────────────────────────────────────
    if (overlay === 'models') {
      const filtered = modelsQuery.trim()
        ? modelsAll.filter(m => m.label.toLowerCase().includes(modelsQuery.toLowerCase()))
        : modelsAll;

      if (key.upArrow) { setModelsIdx(i => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setModelsIdx(i => Math.min(filtered.length - 1, i + 1)); return; }
      if (key.pageDown) { setModelsIdx(i => Math.min(filtered.length - 1, i + 16)); return; }
      if (key.pageUp)   { setModelsIdx(i => Math.max(0, i - 16)); return; }

      if (key.return) {
        const selected = filtered[modelsIdx];
        if (selected) {
          connectionManager.setActive(selected.provider, selected.id);
          setProvider(selected.provider);
          setModel(selected.id);
          loadConfig({}).then(cfg => {
            try { agentRef.current = new Agent(createClient(cfg), cfg, mode); } catch {}
          });
        }
        setOverlay(null);
        return;
      }
      // Let TextInput handle typing for filter (modelsQuery updated via onQueryChange)
      return;
    }

    // ── Themes dialog ────────────────────────────────────────────────────────
    if (overlay === 'themes') {
      const themeKeys = Object.keys(THEMES);
      if (key.upArrow) {
        setThemesIdx(i => {
          const next = Math.max(0, i - 1);
          previewTheme(themeKeys[next]);
          forceThemeUpdate(n => n + 1);
          return next;
        });
        return;
      }
      if (key.downArrow) {
        setThemesIdx(i => {
          const next = Math.min(themeKeys.length - 1, i + 1);
          previewTheme(themeKeys[next]);
          forceThemeUpdate(n => n + 1);
          return next;
        });
        return;
      }
      if (key.return) {
        confirmPreview();
        forceThemeUpdate(n => n + 1);
        setOverlay(null);
        return;
      }
      return;
    }

    // ── Other overlay navigation ───────────────────────────────────────────
    if (overlay) {
      if (key.upArrow) {
        setOverlayIdx(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setOverlayIdx(i => Math.min(overlayItems.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const item = overlayItems[overlayIdx];
        if (item) {
          if (overlay === 'files') {
            const before = inputValue.replace(/^@[^\s]*/, '');
            setInputValue(`@${item.value}${before}`);
            setOverlay(null);
          } else if (overlay === 'commands') {
            setOverlay(null);
            if (item.value.endsWith(' ')) {
              // needs argument — put in input box for user to complete
              setInputValue(item.value);
            } else {
              // no argument needed — execute immediately
              setInputValue('');
              handleSlashCommand(item.value.trim().toLowerCase());
            }
          } else if (overlay === 'sessions') {
            setOverlay(null);
            if (item?.value) resumeSession(item.value);
          }
        }
        return;
      }
    }

    // Enter to submit (handled by TextInput onChange + onSubmit)
  }, { isActive: !!process.stdin.isTTY });

  const showOverlay = overlay && overlayItems !== null;

  const mainW = cols;

  // Performance guard: don't render more messages than needed
  // The layout clips overflow via overflowY: 'hidden' + justifyContent: 'flex-end',
  // but we still limit the DOM to avoid computing hundreds of off-screen nodes.
  const MAX_VISIBLE_MESSAGES = Math.max(4, rows - 12);

  const hiddenCount = Math.max(0, messages.length - MAX_VISIBLE_MESSAGES);
  const visibleMessages = hiddenCount > 0
    ? messages.slice(-MAX_VISIBLE_MESSAGES)
    : messages;

const mainCol = h(Box, { flexDirection: 'column', width: mainW, flexShrink: 0, flexGrow: 1 },
    // Overlay dialogs should appear before the message list so they have space to render
    overlay === 'models' && h(Box, { paddingX: 1 },
      h(ModelsDialog, {
        allModels: modelsAll,
        query: modelsQuery,
        onQueryChange: (v) => { setModelsQuery(v); setModelsIdx(0); },
        selectedIdx: modelsIdx,
      })
    ),
    overlay === 'connect' && h(Box, { paddingX: 1 },
      h(ConnectDialog, {
        step: connectStep,
        selectedIdx: connectProviderIdx,
        providers: PROVIDER_REGISTRY,
        selectedProvider: PROVIDER_REGISTRY[connectProviderIdx],
        keyValue: connectKey,
        onKeyChange: setConnectKey,
        models: connectModels,
        modelIdx: connectModelIdx,
        status: connectStatus,
        connectQuery,
        onConnectQueryChange: (v) => { setConnectQuery(v); setConnectModelIdx(0); },
      })
    ),
    overlay === 'themes' && h(Box, { paddingX: 1 },
      h(ThemesDialog, { selectedIdx: themesIdx })
    ),
    (overlay === 'commands') && h(Box, { paddingX: 1 },
      h(Overlay, {
        title: '/ Commands',
        items: overlayItems,
        selectedIndex: overlayIdx,
        note: '↑↓ navigate  Enter select  Esc close',
      })
    ),
    // Message list occupies remaining space
    h(Box, { flexDirection: 'column', paddingX: 1, flexGrow: 1, overflowY: 'hidden', justifyContent: 'flex-end' },
        messages.length === 0 && !streaming && h(Box, {
          flexDirection: 'column', paddingY: 2, paddingX: 4, marginTop: 1,
        },
          h(Text, { color: C.accent, bold: true }, '⬡  ETTORE  —  AI Coding Agent'),
          h(Box, { flexDirection: 'column', marginTop: 1 },
            h(Box, { flexDirection: 'row' },
              h(Text, { color: C.accent, bold: true }, '  @  '),
              h(Text, { color: C.text }, 'attach a file'),
              h(Text, { color: C.dim }, '   e.g.  @src/main.js'),
            ),
            h(Box, { flexDirection: 'row' },
              h(Text, { color: C.accent, bold: true }, '  /  '),
              h(Text, { color: C.text }, 'commands'),
              h(Text, { color: C.dim }, '      connect  models  themes  new  clear…'),
            ),
            h(Box, { flexDirection: 'row' },
              h(Text, { color: C.accent, bold: true }, '  !  '),
              h(Text, { color: C.text }, 'shell'),
              h(Text, { color: C.dim }, '         e.g.  !ls -la'),
            ),
            h(Box, { flexDirection: 'row' },
              h(Text, { color: C.accent, bold: true }, ' Tab '),
              h(Text, { color: C.text }, 'toggle mode  '),
              h(Text, { color: mode === 'plan' ? C.warn : C.ok, bold: true },
                mode === 'plan' ? 'PLAN (read only)' : 'BUILD (full access)',
              ),
            ),
            h(Box, { flexDirection: 'row' },
              h(Text, { color: C.accent, bold: true }, ' Esc '),
              h(Text, { color: C.text }, 'stop agent'),
            ),
          ),
        ),
        hiddenCount > 0 && h(Text, { color: C.dim },
          `  … ${hiddenCount} earlier message${hiddenCount === 1 ? '' : 's'} hidden`,
        ),
        ...visibleMessages.map((msg, i) => h(MessageView, { 
          key: msg.id || i, 
          msg, 
          maxLines: streaming || isRunning ? 8 : 20 
        })),
        streaming && h(StreamingMessage, { text: streaming.text, tools: streaming.tools, thinking: streaming.thinking, thinkText: streaming.thinkText, thinkTokens: streaming.thinkTokens }),
      ),
    askUser && h(Box, { paddingX: 1 },
      h(AskUserDialog, {
        question: askUser.question,
        options: askUser.options,
        selectedIdx: askUserIdx,
      })
    ),
    h(Box, { paddingX: 1 },
      h(InputArea, {
        value: inputValue,
        onChange: handleInputChange,
        placeholder: askUser
          ? (askUser.options.length === 0
            ? 'Type your answer and press Enter…  (Esc cancel)'
            : 'waiting for your choice above…  (↑↓ enter  esc cancel)')
          : isRunning
          ? 'agent is running…  (Esc to stop)'
          : mode === 'plan'
          ? 'Ask anything  (Plan mode — read only)'
          : 'Message Ettore…  (@ files  / commands  ! bash)',
        isRunning: isRunning && !(askUser && askUser.options.length === 0),
        focus: !overlay && (!askUser || askUser.options.length === 0),
        onSubmit: handleSubmit,
      })
    )
  );

  return h(Box, { flexDirection: 'column', backgroundColor: 'black', width: cols, height: rows },
    h(Header, { provider, model, mode, sessionId, cols, memoryInfo, memorySaved, tokenInfo }),
    h(Box, { flexDirection: 'row', width: cols, flexGrow: 1 },
      mainCol,
    ),
    h(StatusBar, { mode, isRunning, cols, cwd: process.cwd(), gitBranch, detectedLang, msgCount }),
  );
}


// ─── Entry point ─────────────────────────────────────────────────────────────
let altScreenEntered = false;
// Guard to prevent multiple concurrent app instances in the same process
let appRunning = false;
export async function startApp(options = {}) {
  // Prevent re-entrance: if the app is already running in this process, skip a second start.
  if (appRunning) {
    console.error('ETTORE is already running in this process.');
    return;
  }
  appRunning = true;
  if (!process.stdin.isTTY) {
    console.error('ettore requires an interactive terminal (TTY). For non-interactive use: ettore "your prompt"');
    process.exit(1);
  }
  // Active provider/model already restored by loadSavedConnections() via _active field
  // Fallback: if nothing was saved as active, pick the first connected provider
  if (!connectionManager.activeProvider) {
    const connections = connectionManager.listConnections();
    if (connections.length > 0) {
      const first = connections[0];
      connectionManager.activeProvider = first.provider;
      const conn = connectionManager.connections.get(first.provider);
      const firstModel = conn?.models?.[0];
      const modelId = typeof firstModel === 'string' ? firstModel : firstModel?.id;
      connectionManager.activeModel = modelId || null;
    }
  }

  // Restore saved theme
  const savedTheme = getConfig('theme');
  if (savedTheme && THEMES[savedTheme]) setTheme(savedTheme);

  const config = await loadConfig(options);
  let agent = null;

  if (connectionManager.getActive()) {
    try {
      const client = createClient(config);
      agent = new Agent(client, config, 'build');
    } catch (e) {
      // will show "not connected" in UI
    }
  }

  // Enter alternate screen buffer FIRST, before Ink render
  // This prevents the double display issue
  process.stdout.write('\x1b[?1049h');
  altScreenEntered = true;

  // Cleanup function – idempotent, restores screen, clears terminal and removes listeners & guard
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Remove process listeners first
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    // Exit alternate screen and clear
    if (altScreenEntered) {
      process.stdout.write('\x1b[?1049l');
      altScreenEntered = false;
    }
    process.stdout.write('\x1b[2J\x1b[0;0H');
    // Reset the guard so the app can be started again later
    appRunning = false;
  };

  // Handlers for signals that invoke cleanup then exit
  const sigintHandler = () => { cleanup(); process.exit(0); };
  const sigtermHandler = () => { cleanup(); process.exit(0); };

  // Register listeners – using once to avoid duplicates, but also ensure removal on manual cleanup
  process.once('exit', cleanup);
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  // Render AFTER entering alternate screen to avoid duplicate display
  const { waitUntilExit } = render(
    h(App, { initialConfig: config, initialAgent: agent }),
  );

// Ensure cleanup runs even if waitUntilExit throws
try {
  await waitUntilExit();
} finally {
  cleanup();
}

}
