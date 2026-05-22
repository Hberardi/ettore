import { connectionManager } from '../providers/index.js';
import { saveConfig } from '../config/index.js';
import { listInstallSessionApprovals } from '../tools/index.js';
import { stripAllAnsi, stripOrphans } from '../utils/ansi.js';

// ─── Themes ────────────────────────────────────────────────────────────────
export const THEMES = {
  default: {
    label: 'Default',
    accent: '\x1b[38;5;51m',
    text: '\x1b[38;5;255m',
    dim: '\x1b[38;5;250m',
    ok: '\x1b[38;5;84m',
    warn: '\x1b[38;5;220m',
    err: '\x1b[38;5;203m',
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    italic: '\x1b[3m',
    code: '\x1b[38;5;81m',
    codeBg: '\x1b[48;5;236m',
    string: '\x1b[38;5;150m',
    keyword: '\x1b[38;5;203m',
    comment: '\x1b[38;5;247m',
    number: '\x1b[38;5;215m',
    border: '\x1b[38;5;246m',
  },
  midnight: {
    label: 'Midnight',
    accent: '\x1b[38;5;75m',
    text: '\x1b[38;5;189m',
    dim: '\x1b[38;5;152m',
    ok: '\x1b[38;5;86m',
    warn: '\x1b[38;5;215m',
    err: '\x1b[38;5;203m',
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    italic: '\x1b[3m',
    code: '\x1b[38;5;153m',
    codeBg: '\x1b[48;5;234m',
    string: '\x1b[38;5;183m',
    keyword: '\x1b[38;5;211m',
    comment: '\x1b[38;5;147m',
    number: '\x1b[38;5;221m',
    border: '\x1b[38;5;111m',
  },
  matrix: {
    label: 'Matrix',
    accent: '\x1b[38;5;46m',
    text: '\x1b[38;5;40m',
    dim: '\x1b[38;5;77m',
    ok: '\x1b[38;5;46m',
    warn: '\x1b[38;5;190m',
    err: '\x1b[38;5;196m',
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    italic: '\x1b[3m',
    code: '\x1b[38;5;82m',
    codeBg: '\x1b[48;5;232m',
    string: '\x1b[38;5;156m',
    keyword: '\x1b[38;5;46m',
    comment: '\x1b[38;5;71m',
    number: '\x1b[38;5;191m',
    border: '\x1b[38;5;70m',
  },
  forest: {
    label: 'Forest',
    accent: '\x1b[38;5;84m',
    text: '\x1b[38;5;157m',
    dim: '\x1b[38;5;151m',
    ok: '\x1b[38;5;114m',
    warn: '\x1b[38;5;186m',
    err: '\x1b[38;5;167m',
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    italic: '\x1b[3m',
    code: '\x1b[38;5;123m',
    codeBg: '\x1b[48;5;235m',
    string: '\x1b[38;5;180m',
    keyword: '\x1b[38;5;173m',
    comment: '\x1b[38;5;144m',
    number: '\x1b[38;5;221m',
    border: '\x1b[38;5;114m',
  },
  };

let activeTheme = THEMES.default;
const C = new Proxy({}, { get: (_, k) => activeTheme[k] || '' });

export function setTheme(name, options = {}) {
  if (THEMES[name]) {
    activeTheme = THEMES[name];
    if (options.persist === false) return;
    try {
      saveConfig('theme', name);
    } catch {
      // Theme persistence is best-effort; rendering should still work when
      // the global config directory is read-only.
    }
  }
}

// ─── ANSI Helpers ───────────────────────────────────────────────────────────
const ANSI = {
  clear:       '\x1b[2J',
  home:        '\x1b[H',
  hide:        '\x1b[?25l',
  show:        '\x1b[?25h',
  altScreen:   '\x1b[?1049h',
  normalScreen:'\x1b[?1049l',
  move:        (x, y) => `\x1b[${y};${x}H`,
};

// ─── Enhanced Animation State ─────────────────────────────────────────────
const PULSE_FRAMES = ['○', '◐', '◑', '●', '◑', '◐'];
const WAVE_FRAMES = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▂'];
const TYPING_CURSOR = ['█', '▌', ' ', '▌'];
const GLOW_COLORS = ['\x1b[38;5;45m', '\x1b[38;5;51m', '\x1b[38;5;87m', '\x1b[38;5;123m', '\x1b[38;5;159m'];

// Pre-compiled regex for syntax highlighting (avoids repeated RegExp construction per render)
const _HL_KEYWORDS = ['const','let','var','function','return','if','else','for','while','class','import','export','from','async','await','try','catch','throw','new','this','true','false','null','undefined']
  .map(kw => ({ kw, re: new RegExp(`\\b(${kw})\\b`, 'g') }));
const _HL_STRINGS  = /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g;
const _HL_NUMBERS  = /\b(\d+(?:\.\d+)?)\b/g;
const _HL_COMMENTS = /(\/\/.*$)/gm;
const _HL_COMMENTS_BLOCK = /(\/\*[\s\S]*?\*\/)/g;

// Tool category colors (Claude Code style)
const TOOL_COLORS = {
  read:         C.accent,    // cyan — reading files
  write:        C.ok,        // green — writing files
  edit:         C.string,    // yellow — editing files
  bash:         C.warn,     // yellow — shell commands
  glob:         C.dim,      // gray — file discovery
  grep:         C.dim,      // gray — searching
  list_dir:     C.dim,      // gray — directory listing
  file_info:    C.dim,      // gray — metadata
  git_status:   C.string,   // yellow — git
  git_diff:     C.string,   // yellow — git
  webfetch:     C.code,     // blue — fetching URLs
  websearch:    C.code,     // blue — web search
  read_server_console: C.code, // blue — server logs
  ask_user:     C.accent,   // cyan — user interaction
  memory_read:  C.dim,      // gray — memory
  memory_write: C.dim,      // gray — memory
};

// ─── TUI State ──────────────────────────────────────────────────────────────
class TUI {
  constructor() {
    this.cols = process.stdout.columns || 80;
    this.rows = process.stdout.rows || 24;
    this.messages = [];
    this.streaming = null;
    this.todos = [];
    this.input = '';
    this.mode = 'build';
    this.isRunning = false;
    this.provider = '';
    this.model = '';
    this.sessionId = '';
    this.gitBranch = '';
    this.detectedLang = '';
    this.availableHeight = 0;
    this.scrollOffset = 0;
    this.needsRender = false;
    this.renderPending = false;
    
    // Enhanced animation state
    this.animationFrame = 0;
    this.typingPhase = 0;
    this.glowPhase = 0;
    this.lastCharTime = 0;

    this.sessionCost = 0;
    this.askUser = null;
    this.askUserIdx = 0;
    this.askUserInput = '';
    this.exitConfirmMode = false;
    this.currentPlan = [];
    this.sidebarWidth = 32;
  }

  updateSize() {
    this.cols = process.stdout.columns || 80;
    this.rows = process.stdout.rows || 24;
    this.availableHeight = Math.max(4, this.rows - 6);
    this.needsRender = true;
  }

  render() {
    this._render();
  }

  _render() {
    const sidebarWidth = Math.min(this.sidebarWidth, Math.max(24, this.cols - 40));
    const mainWidth = Math.max(20, this.cols - sidebarWidth - 1);
    const msgLines = this._renderMessages();
    const sideLines = this._renderSidebar(sidebarWidth);
    this.animationFrame = (this.animationFrame + 1) % 100;
    let out = ANSI.hide;

    out += ANSI.move(1, 1) + this._padVisual(this._renderHeader(), this.cols);

    for (let i = 0; i < this.availableHeight; i++) {
      out += ANSI.move(1, i + 2) + this._padVisual(msgLines[i] || '', mainWidth);
      out += ANSI.move(mainWidth + 1, i + 2) + ` `;
      out += ANSI.move(mainWidth + 2, i + 2) + `\x1b[48;5;236m${this._padVisual(sideLines[i] || '', sidebarWidth)}${C.reset}`;
    }

    out += ANSI.move(1, this.availableHeight + 2) + this._padVisual(this._renderStatus(), mainWidth);
    out += ANSI.move(mainWidth + 1, this.availableHeight + 2) + ` `;
    out += ANSI.move(mainWidth + 2, this.availableHeight + 2) + `\x1b[48;5;236m${this._padVisual(this._renderSidebarStatus(sidebarWidth), sidebarWidth)}${C.reset}`;

    out += ANSI.move(1, this.availableHeight + 3) + this._renderInputBorder(true, mainWidth);
    out += ANSI.move(1, this.availableHeight + 4) + this._renderInput(mainWidth);
    out += ANSI.move(1, this.availableHeight + 5) + this._renderInputBorder(false, mainWidth);
    out += ANSI.move(mainWidth + 1, this.availableHeight + 3) + ` `;
    out += ANSI.move(mainWidth + 1, this.availableHeight + 4) + ` `;
    out += ANSI.move(mainWidth + 1, this.availableHeight + 5) + ` `;
    out += ANSI.move(mainWidth + 2, this.availableHeight + 3) + `\x1b[48;5;236m${' '.repeat(sidebarWidth)}${C.reset}`;
    out += ANSI.move(mainWidth + 2, this.availableHeight + 4) + `\x1b[48;5;236m${' '.repeat(sidebarWidth)}${C.reset}`;
    out += ANSI.move(mainWidth + 2, this.availableHeight + 5) + `\x1b[48;5;236m${' '.repeat(sidebarWidth)}${C.reset}`;

    // Overlays
    out += this._renderCommandPalette();
    out += this._renderSubMenu();
    out += this._renderApiKeyInput();
    out += this._renderAskUser();
    out += this._renderExitConfirm();

    out += ANSI.move(1, this.rows);
    process.stdout.write(this._stripOrphanSgr(out));
  }

  // Final defensive pass: protect well-formed ESC sequences, then nuke any
  // remaining orphan SGR-like patterns the model may have emitted as text.
  _stripOrphanSgr(text) {
    return stripOrphans(text);
  }

  _padVisual(str, width) {
    const clipped = this._truncateVisual(str, width);
    const vlen = this._visualLen(clipped);
    const pad  = Math.max(0, width - vlen);
    return clipped + ' '.repeat(pad);
  }

  _renderHeader() {
    const modeLabel = this.mode === 'plan' ? 'PLAN' : 'BUILD';
    const modeColor = this.mode === 'plan' ? C.warn : C.ok;
    const session = this._truncate(this.sessionId || '', 8);
    const provider = this.provider && this.provider !== 'unknown' ? this.provider : 'no provider';
    const model = this.model && this.model !== 'unknown' ? this._truncate(this.model, 25) : 'not configured';

    const glowIdx = Math.floor(this.animationFrame / 20) % GLOW_COLORS.length;
    const glowColor = GLOW_COLORS[glowIdx];

    const leftPlain = ` ETTORE  ${session}`;
    const rightPlain = `${provider} ${model} ${modeLabel}`;
    const pad = Math.max(0, this.cols - leftPlain.length - rightPlain.length);

    const bg = '\x1b[48;5;237m';
    const left = `${bg}${C.bold}${glowColor}█${C.reset}${bg}${C.bold}${C.text} ETTORE ${C.reset}${bg}${C.dim}${session}${C.reset}`;
    const providerColor = provider === 'no provider' ? C.warn : C.dim;
    const right = `${bg}${providerColor}${provider}${C.reset}${bg} ${C.text}${model}${C.reset}${bg} ${modeColor}${C.bold}[${modeLabel}]${C.reset}`;
    return left + bg + ' '.repeat(pad) + right + C.reset;
  }

