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

// Keep the three surfaces distinct so the TUI reads as one composed screen
// instead of a collection of independently colored rows.
const HEADER_BG = '\x1b[48;5;237m';
const PANEL_BG = '\x1b[48;5;236m';
const INPUT_BG = '\x1b[48;5;235m';

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
  bash_session: C.warn,     // yellow — persistent shell session
  glob:         C.dim,      // gray — file discovery
  grep:         C.dim,      // gray — searching
  list_dir:     C.dim,      // gray — directory listing
  file_info:    C.dim,      // gray — metadata
  git_status:   C.string,   // yellow — git
  git_diff:     C.string,   // yellow — git
  webfetch:     C.code,     // blue — fetching URLs
  websearch:    C.code,     // blue — web search
  read_server_console: C.code, // blue — server logs
  browser_app:  C.code,     // blue — driving a web app
  desktop_app:  C.code,     // blue — driving a desktop app
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
    this.attachments = [];
    this.filePicker = null;
    this.mode = 'build';
    this.isRunning = false;
    this.provider = '';
    this.model = '';
    this.sessionId = '';
    this.gitBranch = '';
    // Local package version (e.g. "1.1.1") and the optional update status
    // produced by the async check at startup. The sidebar renders both
    // directly under the "ETTORE SESSION" header so the user always knows
    // which build they are on and whether `ettore update` would change it.
    this.version = '';
    this.updateStatus = null;
    this.detectedLang = '';
    this.availableHeight = 0;
    this.scrollOffset = 0;
    this.needsRender = false;
    this.renderPending = false;
    this.turnState = 'idle';
    this.safetyProfile = 'balanced';
    this.effort = null;
    this.activeSkills = [];
    this.skillsAvailable = 0;
    this.dynamicToolRouting = true;
    this.routedToolCount = 0;
    this.routedToolNames = [];
    
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
    // /loop runtime — written by native-ui.js on start/advance/stop, read
    // by _renderSidebar. Null when no loop has run in this session.
    this.loopStatus = null;
    // Sequence id bumped on every loop state change so the renderer can
    // pick up updates even when the data itself didn't change (rare but
    // possible with the same status returned twice).
    this.loopStatusRev = 0;
    // Mission Control snapshot written by native-ui.js. Keeping a snapshot in
    // the renderer makes sidebar drawing pure and avoids coupling the TUI to
    // agent internals.
    this.mission = null;

    // Command palette state — initialized here so the palette is always
    // renderable, even if a keypress path flips `commandPaletteOpen = true`
    // directly without going through `openCommandPalette()`. The native-ui
    // sub-menu backspace/left handlers historically did this; without
    // defaults, `_renderCommandPalette` would dereference
    // `commandFiltered.length` on `undefined` and crash the render loop.
    this.commandPaletteOpen  = false;
    this.commandList         = [];
    this.commandFiltered     = [];
    this.commandFilter       = '';
    this.commandInput        = '';
    this.commandIndex        = 0;
    this.commandScrollOffset = 0;
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
    const sidebarContentWidth = Math.max(1, sidebarWidth - 1);
    const mainWidth = Math.max(20, this.cols - sidebarWidth - 1);

    // Render the input first so we know how many rows it occupies, then shrink
    // the messages area to make room. Messages area must keep at least 2 rows.
    const inputRows = this._renderInput(mainWidth);
    const inputHeight = inputRows.length;
    // Layout overhead: 1 header + 1 status + 2 input borders + 1 bottom margin = 5
    this.availableHeight = Math.max(2, this.rows - 5 - inputHeight);

    const msgLines = this._renderMessages();
    const sideLines = this._renderSidebar(sidebarContentWidth);
    this.animationFrame = (this.animationFrame + 1) % 100;
    let out = ANSI.hide;

    out += ANSI.move(1, 1) + this._padVisual(this._renderHeader(), this.cols);

    for (let i = 0; i < this.availableHeight; i++) {
      out += ANSI.move(1, i + 2) + this._padVisual(msgLines[i] || '', mainWidth);
      out += ANSI.move(mainWidth + 1, i + 2) + ' ';
      out += ANSI.move(mainWidth + 2, i + 2) + `${C.border}│${C.reset}`;
      out += ANSI.move(mainWidth + 3, i + 2) + `${PANEL_BG}${this._padVisual(sideLines[i] || '', sidebarContentWidth)}${C.reset}`;
    }

    out += ANSI.move(1, this.availableHeight + 2) + this._padVisual(this._renderStatus(mainWidth), mainWidth);
    out += ANSI.move(mainWidth + 1, this.availableHeight + 2) + ' ';
    out += ANSI.move(mainWidth + 2, this.availableHeight + 2) + `${C.border}│${C.reset}`;
    out += ANSI.move(mainWidth + 3, this.availableHeight + 2) + `${PANEL_BG}${this._padVisual(this._renderSidebarStatus(sidebarContentWidth), sidebarContentWidth)}${C.reset}`;

    // Input area: top border, N input rows, bottom border.
    const inputTop = this.availableHeight + 3;
    out += ANSI.move(1, inputTop) + this._renderInputBorder(true, mainWidth);
    out += ANSI.move(mainWidth + 1, inputTop) + ' ';
    out += ANSI.move(mainWidth + 2, inputTop) + `${C.border}│${C.reset}`;
    out += ANSI.move(mainWidth + 3, inputTop) + `${PANEL_BG}${' '.repeat(sidebarContentWidth)}${C.reset}`;
    for (let i = 0; i < inputHeight; i++) {
      const row = inputTop + 1 + i;
      out += ANSI.move(1, row) + inputRows[i];
      out += ANSI.move(mainWidth + 1, row) + ' ';
      out += ANSI.move(mainWidth + 2, row) + `${C.border}│${C.reset}`;
      out += ANSI.move(mainWidth + 3, row) + `${PANEL_BG}${' '.repeat(sidebarContentWidth)}${C.reset}`;
    }
    const inputBottom = inputTop + 1 + inputHeight;
    out += ANSI.move(1, inputBottom) + this._renderInputBorder(false, mainWidth);
    out += ANSI.move(mainWidth + 1, inputBottom) + ' ';
    out += ANSI.move(mainWidth + 2, inputBottom) + `${C.border}│${C.reset}`;
    out += ANSI.move(mainWidth + 3, inputBottom) + `${PANEL_BG}${' '.repeat(sidebarContentWidth)}${C.reset}`;

    // Overlays
    out += this._renderCommandPalette();
    out += this._renderSubMenu();
    out += this._renderFilePicker();
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
    let clipped = this._truncateVisual(str, width);
    let vlen = this._visualLen(clipped);
    // If truncation lands exactly at `width` with an ellipsis as the last
    // visible char, the ellipsis replaces the row's right border. Re-truncate
    // to `width-1` so the trailing space from padding can take its place.
    if (vlen >= width && this._stripAnsi(clipped).endsWith('…')) {
      clipped = this._truncateVisual(str, width - 1);
      vlen = this._visualLen(clipped);
    }
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

    const leftPlain = ` ETTORE · ${session}`;
    const rightPlain = `${provider}/${model} · ${modeLabel}`;
    const pad = Math.max(0, this.cols - leftPlain.length - rightPlain.length);

    const bg = HEADER_BG;
    const left = `${bg}${C.bold}${glowColor}▌${C.reset}${bg}${C.bold}${C.text} ETTORE${C.reset}${bg}${C.dim} · ${session}${C.reset}`;
    const providerColor = provider === 'no provider' ? C.warn : C.dim;
    const right = `${bg}${providerColor}${provider}${C.reset}${bg}/${C.text}${model}${C.reset}${bg} ${C.dim}·${C.reset}${bg} ${modeColor}${C.bold}${modeLabel}${C.reset}`;
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
      lines.push(`  ${C.accent}📎${C.reset}${C.text} Ctrl+O${C.reset}          ${C.dim}attach files or images to your next prompt${C.reset}`);
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
    const line = ` ${C.accent}${C.bold}▌${C.reset} ${C.bold}${C.text}${mode}${C.reset} ${C.dim}workspace${C.reset} ${C.text}${workdir}${C.reset} ${C.dim}· llm:${C.reset}${provider === 'no provider' ? C.warn : C.accent}${provider}${C.reset} ${C.dim}· / commands · 📎 attach · ! shell${C.reset}`;
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
  /**
   * A badge naming the plugin a tool came from, or '' for a built-in.
   *
   * Running someone else's code is worth seeing. Without it a plugin tool was
   * indistinguishable from one the CLI ships, which matters most exactly when
   * a plugin misbehaves and there is nothing on screen to point at it.
   */
  _pluginBadge(tool) {
    const name = tool?.plugin;
    if (!name) return '';
    return ` ${C.dim}⧉${C.reset}${C.accent}${this._truncate(String(name), 18)}${C.reset}`;
  }

  _describeToolCall(name, args, maxLen = 55) {
    if (!args) return '';
    let desc = '';
    switch (name) {
      case 'bash':
      case 'bash_session':
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
      case 'bash':
      case 'bash_session': {
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
      const badge = this._pluginBadge(runningTool);
      // Elapsed time placed in the actLabel (top row, always visible above
      // the fold) so the user always sees the timer even when the lower
      // "tool attivo" section is clipped by the assistant block height.
      const aElapsedMs = Math.max(0, Date.now() - (Number(runningTool.startMs) || Date.now()));
      const aElapsedStr = aElapsedMs < 60_000
        ? `${Math.floor(aElapsedMs / 1000)}s`
        : `${Math.floor(aElapsedMs / 60_000)}m${Math.floor((aElapsedMs % 60_000) / 1000)}s`;
      const aElapsedColor = aElapsedMs > 180_000 ? C.err
                          : aElapsedMs > 60_000  ? C.warn
                          :                        C.dim;
      const aElapsed = ` ${aElapsedColor}[${aElapsedStr}]${C.reset}`;
      actLabel = `${toolColor}${pulse}${C.reset} ${toolColor}${C.bold}${runningTool.name}${C.reset}${badge}${descStr}${aElapsed}`;
    } else if (text || reasoning) {
      const waveBar = WAVE_FRAMES.slice(0, 5).map((_, i) =>
        WAVE_FRAMES[(waveIdx + i) % WAVE_FRAMES.length]
      ).join('');
      actLabel = `${C.ok}${pulse}${C.reset} ${C.dim}writing${C.reset} ${C.accent}${waveBar}${C.reset} ${C.text}${cursor}${C.reset}`;
    } else {
      // Model is "thinking" — no tool, no visible text yet. Show how long we've
      // been waiting so the user can tell "slow model" from "hung model" before
      // the 120-300s stall watchdog fires. Without this, a 5-minute provider
      // stall looks identical to a 5-second first-token delay.
      const thinkingElapsedMs = lastActivityAt > 0 ? (Date.now() - lastActivityAt) : 0;
      const thinkingElapsedStr = thinkingElapsedMs < 60_000
        ? `${Math.floor(thinkingElapsedMs / 1000)}s`
        : `${Math.floor(thinkingElapsedMs / 60_000)}m${Math.floor((thinkingElapsedMs % 60_000) / 1000)}s`;
      const thinkingElapsedColor = thinkingElapsedMs > 180_000 ? C.err
                                 : thinkingElapsedMs > 60_000  ? C.warn
                                 :                                 C.dim;
      const thinkingElapsed = ` ${thinkingElapsedColor}[${thinkingElapsedStr}]${C.reset}`;
      actLabel = `${glowColor}${pulse}${C.reset} ${C.accent}${C.bold}●●●${C.reset} ${C.dim}thinking…${C.reset}${thinkingElapsed}`;
    }

    const rows = [actLabel];
    const innerWidth = this._bubbleInnerWidth(maxWidth, 'left');
    const idleMs = lastActivityAt > 0 ? (Date.now() - lastActivityAt) : 0;
    if (idleMs >= stallMs) {
      let waitText;
      if (waitKind === 'tool') {
        waitText = `${C.warn}stato:${C.reset} ${C.dim}in attesa completamento tool…${C.reset}`;
      } else {
        // Model wait: escalate color from accent → warn → err as the idle
        // duration grows. Reaches err well before the 300s hard watchdog
        // so the user can press ESC themselves instead of waiting for the
        // automatic cancel.
        const waitColor = idleMs > 180_000 ? C.err
                        : idleMs > 60_000  ? C.warn
                        :                    C.accent;
        waitText = `${waitColor}stato:${C.reset} ${C.dim}in attesa risposta modello…${C.reset}`;
      }
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

    // Show only the tool currently running in the main agent output area.
    if (runningTool) {
      rows.push('');
      rows.push(`${C.dim}tool attivo${C.reset}`);
      const toolColor = TOOL_COLORS[runningTool.name] || C.dim;
      const desc = this._describeToolCall(runningTool.name, runningTool.args, maxWidth - 18);
      const descStr = desc ? ` ${C.dim}${desc}${C.reset}` : '';
      const progress = runningTool.progress
        ? ` ${C.dim}${this._truncateVisual(this._sanitizeForRender(runningTool.progress), Math.max(10, innerWidth - 24))}${C.reset}`
        : '';
      // Elapsed time since tool started. Gives the user a heartbeat even when
      // the tool itself doesn't emit progress (read, write, edit, grep, glob,
      // git_*, etc.). Color shifts to warn/err so a stuck tool is visible
      // without having to wait for the 300s stall watchdog.
      const elapsedMs = Math.max(0, Date.now() - (Number(runningTool.startMs) || Date.now()));
      const elapsedStr = elapsedMs < 60_000
        ? `${Math.floor(elapsedMs / 1000)}s`
        : `${Math.floor(elapsedMs / 60_000)}m${Math.floor((elapsedMs % 60_000) / 1000)}s`;
      const elapsedColor = elapsedMs > 180_000 ? C.err
                         : elapsedMs > 60_000  ? C.warn
                         :                       C.dim;
      const elapsed = ` ${elapsedColor}[${elapsedStr}]${C.reset}`;
      // Liveness fallback: if the tool hasn't reported progress and it's been
      // a few seconds, surface that it's still working. Prevents the "is it
      // frozen?" perception for silent tools.
      const stillRunning = !runningTool.progress && elapsedMs > 3000
        ? ` ${C.dim}(ancora in esecuzione…)${C.reset}`
        : '';
      const line = `  ${toolColor}${pulse}${C.reset} ${toolColor}${C.bold}${runningTool.name}${C.reset}${descStr}${progress} ${C.dim}…${C.reset}${elapsed}${stillRunning}`;
      this._wrapText(line, innerWidth).forEach(w => rows.push(w));
      if (runningTool.diffPreview) {
        const diffRows = this._renderDiffSideBySide(runningTool.diffPreview, Math.max(20, innerWidth - 2));
        diffRows.forEach(r => rows.push(r));
      }
    }

    return this._renderAssistantBlock({
      label: 'ETTORE',
      meta: 'now',
      rows,
      color: glowColor,
      maxWidth,
    });
  }

  _renderStatus(width = this.cols) {
    const sep = `${C.dim} · ${C.reset}`;
    const glowIdx = Math.floor(this.animationFrame / 20) % GLOW_COLORS.length;
    const glowColor = GLOW_COLORS[glowIdx];
    const pulseIdx = Math.floor(this.animationFrame / 10) % PULSE_FRAMES.length;
    const pulse = PULSE_FRAMES[pulseIdx];
    const runningStateLabel = this.turnState === 'tool_call'
      ? 'tool'
      : this.turnState === 'tool_result'
        ? 'processing'
        : this.turnState === 'failed'
          ? 'failed'
          : 'thinking';
    const runningStateColor = this.turnState === 'failed' ? C.err : C.text;
    const state = this.isRunning
      ? `${glowColor}${C.bold}${pulse}${C.reset} ${runningStateColor}${runningStateLabel}${C.reset}`
      : `${C.ok}●${C.reset} ${C.dim}idle${C.reset}`;
    const scroll = this.scrollOffset > 0 ? `${C.warn}↑ scrolled${C.reset}${sep}` : '';
    const hint = this.isRunning
      ? `${C.dim}ctrl+c stop${C.reset}`
      : `${C.accent}/${C.reset}${C.dim} commands${C.reset}${sep}${C.accent}tab${C.reset}${C.dim} mode${C.reset}`;
    const content = ` ${scroll}${state}${sep}${hint} `;
    return `${PANEL_BG}${this._padVisual(content, width)}${C.reset}`;
  }

  _renderSidebarStatus(width) {
    const model = this._truncate(connectionManager.activeModel || this.model || 'not configured', Math.max(8, width - 8));
    return ` ${C.dim}model${C.reset} ${C.text}${model}${C.reset}`;
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
    return `${INPUT_BG}${bc}${line}${C.reset}`;
  }

  // Maximum number of visual rows the input box may occupy. The first row
  // shows the prompt glyph (❯); subsequent rows are continuation lines.
  static INPUT_MAX_ROWS = 6;

  // Wrap raw user input (no ANSI) at a column boundary, walking codepoints so
  // surrogate pairs aren't split. Honors INPUT_MAX_ROWS — anything past the
  // cap is collapsed into the last row, which is then left-truncated so the
  // tail (where the cursor sits) stays visible.
  _wrapInputText(text, maxLen, maxRows) {
    const rows = [];
    if (!text) return [''];
    let cur = '';
    let curLen = 0;
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      const w = (cp > 0x1100 && (
        cp <= 0x115F || cp === 0x2329 || cp === 0x232A ||
        (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) ||
        (cp >= 0xAC00 && cp <= 0xD7A3) ||
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0xFE30 && cp <= 0xFE4F) ||
        (cp >= 0xFF00 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6) ||
        (cp >= 0x1F300 && cp <= 0x1FAFF)
      )) ? 2 : 1;
      if (curLen + w > maxLen) {
        rows.push(cur);
        cur = '';
        curLen = 0;
      }
      cur += ch;
      curLen += w;
    }
    rows.push(cur);
    if (rows.length <= maxRows) return rows;
    // Overflow: keep first (maxRows - 1) rows, then put the tail in the last
    // visible row, left-truncated with an ellipsis so the cursor stays in view.
    const kept = rows.slice(0, maxRows - 1);
    const remainder = rows.slice(maxRows - 1).join('');
    const tail = remainder.length > maxLen - 1
      ? '…' + remainder.slice(remainder.length - (maxLen - 1))
      : remainder;
    kept.push(tail);
    return kept;
  }

  // Render the input box as an array of fully-formatted rows (1..INPUT_MAX_ROWS).
  // Only free-form user input (this.input) wraps onto multiple lines; all other
  // modes (api-key, command palette, sub-menu, running, placeholder) stay
  // single-line — they are short by construction.
  _renderInput(width = this.cols) {
    const bc     = this.isRunning ? C.warn : C.accent;
    const promptGlyph = this.isRunning ? `${C.warn}◌${C.reset}` : `${C.accent}❯${C.reset}`;
    const maxLen = Math.max(4, width - 6); // visible payload per row

    // Helper: wrap one fully-formatted row to the input-box layout.
    const wrapRow = (payload, isFirst) => {
      const glyph = isFirst ? promptGlyph : ' ';
      const clipped = this._truncateVisual(payload, maxLen);
      const used = this._visualLen(` ${glyph} ${clipped}`);
      const pad = ' '.repeat(Math.max(0, width - used - 1));
      return `${INPUT_BG} ${bc}${glyph}${C.reset}${INPUT_BG} ${clipped}${pad}${C.reset}`;
    };

    // Single-line modes (most of them).
    let singleLine = null;
    if (this.isRunning) {
      singleLine = `${C.dim}agent running… (ctrl+c to stop)${C.reset}`;
    } else if (this.apiKeyInputMode) {
      if (this.apiKeyConnecting) {
        singleLine = `${C.dim}Connecting to ${C.bold}${this.apiKeyProvider}${C.dim}…${C.reset}`;
      } else if (this.apiKeyError) {
        singleLine = `${C.err}${this.apiKeyError}${C.reset}`;
      } else if (this.apiKeyStep === 'baseUrl') {
        const hint = this.apiKeyBaseUrl.length === 0 ? `${C.dim}${this.apiKeyProviderMeta?.baseUrlHint || 'https://...'}${C.reset}` : '';
        singleLine = `${C.dim}Base URL: ${C.reset}${C.text}${this.apiKeyBaseUrl}${C.reset}${hint}${C.dim}▋${C.reset}`;
      } else if (this.apiKeyStep === 'model') {
        const hint = this.apiKeyModelValue.length === 0 ? `${C.dim}${this.apiKeyProviderMeta?.modelHint || 'model-name'}${C.reset}` : '';
        singleLine = `${C.dim}Model: ${C.reset}${C.text}${this.apiKeyModelValue}${C.reset}${hint}${C.dim}▋${C.reset}`;
      } else {
        const masked = this.apiKeyValue.length > 0 ? '•'.repeat(Math.min(this.apiKeyValue.length, 30)) : '';
        singleLine = `${C.dim}API key for ${C.bold}${this.apiKeyProviderMeta?.name || this.apiKeyProvider}${C.dim}: ${C.reset}${C.text}${masked}▋${C.reset}`;
      }
    } else if (this.commandPaletteOpen) {
      const query = this.commandInput || this.commandFilter;
      singleLine = query
        ? `${C.accent}/${C.reset}${C.text}${query}▋${C.reset}`
        : `${C.accent}/${C.reset}${C.dim}Search commands…${C.reset}${C.dim}▋${C.reset}`;
    } else if (this.subMenuOpen) {
      singleLine = `${C.accent}/${C.reset}${C.dim}${this.subMenuTitle}${C.reset} ${C.text}▋${C.reset}`;
    } else if (!this.input && this.attachments.length === 0) {
      const connected = Boolean(connectionManager.getActive());
      singleLine = connected
        ? `${C.dim}Message ETTORE…  ${C.accent}📎 attach${C.dim} (ctrl+o)  / commands  ! shell${C.reset}`
        : `${C.dim}Type /connect to start, or /help for commands${C.reset}`;
    }

    if (singleLine !== null) {
      return [wrapRow(singleLine, true)];
    }

    // Multi-line: wrap user input. Reserve 1 column for the cursor glyph.
    const attachmentRows = this.attachments.length
      ? this._wrapInputText(`📎 ${this.attachments.map(file => this._truncate(file.name, 20)).join('  ')}  ⌫ remove last`, maxLen - 1, 2)
      : [];
    const inputRows = this._wrapInputText(this.input, maxLen - 1, Math.max(1, TUI.INPUT_MAX_ROWS - attachmentRows.length));
    const rows = [...attachmentRows, ...inputRows].slice(0, TUI.INPUT_MAX_ROWS);
    return rows.map((rowText, idx) => {
      const isLast = idx === rows.length - 1;
      const payload = `${C.text}${rowText}${isLast ? '▋' : ''}${C.reset}`;
      return wrapRow(payload, idx === 0);
    });
  }

  _renderSidebar(width) {
    const lines = [];
    const header = `${C.bold}${C.accent}▌ ETTORE${C.reset} ${C.dim}SESSION${C.reset}`;
    lines.push(header);
    if (this.version) {
      const versionStr = `${C.dim}v${C.reset}${C.text}${this.version}${C.reset}`;
      const updateSuffix = (() => {
        if (!this.updateStatus?.outdated) return '';
        return `  ${C.warn}↻ ${this.updateStatus.latest}${C.reset}`;
      })();
      lines.push(`${versionStr}${updateSuffix}`);
      if (this.updateStatus?.outdated) {
        // Two short, dimmed hints: which command runs the upgrade, and
        // where to check the version once done. The actual `update` is
        // a subcommand so a typo'd `npm install -g` does not happen by
        // accident.
        lines.push(`  ${C.warn}→ \`ettore update\` to upgrade${C.reset}`);
      }
    } else {
      lines.push(`${C.dim}version unknown${C.reset}`);
    }
    lines.push(`${C.border}${'━'.repeat(Math.max(4, width))}${C.reset}`);

    // /loop section: only when there's something to show. Either an active
    // loop (top-of-mind status: which step is running and how many remain)
    // or the most recent completed loop in this session (so the user can
    // see "✓ 5/5 step" after the run finishes).
    if (this.loopStatus) {
      const ls = this.loopStatus;
      const titleMax = Math.max(8, width - 14);
      if (ls.active) {
        // Animated dot — alternates ●/○ on every render so the eye catches it.
        const pulse = (this.animationFrame % 4 < 2) ? `${C.warn}●${C.reset}` : `${C.accent}●${C.reset}`;
        const done = ls.completedTitles?.length || 0;
        const cur = Math.min(done + 1, ls.totalSteps);
        const currentTitle = ls.steps?.[done]?.title || `step ${cur}`;
        lines.push(`${C.bold}${C.accent}LOOP${C.reset} ${pulse} ${C.text}${cur}/${ls.totalSteps}${C.reset} ${C.dim}${this._truncate(currentTitle, titleMax)}${C.reset}`);
        // Progress dots — one per step (✓ done, ● current, ◯ pending).
        const dots = (ls.steps || []).map((_s, i) => {
          if (i < done) return `${C.ok}✓${C.reset}`;
          if (i === done) return `${C.warn}●${C.reset}`;
          return `${C.dim}◯${C.reset}`;
        }).join(' ');
        lines.push(`  ${dots}`);
      } else if (ls.totalSteps > 0) {
        // Loop finished — show the summary once, then the section collapses.
        lines.push(`${C.bold}${C.accent}LOOP${C.reset} ${C.ok}✓${C.reset} ${C.text}${ls.totalSteps}/${ls.totalSteps} step${C.totalSteps === 1 ? '' : 's'}${C.reset}`);
        if (ls.goal) {
          lines.push(`  ${C.dim}${this._truncate(ls.goal, width - 3)}${C.reset}`);
        }
      }
    }

    if (this.mission?.id) {
      const ms = this.mission;
      const statusColor = ms.status === 'failed' ? C.err : ms.status === 'completed' ? C.ok : C.warn;
      const statusIcon = ms.status === 'failed' ? '!' : ms.status === 'completed' ? '✓' : '●';
      lines.push(`${C.bold}${C.accent}MISSION${C.reset} ${statusColor}${statusIcon}${C.reset} ${C.text}${this._truncate(ms.status, Math.max(8, width - 12))}${C.reset}`);
      lines.push(`  ${C.dim}${ms.turns} turn${ms.turns === 1 ? '' : 's'} · ${ms.tools?.total || 0} tools · ${ms.files?.length || 0} files${C.reset}`);
      if (ms.progress?.plan || ms.progress?.todos) {
        const progress = [ms.progress.plan ? `plan ${ms.progress.plan}` : '', ms.progress.todos ? `todo ${ms.progress.todos}` : '']
          .filter(Boolean).join(' · ');
        lines.push(`  ${C.dim}${this._truncate(progress, width - 3)}${C.reset}`);
      }
      if (ms.waves?.length) {
        const wave = ms.waves[ms.waves.length - 1];
        lines.push(`  ${C.dim}wave ${wave.index}/${wave.total} · ${wave.tools.length} parallel${C.reset}`);
      }
      if (ms.lastEvent?.detail) {
        lines.push(`  ${C.dim}${this._truncate(ms.lastEvent.detail, width - 3)}${C.reset}`);
      }
    }

    const provider = connectionManager.activeProvider || this.provider || 'none';
    const model = connectionManager.activeModel || this.model || 'none';
    const cwdDisplay = process.cwd().split('/').slice(-2).join('/');
    lines.push(`${C.dim}◉ provider${C.reset} ${C.text}${this._truncate(provider, Math.max(8, width - 11))}${C.reset}`);
    lines.push(`${C.dim}◈ model${C.reset}    ${C.text}${this._truncate(model, Math.max(8, width - 11))}${C.reset}`);
    lines.push(`${C.dim}⌂ cwd${C.reset}      ${C.text}${this._truncate(cwdDisplay, Math.max(8, width - 11))}${C.reset}`);

    const state = this.isRunning ? `${C.warn}running${C.reset}` : `${C.ok}idle${C.reset}`;
    const capability = this.modelCapability === 'full' ? `${C.ok}FULL${C.reset}` : this.modelCapability === 'lite' ? `${C.warn}LITE${C.reset}` : `${C.dim}?${C.reset}`;
    lines.push(`${C.dim}● state${C.reset} ${state} ${C.dim}· cap${C.reset} ${capability}`);
    lines.push(`${C.dim}◆ safety${C.reset} ${C.text}${String(this.safetyProfile || 'balanced').toUpperCase()}${C.reset}`);
    // Only when set: an unset effort means the API's own default, and a row
    // saying "default" would claim a setting nobody made.
    if (this.effort) lines.push(`${C.dim}⚙ effort${C.reset} ${C.text}${String(this.effort).toUpperCase()}${C.reset}`);
    const routeText = this.dynamicToolRouting
      ? `${this.routedToolCount || 0} dynamic`
      : 'all tools';
    lines.push(`${C.dim}↗ route${C.reset} ${C.text}${routeText}${C.reset}`);
    lines.push(`${C.dim}cost${C.reset} ${this._statusCostText()} ${C.dim}· ctx${C.reset} ${this._statusCtxText()}`);
    lines.push(`${C.dim}msgs${C.reset} ${C.text}${this.messages.filter(m => m.role !== 'todos').length}${C.reset}`);
    // Which skills the prompt woke, and how many were on offer. Without it a
    // skill that did not match is indistinguishable from one that did.
    if (this.skillsAvailable) {
      const names = (this.activeSkills || []).join(', ');
      const body = names
        ? `${C.text}${this._truncate(names, Math.max(6, width - 10))}${C.reset}`
        : `${C.dim}none of ${this.skillsAvailable}${C.reset}`;
      lines.push(`${C.dim}✦ skills${C.reset} ${body}`);
    }
    lines.push(`${C.bold}${C.accent}▸ ACTIVITY${C.reset}`);

    const liveTools = this.streaming?.tools || [];
    const lastAssistant = [...this.messages].reverse().find(m => m.role === 'assistant' && m.tools?.length);
    const tools = liveTools.length ? liveTools : (lastAssistant?.tools || []);
    const recent = tools.slice(-5);
    if (recent.length === 0) {
      lines.push(`${C.dim}no tools yet${C.reset}`);
    } else {
      for (const t of recent) {
        const icon = t.status === 'done' ? `${C.ok}✔${C.reset}` : `${C.warn}●${C.reset}`;
        const badge = this._pluginBadge(t);
        // The badge costs columns, so the name gets less room when there is one
        // rather than the row overflowing the panel.
        const room = Math.max(8, width - 4 - (t.plugin ? Math.min(String(t.plugin).length, 18) + 2 : 0));
        lines.push(`${icon} ${C.text}${this._truncate(t.name || 'tool', room)}${C.reset}${badge}`);
      }
    }

    const approvals = listInstallSessionApprovals();
    lines.push(`${C.bold}${C.accent}▸ APPROVALS${C.reset}`);
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

    lines.push(`${C.bold}${C.accent}▸ KEYS${C.reset}`);
    lines.push(`${C.accent}/${C.reset} ${C.dim}commands${C.reset}`);
    lines.push(`${C.accent}📎${C.reset} ${C.dim}attach file (ctrl+o)${C.reset}`);
    lines.push(`${C.accent}!${C.reset} ${C.dim}shell cmd${C.reset}`);
    lines.push(`${C.accent}tab${C.reset} ${C.dim}build/plan${C.reset}`);

    while (lines.length < this.availableHeight) lines.push('');
    return lines.slice(0, this.availableHeight).map(l => this._padVisual(l, width));
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
    // Width measurement must preserve padding spaces. `_stripAnsi` also
    // normalizes repeated whitespace for prose, which is correct for text
    // content but wrong for terminal rows that are intentionally padded.
    const plain = stripAllAnsi(String(s || '')).replace(/\r/g, '');
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

  openFilePicker(options = {}) {
    this.filePicker = { selecting: options.selecting === true, error: '' };
    this.needsRender = true;
  }

  closeFilePicker() {
    this.filePicker = null;
    this.needsRender = true;
  }

  addAttachment(file) {
    if (!file?.path) return false;
    if (this.attachments.some(item => item.path === file.path)) return false;
    this.attachments.push(file);
    this.needsRender = true;
    return true;
  }

  clearAttachments() {
    this.attachments = [];
    this.needsRender = true;
  }

  removeLastAttachment() {
    if (this.attachments.length === 0) return null;
    const removed = this.attachments.pop();
    this.needsRender = true;
    return removed;
  }

  _renderFilePicker() {
    if (!this.filePicker) return '';
    const width = Math.max(52, Math.min(this.cols - 6, 88));
    const left = Math.max(2, Math.floor((this.cols - width) / 2));
    const rows = 7;
    const top = Math.max(2, Math.floor((this.rows - rows) / 2));
    const bg = '\x1b[48;5;238m';
    const headerBg = '\x1b[48;5;24m';
    let out = '';

    for (let i = 0; i < rows; i++) {
      out += ANSI.move(left, top + i) + `${bg}${' '.repeat(width)}${C.reset}`;
    }
    out += ANSI.move(left, top) + `${headerBg}`;
    const title = `  ${C.bold}${C.accent}📎 Allega file${C.reset}  ${C.dim}selettore di sistema${C.reset}`;
    out += title + ' '.repeat(Math.max(0, width - this._visualLen(title))) + C.reset;

    out += ANSI.move(left, top + 2) + bg;
    const status = this.filePicker.error
      ? `${C.err}✗ ${this.filePicker.error}${C.reset}`
      : `${C.accent}▣${C.reset} ${C.text}Seleziona uno o più file nella finestra che si è aperta.${C.reset}`;
    const statusLine = `  ${this._truncateVisual(status, width - 2)}`;
    out += statusLine + ' '.repeat(Math.max(0, width - this._visualLen(statusLine))) + C.reset;

    out += ANSI.move(left, top + 3) + bg;
    const hintLine = `  ${C.dim}Immagini, documenti, audio, video e file di progetto${C.reset}`;
    out += hintLine + ' '.repeat(Math.max(0, width - this._visualLen(hintLine))) + C.reset;

    out += ANSI.move(left, top + 5) + `${headerBg}`;
    const hint = `  ${C.dim}selezione multipla disponibile${C.reset}  ${C.dim}esc annulla${C.reset}  ${C.dim}allegati: ${this.attachments.length}${C.reset}`;
    out += hint + ' '.repeat(Math.max(0, width - this._visualLen(hint))) + C.reset;
    return out;
  }

  // ─── Command palette ──────────────────────────────────────────────────────
  openCommandPalette(commands) {
    this.commandPaletteOpen  = true;
    this.commandFilter       = '';
    this.commandInput        = '';
    this.commandIndex        = 0;
    this.commandScrollOffset = 0;
    this.commandList         = commands;
    this.commandFiltered     = commands;
    this.needsRender         = true;
  }

  closeCommandPalette() {
    this.commandPaletteOpen  = false;
    this.commandFilter       = '';
    this.commandInput        = '';
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

    // Defensive guard: if a keypress handler flipped `commandPaletteOpen` to
    // true without going through `openCommandPalette()` (e.g. the sub-menu
    // backspace/left path in native-ui.js), `commandFiltered` may still be
    // `undefined` or not an array. Treat it as an empty palette so the render
    // loop survives — the user can still see the overlay, type a filter, or
    // press Esc to close it.
    if (!Array.isArray(this.commandFiltered)) {
      this.commandFiltered = Array.isArray(this.commandList) ? [...this.commandList] : [];
    }

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
    const { question, options, sensitive } = this.askUser;
    const hasOptions = Array.isArray(options) && options.length > 0;
    const BG_DIM = '\x1b[48;5;233m';
    const BG_MODAL = '\x1b[48;5;238m';
    const BG_HEADER = '\x1b[48;5;236m';
    const BG_SELECTED = '\x1b[48;5;24m';
    const width = Math.min(Math.max(40, Math.floor(this.cols * 0.72)), Math.max(28, this.cols - 6));
    const innerWidth = Math.max(18, width - 2);
    const left = Math.max(1, Math.floor((this.cols - width) / 2) + 1);
    const keepBg = (str, bg) => String(str || '').replace(/\x1b\[0m/g, `\x1b[0m${bg}`);
    const fit = (str, max = innerWidth) => this._truncateVisual(String(str || ''), max);
    const line = (content, bg = BG_MODAL) => {
      const clipped = fit(content);
      const padding = ' '.repeat(Math.max(0, innerWidth - this._visualLen(clipped)));
      return `${bg}│${keepBg(clipped, bg)}${bg}${padding}${bg}│${C.reset}`;
    };

    // A question is a modal interaction, not another chat message. Cover the
    // whole frame first so the transcript cannot show through the prompt and
    // make the user's answer look like ordinary CLI output.
    let out = '';
    for (let row = 1; row <= this.rows; row++) {
      out += ANSI.move(1, row) + `${BG_DIM}${' '.repeat(this.cols)}${C.reset}`;
    }

    const questionLines = [];
    for (const rawLine of String(question || '').split('\n')) {
      questionLines.push(...this._wrapText(this._sanitizeForRender(rawLine), innerWidth - 4));
    }
    const maxQuestionLines = Math.max(1, Math.min(5, this.rows - 7));
    if (questionLines.length > maxQuestionLines) {
      questionLines.length = maxQuestionLines;
      questionLines[maxQuestionLines - 1] = fit(`${questionLines[maxQuestionLines - 1]}…`, innerWidth - 4);
    }

    const maxModalRows = Math.max(5, this.rows - 2);
    const baseRows = questionLines.length + (hasOptions ? 4 : 5);
    const maxVisibleOptions = hasOptions
      ? Math.max(1, Math.min(options.length, maxModalRows - baseRows))
      : 0;
    const optionStart = hasOptions
      ? Math.min(Math.max(0, this.askUserIdx - maxVisibleOptions + 1), Math.max(0, options.length - maxVisibleOptions))
      : 0;
    const visibleOptions = hasOptions ? options.slice(optionStart, optionStart + maxVisibleOptions) : [];
    const modalRows = Math.min(maxModalRows, baseRows + visibleOptions.length);
    const top = Math.max(1, Math.min(Math.floor((this.rows - modalRows) / 2), this.rows - modalRows));
    const border = (leftChar, rightChar, bg = BG_HEADER) =>
      `${bg}${leftChar}${'─'.repeat(Math.max(0, innerWidth))}${rightChar}${C.reset}`;

    out += ANSI.move(left, top) + border('╭', '╮');
    out += ANSI.move(left, top + 1) + line(` ${C.bold}${C.accent}?${C.reset} ${C.bold}${C.text}ETTORE needs your input${C.reset}`, BG_HEADER);
    for (let i = 0; i < questionLines.length; i++) {
      // Every row gets an explicit cursor position; embedded newlines are
      // deliberately avoided because they can desynchronise the overlay.
      out += ANSI.move(left, top + 2 + i) + line(`  ${C.text}${questionLines[i]}${C.reset}`);
    }

    let row = top + 2 + questionLines.length;
    if (hasOptions) {
      for (let i = 0; i < visibleOptions.length; i++) {
        const optionIndex = optionStart + i;
        const isSelected = optionIndex === this.askUserIdx;
        const bg = isSelected ? BG_SELECTED : BG_MODAL;
        const marker = isSelected ? `${C.bold}${C.ok}▸${C.reset}` : ' ';
        const optionText = fit(String(visibleOptions[i] || ''), innerWidth - 5);
        out += ANSI.move(left, row++) + line(` ${marker} ${isSelected ? C.bold : C.dim}${C.text}${optionText}${C.reset}`, bg);
      }
      const position = options.length > visibleOptions.length
        ? ` ${C.dim}${this.askUserIdx + 1}/${options.length}${C.reset}`
        : '';
      out += ANSI.move(left, row++) + line(` ${C.dim}↑↓ navigate${C.reset} ${C.dim}↵ select${C.reset} ${C.dim}esc cancel${C.reset}${position}`, BG_HEADER);
    } else {
      const answer = this.askUserInput || '';
      const maxAnswerLen = Math.max(8, innerWidth - 14);
      const rawShown = sensitive ? '•'.repeat(answer.length) : answer;
      const shown = fit(rawShown, maxAnswerLen);
      out += ANSI.move(left, row++) + line(` ${C.dim}Answer:${C.reset} ${C.text}${shown}${C.reset}${C.dim}▋${C.reset}`);
      out += ANSI.move(left, row++) + line(` ${C.dim}type response${C.reset} ${C.dim}↵ send${C.reset} ${C.dim}esc cancel${C.reset}`, BG_HEADER);
    }
    out += ANSI.move(left, row) + border('╰', '╯');

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
