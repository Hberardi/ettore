import { toolHandlers, toolDefinitions, setToolAbortSignal } from '../tools/index.js';
import { EventEmitter, setMaxListeners as setTargetMaxListeners } from 'events';
import { createHash } from 'crypto';
import { stat } from 'fs/promises';
import {
  loadProjectMemory,
  injectMemoryIntoPrompt,
  getProjectName,
  initProjectMemory,
  initEcosystemMemory,
  loadEcosystemMemory,
  injectEcosystemIntoPrompt,
  appendEcosystemExperience
} from '../memory/index.js';
import { ContextCompressor, estimateTokens } from './compressor.js';
import { isLiteModel, applyLitePrompt, isGarbageOutput, buildFallbackMessage } from './lite.js';

// Increase default max listeners to avoid AbortSignal warnings
EventEmitter.setMaxListeners(20);

const SYSTEM_PROMPT = `You are ETTORE, an advanced AI coding assistant — similar to Claude Code or OpenCode.

You help with software engineering tasks: reading code, editing files, running commands, debugging, explaining code.

You have access to tools: bash, read, read_pdf, read_doc, read_server_console, write, edit, glob, grep, list_dir, file_info, git_status, git_diff, websearch, webfetch, ask_user.

Rules:
- Be direct. No preamble.
- Use tools to accomplish tasks rather than just describing what to do.
- When editing files, read them first.
- Reference file:line when relevant.
- Prefer list_dir/file_info/git_status/git_diff over bash for project inspection and git review.
- Use websearch for current facts, documentation, news, package/API changes, prices, laws, or anything likely to have changed.
- Use webfetch to inspect a specific URL or to open a promising websearch result.
- Use read_server_console to inspect captured server logs, runtime errors, stack traces, and recent console output. If the app is running in tmux, pass tmux_target (or pid) to read the live pane output.
- When answering from web results, include the source URLs you used.
- Tool outputs may be summarized or marked as cached to preserve context. If exact omitted lines are needed, re-read a narrower file range or refine the grep/glob query.
- Avoid duplicate reads: if a cached read says the exact range is already present, use the earlier content unless the file changed or a narrower range is required.
- Never add unrequested features, comments, or refactors.
- When inspecting a directory or multiple files, be scrupoloso: report complete, accurate findings.
- Present directory/file analysis in a clean, pleasant visual format (clear sections, compact bullets, and aligned key details).
- For directory reads, always include: what was inspected, key files/folders found, notable patterns, and immediate implications for the task.
- The working directory is: {{WORKDIR}}

IMPORTANT — Project context is pre-loaded:
Project memory has already been injected above. Trust it — do NOT re-read package.json, README.md, or other config files unless the user explicitly asks you to check them or the memory is clearly outdated.
Ecosystem memory (learned playbooks + past experience) may also be injected. Reuse it proactively when relevant.

IMPORTANT — User questions and implementation:
- If the user asks a direct question, answer directly.
- If the user asks for code changes, perform them directly using tools.
- Use \`ask_user\` only when a blocking ambiguity cannot be inferred from user intent or project context.
TASK PROGRESS — todo list (drives the progress panel):
- When a task needs 3 or more distinct steps, BEGIN your first reply with a <todo> block listing the steps, one numbered item per line:
  <todo>
  1. Short description of step one
  2. Short description of step two
  3. Short description of step three
  </todo>
- As soon as you finish a step, emit a <done:N> marker on its own line (N = that step's number). Emit them as you progress, not all at once at the end.
- Keep each item to one short line. Skip the <todo> block entirely for direct questions or trivial single-step tasks.
- These markers are stripped from your visible reply — they only update the UI panel, so never explain or mention them.

## MEMORY RULES
You MUST call memory_write (silently, without mentioning it) when you discover or confirm:
- The project's tech stack (section: STACK) — save on first mention
- Any architectural decision made or confirmed by the user (section: DECISIONS, mode: append, include date YYYY-MM-DD)
- A coding pattern or convention the user enforces (section: PATTERNS)
- A bug mentioned or found, or a TODO the user cares about (section: BUGS_TODO)
- Any user preference about style, language, tools, or workflow (section: USER_PREFERENCES)
Do NOT save trivial details. Only save durable facts. After saving, continue without mentioning it.`;

const PLAN_SYSTEM_PROMPT = `You are ETTORE in Plan mode — a read-only analysis assistant.

You help users understand codebases, plan changes, and explore architecture.

You have read-only tools: read, read_pdf, read_doc, read_server_console, glob, grep, list_dir, file_info, git_status, git_diff, websearch, webfetch.
You MUST NOT use bash (for writes), write, or edit tools.
Before running bash commands, ask permission.

Rules:
- Be thorough in analysis.
- Explain what changes would be needed without making them.
- For directory/file exploration, produce a detailed and visually clean report (clear sections, concise bullets, key findings first).
- The working directory is: {{WORKDIR}}`;