  _renderMessages() {
    const maxWidth = this.cols - 3;

    if (this.messages.length === 0 && !this.streaming) {
      const isConnected = Boolean(connectionManager.getActive());
      const modeColor = this.mode === 'plan' ? C.warn : C.ok;
      const lines = [];
      lines.push(`${C.accent}${C.bold}⬡ ETTORE — AI Coding Agent${C.reset}`);
      lines.push('');
      if (isConnected) {
        const provider = connectionManager.activeProvider || 'provider';
        const model = connectionManager.activeModel || 'default model';
        lines.push(`${C.ok}${C.bold}Ready${C.reset}  ${C.text}${provider}/${this._truncate(model, Math.max(18, this.cols - 28))}${C.reset}`);
      } else {
        lines.push(`${C.warn}${C.bold}Setup needed${C.reset}  ${C.text}Connect a provider before asking ETTORE to work.${C.reset}`);
      }
      lines.push('');
      lines.push(`${C.bold}${C.text}Start${C.reset}`);
      lines.push(`  ${C.accent}/${C.reset}${C.text}connect${C.reset}        ${C.dim}choose OpenAI, Anthropic, Ollama, or compatible APIs${C.reset}`);
      lines.push(`  ${C.accent}/${C.reset}${C.text}use${C.reset}            ${C.dim}select the active model${C.reset}`);
      lines.push(`  ${C.accent}/${C.reset}${C.text}help${C.reset}           ${C.dim}show guided command help${C.reset}`);
      lines.push('');
      lines.push(`${C.bold}${C.text}Work faster${C.reset}`);
      lines.push(`  ${C.accent}@${C.reset}${C.text}src/file.js${C.reset}    ${C.dim}attach a file to your next prompt${C.reset}`);
      lines.push(`  ${C.accent}!${C.reset}${C.text}npm test${C.reset}       ${C.dim}run a shell command${C.reset}`);
      lines.push(`  ${C.accent}Tab${C.reset}             ${C.dim}toggle ${modeColor}${this.mode.toUpperCase()}${C.reset}${C.dim} mode${C.reset}`);
      lines.push(`  ${C.accent}↑↓${C.reset}              ${C.dim}scroll conversation history${C.reset}`);
      while (lines.length < this.availableHeight) lines.push('');
      return lines;
    }

    const allLines = this._renderWorkspaceBanner(maxWidth);
    for (const msg of this.messages) {
      this._renderMessageFull(msg, maxWidth).forEach(l => allLines.push(l));
    }
    if (this.streaming) {
      this._renderStreamingFull(maxWidth).forEach(l => allLines.push(l));
    }

    const totalLines = allLines.length;
    const maxScroll  = Math.max(0, totalLines - this.availableHeight);
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

    const startIdx    = Math.max(0, totalLines - this.availableHeight - this.scrollOffset);
    const visibleLines = allLines.slice(startIdx, startIdx + this.availableHeight);

    while (visibleLines.length < this.availableHeight) visibleLines.push('');
    return visibleLines;
  }

  _renderWorkspaceBanner(maxWidth) {
    const provider = connectionManager.activeProvider || 'no provider';
    const mode = this.mode.toUpperCase();
    const workdir = process.cwd().split('/').slice(-2).join('/');
    const line = ` ${C.accent}${C.bold}▌${C.reset} ${C.bold}${C.text}${mode}${C.reset} ${C.dim}workspace${C.reset} ${C.text}${workdir}${C.reset} ${C.dim}· llm:${C.reset}${provider === 'no provider' ? C.warn : C.accent}${provider}${C.reset} ${C.dim}· / commands · @ attach · ! shell${C.reset}`;
    return [this._truncateVisual(line, maxWidth), ''];
  }