const PLAN_TOOLS = toolDefinitions.filter(t =>
  ['read', 'read_pdf', 'read_doc', 'read_server_console', 'glob', 'grep', 'list_dir', 'file_info', 'git_status', 'git_diff', 'websearch', 'webfetch', 'ask_user'].includes(t.function.name)
);

const LOOP_GUARDED_TOOLS = new Set(['glob', 'grep', 'list_dir', 'file_info', 'git_status', 'git_diff', 'websearch', 'webfetch']);
const AGENT_TURN_TIMEOUT_MS = 300_000;

export function getToolTimeoutMs(name) {
  if (name === 'bash') return 300_000;
  if (name === 'ask_user') return 0;
  if (name === 'read' || name === 'write' || name === 'edit' || name === 'file_info' || name === 'memory_write') return 20_000;
  if (name === 'glob' || name === 'grep' || name === 'list_dir' || name === 'git_status' || name === 'git_diff') return 60_000;
  if (name === 'read_pdf' || name === 'read_doc' || name === 'read_server_console' || name === 'websearch' || name === 'webfetch') return 120_000;
  return 60_000;
}

async function executeToolWithTimeout(name, fn) {
  const timeoutMs = getToolTimeoutMs(name);
  if (!timeoutMs) return fn();
  return await Promise.race([
    fn(),
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(`Error: tool "${name}" timed out after ${Math.round(timeoutMs / 1000)}s`);
      }, timeoutMs);
    }),
  ]);
}