  _renderMessageFull(msg, maxWidth) {
    if (msg.role === 'todos') return this._renderTodoBlock(msg.items, maxWidth);

    const isUser = msg.role === 'user';
    const isSys = msg.role === 'system';

    if (isSys) {
      const lines = [];
      if (msg.text) {
        msg.text.split('\n').forEach(rawLine => {
          const line = this._sanitizeForRender(rawLine);
          if (!line.trim()) return;
          const isOk = line.startsWith('✓') || line.startsWith('✔');
          const isErr = line.startsWith('✗') || line.startsWith('✘');
          const isWarn = line.startsWith('⚠') || line.startsWith('!');
          const color = isOk ? C.ok : isErr ? C.err : isWarn ? C.warn : C.dim;
          lines.push(` ${color}◆${C.reset} ${color}${line}${C.reset}`);
        });
      }
      lines.push('');
      return lines;
    }

    if (isUser) {
      const rows = [];
      const innerWidth = this._bubbleInnerWidth(maxWidth, 'right');
      if (msg.text) {
        msg.text.split('\n').forEach(rawLine => {
          const sanitized = this._sanitizeForRender(rawLine);
          if (!rawLine.trim()) {
            rows.push('');
          } else {
            this._wrapText(sanitized, innerWidth).forEach(wrapped => {
              rows.push(`${C.text}${wrapped}${C.reset}`);
            });
          }
        });
      }
      return this._renderBubble({
        label: 'YOU',
        meta: this._messageTime(msg),
        rows,
        color: C.accent,
        maxWidth,
        align: 'right',
      });
    }

    const glowIdx = Math.floor(this.animationFrame / 20) % GLOW_COLORS.length;
    const glowColor = GLOW_COLORS[glowIdx];
    const rows = [];
    const assistantWidth = this._bubbleInnerWidth(maxWidth, 'left');

    if (msg.text) {
      const rawLines = msg.text.split('\n');
      let i = 0;
      while (i < rawLines.length) {
        const rawLine = rawLines[i];
        const normalized = this._normalizeAssistantLine(rawLine);
        const sanitized = normalized;

        // Detect markdown table
        if (sanitized.match(/^\|.*\|$/)) {
          const tableLines = [];
          while (i < rawLines.length) {
            const ln = this._normalizeAssistantLine(rawLines[i]);
            if (!ln.match(/^\|.*\|$/)) break;
            tableLines.push(ln);
            i++;
          }
          const formatted = this._renderMarkdownTable(tableLines);
          formatted.forEach(row => {
            this._wrapText(row, assistantWidth).forEach(wrapped => {
              rows.push(`${C.border}${wrapped}${C.reset}`);
            });
          });
          continue;
        }

        // Detect markdown headings
        if (sanitized.match(/^#{1,4}\s/)) {
          const heading = this._renderMarkdown(sanitized.replace(/^#{1,6}\s+/, ''));
          const colored = `${C.accent}${C.bold}${heading}${C.reset}`;
          this._wrapText(colored, assistantWidth).forEach(wrapped => {
            rows.push(wrapped);
          });
          i++;
          continue;
        }

        // Detect blank lines - add visual spacing
        if (!sanitized.trim()) {
          rows.push('');
          i++;
          continue;
        }

        const pipeLine = this._formatLoosePipeLine(sanitized);
        if (pipeLine !== null) {
          if (pipeLine) {
            const marked = this._renderMarkdown(pipeLine);
            this._wrapText(marked, assistantWidth).forEach(wrapped => {
              rows.push(`${C.text}${wrapped}${C.reset}`);
            });
          }
          i++;
          continue;
        }

        // Detect list items
        if (sanitized.match(/^[-*+]\s/) || sanitized.match(/^\d+\.\s/)) {
          const listContent = this._renderMarkdown(sanitized);
          this._wrapText(listContent, assistantWidth).forEach(wrapped => {
            rows.push(`${C.text}${wrapped}${C.reset}`);
          });
          i++;
          continue;
        }

        const tabularNormalized = this._tableLikeToBullet(sanitized, assistantWidth);
        const marked = this._highlightCode(tabularNormalized);
        const highlighted = this._renderMarkdown(marked);
        this._wrapText(highlighted, assistantWidth).forEach(wrapped => {
          rows.push(wrapped);
        });
        i++;
      }
    }

    this._compactRows(rows);

    return this._renderAssistantBlock({
      label: 'ETTORE',
      meta: this._messageTime(msg),
      rows,
      color: glowColor,
      maxWidth,
    });
  }

  _renderTodoBlock(items, maxWidth) {
    const lines = [];
    const bar   = `${C.dim}${'─'.repeat(Math.min(36, maxWidth - 2))}${C.reset}`;

    lines.push(`${C.accent}${C.bold}  Tasks${C.reset}`);
    lines.push(`  ${bar}`);

    if (!items || items.length === 0) {
      lines.push(`  ${C.dim}no tasks${C.reset}`);
    } else {
      items.forEach((t, i) => {
        const icon   = t.status === 'done'    ? `${C.ok}✔${C.reset}`
                     : t.status === 'running' ? `${C.warn}●${C.reset}`
                     :                          `${C.dim}○${C.reset}`;
        const strike = t.status === 'done' ? '\x1b[9m' : '';
        const num    = `${C.dim}${String(i + 1).padStart(2)}.${C.reset}`;
        const txt    = this._truncate(this._sanitizeForRender(t.text), maxWidth - 9);
        lines.push(`  ${num} ${icon} ${strike}${txt}${C.reset}`);
      });
    }

    lines.push('');
    return lines;
  }

  _compactRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    const compacted = [];
    let prevBlank = false;
    for (const r of rows) {
      const blank = !r || !this._stripAnsi(String(r)).trim();
      if (blank) {
        if (!prevBlank) compacted.push('');
      } else {
        compacted.push(r);
      }
      prevBlank = blank;
    }
    while (compacted.length > 0) {
      const last = compacted[compacted.length - 1];
      if (last && this._stripAnsi(String(last)).trim()) break;
      compacted.pop();
    }
    rows.length = 0;
    rows.push(...compacted);
    return rows;
  }

  _bubbleInnerWidth(maxWidth, align) {
    const ratio = align === 'right' ? 0.68 : 0.84;
    const minWidth = align === 'right' ? 30 : 40;
    const bubbleWidth = Math.min(maxWidth - 2, Math.max(minWidth, Math.floor(maxWidth * ratio)));
    return Math.max(18, bubbleWidth - 4);
  }

  _renderBubble({ label, meta, rows, color, maxWidth, align }) {
    const ratio = align === 'right' ? 0.68 : 0.84;
    const minWidth = align === 'right' ? 32 : 42;
    const bubbleWidth = Math.min(maxWidth - 2, Math.max(minWidth, Math.floor(maxWidth * ratio)));
    const innerWidth = Math.max(18, bubbleWidth - 4);
    const leftPad = align === 'right' ? Math.max(1, maxWidth - bubbleWidth - 1) : 1;
    const pad = ' '.repeat(leftPad);
    const labelText = ` ${label}${meta ? ` ${meta}` : ''} `;
    const topFill = '━'.repeat(Math.max(0, bubbleWidth - 2 - this._visualLen(labelText)));
    const emptyRows = rows && rows.length ? rows : [''];
    const out = [];

    out.push(`${pad}${color}╭${C.reset}${color}${C.bold}${labelText}${C.reset}${color}${topFill}╮${C.reset}`);
    for (const row of emptyRows) {
      const clippedRow = this._truncateVisual(row, innerWidth);
      const visible = this._visualLen(clippedRow);
      const fill = ' '.repeat(Math.max(0, innerWidth - visible));
      out.push(`${pad}${color}┃${C.reset} ${clippedRow}${fill} ${color}┃${C.reset}`);
    }
    out.push(`${pad}${color}╰${'━'.repeat(Math.max(0, bubbleWidth - 2))}╯${C.reset}`);
    out.push('');
    return out;
  }

  _renderAssistantBlock({ label, meta, rows, color, maxWidth }) {
    const contentWidth = Math.max(18, maxWidth - 5);
    const cleanRows = rows && rows.length ? rows : [''];
    const out = [];
    const title = `${color}${C.bold}${label}${C.reset}${meta ? `${C.dim} ${meta}${C.reset}` : ''}`;
    out.push(` ${title}`);
    for (const row of cleanRows) {
      if (!this._stripAnsi(String(row)).trim()) {
        out.push('');
        continue;
      }
      // Pre-formatted rows (side-by-side diff, ASCII art, tables) rely on
      // multi-space padding that _wrapText would collapse. If the row already
      // fits, keep it verbatim; otherwise wrap+truncate as a fallback.
      if (this._visualLen(row) <= contentWidth) {
        out.push(`  ${row}`);
        continue;
      }
      this._wrapText(row, contentWidth).forEach(wrapped => {
        out.push(`  ${this._truncateVisual(wrapped, contentWidth)}`);
      });
    }
    out.push('');
    return out;
  }

  // Returns a short human-readable description of a tool call (truncated to fit)
  _describeToolCall(name, args, maxLen = 55) {
    if (!args) return '';
    let desc = '';
    switch (name) {
      case 'bash':
        desc = (args.command || '').replace(/\n/g, ' ').trim();
        break;
      case 'read':
        desc = args.file_path || '';
        if (args.offset) desc += `:${args.offset}`;
        break;
      case 'write':
        desc = args.file_path || '';
        break;
      case 'edit':
        desc = args.file_path || '';
        break;
      case 'glob':
        desc = args.pattern || '';
        break;
      case 'grep':
        desc = args.pattern ? `"${args.pattern}"` : '';
        if (args.path) {
          const p = args.path.split('/');
          desc += ` in ${p.slice(-1).join('/')}`;
        }
        break;
      case 'list_dir':
        desc = args.path || '.';
        if (args.recursive) desc += ' recursive';
        break;
      case 'file_info':
        desc = args.path || '';
        break;
      case 'git_status':
        desc = args.workdir || '';
        break;
      case 'git_diff':
        desc = args.file_path || (args.staged ? 'staged' : 'unstaged');
        break;
      case 'webfetch':
        desc = args.url || '';
        break;
      case 'websearch':
        desc = args.query || '';
        if (args.site) desc += ` site:${args.site}`;
        break;
      case 'ask_user':
        desc = args.question || '';
        break;
      case 'memory_read':
      case 'memory_write':
        desc = args.section ? `[${args.section}]` : '';
        break;
      default:
        desc = '';
    }
    // Keep only the last 2 path segments for file paths to save space
    if (['read','write','edit'].includes(name) && desc.includes('/')) {
      const parts = desc.split('/');
      desc = parts.slice(-2).join('/');
    }
    // Model-supplied args may contain ANSI orphans — sanitize before display.
    desc = stripAllAnsi(desc).replace(/\s+/g, ' ').trim();
    return desc.length > maxLen ? desc.slice(0, maxLen - 1) + '…' : desc;
  }

  _summarizeToolOutput(name, output, args) {
    if (!output) return '';
    const s = String(output).trim();
    switch (name) {
      case 'read': {
        const lines = s.split('\n');
        const total = lines.length;
        const bytes = new TextEncoder().encode(s).length;
        const kb = (bytes / 1024).toFixed(1);
        if (args?.offset) return `[${total} lines, ${kb}kB, from :${args.offset}]`;
        return `[${total} lines, ${kb}kB]`;
      }
      case 'glob': {
        const files = s.split('\n').filter(Boolean);
        if (files.length === 0) return `[no files]`;
        if (files.length <= 3) return `[${files.join(', ')}]`;
        return `[${files.length} files: ${files.slice(0, 2).join(', ')}…]`;
      }
      case 'grep': {
        const matches = s.split('\n').filter(Boolean);
        if (matches.length === 0) return `[no matches]`;
        if (matches.length === 1) return `[1 match: ${this._truncate(stripAllAnsi(matches[0]), 40)}]`;
        return `[${matches.length} matches]`;
      }
      case 'list_dir': {
        const entries = s.split('\n').filter(Boolean).filter(l => !l.startsWith('...'));
        return `[${entries.length} entries]`;
      }
      case 'file_info':
        return `[metadata]`;
      case 'git_status': {
        const lines = s.split('\n').filter(Boolean);
        return lines.length ? `[${lines.length} status lines]` : `[clean]`;
      }
      case 'git_diff':
        return s === '(no diff)' ? `[no diff]` : `[diff ${new TextEncoder().encode(s).length}b]`;
      case 'bash': {
        const firstLine = s.split('\n')[0];
        return `[${this._truncate(stripAllAnsi(firstLine), 50)}]`;
      }
      case 'write':
        return `[written]`;
      case 'edit': {
        if (args?.oldString) {
          const removed = (args.oldString.match(/\n/g) || []).length;
          const added = (String(output).match(/\n/g) || []).length;
          if (removed > 0 || added > 0) return `[${added} +${added - removed} lines]`;
        }
        return `[modified]`;
      }
      case 'webfetch':
        return `[fetched ${new TextEncoder().encode(s).length}b]`;
      case 'websearch': {
        const count = (s.match(/^\d+\./gm) || []).length;
        return count ? `[${count} results]` : `[search complete]`;
      }
      default:
        return `[${s.slice(0, 40)}]`;
    }
  }

  _renderDiffSideBySide(diffPreview, innerWidth) {
    if (!diffPreview) return [];
    const colWidth = Math.max(14, Math.floor((innerWidth - 6) / 2));
    const before = Array.isArray(diffPreview.beforeLines) ? diffPreview.beforeLines : [];
    const after = Array.isArray(diffPreview.afterLines) ? diffPreview.afterLines : [];
    const total = Math.max(before.length, after.length, 1);
    const leftBorder = C.err;
    const rightBorder = C.ok;
    const rows = [];

    const leftLabel = `${C.err}${C.bold} before ${C.reset}`;
    const rightLabel = `${C.ok}${C.bold} after ${C.reset}`;
    const leftTopFill = '─'.repeat(Math.max(0, colWidth - this._visualLen(leftLabel)));
    const rightTopFill = '─'.repeat(Math.max(0, colWidth - this._visualLen(rightLabel)));
    rows.push(
      `    ${leftBorder}┌${leftLabel}${leftTopFill}┐${C.reset}  ${rightBorder}┌${rightLabel}${rightTopFill}┐${C.reset}`
    );

    for (let i = 0; i < total; i++) {
      const b = this._truncateVisual(this._sanitizeForRender(before[i] ?? ''), colWidth);
      const a = this._truncateVisual(this._sanitizeForRender(after[i] ?? ''), colWidth);
      const bPad = b + ' '.repeat(Math.max(0, colWidth - this._visualLen(b)));
      const aPad = a + ' '.repeat(Math.max(0, colWidth - this._visualLen(a)));
      const left = `${C.err}${bPad}${C.reset}`;
      const right = `${C.ok}${aPad}${C.reset}`;
      rows.push(
        `    ${leftBorder}│${C.reset}${left}${leftBorder}│${C.reset}  ${rightBorder}│${C.reset}${right}${rightBorder}│${C.reset}`
      );
    }
    rows.push(
      `    ${leftBorder}└${'─'.repeat(colWidth)}┘${C.reset}  ${rightBorder}└${'─'.repeat(colWidth)}┘${C.reset}`
    );
    if (diffPreview.truncated) rows.push(`    ${C.dim}… diff preview truncated${C.reset}`);
    return rows;
  }

  _renderStreamingFull(maxWidth) {
    const text = this.streaming?.text || '';
    const tools = this.streaming?.tools || [];
    const reasoning = this.streaming?.reasoning || '';
    const waitKind = this.streaming?.waitKind || 'model';
    const lastActivityAt = Number(this.streaming?.lastActivityAt) || 0;
    const stallMs = Number(this.streaming?.stallMs) || 1800;

    const pulseIdx = Math.floor(this.animationFrame / 10) % PULSE_FRAMES.length;
    const pulse = PULSE_FRAMES[pulseIdx];
    const waveIdx = Math.floor(this.animationFrame / 8) % WAVE_FRAMES.length;
    const glowIdx = Math.floor(this.animationFrame / 15) % GLOW_COLORS.length;
    const glowColor = GLOW_COLORS[glowIdx];
    const cursorIdx = Math.floor(this.animationFrame / 6) % TYPING_CURSOR.length;
    const cursor = TYPING_CURSOR[cursorIdx];

    const runningTool = tools.slice().reverse().find(t => t.status === 'running');
    let actLabel;
    if (runningTool) {
      const toolColor = TOOL_COLORS[runningTool.name] || C.accent;
      const desc = this._describeToolCall(runningTool.name, runningTool.args, 40);
      const descStr = desc ? `${C.dim}: ${C.reset}${C.text}${desc}${C.reset}` : '';
      actLabel = `${toolColor}${pulse}${C.reset} ${toolColor}${C.bold}${runningTool.name}${C.reset}${descStr}`;
    } else if (text || reasoning) {
      const waveBar = WAVE_FRAMES.slice(0, 5).map((_, i) =>
        WAVE_FRAMES[(waveIdx + i) % WAVE_FRAMES.length]
      ).join('');
      actLabel = `${C.ok}${pulse}${C.reset} ${C.dim}writing${C.reset} ${C.accent}${waveBar}${C.reset} ${C.text}${cursor}${C.reset}`;
    } else {
      actLabel = `${glowColor}${pulse}${C.reset} ${C.accent}${C.bold}●●●${C.reset} ${C.dim}thinking…${C.reset}`;
    }

    const rows = [actLabel];
    const innerWidth = this._bubbleInnerWidth(maxWidth, 'left');
    const idleMs = lastActivityAt > 0 ? (Date.now() - lastActivityAt) : 0;
    if (idleMs >= stallMs) {
      const waitText = waitKind === 'tool'
        ? `${C.warn}stato:${C.reset} ${C.dim}in attesa completamento tool…${C.reset}`
        : `${C.accent}stato:${C.reset} ${C.dim}in attesa risposta modello…${C.reset}`;
      rows.push(waitText);
    }

    // Show plan (if any) at the top of the message bubble
    if (this.currentPlan.length > 0) {
      const maxPlan = Math.min(this.currentPlan.length, 5);
      for (let i = 0; i < maxPlan; i++) {
        const item = this.currentPlan[i];
        const icon = item.status === 'done' ? `${C.ok}✔${C.reset}`
          : item.status === 'running' ? `${C.warn}▸${C.reset}`
          : `${C.dim}○${C.reset}`;
        const txt = this._truncate(this._sanitizeForRender(item.text), innerWidth - 8);
        rows.push(`${icon} ${C.dim}${i + 1}.${C.reset} ${txt}`);
      }
      if (this.currentPlan.length > maxPlan) {
        rows.push(`${C.dim}+${this.currentPlan.length - maxPlan} more…${C.reset}`);
      }
      rows.push(`${C.dim}${'·'.repeat(Math.min(innerWidth, 36))}${C.reset}`);
    }

    // Show response text FIRST (most important — what the model is saying)
    if (text) {
      const allWrapped = [];
      text.split('\n').forEach(rawLine => {
        const normalized = this._normalizeAssistantLine(rawLine);
        const pipeLine = this._formatLoosePipeLine(normalized);
        const line = pipeLine === null ? normalized : pipeLine;
        if (!line && pipeLine !== null) return;
        this._wrapText(line, innerWidth).forEach(w => allWrapped.push(w));
      });
      const maxShow = Math.max(3, Math.floor((this.availableHeight || 10) / 2));
      const start = Math.max(0, allWrapped.length - maxShow);
      allWrapped.slice(start).forEach(wrapped => {
        rows.push(wrapped);
      });
      // Show reasoning AFTER text content
      if (reasoning) {
        const maxReasoning = Math.min(reasoning.length, 300);
        const reasonText = reasoning.slice(0, maxReasoning);
        const truncated = reasoning.length > 300;
        reasonText.split('\n').forEach(rawLine => {
          if (!rawLine.trim()) { rows.push(''); return; }
          const wrapped = this._wrapText(`${C.dim}${C.italic}${rawLine}${C.reset}`, innerWidth);
          wrapped.forEach(w => rows.push(w));
        });
        if (truncated) rows.push(`${C.dim}…${C.reset}`);
      }
    } else if (reasoning) {
      // No text yet — show reasoning directly as the main output
      const maxShow = Math.max(3, Math.floor((this.availableHeight || 10) / 2));
      const reasonLines = reasoning.split('\n').filter(l => l.trim());
      const start = Math.max(0, reasonLines.length - maxShow);
      reasonLines.slice(start).forEach(rawLine => {
        const wrapped = this._wrapText(`${C.accent}${rawLine}${C.reset}`, innerWidth);
        wrapped.forEach(w => rows.push(w));
      });
    } else if (!runningTool && tools.length === 0) {
      const dots = '·'.repeat(3 + (this.animationFrame % 3));
      rows.push(`${C.dim}${dots}${C.reset}`);
    }

    // Show tools with output previews
    if (tools.length > 0) {
      rows.push('');
      rows.push(`${C.dim}tools${C.reset}`);
      const maxTools = Math.max(2, (this.availableHeight || 10) - 4);
      const start = Math.max(0, tools.length - maxTools);
      tools.slice(start).forEach(tool => {
        const toolColor = TOOL_COLORS[tool.name] || C.dim;
        const desc = this._describeToolCall(tool.name, tool.args, maxWidth - 18);
        const descStr = desc ? ` ${C.dim}${desc}${C.reset}` : '';
        const durStr = tool.durationMs != null
          ? ` ${C.dim}${(tool.durationMs / 1000).toFixed(1)}s${C.reset}`
          : '';
        if (tool.status === 'done') {
          const outStr = this._summarizeToolOutput(tool.name, tool.output, tool.args);
          const outColor = tool.output ? C.text : C.dim;
          const outPreview = outStr ? ` ${outColor}${outStr}${C.reset}` : '';
          rows.push(`  ${C.ok}✔${C.reset} ${toolColor}${tool.name}${C.reset}${descStr}${outPreview}${durStr}`);
        } else {
          rows.push(`  ${toolColor}${pulse}${C.reset} ${toolColor}${C.bold}${tool.name}${C.reset}${descStr} ${C.dim}…${C.reset}`);
        }
        if (tool.diffPreview) {
          const diffRows = this._renderDiffSideBySide(tool.diffPreview, Math.max(20, innerWidth - 2));
          diffRows.forEach(r => rows.push(r));
        }
      });
    }

    return this._renderAssistantBlock({
      label: 'ETTORE',
      meta: 'now',
      rows,
      color: glowColor,
      maxWidth,
    });
  }

  _renderStatus() {
    const sep = `${C.dim} · ${C.reset}`;
    const glowIdx = Math.floor(this.animationFrame / 20) % GLOW_COLORS.length;
    const glowColor = GLOW_COLORS[glowIdx];
    const pulseIdx = Math.floor(this.animationFrame / 10) % PULSE_FRAMES.length;
    const pulse = PULSE_FRAMES[pulseIdx];
    const state = this.isRunning
      ? `${glowColor}${C.bold}${pulse}${C.reset} ${C.text}thinking${C.reset}`
      : `${C.ok}●${C.reset} ${C.dim}idle${C.reset}`;
    const scroll = this.scrollOffset > 0 ? `${C.warn}↑ scrolled${C.reset}${sep}` : '';
    const hint = this.isRunning
      ? `${C.dim}ctrl+c stop${C.reset}`
      : `${C.accent}/${C.reset}${C.dim} commands${C.reset}${sep}${C.accent}tab${C.reset}${C.dim} mode${C.reset}`;
    return `\x1b[48;5;236m ${scroll}${state}${sep}${hint} ${C.reset}`;
  }

  _renderSidebarStatus(width) {
    const model = this._truncate(connectionManager.activeModel || this.model || 'not configured', Math.max(8, width - 8));
    return `\x1b[48;5;236m ${C.dim}model:${C.reset} ${C.text}${model}${C.reset}`;
  }

  _fmtTokens(n) {
    if (!n) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  _renderInputBorder(isTop, width = this.cols) {
    const glowIdx = Math.floor(this.animationFrame / 15) % GLOW_COLORS.length;
    const glowColor = GLOW_COLORS[glowIdx];
    const bc = this.isRunning ? C.warn : glowColor;
    const borderChar = this.isRunning ? '-' : '━';
    const line = ` ${borderChar.repeat(Math.max(0, width - 2))} `;
    return `${bc}${line}${C.reset}`;
  }

  _renderInput(width = this.cols) {
    const bc     = this.isRunning ? C.warn : C.accent;
    const prompt = this.isRunning ? `${C.warn}◌${C.reset}` : `${C.accent}❯${C.reset}`;
    const maxLen = width - 10;

    let content;
    if (this.isRunning) {
      content = `${C.dim}agent running… (ctrl+c to stop)${C.reset}`;
    } else if (this.apiKeyInputMode) {
      if (this.apiKeyConnecting) {
        content = `${C.dim}Connecting to ${C.bold}${this.apiKeyProvider}${C.dim}…${C.reset}`;
      } else if (this.apiKeyError) {
        content = `${C.err}${this.apiKeyError}${C.reset}`;
      } else if (this.apiKeyStep === 'baseUrl') {
        const hint = this.apiKeyBaseUrl.length === 0 ? `${C.dim}${this.apiKeyProviderMeta?.baseUrlHint || 'https://...'}${C.reset}` : '';
        content = `${C.dim}Base URL: ${C.reset}${C.text}${this.apiKeyBaseUrl}${C.reset}${hint}${C.dim}▋${C.reset}`;
      } else if (this.apiKeyStep === 'model') {
        const hint = this.apiKeyModelValue.length === 0 ? `${C.dim}${this.apiKeyProviderMeta?.modelHint || 'model-name'}${C.reset}` : '';
        content = `${C.dim}Model: ${C.reset}${C.text}${this.apiKeyModelValue}${C.reset}${hint}${C.dim}▋${C.reset}`;
      } else {
        const masked = this.apiKeyValue.length > 0 ? '•'.repeat(Math.min(this.apiKeyValue.length, 30)) : '';
        content = `${C.dim}API key for ${C.bold}${this.apiKeyProviderMeta?.name || this.apiKeyProvider}${C.dim}: ${C.reset}${C.text}${masked}▋${C.reset}`;
      }
    } else if (this.commandPaletteOpen) {
      content = this.commandFilter
        ? `${C.accent}/${C.reset}${C.text}${this.commandFilter}▋${C.reset}`
        : `${C.accent}/${C.reset}${C.dim}Search commands…${C.reset}${C.dim}▋${C.reset}`;
    } else if (this.subMenuOpen) {
      content = `${C.accent}/${C.reset}${C.dim}${this.subMenuTitle}${C.reset} ${C.text}▋${C.reset}`;
    } else if (this.input) {
      content = `${C.text}${this._truncate(this.input, maxLen - 1)}▋${C.reset}`;
    } else {
      const connected = Boolean(connectionManager.getActive());
      content = connected
        ? `${C.dim}Message ETTORE…  / commands  @ attach  ! shell${C.reset}`
        : `${C.dim}Type /connect to start, or /help for commands${C.reset}`;
    }

    const inner  = `${content}`;
    const clipped = this._truncateVisual(inner, Math.max(0, width - 6));
    return `\x1b[48;5;235m ${bc}${prompt}${C.reset}\x1b[48;5;235m ${clipped}${' '.repeat(Math.max(0, width - this._visualLen(` ${prompt} ${clipped}`) - 1))}${C.reset}`;
  }

  _renderSidebar(width) {
    const lines = [];
    const header = `${C.bold}${C.accent} ETTORE PANEL${C.reset}`;
    lines.push(header);
    lines.push(`${C.dim}${'-'.repeat(Math.max(4, width - 1))}${C.reset}`);

    const provider = connectionManager.activeProvider || this.provider || 'none';
    const model = connectionManager.activeModel || this.model || 'none';
    const cwdDisplay = process.cwd().split('/').slice(-2).join('/');
    lines.push(`${C.dim}LLM${C.reset} ${C.text}${this._truncate(provider, Math.max(8, width - 5))}${C.reset}`);
    lines.push(`${C.dim}Model${C.reset} ${C.text}${this._truncate(model, Math.max(8, width - 7))}${C.reset}`);
    lines.push(`${C.dim}CWD${C.reset} ${C.text}${this._truncate(cwdDisplay, Math.max(8, width - 5))}${C.reset}`);

    const state = this.isRunning ? `${C.warn}running${C.reset}` : `${C.ok}idle${C.reset}`;
    lines.push(`${C.dim}State${C.reset} ${state}`);
    lines.push(`${C.dim}Cap${C.reset} ${this.modelCapability === 'full' ? `${C.ok}FULL${C.reset}` : this.modelCapability === 'lite' ? `${C.warn}LITE${C.reset}` : `${C.dim}?${C.reset}`}`);
    lines.push(`${C.dim}Cost${C.reset} ${this._statusCostText()}`);
    lines.push(`${C.dim}Ctx${C.reset} ${this._statusCtxText()}`);
    lines.push(`${C.dim}Msgs${C.reset} ${C.text}${this.messages.filter(m => m.role !== 'todos').length}${C.reset}`);
    lines.push(`${C.bold}${C.dim}Recent tools${C.reset}`);

    const liveTools = this.streaming?.tools || [];
    const lastAssistant = [...this.messages].reverse().find(m => m.role === 'assistant' && m.tools?.length);
    const tools = liveTools.length ? liveTools : (lastAssistant?.tools || []);
    const recent = tools.slice(-5);
    if (recent.length === 0) {
      lines.push(`${C.dim}no tools yet${C.reset}`);
    } else {
      for (const t of recent) {
        const icon = t.status === 'done' ? `${C.ok}✔${C.reset}` : `${C.warn}●${C.reset}`;
        lines.push(`${icon} ${C.text}${this._truncate(t.name || 'tool', Math.max(8, width - 4))}${C.reset}`);
      }
    }

    const approvals = listInstallSessionApprovals();
    lines.push(`${C.bold}${C.dim}Approvals${C.reset}`);
    if (approvals.length === 0) {
      lines.push(`${C.dim}none${C.reset}`);
    } else {
      const projectCount = approvals.filter(item => item.kind === 'project').length;
      const systemCount = approvals.filter(item => item.kind === 'system').length;
      const downloadCount = approvals.filter(item => item.kind === 'download').length;
      lines.push(
        `${C.dim}total${C.reset} ${C.text}${approvals.length}${C.reset} ` +
        `${C.ok}project${C.reset}:${C.text}${projectCount}${C.reset} ` +
        `${C.err}system${C.reset}:${C.text}${systemCount}${C.reset} ` +
        `${C.warn}download${C.reset}:${C.text}${downloadCount}${C.reset}`
      );
      const maxApprovals = Math.min(3, approvals.length);
      for (const approval of approvals.slice(0, maxApprovals)) {
        const badge = approval.kind === 'system'
          ? `${C.err}[system]${C.reset}`
          : approval.kind === 'download'
            ? `${C.warn}[download]${C.reset}`
            : `${C.ok}[project]${C.reset}`;
        const label = approval.label ? this._truncate(approval.label, Math.max(8, width - 16)) : '';
        lines.push(`${badge} ${C.text}${label}${C.reset}`);
      }
      if (approvals.length > maxApprovals) {
        lines.push(`${C.dim}+${approvals.length - maxApprovals} more${C.reset}`);
      }
    }

    lines.push(`${C.bold}${C.dim}Quick keys${C.reset}`);
    lines.push(`${C.accent}/${C.reset} ${C.dim}commands${C.reset}`);
    lines.push(`${C.accent}@${C.reset} ${C.dim}attach file${C.reset}`);
    lines.push(`${C.accent}!${C.reset} ${C.dim}shell cmd${C.reset}`);
    lines.push(`${C.accent}tab${C.reset} ${C.dim}build/plan${C.reset}`);

    while (lines.length < this.availableHeight) lines.push('');
    return lines.slice(0, this.availableHeight).map(l => this._truncateVisual(l, width));
  }

  _statusCostText() {
    const activeModel = connectionManager.activeModel || '';
    const activeProvider = connectionManager.activeProvider || '';
    if (!activeProvider || !activeModel) return `${C.dim}n/a${C.reset}`;
    if (this.isFreeModel) return `${C.ok}$0.000${C.reset}`;
    if (this.costKnown) {
      const cost = this.sessionCost;
      const costFmt = cost < 0.001 ? '$0.000'
        : cost < 0.01 ? `$${cost.toFixed(4)}`
        : cost < 1 ? `$${cost.toFixed(3)}`
        : `$${cost.toFixed(2)}`;
      return `${C.ok}${costFmt}${C.reset}`;
    }
    if (this.inputTokensTotal > 0) {
      return `${C.text}${this._fmtTokens(this.inputTokensTotal)}/${this._fmtTokens(this.outputTokensTotal)}${C.reset}`;
    }
    return `${C.dim}$0.000${C.reset}`;
  }

  _statusCtxText() {
    if (this.tokenCount <= 0) return `${C.dim}n/a${C.reset}`;
    const pct = Math.min(100, Math.round((this.tokenCount / this.tokenMax) * 100));
    const tokFmt = this._fmtTokens(this.tokenCount);
    const maxFmt = this._fmtTokens(this.tokenMax);
    const barLen = 6;
    const filled = Math.round((pct / 100) * barLen);
    const empty = barLen - filled;
    const pctColor = pct >= 80 ? C.err : pct >= 50 ? C.warn : C.ok;
    return `${pctColor}${'█'.repeat(filled)}${C.dim}${'░'.repeat(empty)}${C.reset} ${C.text}${tokFmt}/${maxFmt}${C.reset}`;
  }

  _sanitizeForRender(text) {
    if (!text) return '';
    // Tabs first (renderer treats them as 2 spaces visually), then full strip,
    // then collapse runs of spaces that the orphan removal may have created.
    return stripAllAnsi(String(text).replace(/\t/g, '  '))
      .replace(/\r/g, '')
      .replace(/\s{2,}/g, ' ');
  }

  _normalizeAssistantLine(text) {
    let s = this._sanitizeForRender(text || '');
    if (/^`+$/.test(s.trim())) return '';

    // Strip outer "fake box" borders often emitted by models:
    // e.g. "┃ content ┃", "| content |", "│ content │"
    s = s
      .replace(/^\s*[┃│|]\s?/, '')
      .replace(/\s?[┃│|]\s*$/, '');

    // Remove full border/separator rows from model-generated ASCII/Unicode boxes
    if (/^[\s┌┐└┘├┤┬┴┼│┃─━═|+\-]+$/.test(s.trim())) return '';

    s = this._normalizeUnicodeTableLine(s);
    // Collapse repeated spaces introduced by border stripping
    s = s.replace(/\s{2,}/g, ' ').trimEnd();
    return s;
  }

  _normalizeUnicodeTableLine(line) {
    const s = String(line || '');
    // Convert pseudo-table rows made of box-drawing chars into plain readable text.
    if (!/[┌┐└┘├┤┬┴┼│─]/.test(s)) return s;
    // Separator-only rows become blank
    if (/^[\s┌┐└┘├┤┬┴┼│─]+$/.test(s.trim())) return '';
    // Keep cell contents, collapse borders to " | "
    const parts = s
      .split('│')
      .map(p => p.replace(/[┌┐└┘├┤┬┴┼─]/g, '').trim())
      .filter(Boolean);
    if (parts.length === 0) return s.replace(/[┌┐└┘├┤┬┴┼│─]/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return parts.join(' | ');
  }

  _tableLikeToBullet(line, maxWidth) {
    const s = String(line || '');
    if (!s.includes('|')) return s;
    if (this._visualLen(s) <= maxWidth) return s;

    const cells = s.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 2) return s;

    const left = cells[0].replace(/^[-*•]\s*/, '');
    const right = cells.slice(1).join(' — ');
    return `- ${left}: ${right}`;
  }

  _formatLoosePipeLine(line) {
    const s = String(line || '').trim();
    if (!s.includes('|')) return null;
    if (/^\|.*\|$/.test(s)) return null;

    const cells = s.split('|').map(c => this._sanitizeForRender(c).trim()).filter(Boolean);
    if (cells.length < 2) return null;

    const normalized = cells.map(c => c.toLowerCase());
    const isHeader = normalized.includes('endpoint') ||
      (normalized.includes('metodo') && normalized.includes('descrizione')) ||
      (normalized.includes('method') && normalized.includes('description'));
    if (isHeader) return '';

    const methodIdx = cells.findIndex(c => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(c));
    if (methodIdx >= 0) {
      const method = cells[methodIdx].toUpperCase();
      const endpoint = cells.slice(0, methodIdx).join(' ').trim() || cells[methodIdx + 1] || '';
      const desc = cells.slice(methodIdx + 1).join(' - ').trim();
      return `- ${method} ${endpoint}${desc ? `: ${desc}` : ''}`;
    }

    const [first, ...rest] = cells;
    return `- ${first}: ${rest.join(' - ')}`;
  }

  _wrapText(text, maxWidth) {
    if (!text) return [''];
    if (maxWidth <= 0) return [text];
    const words = text.split(' ');
    const lines = [];
    let current = '';
    let currentVLen = 0;
    for (let word of words) {
      let wordVLen = this._visualLen(word);
      // If a single word is too long, flush current and push the word as-is
      while (wordVLen > maxWidth) {
        if (current) { lines.push(current); current = ''; currentVLen = 0; }
        lines.push(this._truncateVisual(word, maxWidth));
        word = '';
        wordVLen = 0;
        break;
      }
      if (!word && wordVLen === 0) continue;
      const addLen = current ? currentVLen + 1 + wordVLen : wordVLen;
      if (addLen <= maxWidth) {
        current = current ? current + ' ' + word : word;
        currentVLen = addLen;
      } else {
        if (current) lines.push(current);
        current = word;
        currentVLen = wordVLen;
      }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }

  _visualLen(s) {
    const plain = this._stripAnsi(s || '');
    let width = 0;
    for (let i = 0; i < plain.length; i++) {
      const cp = plain.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      if (cp > 0xFFFF) i++;
      width += this._charWidth(cp, ch);
    }
    return width;
  }

  _messageTime(msg) {
    const ts = Number(msg?.id);
    if (!Number.isFinite(ts)) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  _truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }

  _truncateVisual(str, max) {
    if (!str) return '';
    let out = '';
    let visible = 0;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '\x1b') {
        const match = str.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
        if (match) {
          out += match[0];
          i += match[0].length - 1;
          continue;
        }
      }
      const cp = str.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      const w = this._charWidth(cp, ch);
      if (visible + w > max - 1) return out + '…' + C.reset;
      out += ch;
      visible += w;
      if (cp > 0xFFFF) i++;
    }
    return out;
  }

  _stripAnsi(s) {
    return this._sanitizeForRender(s);
  }

  _charWidth(cp, ch) {
    // zero-width: combining marks, variation selectors, zero-width joiner
    if (cp === 0x200D || (cp >= 0xFE00 && cp <= 0xFE0F) || /\p{Mark}/u.test(ch)) return 0;
    // wide chars: CJK + emoji blocks (approximation suitable for terminal layout)
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0x2E80 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE10 && cp <= 0xFE6F) ||
      (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x1F300 && cp <= 0x1FAFF)
    ) return 2;
    return 1;
  }

  _highlightCode(text) {
    if (!text) return '';
    // Protect ANSI codes between passes so patterns like _HL_NUMBERS (`\b\d+\b`)
    // never match digits inside an `\x1b[…m` body (e.g. the `38` in `\x1b[38;5;150m`).
    // Without this, the SGR body gets shredded and literal `[38;5;NNNm` leaks
    // to the terminal as visible text.
    //
    // Each protected ANSI is replaced by a single Private Use Area code point.
    // PUA is non-word, non-digit, non-quote, non-`/` → can't be matched by any
    // _HL_* regex. Index = codePoint - 0xE000.
    const placeholders = [];
    const ANSI_RE = /\x1b\[[0-9;:?]*[ -/]*[A-Za-z@]/g;
    const PUA_BASE = 0xE000;
    const protect = (s) => s.replace(ANSI_RE, (m) => {
      const idx = placeholders.length;
      placeholders.push(m);
      return String.fromCodePoint(PUA_BASE + idx);
    });

    let result = protect(text);
    _HL_KEYWORDS.forEach(({ kw, re }) => {
      re.lastIndex = 0;
      result = result.replace(re, `${C.keyword}${kw}${C.reset}`);
    });
    result = protect(result);
    result = result.replace(_HL_STRINGS, `${C.string}$&${C.reset}`);
    result = protect(result);
    result = result.replace(_HL_NUMBERS, `${C.number}$1${C.reset}`);
    result = protect(result);
    _HL_COMMENTS.lastIndex = 0;
    result = result.replace(_HL_COMMENTS, `${C.comment}$1${C.reset}`);
    result = result.replace(_HL_COMMENTS_BLOCK, `${C.comment}$1${C.reset}`);
    result = result.replace(/[-]/g, (c) => placeholders[c.codePointAt(0) - PUA_BASE] || '');
    return result;
  }

  _renderMarkdown(text) {
    if (!text) return '';
    // Strip leading -/+ bullets for list items but preserve the bullet char
    let result = text;
    // Inline code: `code` -> code (colored, backticks removed)
    result = result.replace(/`([^`\n]+)`/g, `${C.code}$1${C.reset}`);
    // Bold: **text** -> bold colored
    result = result.replace(/\*\*([^*\n]+)\*\*/g, `${C.bold}$1${C.reset}`);
    // Italic: *text* -> dim colored
    result = result.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, `${C.dim}$1${C.reset}`);
    return result;
  }

  _formatTableRow(cells, widths, isHeader) {
    const open = isHeader ? '┌' : '│';
    const close = isHeader ? '┐' : '│';
    const mid = isHeader ? '│' : '│';
    const parts = [];
    for (let i = 0; i < widths.length; i++) {
      const cell = (cells[i] || '').trim();
      const w = widths[i];
      const content = cell.padEnd(w).slice(0, w);
      parts.push(` ${content} `);
    }
    return `${open}${parts.join(mid)}${close}`;
  }

  _renderMarkdownTable(rawLines) {
    if (!rawLines || rawLines.length === 0) return [];
    const rows = rawLines.map(line =>
      line.split('|').slice(1, -1).map(c => this._sanitizeForRender(c).trim())
    );
    if (rows.length < 2) return rawLines.map(l => this._sanitizeForRender(l));

    const header = rows[0];
    const body = rows.slice(1).filter(cells =>
      !cells.every(cell => /^:?-{2,}:?$/.test(cell) || cell === '')
    );
    if (body.length === 0) return header.filter(Boolean);

    return body.map(cells => {
      const parts = [];
      for (let i = 0; i < header.length; i++) {
        const key = (header[i] || '').replace(/[#*`]/g, '').trim();
        const value = (cells[i] || '').trim();
        if (!key && !value) continue;
        if (!key) parts.push(value);
        else if (!value || value === '-' || value === '---') parts.push(key);
        else parts.push(`${key}: ${value}`);
      }
      return `- ${parts.join(' | ')}`.trim();
    });
  }

  setInput(val)  { this.input = val;                  this.needsRender = true; }
  addChar(ch)    { this.input += ch;                  this.needsRender = true; }
  removeChar()   { this.input = this.input.slice(0,-1); this.needsRender = true; }
  clearInput()   { this.input = '';                   this.needsRender = true; }

  // ─── Command palette ──────────────────────────────────────────────────────
  openCommandPalette(commands) {
    this.commandPaletteOpen  = true;
    this.commandFilter       = '';
    this.commandIndex        = 0;
    this.commandScrollOffset = 0;
    this.commandList         = commands;
    this.commandFiltered     = commands;
    this.needsRender         = true;
  }

  closeCommandPalette() {
    this.commandPaletteOpen  = false;
    this.commandFilter       = '';
    this.commandIndex        = 0;
    this.commandScrollOffset = 0;
    this.needsRender         = true;
  }

  filterCommands(filter) {
    this.commandFilter       = filter;
    this.commandIndex        = 0;
    this.commandScrollOffset = 0;
    const f                  = filter.toLowerCase();
    this.commandFiltered     = this.commandList.filter(cmd => {
      const name    = cmd.name.toLowerCase();
      const aliases = (cmd.aliases || []).join(' ').toLowerCase();
      const desc    = (cmd.description || '').toLowerCase();
      return name.includes(f) || aliases.includes(f) || desc.includes(f);
    });
    this.needsRender = true;
  }

  selectCommandUp() {
    if (this.commandIndex > 0) {
      this.commandIndex--;
      if (this.commandIndex < this.commandScrollOffset) {
        this.commandScrollOffset = this.commandIndex;
      }
    }
    this.needsRender = true;
  }

  selectCommandDown() {
    if (this.commandIndex < this.commandFiltered.length - 1) {
      this.commandIndex++;
      const maxVisible = Math.min(this.commandFiltered.length, this.availableHeight - 3);
      if (this.commandIndex >= this.commandScrollOffset + maxVisible) {
        this.commandScrollOffset = this.commandIndex - maxVisible + 1;
      }
    }
    this.needsRender = true;
  }

  getSelectedCommand() {
    return this.commandFiltered[this.commandIndex] || null;
  }

  // ─── Sub-menu ─────────────────────────────────────────────────────────────
  openSubMenu(title, items) {
    this.subMenuOpen         = true;
    this.subMenuTitle        = title;
    this.subMenuItems        = items;
    this.subMenuFiltered     = [...items];
    this.subMenuFilter       = '';
    this.subMenuIndex        = 0;
    this.subMenuScrollOffset = 0;
    this.needsRender         = true;
  }

  closeSubMenu() {
    this.subMenuOpen         = false;
    this.subMenuTitle        = '';
    this.subMenuItems        = [];
    this.subMenuFiltered     = [];
    this.subMenuFilter       = '';
    this.subMenuIndex        = 0;
    this.subMenuScrollOffset = 0;
    this.needsRender         = true;
  }

  filterSubMenu(text) {
    this.subMenuFilter = text;
    const f = text.toLowerCase();
    this.subMenuFiltered = f
      ? this.subMenuItems.filter(item => {
          const label = (item.label || item.value || '').toLowerCase();
          const desc  = (item.description || '').toLowerCase();
          return label.includes(f) || desc.includes(f);
        })
      : [...this.subMenuItems];
    this.subMenuIndex        = 0;
    this.subMenuScrollOffset = 0;
    this.needsRender         = true;
  }

  selectSubMenuUp() {
    if (this.subMenuIndex > 0) {
      this.subMenuIndex--;
      if (this.subMenuIndex < this.subMenuScrollOffset) {
        this.subMenuScrollOffset = this.subMenuIndex;
      }
    }
    this.needsRender = true;
  }

  selectSubMenuDown() {
    if (this.subMenuIndex < this.subMenuFiltered.length - 1) {
      this.subMenuIndex++;
      const maxVisible = Math.min(this.subMenuFiltered.length, this.availableHeight - 4);
      if (this.subMenuIndex >= this.subMenuScrollOffset + maxVisible) {
        this.subMenuScrollOffset = this.subMenuIndex - maxVisible + 1;
      }
    }
    this.needsRender = true;
  }

  getSelectedSubItem() {
    return this.subMenuFiltered[this.subMenuIndex] || null;
  }

  // ─── API Key Input Mode ──────────────────────────────────────────────────
  openApiKeyInput(providerName, providerMeta) {
    this.apiKeyInputMode    = true;
    this.apiKeyProvider     = providerName;
    this.apiKeyProviderMeta = providerMeta;
    this.apiKeyValue        = '';
    this.apiKeyBaseUrl      = '';
    this.apiKeyModelValue   = '';
    this.apiKeyTokenPlanKey = '';
    this.apiKeyStep         = providerMeta?.requiresBaseUrl ? 'baseUrl' : 'key';
    this.apiKeyError        = '';
    this.apiKeyConnecting   = false;
    this.needsRender        = true;
  }

  closeApiKeyInput() {
    this.apiKeyInputMode    = false;
    this.apiKeyProvider     = '';
    this.apiKeyProviderMeta = null;
    this.apiKeyValue        = '';
    this.apiKeyBaseUrl      = '';
    this.apiKeyModelValue   = '';
    this.apiKeyTokenPlanKey = '';
    this.apiKeyStep         = 'key';
    this.apiKeyError        = '';
    this.apiKeyConnecting   = false;
    this.needsRender        = true;
  }

  addApiKeyChar(ch) {
    if (this.apiKeyStep === 'baseUrl')  this.apiKeyBaseUrl    += ch;
    else if (this.apiKeyStep === 'model') this.apiKeyModelValue += ch;
    else                                  this.apiKeyValue      += ch;
    this.apiKeyError = '';
    this.needsRender = true;
  }

  removeApiKeyChar() {
    if (this.apiKeyStep === 'baseUrl')  this.apiKeyBaseUrl    = this.apiKeyBaseUrl.slice(0, -1);
    else if (this.apiKeyStep === 'model') this.apiKeyModelValue = this.apiKeyModelValue.slice(0, -1);
    else                                  this.apiKeyValue      = this.apiKeyValue.slice(0, -1);
    this.apiKeyError = '';
    this.needsRender = true;
  }

  nextApiKeyStep() {
    if (this.apiKeyStep === 'baseUrl')  this.apiKeyStep = 'key';
    else if (this.apiKeyStep === 'key') this.apiKeyStep = 'model';
    this.apiKeyError = '';
    this.needsRender = true;
  }

  // ─── Command palette rendering (OpenCode-style full-width) ────────────────
  _renderCommandPalette() {
    if (!this.commandPaletteOpen || this.subMenuOpen || this.apiKeyInputMode) return '';

    const maxVisible = Math.max(1, Math.min(this.commandFiltered.length || 1, this.availableHeight - 3));
    const width      = Math.max(52, Math.min(this.cols - 8, 96));
    const left       = Math.max(1, Math.floor((this.cols - width) / 2));
    const top        = Math.max(2, Math.floor((this.rows - (maxVisible + 2)) / 2));
    const height     = maxVisible + 2;

    let out = '';

    // Shadow (offset)
    for (let i = 0; i < height; i++) {
      out += ANSI.move(left + 1, top + i + 1);
      out += `\x1b[48;5;234m${' '.repeat(width)}\x1b[0m`;
    }

    // Border
    out += ANSI.move(left, top - 1) + `\x1b[48;5;240m+${'-'.repeat(Math.max(0, width - 2))}+\x1b[0m`;
    for (let i = 0; i < height; i++) {
      out += ANSI.move(left, top + i) + `\x1b[48;5;240m|\x1b[0m`;
      out += ANSI.move(left + width - 1, top + i) + `\x1b[48;5;240m|\x1b[0m`;
    }
    out += ANSI.move(left, top + height) + `\x1b[48;5;240m+${'-'.repeat(Math.max(0, width - 2))}+\x1b[0m`;

    // Background rows: title + items + hint
    for (let i = 0; i < maxVisible + 2; i++) {
      out += ANSI.move(left, top + i);
      out += `\x1b[48;5;238m${' '.repeat(width)}\x1b[0m`;
    }

    out += ANSI.move(left, top);
    out += `\x1b[48;5;24m`;
    const title = this.commandFilter
      ? `  ${C.bold}${C.accent}/ commands${C.reset}  ${C.dim}filter:${C.reset} ${C.text}${this.commandFilter}${C.reset}`
      : `  ${C.bold}${C.accent}/ commands${C.reset}  ${C.dim}type to filter, enter to run${C.reset}`;
    out += title;
    out += ' '.repeat(Math.max(0, width - this._visualLen(title)));
    out += C.reset;

    if (this.commandFiltered.length === 0) {
      out += ANSI.move(left, top + 1);
      out += `\x1b[48;5;238m`;
      const empty = `  ${C.warn}No commands match "${this.commandFilter}"${C.reset}  ${C.dim}backspace to edit, esc to close${C.reset}`;
      out += empty;
      out += ' '.repeat(Math.max(0, width - this._visualLen(empty)));
      out += C.reset;
    }

    // Items
    for (let i = 0; i < maxVisible; i++) {
      const cmd = this.commandFiltered[i + this.commandScrollOffset];
      if (!cmd) break;
      const isSelected = (i + this.commandScrollOffset) === this.commandIndex;

      out += ANSI.move(left, top + 1 + i);

      const usage = `/${cmd.usage || cmd.name}`;
      const usageWidth = Math.min(30, Math.max(16, Math.floor(width * 0.28)));
      const usagePlain = this._truncate(usage, usageWidth);
      const aliasText = cmd.aliases && cmd.aliases.length ? ` aliases: ${cmd.aliases.join(', ')}` : '';
      const descPlain = this._truncate(`${cmd.description || ''}${aliasText}`, Math.max(12, width - usageWidth - 8));
      if (isSelected) {
        out += `\x1b[48;5;31m`;
        const line = `  ${C.bold}${C.text}${usagePlain.padEnd(usageWidth)}${C.reset} ${C.dim}${descPlain}${C.reset}`;
        out += line;
        out += ' '.repeat(Math.max(0, width - this._visualLen(line)));
        out += C.reset;
      } else {
        const line = `  ${C.accent}${usagePlain.padEnd(usageWidth)}${C.reset} ${C.dim}${descPlain}${C.reset}`;
        out += line;
        out += ' '.repeat(Math.max(0, width - this._visualLen(line)));
      }
    }

    // Hint bar
    out += ANSI.move(left, top + 1 + maxVisible);
    out += `\x1b[48;5;24m`;
    const total     = this.commandFiltered.length;
    const canScroll = total > maxVisible;
    const arrowUp   = canScroll && this.commandIndex > 0
                      ? `${C.accent}▲${C.reset}` : `${C.dim}▲${C.reset}`;
    const arrowDown = canScroll && this.commandIndex < total - 1
                      ? `${C.accent}▼${C.reset}` : `${C.dim}▼${C.reset}`;
    const posInfo   = canScroll ? `  ${C.dim}${this.commandIndex + 1}/${total}${C.reset}` : '';
    const hint = total === 0
      ? `  ${C.dim}backspace edit${C.reset}  ${C.dim}esc close${C.reset}`
      : canScroll
        ? `  ${arrowUp} ${arrowDown}  ${C.dim}↑↓ navigate${C.reset}  ${C.dim}↵ run/open${C.reset}  ${C.dim}esc close${C.reset}${posInfo}`
        : `  ${C.dim}↑↓ navigate${C.reset}  ${C.dim}↵ run/open${C.reset}  ${C.dim}esc close${C.reset}`;
    out += hint;
    out += ' '.repeat(Math.max(0, width - this._visualLen(hint)));
    out += C.reset;

    return out;
  }

  // ─── Sub-menu rendering ───────────────────────────────────────────────────
  _renderSubMenu() {
    if (!this.subMenuOpen || this.subMenuItems.length === 0 || this.apiKeyInputMode) return '';

    const items      = this.subMenuFiltered;
    const maxVisible = Math.min(items.length, this.availableHeight - 4);
    const width      = Math.max(52, Math.min(this.cols - 8, 96));
    const left       = Math.max(1, Math.floor((this.cols - width) / 2));
    const top        = Math.max(2, Math.floor((this.rows - (maxVisible + 3)) / 2));
    const height     = maxVisible + 3;

    let out = '';

    // Shadow (offset)
    for (let i = 0; i < height; i++) {
      out += ANSI.move(left + 1, top + i + 1);
      out += `\x1b[48;5;234m${' '.repeat(width)}\x1b[0m`;
    }

    // Border
    out += ANSI.move(left, top - 1) + `\x1b[48;5;240m+${'-'.repeat(Math.max(0, width - 2))}+\x1b[0m`;
    for (let i = 0; i < height; i++) {
      out += ANSI.move(left, top + i) + `\x1b[48;5;240m|\x1b[0m`;
      out += ANSI.move(left + width - 1, top + i) + `\x1b[48;5;240m|\x1b[0m`;
    }
    out += ANSI.move(left, top + height) + `\x1b[48;5;240m+${'-'.repeat(Math.max(0, width - 2))}+\x1b[0m`;

    // Background (title + search + items + hint)
    for (let i = 0; i < maxVisible + 3; i++) {
      out += ANSI.move(left, top + i);
      out += `\x1b[48;5;238m${' '.repeat(width)}\x1b[0m`;
    }

    // Title
    out += ANSI.move(left, top);
    out += `\x1b[48;5;24m`;
    const titleLine = `  ${C.bold}${C.accent}/${this.subMenuTitle}${C.reset}`;
    out += titleLine;
    out += ' '.repeat(Math.max(0, width - this._visualLen(titleLine)));
    out += C.reset;

    // Search bar
    out += ANSI.move(left, top + 1);
    out += `\x1b[48;5;238m`;
    const searchLine = this.subMenuFilter
      ? `  ${C.accent}🔍${C.reset}  ${C.bold}${C.text}${this.subMenuFilter}${C.reset}${C.accent}▋${C.reset}`
      : `  ${C.accent}🔍${C.reset}  ${C.dim}cerca…${C.reset}${C.dim}▋${C.reset}`;
    out += searchLine;
    out += ' '.repeat(Math.max(0, width - this._visualLen(searchLine)));
    out += C.reset;

    // Items
    if (items.length === 0) {
      out += ANSI.move(1, top + 2);
      out += ANSI.move(left, top + 2);
      out += `\x1b[48;5;238m`;
      const noResult = `  ${C.dim}nessun risultato per "${this.subMenuFilter}"${C.reset}`;
      out += noResult;
      out += ' '.repeat(Math.max(0, width - this._visualLen(noResult)));
      out += C.reset;
    } else {
      for (let i = 0; i < maxVisible; i++) {
        const item = items[i + this.subMenuScrollOffset];
        if (!item) break;
        const isSelected = (i + this.subMenuScrollOffset) === this.subMenuIndex;

        out += ANSI.move(left, top + 2 + i);

        if (isSelected) {
          out += `\x1b[48;5;31m`;
          const label = item.label || item.value || '';
          const desc  = item.description || '';
          const line  = `  ${C.bold}${C.text}${label}${C.reset}${desc ? `${C.dim} · ${desc}${C.reset}` : ''}`;
          out += line;
          out += ' '.repeat(Math.max(0, width - this._visualLen(line)));
          out += C.reset;
        } else {
          const label = item.label || item.value || '';
          const desc  = item.description || '';
          const line  = `  ${C.accent}${label}${C.reset}${desc ? `${C.dim} · ${desc}${C.reset}` : ''}`;
          out += line;
          out += ' '.repeat(Math.max(0, width - this._visualLen(line)));
        }
      }
    }

    // Hint bar
    out += ANSI.move(left, top + 2 + maxVisible);
    out += `\x1b[48;5;24m`;
    const total     = items.length;
    const fullTotal = this.subMenuItems.length;
    const canScroll = total > maxVisible;
    const arrowUp   = canScroll && this.subMenuIndex > 0
                      ? `${C.accent}▲${C.reset}` : `${C.dim}▲${C.reset}`;
    const arrowDown = canScroll && this.subMenuIndex < total - 1
                      ? `${C.accent}▼${C.reset}` : `${C.dim}▼${C.reset}`;
    const hint = this.subMenuFilter
      ? `  ${C.accent}🔍${C.reset} ${C.bold}${C.text}"${this.subMenuFilter}"${C.reset}  ${C.accent}${total}/${fullTotal}${C.reset}  ${C.dim}⌫ cancella${C.reset}  ${canScroll ? `${arrowUp} ${arrowDown}  ${C.dim}${this.subMenuIndex + 1}/${total}${C.reset}  ` : ''}${C.dim}↵ select${C.reset}  ${C.dim}esc chiudi${C.reset}`
      : canScroll
        ? `  ${arrowUp} ${arrowDown}  ${C.dim}↑↓ naviga${C.reset}  ${C.dim}↵ select${C.reset}  ${C.dim}← back${C.reset}  ${C.dim}digita per cercare${C.reset}  ${C.dim}${this.subMenuIndex + 1}/${total}${C.reset}`
        : `  ${C.dim}↑↓ naviga${C.reset}  ${C.dim}↵ select${C.reset}  ${C.dim}← back${C.reset}  ${C.dim}digita per cercare${C.reset}`;
    out += hint;
    out += ' '.repeat(Math.max(0, width - this._visualLen(hint)));
    out += C.reset;

    return out;
  }

  // ─── API Key Input Overlay ────────────────────────────────────────────────
  _renderApiKeyInput() {
    if (!this.apiKeyInputMode) return '';

    const meta = this.apiKeyProviderMeta || {};
    if (meta.requiresBaseUrl) return this._renderApiKeyInputMultiStep();

    const width = this.cols;
    const top   = 2;
    let out     = '';

    // Background (6 rows)
    for (let i = 0; i < 6; i++) {
      out += ANSI.move(1, top + i);
      out += `\x1b[48;5;235m${' '.repeat(width)}\x1b[0m`;
    }

    const icon = meta.icon || '🔌';
    const name = meta.name || this.apiKeyProvider;

    // Title row
    out += ANSI.move(1, top);
    out += `\x1b[48;5;236m`;
    const titleText = `  ${icon} ${C.bold}${C.accent}Connect to ${name}${C.reset}`;
    out += titleText;
    out += ' '.repeat(Math.max(0, width - this._visualLen(titleText)));
    out += C.reset;

    // Description row
    out += ANSI.move(1, top + 1);
    out += `\x1b[48;5;235m`;
    const descText = `  ${C.dim}${meta.description || ''}${C.reset}`;
    out += descText;
    out += ' '.repeat(Math.max(0, width - this._visualLen(descText)));

    // Input row
    out += ANSI.move(1, top + 2);
    out += `\x1b[48;5;235m`;
    if (this.apiKeyConnecting) {
      const connectingText = `  ${C.warn}${C.bold}⏳${C.reset} ${C.dim}Validating key and fetching models…${C.reset}`;
      out += connectingText;
      out += ' '.repeat(Math.max(0, width - this._visualLen(connectingText)));
    } else if (this.apiKeyError) {
      const errorText = `  ${C.err}✗ ${this.apiKeyError}${C.reset}`;
      out += errorText;
      out += ' '.repeat(Math.max(0, width - this._visualLen(errorText)));
    } else {
      const masked = this.apiKeyValue.length > 0 ? '•'.repeat(this.apiKeyValue.length) : '';
      const keyHint = meta.keyHint || '';
      const placeholder = this.apiKeyValue.length === 0 && keyHint ? `${C.dim}${keyHint}${C.reset}` : '';
      const inputText = `  ${C.accent}🔑${C.reset} ${C.text}${masked}${C.reset}${placeholder}${C.dim}▋${C.reset}`;
      out += inputText;
      out += ' '.repeat(Math.max(0, width - this._visualLen(inputText)));
    }

    // Spacer rows
    out += ANSI.move(1, top + 3);
    out += `\x1b[48;5;235m${' '.repeat(width)}`;
    out += ANSI.move(1, top + 4);
    out += `\x1b[48;5;235m${' '.repeat(width)}`;

    // Hint bar
    out += ANSI.move(1, top + 5);
    out += `\x1b[48;5;236m`;
    const hint = `  ${C.dim}↵ connect${C.reset}  ${C.dim}esc cancel${C.reset}  ${C.dim}← back to providers${C.reset}`;
    out += hint;
    out += ' '.repeat(Math.max(0, width - this._visualLen(hint)));
    out += C.reset;

    return out;
  }

  // Multi-step form for providers that require base URL + key + model
  _renderApiKeyInputMultiStep() {
    const width = this.cols;
    const top   = 2;
    const rows  = 9; // title + desc + url + key + model + error + spacer + spacer + hint
    let out     = '';

    const meta  = this.apiKeyProviderMeta || {};
    const icon  = meta.icon || '🔧';
    const name  = meta.name || this.apiKeyProvider;
    const step  = this.apiKeyStep; // 'baseUrl' | 'key' | 'model'

    // Background
    for (let i = 0; i < rows; i++) {
      out += ANSI.move(1, top + i);
      out += `\x1b[48;5;235m${' '.repeat(width)}\x1b[0m`;
    }

    // Title row
    const stepNum = step === 'baseUrl' ? 1 : step === 'key' ? 2 : 3;
    out += ANSI.move(1, top);
    out += `\x1b[48;5;236m`;
    const titleText = `  ${icon} ${C.bold}${C.accent}Connect to ${name}${C.reset}  ${C.dim}step ${stepNum}/3${C.reset}`;
    out += titleText;
    out += ' '.repeat(Math.max(0, width - this._visualLen(titleText)));
    out += C.reset;

    // Description row
    out += ANSI.move(1, top + 1);
    out += `\x1b[48;5;235m`;
    const descText = `  ${C.dim}${meta.description || ''}${C.reset}`;
    out += descText;
    out += ' '.repeat(Math.max(0, width - this._visualLen(descText)));

    // ── Base URL field (row 2) ─────────────────────────────────────────────
    out += ANSI.move(1, top + 2);
    out += `\x1b[48;5;235m`;
    if (step === 'baseUrl') {
      // Active
      const hint = this.apiKeyBaseUrl.length === 0 ? `${C.dim}${meta.baseUrlHint || 'https://...'}${C.reset}` : '';
      const urlText = `  ${C.accent}🌐${C.reset} ${C.text}${this.apiKeyBaseUrl}${C.reset}${hint}${C.dim}▋${C.reset}`;
      out += urlText;
      out += ' '.repeat(Math.max(0, width - this._visualLen(urlText)));
    } else {
      // Completed
      const urlText = `  ${C.dim}🌐${C.reset} ${C.dim}${this.apiKeyBaseUrl}${C.reset}  ${C.ok}✓${C.reset}`;
      out += urlText;
      out += ' '.repeat(Math.max(0, width - this._visualLen(urlText)));
    }

    // ── API Key field (row 3) ──────────────────────────────────────────────
    out += ANSI.move(1, top + 3);
    out += `\x1b[48;5;235m`;
    if (step === 'baseUrl') {
      // Not reached yet
      const keyText = `  ${C.dim}🔑 API key${C.reset}`;
      out += keyText;
      out += ' '.repeat(Math.max(0, width - this._visualLen(keyText)));
    } else if (step === 'key') {
      // Active
      const masked = this.apiKeyValue.length > 0 ? '•'.repeat(this.apiKeyValue.length) : '';
      const hint   = this.apiKeyValue.length === 0 ? `${C.dim}${meta.keyHint || 'your api key'}${C.reset}` : '';
      const keyText = `  ${C.accent}🔑${C.reset} ${C.text}${masked}${C.reset}${hint}${C.dim}▋${C.reset}`;
      out += keyText;
      out += ' '.repeat(Math.max(0, width - this._visualLen(keyText)));
    } else {
      // Completed
      const masked  = '•'.repeat(Math.min(this.apiKeyValue.length, 12));
      const keyText = `  ${C.dim}🔑${C.reset} ${C.dim}${masked}${C.reset}  ${C.ok}✓${C.reset}`;
      out += keyText;
      out += ' '.repeat(Math.max(0, width - this._visualLen(keyText)));
    }

    // ── Model field (row 4) ────────────────────────────────────────────────
    out += ANSI.move(1, top + 4);
    out += `\x1b[48;5;235m`;
    if (step === 'model') {
      // Active
      const hint    = this.apiKeyModelValue.length === 0 ? `${C.dim}${meta.modelHint || 'model-name'}${C.reset}` : '';
      const mdlText = `  ${C.accent}🤖${C.reset} ${C.text}${this.apiKeyModelValue}${C.reset}${hint}${C.dim}▋${C.reset}`;
      out += mdlText;
      out += ' '.repeat(Math.max(0, width - this._visualLen(mdlText)));
    } else {
      // Not reached yet
      const mdlText = `  ${C.dim}🤖 model name${C.reset}`;
      out += mdlText;
      out += ' '.repeat(Math.max(0, width - this._visualLen(mdlText)));
    }

    // ── Error / connecting row (row 5) ─────────────────────────────────────
    out += ANSI.move(1, top + 5);
    out += `\x1b[48;5;235m`;
    if (this.apiKeyConnecting) {
      const ct = `  ${C.warn}${C.bold}⏳${C.reset} ${C.dim}Connecting…${C.reset}`;
      out += ct;
      out += ' '.repeat(Math.max(0, width - this._visualLen(ct)));
    } else if (this.apiKeyError) {
      const et = `  ${C.err}✗ ${this.apiKeyError}${C.reset}`;
      out += et;
      out += ' '.repeat(Math.max(0, width - this._visualLen(et)));
    } else {
      out += ' '.repeat(width);
    }

    // Spacer rows
    out += ANSI.move(1, top + 6);
    out += `\x1b[48;5;235m${' '.repeat(width)}`;
    out += ANSI.move(1, top + 7);
    out += `\x1b[48;5;235m${' '.repeat(width)}`;

    // Hint bar (row 8)
    out += ANSI.move(1, top + 8);
    out += `\x1b[48;5;236m`;
    const nextLabel = step === 'model' ? '↵ connect' : '↵ next';
    const hint = `  ${C.dim}${nextLabel}${C.reset}  ${C.dim}esc cancel${C.reset}  ${C.dim}← back to providers${C.reset}`;
    out += hint;
    out += ' '.repeat(Math.max(0, width - this._visualLen(hint)));
    out += C.reset;

    return out;
  }

  // ─── Ask User rendering ───────────────────────────────────────────────────
  _renderAskUser() {
    if (!this.askUser) return '';
    const { question, options } = this.askUser;
    const hasOptions = Array.isArray(options) && options.length > 0;
    const modalRows = hasOptions ? (options.length + 4) : 7;
    const BG_MODAL = '\x1b[48;5;238m';
    const BG_HEADER = '\x1b[48;5;236m';
    const BG_SELECTED = '\x1b[48;5;24m';
    const width = Math.min(Math.max(56, Math.floor(this.cols * 0.72)), Math.max(40, this.cols - 8));
    const left = Math.max(1, Math.floor((this.cols - width) / 2) + 1);
    const top = Math.max(2, Math.floor((this.rows - modalRows) / 2));
    const keepBg = (str, bg) => String(str || '').replace(/\x1b\[0m/g, `\x1b[0m${bg}`);
    
    let out = '';
    
    // Modal background
    for (let i = 0; i < modalRows; i++) {
      out += ANSI.move(left, top + i);
      out += `${BG_MODAL}${' '.repeat(width)}\x1b[0m`;
    }
    
    // Question/header
    out += ANSI.move(left, top);
    out += BG_HEADER;
    const qLine = keepBg(` ${C.bold}${C.accent}?${C.reset} ${C.text}${question}${C.reset}`, BG_HEADER);
    out += qLine;
    out += ' '.repeat(Math.max(0, width - this._visualLen(qLine)));
    out += C.reset;
    
    if (hasOptions) {
      for (let i = 0; i < options.length; i++) {
        out += ANSI.move(left, top + 2 + i);
        const isSelected = i === this.askUserIdx;
        if (isSelected) {
          out += BG_SELECTED;
          const line = keepBg(` ${C.bold}${C.ok}▸${C.reset} ${C.bold}${C.text}${options[i]}${C.reset}`, BG_SELECTED);
          out += line;
          out += ' '.repeat(Math.max(0, width - this._visualLen(line)));
        } else {
          out += BG_MODAL;
          const line = keepBg(` ${C.dim}  ${options[i]}${C.reset}`, BG_MODAL);
          out += line;
          out += ' '.repeat(Math.max(0, width - this._visualLen(line)));
        }
        out += C.reset;
      }

      out += ANSI.move(left, top + 2 + options.length);
      out += BG_HEADER;
      const hint = keepBg(` ${C.dim}↑↓ navigate${C.reset} ${C.dim}↵ select${C.reset} ${C.dim}esc cancel${C.reset}`, BG_HEADER);
      out += hint;
      out += ' '.repeat(Math.max(0, width - this._visualLen(hint)));
      out += C.reset;
    } else {
      out += ANSI.move(left, top + 2);
      out += BG_MODAL;
      const answer = this.askUserInput || '';
      const maxAnswerLen = Math.max(8, width - 14);
      const shown = this._truncate(answer, maxAnswerLen);
      const inputLine = keepBg(` ${C.dim}Answer:${C.reset} ${C.text}${shown}${C.reset}${C.dim}▋${C.reset}`, BG_MODAL);
      out += inputLine;
      out += ' '.repeat(Math.max(0, width - this._visualLen(inputLine)));
      out += C.reset;

      out += ANSI.move(left, top + 4);
      out += BG_HEADER;
      const hint = keepBg(` ${C.dim}type response${C.reset} ${C.dim}↵ send${C.reset} ${C.dim}esc cancel${C.reset}`, BG_HEADER);
      out += hint;
      out += ' '.repeat(Math.max(0, width - this._visualLen(hint)));
      out += C.reset;
    }
    
    return out;
  }

  _renderExitConfirm() {
    if (!this.exitConfirmMode) return '';
    const width = 40;
    const left = Math.floor((this.cols - width) / 2);
    const top = Math.floor(this.rows / 2) - 2;
    const boxWidth = width;

    let out = '';

    out += ANSI.move(left, top);
    out += `${C.dim}┌${'─'.repeat(boxWidth - 2)}┐${C.reset}`;

    out += ANSI.move(left, top + 1);
    out += `${C.dim}│${C.reset}${' '.repeat(boxWidth - 2)}${C.dim}│${C.reset}`;

    const msg = ' Uscire? ';
    const padBefore = Math.floor((boxWidth - 2 - msg.length - 4) / 2);
    const padAfter = boxWidth - 2 - msg.length - 4 - padBefore;
    out += ANSI.move(left, top + 1);
    out += `${C.dim}│${C.reset}${' '.repeat(padBefore)}${C.text}${C.bold}Uscire?${C.reset}${C.dim} [y/N]${C.reset}${' '.repeat(padAfter)}${C.dim}│${C.reset}`;

    out += ANSI.move(left, top + 2);
    out += `${C.dim}│${C.reset}${' '.repeat(boxWidth - 2)}${C.dim}│${C.reset}`;

    out += ANSI.move(left, top + 3);
    out += `${C.dim}└${'─'.repeat(boxWidth - 2)}┘${C.reset}`;

    return out;
  }
}

export { TUI };