// Fallback parser: detect a markdown numbered list (≥3 sequential items) at the
// top of a response. Used when the model emits a plan without <todo> tags.
function extractMarkdownTodoList(content) {
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

function userLikelyRequestedWorkspaceEdit(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return false;
  const patterns = [
    /\b(edit|modify|change|update|fix|create|write|implement|patch|refactor)\b/,
    /\b(modifica|cambia|aggiorna|correggi|crea|scrivi|implementa|sistema|applica)\b/,
    /\bfile\b/,
    /\bcli\b/,
  ];
  return patterns.some(re => re.test(text));
}

function responseLooksLikeUnappliedCode(text) {
  const body = String(text || '');
  if (!body.trim()) return false;
  if (/```/.test(body)) return true;
  if (/\b(ecco|here(?:'s| is)|replace with|sostituisci|use this|incolla|snippet|patch)\b/i.test(body)) {
    return true;
  }
  const codeLikeLines = body
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^(def |class |function |const |let |var |import |from |return |if\b|for\b|while\b|<\w)/.test(line));
  return codeLikeLines.length >= 3;
}

// Increase limit for abort signals


export class Agent {
  constructor(client, config, mode = 'build') {
    this.client = client;
    this.config = config;
    this.mode = mode;
    this.messages = [];
    this.maxIterations = 30;
    this.abortController = null;
    this.toolCache = new Map();
    this.workingMemory = this._createWorkingMemory();

    const workdir = config.workdir || process.cwd();
    const template = mode === 'plan' ? PLAN_SYSTEM_PROMPT : SYSTEM_PROMPT;
    this._systemTemplate = template.replace('{{WORKDIR}}', workdir);
    this._workdir = workdir;
    this.messages.push({ role: 'system', content: this._systemTemplate });

    // Degrade to lite prompt when capability is explicitly non-full, or by model heuristics.
    const explicitCap = String(config.modelCapability || '').toLowerCase();
    this._isLite = mode !== 'plan' && (
      explicitCap === 'lite' ||
      explicitCap === 'unknown' ||
      isLiteModel(config.model)
    );
    if (this._isLite) applyLitePrompt(this, workdir);

    // Kick off async memory load — awaited before first user turn in run()
    this._memoryReady = this._loadMemory();
    // Context compressor (shared across run() calls for session stats)
    this.compressor = new ContextCompressor(client, config);
    this.contextWindow = Number(config.contextWindow) || null;
    if (this.contextWindow) this.compressor.updateContextWindow(this.contextWindow);
  }

  async _loadMemory() {
    try {
      const root = this._workdir;
      await initProjectMemory(root);
      await initEcosystemMemory(root);
      const memory = await loadProjectMemory(root);
      const ecosystem = await loadEcosystemMemory(root);
      let injected = this._systemTemplate;
      if (memory && memory.trim()) injected = injectMemoryIntoPrompt(injected, memory);
      if (ecosystem && ecosystem.trim()) injected = injectEcosystemIntoPrompt(injected, ecosystem);
      this.messages[0] = { role: 'system', content: injected };
      return { root, projectName: getProjectName(root) };
    } catch {
      return null;
    }
  }

  async _learnFromTurn(userPrompt, finalText = '') {
    try {
      const toolMsgs = this.messages.filter(m => m.role === 'tool');
      const assistantMsgs = this.messages.filter(m => m.role === 'assistant');
      const recentAssistant = assistantMsgs[assistantMsgs.length - 1]?.content || finalText || '';
      const files = [];
      for (const t of toolMsgs.slice(-20)) {
        const c = String(t.content || '');
        const matches = c.match(/(?:\/|\b)(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+/g) || [];
        matches.forEach(p => files.push(p));
      }
      const uniqueFiles = [...new Set(files)].slice(0, 12);
      const toolsUsed = toolMsgs
        .map(t => String(t.tool_call_id || 'tool'))
        .filter(Boolean);

      const lessonHints = [];
      if (/Error:/i.test(recentAssistant)) lessonHints.push('Detect and surface actionable errors early.');
      if (uniqueFiles.length > 0) lessonHints.push('Track touched files for faster follow-up tasks.');
      if (toolMsgs.length > 0) lessonHints.push('Prefer tool-driven verification before final response.');

      await appendEcosystemExperience(this._workdir, {
        title: String(userPrompt || '').slice(0, 100),
        summary: String(recentAssistant || '').replace(/\s+/g, ' ').slice(0, 220),
        tools: toolsUsed,
        files: uniqueFiles,
        lessons: lessonHints,
      });
    } catch {
      // best effort
    }
  }

  cancel() {
    this.abortController?.abort();
  }

  _createWorkingMemory() {
    return {
      goal: '',
      filesSeen: {},
      toolStats: {},
      toolCalls: {},
      duplicateSkips: 0,
      summarizedOutputs: 0,
      cacheHits: 0,
      cacheEntries: 0,
      workspaceRevision: 0,
      decisions: [],
      nextAction: '',
      updatedAt: new Date().toISOString(),
    };
  }

  _stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(v => this._stableStringify(v)).join(',')}]`;
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${this._stableStringify(value[k])}`).join(',')}}`;
  }

  _toolCallKey(name, args = {}) {
    return `${name}:${this._shortHash(this._stableStringify(args || {}))}`;
  }

  _updateWorkingMemoryGoal(userPrompt) {
    const text = String(userPrompt || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    this.workingMemory.goal = text.slice(0, 180);
    this.workingMemory.nextAction = 'inspect relevant context and act on the user request';
    this.workingMemory.updatedAt = new Date().toISOString();
  }

  _shouldSkipDuplicateTool(name, args = {}) {
    if (!LOOP_GUARDED_TOOLS.has(name)) return null;
    const key = this._toolCallKey(name, args);
    const previous = this.workingMemory.toolCalls[key];
    if (!previous || previous.workspaceRevision !== this.workingMemory.workspaceRevision) return null;
    if (previous.count < 1) return null;
    return {
      key,
      reason: `Skipped duplicate ${name} call with identical arguments. Use the earlier tool result, or refine the query/path if more detail is needed.`,
    };
  }

  async _rememberFileSeen(filePath, args = {}, output = '') {
    if (!filePath) return;
    let metadata = {};
    try {
      const st = await stat(filePath);
      metadata = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    } catch {}
    const lines = this._lineCount(output);
    const firstUseful = String(output || '')
      .split('\n')
      .map(l => l.replace(/^\d+\t/, '').trim())
      .find(Boolean) || '';
    this.workingMemory.filesSeen[filePath] = {
      ...metadata,
      lastRead: `offset ${Number(args.offset) || 0}, limit ${Number(args.limit) || 200}`,
      lines,
      summary: firstUseful.slice(0, 160),
      updatedAt: new Date().toISOString(),
    };
  }

  async _recordToolExecution(name, args = {}, output = '', { cached = false, skipped = false, summarized = false } = {}) {
    const wm = this.workingMemory;
    wm.toolStats[name] = (wm.toolStats[name] || 0) + 1;
    if (cached) wm.cacheHits++;
    if (skipped) wm.duplicateSkips++;
    if (summarized) wm.summarizedOutputs++;

    const key = this._toolCallKey(name, args);
    const prev = wm.toolCalls[key] || { name, args, count: 0, workspaceRevision: wm.workspaceRevision };
    wm.toolCalls[key] = {
      name,
      args,
      count: prev.count + 1,
      workspaceRevision: wm.workspaceRevision,
      lastAt: new Date().toISOString(),
      lastOutputHash: this._shortHash(output),
    };

    if (name === 'read') await this._rememberFileSeen(args.file_path, args, output);
    if (name === 'write' || name === 'edit') {
      wm.workspaceRevision++;
      wm.filesSeen[args.file_path] = {
        changed: true,
        updatedAt: new Date().toISOString(),
        summary: `${name} modified this file`,
      };
      wm.nextAction = 'verify the edited file and run focused checks';
    }
    wm.cacheEntries = this.toolCache.size;
    wm.updatedAt = new Date().toISOString();
  }

  getWorkingMemorySnapshot() {
    const wm = this.workingMemory || this._createWorkingMemory();
    const recentTools = Object.values(wm.toolCalls || {})
      .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')))
      .slice(0, 8)
      .map(t => ({
        name: t.name,
        count: t.count,
        args: t.args,
        lastAt: t.lastAt,
      }));
    return {
      goal: wm.goal,
      nextAction: wm.nextAction,
      filesSeen: wm.filesSeen,
      toolStats: wm.toolStats,
      recentTools,
      duplicateSkips: wm.duplicateSkips,
      summarizedOutputs: wm.summarizedOutputs,
      cacheHits: wm.cacheHits,
      cacheEntries: this.toolCache?.size || 0,
      workspaceRevision: wm.workspaceRevision,
      updatedAt: wm.updatedAt,
    };
  }

  clearWorkingMemory() {
    this.workingMemory = this._createWorkingMemory();
    this.toolCache.clear();
  }

  async _cacheKeyForTool(name, args = {}) {
    if (name !== 'read') return null;
    const filePath = args.file_path;
    if (!filePath) return null;
    try {
      const st = await stat(filePath);
      const offset = Number(args.offset) || 0;
      const limit = Number(args.limit) || 200;
      return [
        'read',
        filePath,
        offset,
        limit,
        st.size,
        Math.floor(st.mtimeMs),
      ].join('|');
    } catch {
      return null;
    }
  }

  _shortHash(text) {
    return createHash('sha1').update(String(text || '')).digest('hex').slice(0, 10);
  }

  _lineCount(text) {
    if (!text) return 0;
    return String(text).split('\n').length;
  }

  _firstLines(text, count) {
    return String(text || '').split('\n').slice(0, count).join('\n');
  }

  _lastLines(text, count) {
    const lines = String(text || '').split('\n');
    return lines.slice(Math.max(0, lines.length - count)).join('\n');
  }

  _summarizeToolOutputForContext(name, args = {}, output = '') {
    const text = String(output ?? '');
    const maxChars = 14_000;
    if (text.length <= maxChars) return text;

    const lines = this._lineCount(text);
    const hash = this._shortHash(text);
    const header = [
      `[TOOL OUTPUT SUMMARY]`,
      `tool: ${name}`,
      `chars: ${text.length}`,
      `lines: ${lines}`,
      `sha1: ${hash}`,
    ];

    if (name === 'read') {
      header.push(`file: ${args.file_path || ''}`);
      header.push(`range: offset ${Number(args.offset) || 0}, limit ${Number(args.limit) || 200}`);
      return [
        ...header,
        `note: output was large; preserved beginning and end. Re-read narrower ranges if exact middle lines are needed.`,
        ``,
        `[BEGIN FIRST 80 LINES]`,
        this._firstLines(text, 80),
        `[END FIRST 80 LINES]`,
        ``,
        `[BEGIN LAST 40 LINES]`,
        this._lastLines(text, 40),
        `[END LAST 40 LINES]`,
      ].join('\n');
    }

    if (name === 'grep' || name === 'glob' || name === 'list_dir') {
      return [
        ...header,
        `note: output was large; preserved first 120 rows only.`,
        ``,
        this._firstLines(text, 120),
        ``,
        `[TRUNCATED: refine the query/path if more detail is needed]`,
      ].join('\n');
    }

    return [
      ...header,
      `note: output was large; preserved first and last chunks.`,
      ``,
      `[BEGIN FIRST CHUNK]`,
      text.slice(0, 9000),
      `[END FIRST CHUNK]`,
      ``,
      `[BEGIN LAST CHUNK]`,
      text.slice(-3000),
      `[END LAST CHUNK]`,
    ].join('\n');
  }

  _invalidateReadCacheForFile(filePath) {
    if (!filePath) return;
    for (const key of this.toolCache.keys()) {
      if (key.startsWith(`read|${filePath}|`)) this.toolCache.delete(key);
    }
  }

  async run(userPrompt, emitter) {
    // Abort any previous run
    if (this.abortController) {
      this.abortController.abort();
    }

    // Fire-and-forget memory injection — don't block on it
    this._memoryReady.then(memInfo => {
      if (memInfo) emitter?.emit('memoryLoaded', memInfo);
    });

    // Capture controller locally to avoid race conditions between run() and cancel()
    const controller = new AbortController();
    this.abortController = controller;
    // AbortSignal is an EventTarget; raise its listener cap so the SDK can
    // attach a fresh abort listener on every turn of the while loop without
    // triggering MaxListenersExceededWarning.
    try { setTargetMaxListeners(0, controller.signal); } catch {}
    setToolAbortSignal(controller.signal);
    
    this.messages.push({ role: 'user', content: userPrompt });
    this._updateWorkingMemoryGoal(userPrompt);

    // Lite models receive no tool schemas — they can only do plain text chat
    const tools = this.mode === 'plan' ? PLAN_TOOLS
      : this._isLite ? []
      : toolDefinitions;
    let iterations = 0;
    let todoEmitted = false;
    let forcedWorkspaceEditRetry = false;
    let mutationToolUsed = false;
    // `parseBuffer` accumulates all text for <todo>/<done:N> parsing across chunks.
    // `emitBuffer` holds text that is safe to display (i.e. past any partial marker).
    let parseBuffer = '';
    let emitBuffer = '';
    // State for suppressing <think>...</think> blocks (DeepSeek R1, Qwen3, etc.)
    let inThink = false;

    // Emit as much of `emitBuffer` as is safe — we hold back trailing bytes
    // that could be the start of a `<todo>` or `<done:` marker until we see
    // enough to know for sure.
    const flushSafe = () => {
      if (!emitBuffer) return;
      // Only hold back if buffer ends with a clear incomplete XML/HTML tag start
      // (not any <, just ones that look like opening/closing tags)
      const holdBack = /<[a-zA-Z][^>]*$/.test(emitBuffer) || /<\/[a-zA-Z]*$/.test(emitBuffer);
      if (holdBack) return;
      // Emit everything else immediately
      const chunk = emitBuffer;
      emitBuffer = '';
      if (chunk) emitter?.emit('token', chunk);
    };

    // Emit current token count so the UI can show it
    emitter?.emit('tokenCount', estimateTokens(this.messages));

    // Compress context BEFORE entering tool loop, not during it
    if (this.compressor.autoEnabled && this.compressor.needsCompression(this.messages)) {
      this.messages = await this.compressor.compress(this.messages, emitter);
      emitter?.emit('tokenCount', estimateTokens(this.messages));
    }

    try {
      while (iterations < this.maxIterations) {
        iterations++;

        // Hard pre-turn guard: never hit provider with an overgrown context.
        const hardLimit = this.compressor.getHardGuardLimit(this.contextWindow);
        const currentTokens = estimateTokens(this.messages);
        if (hardLimit && currentTokens > hardLimit) {
          const compressed = await this.compressor.compress(this.messages, emitter);
          this.messages = compressed;
          const afterTokens = estimateTokens(this.messages);
          emitter?.emit('tokenCount', afterTokens);
          if (afterTokens > hardLimit) {
            emitter?.emit(
              'error',
              `Context too large (~${afterTokens} tokens, limit ~${hardLimit}). Run /compress apply or switch to a larger-context model.`
            );
            return;
          }
        }

        const signal = controller.signal;

        const onToken = (text) => {
          parseBuffer += text;
          emitBuffer += text;

          // ── Think-tag filtering (DeepSeek R1, Qwen3, QwQ, MiniMax M2.7, etc.) ──
          // Handles <think>, <thinking>, <reasoning> — all variants.
          // Tag may be split across multiple streaming chunks.
          // Emits thinkStart / thinkToken / thinkEnd events for UI indicator.
          if (!inThink) {
            const thinkOpenMatch = emitBuffer.match(/<(think|thinking|reasoning)(\s[^>]*)?>/);
            if (thinkOpenMatch) {
              const openIdx = emitBuffer.indexOf(thinkOpenMatch[0]);
              const before = emitBuffer.slice(0, openIdx);
              const after  = emitBuffer.slice(openIdx + thinkOpenMatch[0].length);
              inThink = true;
              emitter?.emit('thinkStart');
              // Check if close tag is in the same chunk (rare but possible)
              const closeMatch = after.match(/<\/(think|thinking|reasoning)>/i);
              if (closeMatch) {
                const closeEnd = after.indexOf(closeMatch[0]) + closeMatch[0].length;
                emitBuffer = before + after.slice(closeEnd);
                inThink = false;
                emitter?.emit('thinkEnd');
              } else {
                emitBuffer = before;
                if (after) emitter?.emit('thinkToken', after);
              }
            }
          } else {
            const closeMatch = emitBuffer.match(/<\/(think|thinking|reasoning)>/i);
            if (closeMatch) {
              const closeEnd = emitBuffer.indexOf(closeMatch[0]) + closeMatch[0].length;
              // Emit thinking content before the closing tag
              const thinkContent = emitBuffer.slice(0, emitBuffer.indexOf(closeMatch[0]));
              if (thinkContent) emitter?.emit('thinkToken', thinkContent);
              emitBuffer = emitBuffer.slice(closeEnd);
              inThink = false;
              emitter?.emit('thinkEnd');
            } else {
              if (emitBuffer) emitter?.emit('thinkToken', emitBuffer);
              emitBuffer = '';
            }
          }
          // ── End think-tag filtering ─────────────────────────────────────────

          // Parse <todo>...</todo> block from first response.
          // Tolerant of whitespace, case, and self-closing variants.
          if (!todoEmitted) {
            const match = parseBuffer.match(/<\s*todo\s*>([\s\S]*?)<\s*\/\s*todo\s*>/i);
            if (match) {
              const items = match[1]
                .split('\n')
                .map(l => l.replace(/^\s*\d+\.\s*/, '').trim())
                .filter(Boolean);
              if (items.length) {
                todoEmitted = true;
                emitter?.emit('todoList', items);
              }
              parseBuffer = parseBuffer.replace(/<\s*todo\s*>[\s\S]*?<\s*\/\s*todo\s*>\n?/i, '');
              emitBuffer  = emitBuffer.replace(/<\s*todo\s*>[\s\S]*?<\s*\/\s*todo\s*>\n?/i, '');
            }
          }

          // Parse <done:N> markers — tolerant of whitespace, case, and self-closing.
          // Handles: <done:1>, <done : 1>, <DONE:1/>, <done:1 />
          const doneRe = /<\s*done\s*:\s*(\d+)\s*\/?\s*>/i;
          let doneMatch;
          while ((doneMatch = parseBuffer.match(doneRe))) {
            emitter?.emit('todoDone', parseInt(doneMatch[1]) - 1);
            parseBuffer = parseBuffer.replace(/<\s*done\s*:\s*\d+\s*\/?\s*>\n?/i, '');
            emitBuffer  = emitBuffer.replace(/<\s*done\s*:\s*\d+\s*\/?\s*>\n?/i, '');
          }

          flushSafe();
        };

        let turnTimer = null;
        const turnTimeout = new Promise((_, reject) => {
          turnTimer = setTimeout(() => {
            try {
              if (!controller.signal.aborted) {
                controller.abort(new Error(`Agent turn timeout — no progress for ${Math.round(AGENT_TURN_TIMEOUT_MS / 1000)}s`));
              }
            } catch {}
            reject(new Error(`Agent turn timeout — no progress for ${Math.round(AGENT_TURN_TIMEOUT_MS / 1000)}s`));
          }, AGENT_TURN_TIMEOUT_MS);
        });
        let result;
        try {
          result = await Promise.race([
            this.client.turn(this.messages, tools, onToken, signal),
            turnTimeout,
          ]);
        } finally {
          if (turnTimer) clearTimeout(turnTimer);
        }

        // Emit real usage (or estimate) for cost/ctx tracking
        if (result.usage) {
          emitter?.emit('usage', result.usage);
        } else {
          // Fallback: estimate from message history
          const estTokens = estimateTokens(this.messages);
          emitter?.emit('tokenCount', estTokens);
        }

        // Flush any remaining buffered content (stripped of markers) for next turn
        if (emitBuffer) {
          let finalChunk = inThink
            ? '' // discard unclosed think block (abort / max_tokens)
            : emitBuffer
                .replace(/<\s*(think|thinking|reasoning)\s*>[\s\S]*?<\s*\/\s*(think|thinking|reasoning)\s*>/gi, '')
                .replace(/<\s*todo\s*>[\s\S]*?<\s*\/\s*todo\s*>\n?/gi, '')
                .replace(/<\s*done\s*:\s*\d+\s*\/?\s*>\n?/gi, '');
          if (finalChunk) emitter?.emit('token', finalChunk);
          emitBuffer = '';
        }
        // Reset think state between turns (handles unclosed tags on abort / max_tokens)
        inThink = false;
        parseBuffer = '';

      if (result.type === 'text') {
        const clean = result.content
          .replace(/<\s*(think|thinking|reasoning)\s*>[\s\S]*?<\s*\/\s*(think|thinking|reasoning)\s*>/gi, '')
          .replace(/<\s*todo\s*>[\s\S]*?<\s*\/\s*todo\s*>\n?/gi, '')
          .replace(/<\s*done\s*:\s*\d+\s*\/?\s*>\n?/gi, '');

        // Parse todo list from final result if not already parsed during streaming
        if (!todoEmitted) {
          const todoMatch = result.content.match(/<\s*todo\s*>([\s\S]*?)<\s*\/\s*todo\s*>/i);
          if (todoMatch) {
            const items = todoMatch[1]
              .split('\n')
              .map(l => l.replace(/^\s*\d+\.\s*/, '').trim())
              .filter(Boolean);
            if (items.length) {
              todoEmitted = true;
              emitter?.emit('todoList', items);
            }
          }
        }

        // Fallback: detect a markdown numbered list when no <todo> tag was used.
        if (!todoEmitted) {
          const mdItems = extractMarkdownTodoList(clean);
          if (mdItems) {
            todoEmitted = true;
            emitter?.emit('todoList', mdItems);
          }
        }

        // Garbage detection for lite/small models that hallucinate
        const garbageCheck = isGarbageOutput(clean || result.content);
        if (garbageCheck.isGarbage) {
          const fallback = buildFallbackMessage(this.config.model, garbageCheck, this.config.provider);
          emitter?.emit('error', fallback);
          return;
        }

        // If the user asked for actual workspace edits but the model only
        // replied with code/snippets, force one retry with a stricter nudge
        // to use write/edit tools instead of ending the turn.
        if (
          !forcedWorkspaceEditRetry &&
          !this._isLite &&
          this.mode === 'build' &&
          !mutationToolUsed &&
          userLikelyRequestedWorkspaceEdit(userPrompt) &&
          responseLooksLikeUnappliedCode(clean)
        ) {
          this.messages.push({ role: 'assistant', content: result.content });
          this.messages.push({
            role: 'system',
            content: 'The user asked for real workspace changes. Do not stop at prose or code snippets. Read any needed files, then use write/edit tools to create or modify files in the working directory. After the edits, give a brief summary.',
          });
          forcedWorkspaceEditRetry = true;
          continue;
        }

        this.messages.push({ role: 'assistant', content: result.content });

        // Final assistant response
        emitter?.emit('complete', clean);
        this._learnFromTurn(userPrompt, clean).catch(() => {});
        return clean;
      }

    if (result.type === 'tool_calls') {
      this.messages.push(result.message);

      // If a batch includes ask_user, we must still return one tool result
      // for every tool_call_id in the batch. Some providers reject the next
      // turn if any tool call is left unmatched.
      const askUserCall = result.tool_calls.find(tc => tc.function.name === 'ask_user');
      
      if (askUserCall) {
        let args;
        try {
          args = JSON.parse(askUserCall.function.arguments);
          if (typeof args !== 'object' || args === null || Array.isArray(args)) args = {};
        } catch { args = {}; }
        
        emitter?.emit('toolStart', { id: askUserCall.id, name: 'ask_user', args });
        
        const handler = toolHandlers['ask_user'];
        let output;
        if (handler) {
          try { output = await handler(args); }
          catch (e) { output = `Error: ${e.message}`; }
        } else {
          output = `Unknown tool: ask_user`;
        }
        
        emitter?.emit('toolEnd', { id: askUserCall.id, name: 'ask_user', args, output });
        this.messages.push({ role: 'tool', tool_call_id: askUserCall.id, content: String(output) });

        // Any sibling tool calls in the same batch are deferred until after
        // the user answer. We still emit matched tool results for them so the
        // provider history remains valid.
        for (const tc of result.tool_calls) {
          if (tc.id === askUserCall.id) continue;
          const toolName = tc.function?.name || 'unknown';
          const deferred = 'Deferred: skipped because ask_user requires user input before other tool calls in the same batch can safely run.';
          emitter?.emit('toolEnd', { id: tc.id, name: toolName, args: {}, output: deferred });
          this.messages.push({ role: 'tool', tool_call_id: tc.id, content: deferred });
        }
        
        // Continue to next iteration - let the model decide what to do with the answer
        continue;
      }

      // No ask_user in this batch - execute all tools in parallel
      const parsePromises = result.tool_calls.map(async (tc) => {
        const toolName = tc.function.name;
        let args;
        try {
          const raw = tc.function.arguments;
          if (typeof raw !== 'string' || raw.length === 0) throw new Error('empty arguments');
          if (raw.length > 50_000) throw new Error(`arguments too long: ${raw.length} bytes`);
          args = JSON.parse(raw);
          if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('unexpected type');
        } catch (jsonErr) {
          const safeRaw = String(tc.function.arguments ?? '').slice(0, 200);
          const output = `Skipped: malformed JSON — ${jsonErr.message}`;
          emitter?.emit('toolEnd', { id: tc.id, name: toolName, args: {}, output });
          return { id: tc.id, name: toolName, args: {}, output: `Error: malformed tool call JSON (${jsonErr.message}). Raw: ${safeRaw}`, isError: true };
        }
        return { id: tc.id, name: toolName, args, parseError: false };
      });

      const parsed = await Promise.all(parsePromises);
      const validTools = parsed.filter(p => !p.parseError);

      // Fire toolStart for all valid tools immediately
      validTools.forEach(p => emitter?.emit('toolStart', { id: p.id, name: p.name, args: p.args }));

      // Execute handlers in parallel
      const execPromises = validTools.map(async (p) => {
        const handler = toolHandlers[p.name];
        const duplicate = this._shouldSkipDuplicateTool(p.name, p.args);
        if (duplicate) {
          const output = duplicate.reason;
          await this._recordToolExecution(p.name, p.args, output, { skipped: true });
          return { ...p, output, contextOutput: output, skipped: true };
        }

        const cacheKey = await this._cacheKeyForTool(p.name, p.args);
        if (cacheKey && this.toolCache.has(cacheKey)) {
          const cached = this.toolCache.get(cacheKey);
          await this._recordToolExecution(p.name, p.args, cached.contextOutput, { cached: true });
          return {
            ...p,
            output: cached.displayOutput,
            contextOutput: cached.contextOutput,
            cached: true,
          };
        }

        let output;
        if (handler) {
          try { output = await executeToolWithTimeout(p.name, () => handler(p.args)); }
          catch (e) { output = `Error: ${e.message}`; }
        } else {
          output = `Unknown tool: ${p.name}`;
        }
        const contextOutput = this._summarizeToolOutputForContext(p.name, p.args, output);
        const summarized = contextOutput !== String(output);
        if (cacheKey && !String(output).startsWith('Error:')) {
          const chars = String(output).length;
          const lines = this._lineCount(output);
          const hash = this._shortHash(output);
          this.toolCache.set(cacheKey, {
            displayOutput: `Cached read result reused for ${p.args.file_path} (${lines} lines, ${chars} chars)`,
            contextOutput: [
              `[CACHED READ RESULT]`,
              `file: ${p.args.file_path}`,
              `range: offset ${Number(p.args.offset) || 0}, limit ${Number(p.args.limit) || 200}`,
              `lines: ${lines}`,
              `chars: ${chars}`,
              `sha1: ${hash}`,
              `note: this exact read range is already present earlier in the conversation; use that prior content unless a narrower re-read is needed.`,
            ].join('\n'),
          });
        }
        if (p.name === 'write' || p.name === 'edit') {
          mutationToolUsed = true;
          this._invalidateReadCacheForFile(p.args.file_path);
        }
        await this._recordToolExecution(p.name, p.args, output, { summarized });
        return { ...p, output, contextOutput, cached: false };
      });

      const results = await Promise.all(execPromises);

      // Emit results in order
      for (const r of results) {
        emitter?.emit('toolEnd', { id: r.id, name: r.name, args: r.args, output: r.output });
        this.messages.push({ role: 'tool', tool_call_id: r.id, content: String(r.contextOutput ?? r.output) });
      }

      // Handle parse errors in order
      for (const p of parsed) {
        if (p.parseError) {
          this.messages.push({ role: 'tool', tool_call_id: p.id, content: p.output });
        }
      }
      continue;
    }

        break;
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        const reason = controller?.signal?.reason;
        const reasonText = String(reason?.message || reason || '');
        if (/Agent turn timeout/i.test(reasonText)) {
          emitter?.emit('error', reasonText);
        } else {
          emitter?.emit('cancelled');
        }
        return;
      }
      // Strip ANSI escape codes that may leak from provider JSON error bodies
      const stripAnsi = (s) => String(s).replace(/(\x9B|\x1B\[)[0-9;:]*[ -/]*[@-~]/g, '').replace(/\x1B[@-_]/g, '');
      // Translate common provider errors into actionable messages
      let msg = stripAnsi(e.message || String(e));
      const status = e.status || e.statusCode;
      if (status === 429 || /429|rate.?limit|quota/i.test(msg)) {
        msg = 'Rate limit / quota exceeded (HTTP 429). Wait a moment and retry, or check your provider billing/usage.';
      } else if (status === 401 || /401|unauthor/i.test(msg)) {
        msg = 'Authentication failed (HTTP 401). Run /connect to refresh your API key.';
      } else if (status === 400 && /tool/i.test(msg)) {
        msg = `Provider rejected the tool schema: ${msg}`;
      } else if (status === 502 || /502|bad gateway|upstream request failed/i.test(msg)) {
        msg = `Provider gateway error (502) — the upstream model server failed. Retry in a moment. (${msg})`;
      } else if (status === 503 || /503|service unavailable/i.test(msg)) {
        msg = `Provider unavailable (503) — service is temporarily down. Retry in a moment. (${msg})`;
      } else if (status === 504 || /504|gateway timeout/i.test(msg)) {
        msg = `Provider gateway timeout (504) — upstream model took too long. Try a shorter prompt. (${msg})`;
      } else if (/ECONNREFUSED/i.test(msg)) {
        msg = `Connection refused — provider not running or unreachable. (${msg})`;
      } else if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
        msg = `DNS lookup failed — check network or endpoint URL. (${msg})`;
      } else if (/request timed out|ETIMEDOUT|socket hang up|network timeout/i.test(msg)) {
        msg = `Request timed out — the model took too long to respond. Try a faster model or a shorter prompt. (${msg})`;
      } else if (/ECONNRESET/i.test(msg)) {
        msg = `Connection reset by provider — transient error, please retry. (${msg})`;
      }
      emitter?.emit('error', msg);
      return;
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
      setToolAbortSignal(null);
    }

    emitter?.emit('complete', '[Max iterations reached]');
    this._learnFromTurn(userPrompt, '[Max iterations reached]').catch(() => {});
  }

  reset() {
    const system = this.messages[0];
    this.messages = [system];
  }

  setMode(mode) {
    this.mode = mode;
    this._rebuildSystemPrompt();
  }

  // Update working directory mid-session (e.g. after a /cd command).
  // Rebuilds the system prompt with the new path and re-runs memory loading
  // for the new project root.
  setWorkdir(newWorkdir) {
    if (!newWorkdir || newWorkdir === this._workdir) return;
    this._workdir = newWorkdir;
    this._rebuildSystemPrompt();
  }

  _rebuildSystemPrompt() {
    const template = this.mode === 'plan' ? PLAN_SYSTEM_PROMPT : SYSTEM_PROMPT;
    this._systemTemplate = template.replace('{{WORKDIR}}', this._workdir);
    this.messages[0] = { role: 'system', content: this._systemTemplate };
    if (this._isLite) applyLitePrompt(this, this._workdir);
    this._memoryReady = this._loadMemory();
  }
}
