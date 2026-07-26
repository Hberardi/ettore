import { toolHandlers, toolDefinitions, setToolAbortSignal, setAgentTodoSink, validateToolArgs, coerceToolArgsToSchema } from '../tools/index.js';
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
import {
  TODO_BLOCK_RE,
  DONE_MARKER_RE,
  TODO_CAPTURE_RE,
  THINK_OPEN_RE,
  THINK_CLOSE_RE,
  PARTIAL_TAG_OPEN_RE,
  PARTIAL_TAG_CLOSE_RE,
  PARTIAL_TOOL_TAG_RE,
  PARTIAL_FRAMING_RE,
  filterToolCallStream,
  stripMarkers,
  stripThinkTags,
  stripToolCallTags,
  parseTodoBlock,
  extractMarkdownTodoList,
} from './stream-parser.js';
import { parseTextToolCalls } from './text-tool-calls.js';
import { translateProviderError } from './error-translator.js';
import { renderSystemPrompt } from './prompts.js';
import {
  buildTurnOverlay,
  createTurnRecoveryState,
  extractAnnouncement,
  responseAnnouncesUnexecutedAction,
  responseLooksLikeUnappliedCode,
  toolBatchNeedsSequential,
  userLikelyRequestedWorkspaceEdit,
} from './turn-recovery.js';
import { redactSecrets } from '../utils/secrets.js';
import {
  canonicalizeToolTurn,
  repairMessageHistory,
  validateMessageHistory,
} from './message-ledger.js';
import { TurnStateMachine } from './turn-state.js';
import { selectToolDefinitions, selectedToolNames } from './tool-router.js';
import { authorizeToolAccess, normalizeToolArgsForWorkspace } from '../tools/workspace-policy.js';
import { buildVisionContent } from '../utils/images.js';
import { isWebImageResult } from '../tools/web-image.js';

// Increase default max listeners to avoid AbortSignal warnings
EventEmitter.setMaxListeners(20);

const PLAN_TOOLS = toolDefinitions.filter(t =>
  ['read', 'read_pdf', 'read_doc', 'read_server_console', 'repo_map', 'repo_find_symbol', 'browser_check', 'dep_inspect', 'glob', 'grep', 'list_dir', 'file_info', 'git_status', 'git_diff', 'websearch', 'webfetch', 'web_image', 'video_transcript', 'ask_user', 'todo_write'].includes(t.function.name)
);

const LOOP_GUARDED_TOOLS = new Set(['repo_map', 'glob', 'grep', 'list_dir', 'file_info', 'git_status', 'git_diff', 'websearch', 'webfetch', 'web_image']);
const AGENT_TURN_TIMEOUT_MS = 300_000;
// How many times per user turn a text-leaked tool-call blob may be converted
// back into real tool calls before the loop stops covering for the model.
const MAX_TEXT_TOOL_CALL_RECOVERIES = 4;

// Bash commands that count as "verifying" the just-edited files: syntax
// checkers, linters, type-checkers, test runners. The set is intentionally
// broad — a false positive (model runs an unrelated command) just skips the
// extra verify nudge, which is preferable to forcing an extra turn when the
// model already did its diligence.
const VERIFIER_RE = /\b(?:node\s+(?:-c|--check|-e)|python3?\s+(?:-m\s+(?:py_compile|pyflakes|mypy|unittest|pytest)|-c)|tsc\b|--noEmit|eslint\b|prettier\s+(?:--check|-c)\b|ruff\s+(?:check|format)|pylint\b|pyflakes\b|flake8\b|mypy\b|black\s+--check|pytest\b|jest\b|vitest\b|mocha\b|cargo\s+(?:check|test|clippy|build)|rustc\b|go\s+(?:vet|test|build)|npm\s+(?:test|run\s+(?:test|lint|typecheck|build|check|format))|yarn\s+(?:test|lint|typecheck|build)|pnpm\s+(?:test|lint|typecheck|build)|rspec\b|phpstan\b|gcc\s+-fsyntax-only)\b/i;


export function getToolTimeoutMs(name) {
  if (name === 'bash') return 300_000;
  if (name === 'bash_session') return 600_000;
  if (name === 'ask_user') return 0;
  if (name === 'todo_write') return 5_000;
  if (name === 'read' || name === 'write' || name === 'edit' || name === 'file_info' || name === 'memory_write') return 20_000;
  if (name === 'apply_patch_structured') return 30_000;
  if (name === 'run_tests') return 300_000;
  if (name === 'run_checks') return 300_000;
  if (name === 'repo_map') return 120_000;
  if (name === 'repo_find_symbol') return 60_000;
  if (name === 'dev_server') return 120_000;
  if (name === 'browser_check') return 60_000;
  if (name === 'dep_inspect') return 120_000;
  if (name === 'glob' || name === 'grep' || name === 'list_dir' || name === 'git_status' || name === 'git_diff') return 60_000;
  if (name === 'read_pdf' || name === 'read_doc' || name === 'read_server_console' || name === 'websearch' || name === 'webfetch') return 120_000;
  // video_transcript can run a local whisper pass on long audio — give it
  // enough room (matches the 10-minute timeout in the tool itself).
  if (name === 'video_transcript') return 600_000;
  return 60_000;
}

async function executeToolWithTimeout(name, fn) {
  const timeoutMs = getToolTimeoutMs(name);
  if (!timeoutMs) return fn();
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          resolve(`Error: tool "${name}" timed out after ${Math.round(timeoutMs / 1000)}s`);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTransientToolError(output = '') {
  const text = String(output || '');
  if (!/^Error:/i.test(text)) return false;
  return /(timed out|timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network|429|503|rate limit|temporar|try again|Service Unavailable)/i.test(text);
}

// Recognises errors where the provider rejected the tool-call history because
// the model emitted malformed function arguments (unterminated strings, bad
// escapes, surrogates, etc.). Distinct from transient errors because the
// trigger is the model's output, not the network — retrying once with a
// nudge is enough; beyond that the model is unlikely to recover and we
// surface the error.
function isInvalidToolArgsError(err) {
  const msg = String(err?.message || err || '');
  const status = err?.status ?? err?.statusCode;
  // The 2013 code is the OpenAI-compat proxy's tag for "invalid arguments".
  if (status !== 400 && !/400/.test(msg)) return false;
  return /invalid function arguments json string|invalid params.*arguments|tool.?call.*arguments.*invalid|2013/i.test(msg);
}

// Compact one-line rendering of tool arguments for error messages. Values are
// truncated hard — this goes on screen next to a failure, not into a log.
function describeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args);
  if (!entries.length) return '';
  return entries
    .slice(0, 4)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const short = String(text ?? '').replace(/\s+/g, ' ').slice(0, 40);
      return `${key}=${short}${String(text ?? '').length > 40 ? '…' : ''}`;
    })
    .join(', ') + (entries.length > 4 ? ', …' : '');
}

function waitMs(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

// Increase limit for abort signals


export class Agent {
  constructor(client, config, mode = 'build') {
    this.client = client;
    this.config = config;
    this.mode = mode;
    this.messages = [];
    this.maxIterations = 30;
    this.maxReadOnlyToolBatches = Math.max(2, Number(config.maxReadOnlyToolBatches) || 12);
    this.maxToolCallsPerTurn = Number(config.maxToolCallsPerTurn) || 80;
    this.maxToolsPerRequest = Math.max(4, Math.min(28, Number(config.maxToolsPerRequest) || 16));
    this.dynamicToolRouting = config.dynamicToolRouting !== false;
    const configuredSafetyProfile = config.safetyProfile == null
      ? null
      : String(config.safetyProfile).toLowerCase();
    this.safetyProfile = configuredSafetyProfile == null
      ? null
      : ['safe', 'balanced', 'autonomous'].includes(configuredSafetyProfile)
        ? configuredSafetyProfile
        : 'balanced';
    this.debug = config.debug === true;
    this.abortController = null;
    this.toolCache = new Map();
    this.workingMemory = this._createWorkingMemory();
    // Auto-continue: if a turn ends with text but the parsed <todo> plan has
    // unfinished steps, automatically re-prompt the model to finish them.
    // Capped to prevent runaway loops on models that stall mid-plan.
    // Only fires on explicit <todo> blocks — markdown numbered lists (used as
    // a fallback to populate the UI panel) can be plain enumerations the user
    // didn't ask the model to execute.
    this._todoList = [];
    this._todoDoneIdx = new Set();
    this._todoFromBlock = false;
    this._autoContinueCount = 0;
    this.maxAutoContinues = 3;
    // After write/edit, force one extra turn to verify the changes (syntax /
    // lint / test) unless the model already ran a verifier. Opt-out via
    // config.verifyAfterEdit=false (tests use this).
    this.verifyAfterEdit = config.verifyAfterEdit !== false;
    this.cavemanLevel = config.cavemanLevel || null;
    this._pendingTurnOverlay = '';

    const workdir = config.workdir || process.cwd();
    this._systemTemplate = renderSystemPrompt(mode, workdir, {
      cavemanLevel: this.cavemanLevel,
      provider: this.config.provider,
      model: this.config.model,
    });
    this._systemPromptBase = this._systemTemplate;
    this._workdir = workdir;
    this.messages.push({ role: 'system', content: this._systemPromptBase });

    // Degrade to lite prompt only when capability is explicitly 'lite' or
    // the model id matches a known-lite pattern. 'unknown' capability still
    // receives tools — the garbage detector ([[lite.js isGarbageOutput]])
    // catches chat-only models that hallucinate when given tool schemas.
    const explicitCap = String(config.modelCapability || '').toLowerCase();
    this._isLite = mode !== 'plan' && (
      explicitCap === 'lite' ||
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
      this._systemPromptBase = injected;
      this._refreshActiveSystemPrompt();
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
      ledgerRepairs: 0,
      routedTools: [],
      turnState: 'idle',
      stateTransitions: [],
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
    if (name === 'write' || name === 'edit' || name === 'apply_patch_structured') {
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
      ledgerRepairs: wm.ledgerRepairs || 0,
      routedTools: wm.routedTools || [],
      turnState: wm.turnState || 'idle',
      stateTransitions: wm.stateTransitions || [],
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

  _debugLog(emitter, event, payload = {}) {
    if (!this.debug) return;
    const redacted = redactSecrets(JSON.stringify(payload));
    const line = JSON.stringify({ ts: new Date().toISOString(), event, payload: JSON.parse(redacted) });
    emitter?.emit('debug', line);
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
    // Tighter cap than before (was 14k) — the bulk of the session cost comes
    // from accumulating tool results across many turns. Every tool result is
    // sent back to the model on every subsequent turn, so trimming early has
    // multiplicative savings. Trade-off: the agent may need to re-run a tool
    // with a narrower query to see elided middle content.
    const maxChars = 6_000;
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
        `[BEGIN FIRST 60 LINES]`,
        this._firstLines(text, 60),
        `[END FIRST 60 LINES]`,
        ``,
        `[BEGIN LAST 30 LINES]`,
        this._lastLines(text, 30),
        `[END LAST 30 LINES]`,
      ].join('\n');
    }

    if (name === 'repo_map' || name === 'grep' || name === 'glob' || name === 'list_dir') {
      return [
        ...header,
        `note: output was large; preserved first 80 rows only.`,
        ``,
        this._firstLines(text, 80),
        ``,
        `[TRUNCATED: refine the query/path if more detail is needed]`,
      ].join('\n');
    }

    // Generic path: keep head + tail, smaller than before (was 9k+3k).
    return [
      ...header,
      `note: output was large; preserved first and last chunks.`,
      ``,
      `[BEGIN FIRST CHUNK]`,
      text.slice(0, 4000),
      `[END FIRST CHUNK]`,
      ``,
      `[BEGIN LAST CHUNK]`,
      text.slice(-1500),
      `[END LAST CHUNK]`,
    ].join('\n');
  }

  _invalidateReadCacheForFile(filePath) {
    if (!filePath) return;
    for (const key of this.toolCache.keys()) {
      if (key.startsWith(`read|${filePath}|`)) this.toolCache.delete(key);
    }
  }

  // Retry once after the provider rejected a turn because the model emitted
  // a tool call with malformed JSON arguments. The strategy is to:
  //   1. drop the offending tool_calls from the assistant message so the
  //      replayed history is acceptable again
  //   2. push a synthetic "tool" message that records the parse failure,
  //      so the model sees that those calls were rejected
  //   3. nudge the model with a one-shot reminder to emit strict JSON
  //
  // Returns true if the retry succeeded, false if it failed too (caller
  // then surfaces the original error to the user).
  async _retryAfterInvalidToolArgs(originalErr, emitter) {
    try {
      const nudge = '\n\n[system note: the previous turn produced tool calls with malformed JSON arguments. On the next turn, regenerate any needed tool calls as strict JSON with no trailing commas, escaped quotes, and no control characters. If you no longer need to call a tool, answer directly.]';
      // Find the most recent assistant message that contains tool_calls and
      // either drop the bad calls or annotate them. We can't safely mutate
      // tool_call arguments in place because the provider's parser already
      // rejected them — instead we replace each bad tool_call with an empty
      // arguments object so the provider stops complaining and the model
      // can retry on its own.
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          m.tool_calls = m.tool_calls.map((tc) => {
            if (!tc?.function) return tc;
            const raw = typeof tc.function.arguments === 'string' ? tc.function.arguments : '';
            // Heuristic: if the raw args parse OR are empty, leave them.
            if (!raw) return tc;
            try { JSON.parse(raw); return tc; } catch {}
            // Sanitize: coerce to empty arguments object so the provider
            // stops rejecting. A subsequent "tool" message records what
            // happened so the model can see the rejection and re-decide.
            return {
              ...tc,
              function: { ...tc.function, arguments: '{}' },
              __invalidArgs: true,
            };
          });
          break;
        }
      }
      // Append a nudge as the next user message; the model will see it and
      // can re-emit correct tool calls (or just answer).
      this.messages.push({ role: 'user', content: nudge.trim() });
      emitter?.emit('toolProgress', {
        name: 'tool-args-retry',
        key: '',
        message: `Provider rejected tool arguments (${originalErr?.status || 400}). Retrying with strict-JSON nudge.`,
      });
      // Re-run the same turn loop by calling run() recursively is too heavy
      // (resets state); instead just signal the caller to surface success
      // and let the next user prompt trigger a fresh turn. The nudge will
      // sit in history so the model can recover on the next iteration.
      // Note: we deliberately do NOT re-call client.turn() here — that
      // would race with the outer loop. Returning true tells the caller to
      // stop the failed turn cleanly; the nudge waits for the next prompt.
      this._debugLog(emitter, 'turn.tool_args_retry', { status: originalErr?.status });
      return true;
    } catch (retryErr) {
      this._debugLog(emitter, 'turn.tool_args_retry_failed', { error: String(retryErr?.message || retryErr) });
      return false;
    }
  }

  _renderActiveSystemPrompt() {
    const base = this._systemPromptBase || this._systemTemplate || '';
    const overlay = String(this._pendingTurnOverlay || '').trim();
    if (!overlay) return base;
    return `${base}\n\nTURN RECOVERY OVERLAY\n${overlay}`;
  }

  _refreshActiveSystemPrompt() {
    this.messages[0] = { role: 'system', content: this._renderActiveSystemPrompt() };
  }

  _queueNamedTurnOverlay(kind, data = {}) {
    const text = buildTurnOverlay(kind, data);
    this._queueTurnOverlay(text);
  }

  _createTurnRecoveryState() {
    return createTurnRecoveryState();
  }

  _queueTurnOverlay(text) {
    this._pendingTurnOverlay = String(text || '').trim();
    this._refreshActiveSystemPrompt();
  }

  _clearTurnOverlay() {
    if (!this._pendingTurnOverlay) return;
    this._pendingTurnOverlay = '';
    this._refreshActiveSystemPrompt();
  }

  async run(userPrompt, emitter, options = {}) {
    const promptText = String(userPrompt || '');
    const imageAttachments = Array.isArray(options.imageAttachments) ? options.imageAttachments : [];
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
    const workspacePolicy = this.safetyProfile
      ? { root: this._workdir, profile: this.safetyProfile }
      : null;

    const turnMachine = new TurnStateMachine();
    const emitTurnState = (state, metadata = {}) => {
      const transition = turnMachine.transition(state, metadata);
      if (transition.error) {
        this._debugLog(emitter, 'turn.invalid_state_transition', {
          error: transition.error,
          requested: state,
        });
        return false;
      }
      this.workingMemory.turnState = turnMachine.state;
      this.workingMemory.stateTransitions = turnMachine.history.slice(-12);
      if (transition.changed) emitter?.emit('turnState', { state, ...metadata });
      return true;
    };

    const initialLedger = repairMessageHistory(this.messages);
    if (initialLedger.repaired) {
      this.messages = initialLedger.messages;
      this.workingMemory.ledgerRepairs++;
      this._debugLog(emitter, 'ledger.repaired', { phase: 'turn_start', issues: initialLedger.issues });
    }

    this.messages.push({
      role: 'user',
      content: imageAttachments.length ? buildVisionContent(promptText, imageAttachments) : promptText,
    });
    emitTurnState('started');
    this._debugLog(emitter, 'turn.started', { mode: this.mode, provider: this.config.provider, model: this.config.model });
    this._updateWorkingMemoryGoal(promptText);
    // Reset auto-continue state for the new user turn. A fresh user prompt
    // means any prior plan is no longer load-bearing.
    this._todoList = [];
    this._todoDoneIdx = new Set();
    this._todoFromBlock = false;
    this._autoContinueCount = 0;

    let iterations = 0;
    let todoEmitted = false;
    const turnRecoveryState = this._createTurnRecoveryState();
    let mutationToolUsed = false;
    let verificationDone = false;
    let repoMapUsedThisTurn = false;
    let toolCallCount = 0;
    let readOnlyToolBatchCount = 0;
    let forceTextOnlyNextTurn = false;
    // Tool calls the model printed as text instead of emitting natively. Capped
    // so a model that only ever leaks XML cannot spin the loop forever.
    let textToolCallRecoveries = 0;
    let textToolCallNudgeUsed = false;
    // Progress fingerprint from the last auto-continue, so a retry that
    // changed nothing can be told apart from one that made headway.
    let lastAutoContinueProgress = null;
    let autoContinueStallNudgeUsed = false;
    const touchedFiles = new Set();
    // `parseBuffer` accumulates all text for <todo>/<done:N> parsing across chunks.
    // `emitBuffer` holds text that is safe to display (i.e. past any partial marker).
    let parseBuffer = '';
    let emitBuffer = '';
    // Set once the model starts printing tool-call protocol as visible text;
    // suppresses the rest of the turn's display output. Reset per turn.
    let inToolLeak = false;
    // State for suppressing <think>...</think> blocks (DeepSeek R1, Qwen3, etc.)
    let inThink = false;
    let pendingThinkClose = '';

    // Sink that lets the todo_write tool update agent + UI state in lockstep.
    // Mirrors the same writes the <todo>/<done:N> parser would do, so the
    // auto-continue logic and the progress panel both react identically
    // regardless of whether the plan came from a tool call or from tagged text.
    const todoSink = {
      setList: (items) => {
        this._todoList = items.slice();
        this._todoDoneIdx = new Set();
        this._todoFromBlock = true;
        todoEmitted = true;
        emitter?.emit('todoList', items.slice());
      },
      append: (items) => {
        const before = this._todoList.length;
        this._todoList = [...this._todoList, ...items];
        this._todoFromBlock = true;
        todoEmitted = true;
        emitter?.emit('todoList', this._todoList.slice());
        return { added: this._todoList.length - before };
      },
      markDone: (idx) => {
        const size = this._todoList.length;
        if (idx < 0 || idx >= size) return { outOfRange: true, size };
        if (!this._todoDoneIdx.has(idx)) {
          this._todoDoneIdx.add(idx);
          emitter?.emit('todoDone', idx);
        }
        return { remaining: size - this._todoDoneIdx.size };
      },
    };
    setAgentTodoSink(todoSink);

    // Emit as much of `emitBuffer` as is safe — we hold back only the
    // incomplete control tags that this parser knows how to suppress.
    const flushSafe = () => {
      if (!emitBuffer) return;
      // Keep the last few bytes only when they could still grow into a
      // supported control tag (<think>, <todo>, <done:N>).
      const holdBack = PARTIAL_TAG_OPEN_RE.test(emitBuffer)
        || PARTIAL_TAG_CLOSE_RE.test(emitBuffer)
        || PARTIAL_TOOL_TAG_RE.test(emitBuffer)
        || PARTIAL_FRAMING_RE.test(emitBuffer);
      if (holdBack) return;
      // Emit everything else immediately
      const chunk = emitBuffer;
      emitBuffer = '';
      if (chunk) emitter?.emit('token', chunk);
    };

    // Emit current token count so the UI can show it
    emitter?.emit('tokenCount', estimateTokens(this.messages));

    try {
      while (iterations < this.maxIterations) {
        iterations++;
        if (iterations === this.maxIterations && !forceTextOnlyNextTurn) {
          forceTextOnlyNextTurn = true;
          this._queueNamedTurnOverlay('tool_loop_finalize', { reason: 'the maximum iteration budget is about to be exhausted' });
        }
        this._debugLog(emitter, 'turn.iteration', { iterations, maxIterations: this.maxIterations, messageCount: this.messages.length });
        this._refreshActiveSystemPrompt();

        const toolRouteContext = {
          mode: this.mode,
          prompt: promptText,
          overlay: this._pendingTurnOverlay,
          isLite: this._isLite,
          mutationToolUsed,
          touchedFiles: touchedFiles.size,
          verificationNeeded: mutationToolUsed && !verificationDone,
          maxTools: this.maxToolsPerRequest,
        };
        const tools = forceTextOnlyNextTurn || this._isLite
          ? []
          : this.dynamicToolRouting
            ? selectToolDefinitions(toolDefinitions, toolRouteContext)
            : this.mode === 'plan' ? PLAN_TOOLS : toolDefinitions;
        this.workingMemory.routedTools = selectedToolNames(tools);
        emitter?.emit('toolRoute', {
          count: tools.length,
          names: this.workingMemory.routedTools,
          dynamic: this.dynamicToolRouting,
        });
        this._debugLog(emitter, 'turn.tools_routed', {
          count: tools.length,
          names: this.workingMemory.routedTools,
        });

        // Cheap lossy shrink first: zero-LLM cost, kicks in at half threshold
        // to keep the LLM-driven compressor as a backstop rather than a
        // first resort. Cuts the bulk of accumulated tool results while
        // preserving a hint of each one's content.
        if (this.compressor.autoEnabled) {
          const shrunken = this.compressor.lossyShrink(this.messages);
          if (shrunken !== this.messages) {
            this.messages = shrunken;
            emitter?.emit('tokenCount', estimateTokens(this.messages));
          }
        }

        // Auto-compress context when it exceeds the dynamic threshold (~30% of
        // context window).  Runs every iteration so mid-turn growth from tool
        // results is caught, not just the pre-loop snapshot.
        if (this.compressor.autoEnabled && this.compressor.needsCompression(this.messages)) {
          this.messages = await this.compressor.compress(this.messages, emitter);
          emitter?.emit('tokenCount', estimateTokens(this.messages));
        }

        // Hard pre-turn guard: never hit provider with an overgrown context.
        // Skip the token estimation entirely when no hard limit is configured.
        const hardLimit = this.compressor.getHardGuardLimit(
          this.contextWindow,
          Number(this.config.maxTokens) || 8192,
        );
        if (hardLimit) {
          const currentTokens = estimateTokens(this.messages, tools);
          if (currentTokens > hardLimit) {
            this.messages = await this.compressor.compress(this.messages, emitter);
            const afterTokens = estimateTokens(this.messages, tools);
            emitter?.emit('tokenCount', afterTokens);
            if (afterTokens > hardLimit) {
              emitter?.emit(
                'error',
                `Context too large (~${afterTokens} tokens, limit ~${hardLimit}). Run /compress apply or switch to a larger-context model.`
              );
              emitTurnState('failed', { reason: 'context_limit' });
              return;
            }
          }
        }

        const signal = controller.signal;

        const onToken = (text) => {
          parseBuffer += text;
          emitBuffer += text;
          if (inThink && pendingThinkClose) {
            emitBuffer = pendingThinkClose + emitBuffer;
            pendingThinkClose = '';
          }

          // ── Think-tag filtering (DeepSeek R1, Qwen3, QwQ, MiniMax M2.7, etc.) ──
          // Handles <think>, <thinking>, <reasoning> — all variants.
          // Tag may be split across multiple streaming chunks.
          // Emits thinkStart / thinkToken / thinkEnd events for UI indicator.
          if (!inThink) {
            const thinkOpenMatch = emitBuffer.match(THINK_OPEN_RE);
            if (thinkOpenMatch) {
              const openIdx = emitBuffer.indexOf(thinkOpenMatch[0]);
              const before = emitBuffer.slice(0, openIdx);
              const after  = emitBuffer.slice(openIdx + thinkOpenMatch[0].length);
              inThink = true;
              emitter?.emit('thinkStart');
              // Check if close tag is in the same chunk (rare but possible)
              const closeMatch = after.match(THINK_CLOSE_RE);
              if (closeMatch) {
                const closeEnd = after.indexOf(closeMatch[0]) + closeMatch[0].length;
                emitBuffer = before + after.slice(closeEnd);
                inThink = false;
                emitter?.emit('thinkEnd');
              } else {
                const partialClose = after.match(PARTIAL_TAG_CLOSE_RE);
                const holdFrom = partialClose?.index ?? after.length;
                emitBuffer = before;
                pendingThinkClose = after.slice(holdFrom);
                const thinkContent = after.slice(0, holdFrom);
                if (thinkContent) emitter?.emit('thinkToken', thinkContent);
              }
            }
          } else {
            const closeMatch = emitBuffer.match(THINK_CLOSE_RE);
            if (closeMatch) {
              const closeEnd = emitBuffer.indexOf(closeMatch[0]) + closeMatch[0].length;
              // Emit thinking content before the closing tag
              const thinkContent = emitBuffer.slice(0, emitBuffer.indexOf(closeMatch[0]));
              if (thinkContent) emitter?.emit('thinkToken', thinkContent);
              emitBuffer = emitBuffer.slice(closeEnd);
              inThink = false;
              emitter?.emit('thinkEnd');
            } else {
              // Preserve a trailing partial tag such as "<" or "</thi"
              // until the next chunk. Consuming it as reasoning would make a
              // split </think> impossible to recognize on the next token.
              const partialClose = emitBuffer.match(PARTIAL_TAG_CLOSE_RE);
              const holdFrom = partialClose?.index ?? emitBuffer.length;
              const thinkContent = emitBuffer.slice(0, holdFrom);
              if (thinkContent) emitter?.emit('thinkToken', thinkContent);
              pendingThinkClose = emitBuffer.slice(holdFrom);
              emitBuffer = '';
            }
          }
          // ── End think-tag filtering ─────────────────────────────────────────

          // Some providers emit a raw closing tag in visible content after
          // sending reasoning through a dedicated reasoning_content field.
          // Treat standalone reasoning tags as protocol markers, not text.
          if (!inThink) {
            emitBuffer = stripThinkTags(emitBuffer);
            // Strip leaked tool-call protocol fragments (e.g. `<tool_call>`,
            // `<invoke name="…">`, `<function_calls>`) that some models emit
            // as raw text instead of structured tool_calls deltas. Without
            // this, the user sees lines like `]<]minimax>[<tool_call>` mixed
            // in with the real response.
            //
            // Stripping complete tags is not enough on its own: the blob's
            // *inner* tags are the tool's own parameter names (`<command>`,
            // `<file_path>`), which no fixed list can cover. So an unclosed
            // opener also suppresses display until its closing tag arrives in
            // a later chunk. The raw content still reaches parseTextToolCalls
            // below, which turns the blob back into real tool calls.
            const filtered = filterToolCallStream(emitBuffer, inToolLeak);
            emitBuffer = filtered.text;
            inToolLeak = filtered.inLeak;
            parseBuffer = stripToolCallTags(parseBuffer);
          }

          // Parse <todo>...</todo> block from first response.
          // Tolerant of whitespace, case, and self-closing variants.
          if (!todoEmitted) {
            const match = parseBuffer.match(TODO_CAPTURE_RE);
            if (match) {
              const items = parseTodoBlock(match[1]);
              if (items.length) {
                this._todoList = items;
                this._todoDoneIdx = new Set();
                this._todoFromBlock = true;
                todoEmitted = true;
                emitter?.emit('todoList', items);
              }
              parseBuffer = parseBuffer.replace(TODO_BLOCK_RE, '');
              emitBuffer  = emitBuffer.replace(TODO_BLOCK_RE, '');
            }
          }

          // Parse <done:N> markers — tolerant of whitespace, case, and self-closing.
          // Handles: <done:1>, <done : 1>, <DONE:1/>, <done:1 />
          const doneMatches = [...parseBuffer.matchAll(DONE_MARKER_RE)];
          if (doneMatches.length) {
            for (const m of doneMatches) {
              const n = parseInt(m[0].match(/\d+/)[0], 10);
              this._todoDoneIdx.add(n - 1);
              emitter?.emit('todoDone', n - 1);
            }
            parseBuffer = parseBuffer.replace(DONE_MARKER_RE, '');
            emitBuffer  = emitBuffer.replace(DONE_MARKER_RE, '');
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
          const ledger = repairMessageHistory(this.messages);
          if (ledger.repaired) {
            this.messages = ledger.messages;
            this.workingMemory.ledgerRepairs++;
            this._debugLog(emitter, 'ledger.repaired', {
              phase: 'before_provider',
              issues: ledger.issues,
            });
          }
          const validation = validateMessageHistory(this.messages);
          if (!validation.valid) {
            throw new Error(`Internal message ledger invalid: ${JSON.stringify(validation.issues).slice(0, 1000)}`);
          }
          emitTurnState('model', { iteration: iterations });
          result = await Promise.race([
            this.client.turn(this.messages, tools, onToken, signal),
            turnTimeout,
          ]);
        } finally {
          this._clearTurnOverlay();
          if (turnTimer) clearTimeout(turnTimer);
        }

        // Emit real usage (or estimate) for cost/ctx tracking
        if (result.usage) {
          emitter?.emit('usage', result.usage);
        } else {
          // Fallback: estimate from message history
          const estTokens = estimateTokens(this.messages, tools);
          emitter?.emit('tokenCount', estTokens);
        }

        // Flush any remaining buffered content (stripped of markers) for next turn
        if (emitBuffer) {
          const finalChunk = inThink || inToolLeak
            ? '' // discard unclosed think block / leaked tool-call protocol
            : stripMarkers(stripToolCallTags(emitBuffer));
          if (finalChunk) emitter?.emit('token', finalChunk);
          emitBuffer = '';
        }
        // Reset think state between turns (handles unclosed tags on abort / max_tokens)
        inThink = false;
        inToolLeak = false;
        pendingThinkClose = '';
        parseBuffer = '';

        // ── Text-leaked tool calls ─────────────────────────────────────────
        // MiniMax M2.x/M3 sometimes ship their XML tool-call protocol as
        // assistant *content* instead of as structured tool_calls deltas.
        // The turn then ends with no tool run and no error, and the CLI looks
        // frozen mid-task while the model believes it already called the tool.
        // Parse the leaked blob back into real calls and re-enter the normal
        // tool path; if nothing parses, nudge the model onto the native API.
        if (result.type === 'text' && !forceTextOnlyNextTurn && !this._isLite) {
          const leaked = parseTextToolCalls(result.content);
          // Only calls whose arguments actually satisfy the tool schema are
          // worth replaying. A half-parsed blob would otherwise reach the
          // executor as an empty-args call, trip the invalid-tool-call circuit
          // breaker, and blame the model for what this parser got wrong.
          const usable = leaked.calls.filter(tc => {
            let args;
            try { args = JSON.parse(tc.function.arguments); } catch { return false; }
            // Judge the call the same way the executor will, coercion included,
            // or a recoverable call gets thrown away here for a type the
            // executor would have fixed anyway.
            return validateToolArgs(tc.function.name, coerceToolArgsToSchema(tc.function.name, args)).valid;
          });
          if (usable.length && textToolCallRecoveries < MAX_TEXT_TOOL_CALL_RECOVERIES) {
            textToolCallRecoveries++;
            emitter?.emit('loopRecovery', { reason: 'text_tool_call_recovery', iteration: iterations });
            this._debugLog(emitter, 'turn.text_tool_call_recovery', {
              attempt: textToolCallRecoveries,
              calls: usable.map(tc => tc.function.name),
              dropped: leaked.calls.length - usable.length,
            });
            result = {
              type: 'tool_calls',
              tool_calls: usable,
              message: { role: 'assistant', content: stripMarkers(stripToolCallTags(leaked.text)) },
              usage: result.usage,
            };
          } else if (leaked.detected && !textToolCallNudgeUsed) {
            textToolCallNudgeUsed = true;
            this._debugLog(emitter, 'turn.text_tool_call_nudge', {
              recoveries: textToolCallRecoveries,
              parsed: leaked.calls.map(tc => tc.function.name),
              unusable: leaked.calls.length,
            });
            this._queueNamedTurnOverlay('native_tool_calls');
            continue;
          }
        }

      if (result.type === 'text') {
        const clean = stripMarkers(result.content);

        // Parse todo list from final result if not already parsed during streaming
        if (!todoEmitted) {
          const todoMatch = result.content.match(TODO_CAPTURE_RE);
          if (todoMatch) {
            const items = parseTodoBlock(todoMatch[1]);
            if (items.length) {
              this._todoList = items;
              this._todoDoneIdx = new Set();
              this._todoFromBlock = true;
              todoEmitted = true;
              emitter?.emit('todoList', items);
            }
          }
        }

        // Pick up any <done:N> markers from the final content too — covers the
        // non-streaming code path where onToken never fires.
        if (this._todoFromBlock) {
          const doneMatches = [...String(result.content || '').matchAll(DONE_MARKER_RE)];
          for (const m of doneMatches) {
            const n = parseInt(m[0].match(/\d+/)[0], 10);
            if (!this._todoDoneIdx.has(n - 1)) {
              this._todoDoneIdx.add(n - 1);
              emitter?.emit('todoDone', n - 1);
            }
          }
        }

        // Fallback: detect a markdown numbered list when no <todo> tag was used.
        // Populates the UI panel only — does NOT trigger auto-continue, since a
        // bare numbered list may just be a plain enumeration, not a plan.
        if (!todoEmitted) {
          const mdItems = extractMarkdownTodoList(clean);
          if (mdItems) {
            this._todoList = mdItems;
            this._todoDoneIdx = new Set();
            todoEmitted = true;
            emitter?.emit('todoList', mdItems);
          }
        }

        // Garbage detection for lite/small models that hallucinate
        const garbageCheck = isGarbageOutput(clean || result.content);
        if (garbageCheck.isGarbage) {
          const fallback = buildFallbackMessage(this.config.model, garbageCheck, this.config.provider);
          emitter?.emit('error', fallback);
          emitTurnState('failed', { reason: 'garbage_output' });
          return;
        }

        // Force one retry with a stricter nudge when the turn ends without
        // any mutation tool call but the response clearly should have been
        // backed by one. Two distinct stall shapes are caught:
        //   - Code-snippet stall: user asked for edits and the model replied
        //     with a snippet/prose instead of using write/edit.
        //   - Announcement stall: the model itself declared an action
        //     ("Piano:", "Prossimo passo: scrivo X", "Ora creo Y") but never
        //     invoked the tool — its own intent is enough to justify a retry,
        //     even if the latest user prompt is just "continua" / "ok".
        const stalledOnAnnouncement = !this._isLite
          && this.mode === 'build'
          && !mutationToolUsed
          && (
            (userLikelyRequestedWorkspaceEdit(promptText) && responseLooksLikeUnappliedCode(clean)) ||
            responseAnnouncesUnexecutedAction(clean)
          );
        if (stalledOnAnnouncement) {
          // One retry was not enough: a model that narrates instead of acting
          // narrates again, and every announcement after the first one used to
          // end the turn in silence. Retry twice, escalating the second time,
          // and treat "ran tools since the last retry" as progress worth
          // another attempt rather than a loop to break.
          const progressKey = `${toolCallCount}:${touchedFiles.size}`;
          const repeated = turnRecoveryState.lastWorkspaceEditProgress === progressKey;
          if (turnRecoveryState.workspaceEditRetries < turnRecoveryState.maxWorkspaceEditRetries) {
            this.messages.push({ role: 'assistant', content: result.content });
            turnRecoveryState.workspaceEditRetries++;
            turnRecoveryState.lastWorkspaceEditProgress = progressKey;
            if (turnRecoveryState.workspaceEditRetries > 1 || repeated) {
              this._queueNamedTurnOverlay('workspace_edit_retry_hard', {
                announcement: extractAnnouncement(clean),
              });
            } else {
              this._queueNamedTurnOverlay('workspace_edit_retry');
            }
            this._debugLog(emitter, 'turn.workspace_edit_retry', {
              attempt: turnRecoveryState.workspaceEditRetries,
              repeated,
              progressKey,
            });
            continue;
          }

          // Out of retries and still narrating. Ending here is right; ending
          // without a word is what makes the CLI look frozen on "Prossimo
          // passo: …".
          emitter?.emit('announcementStall', {
            attempts: turnRecoveryState.workspaceEditRetries,
            announcement: extractAnnouncement(clean),
          });
          this._debugLog(emitter, 'turn.announcement_stall', {
            attempts: turnRecoveryState.workspaceEditRetries,
          });
        }

        // Force one extra turn to debug/verify when files were modified but
        // no verifier ran. Catches the common stall where the model writes a
        // file and immediately reports success without checking syntax/lint
        // /tests. Capped at one retry per turn to avoid runaway loops.
        if (
          !turnRecoveryState.verifyRetryUsed &&
          this.verifyAfterEdit &&
          !this._isLite &&
          this.mode === 'build' &&
          mutationToolUsed &&
          !verificationDone &&
          touchedFiles.size > 0
        ) {
          this.messages.push({ role: 'assistant', content: result.content });
          const touched = [...touchedFiles].slice(0, 6).join(', ');
          this._queueNamedTurnOverlay('verify_after_edit', {
            touchedCount: touchedFiles.size,
            touchedList: touched,
          });
          turnRecoveryState.verifyRetryUsed = true;
          continue;
        }

        this.messages.push({ role: 'assistant', content: result.content });

        // Auto-continue: if the model ended a turn with unfinished steps in
        // its declared <todo> plan, re-prompt it to keep going instead of
        // returning control to the user. Capped at maxAutoContinues per turn.
        const pendingTodos = this._todoList
          .map((text, i) => ({ text, i }))
          .filter(({ i }) => !this._todoDoneIdx.has(i));
        const autoContinueEligible = pendingTodos.length > 0
          && this._todoFromBlock
          && this.mode === 'build';
        if (autoContinueEligible) {
          // Repeating the same overlay against an unchanged state just burns
          // turns: the model that ignored it once ignores it again. A step
          // marked done, a file touched, or a tool run all count as progress —
          // models that work but never emit <done:N> still move this key.
          const progressKey = `${this._todoDoneIdx.size}:${touchedFiles.size}:${toolCallCount}`;
          const stalled = lastAutoContinueProgress === progressKey;
          const pendingLines = pendingTodos.map(({ text, i }) => `${i + 1}. ${text}`).join('\n');
          if (
            this._autoContinueCount < this.maxAutoContinues
            && !(stalled && autoContinueStallNudgeUsed)
          ) {
            this._autoContinueCount++;
            lastAutoContinueProgress = progressKey;
            if (stalled) {
              autoContinueStallNudgeUsed = true;
              this._queueNamedTurnOverlay('auto_continue_stalled', { pendingLines });
            } else {
              this._queueNamedTurnOverlay('auto_continue', {
                attempt: this._autoContinueCount,
                max: this.maxAutoContinues,
                pendingLines,
              });
            }
            emitter?.emit('autoContinue', {
              attempt: this._autoContinueCount,
              max: this.maxAutoContinues,
              remaining: pendingTodos.length,
              stalled,
            });
            this._debugLog(emitter, 'turn.auto_continue', {
              attempt: this._autoContinueCount,
              stalled,
              progressKey,
            });
            continue;
          }

          // Out of attempts, or stuck with nothing changing. Ending here is
          // correct, but ending *silently* is what makes the CLI look frozen:
          // the last thing on screen is the model announcing work it never did.
          emitter?.emit('autoContinueExhausted', {
            reason: stalled ? 'no_progress' : 'max_attempts',
            remaining: pendingTodos.length,
            attempts: this._autoContinueCount,
            pending: pendingTodos.map(({ text, i }) => `${i + 1}. ${text}`),
          });
          this._debugLog(emitter, 'turn.auto_continue_exhausted', {
            reason: stalled ? 'no_progress' : 'max_attempts',
            remaining: pendingTodos.length,
            attempts: this._autoContinueCount,
          });
        }

        // Final assistant response
        emitter?.emit('complete', clean);
        emitTurnState('completed');
        this._debugLog(emitter, 'turn.completed', {
          iterations,
          toolCallCount,
          touchedFiles: [...touchedFiles],
          verificationDone,
        });
        this._learnFromTurn(promptText, clean).catch(() => {});
        return clean;
      }

    if (result.type === 'tool_calls') {
      const canonical = canonicalizeToolTurn(result);
      if (!canonical.calls.length) {
        emitter?.emit('error', 'Provider returned a tool-call turn without any valid tool calls.');
        emitTurnState('failed', { reason: 'empty_tool_call_turn' });
        return;
      }
      if (canonical.issues.length) {
        this._debugLog(emitter, 'ledger.canonicalized_tool_turn', { issues: canonical.issues });
      }
      result = {
        ...result,
        tool_calls: canonical.calls,
        message: canonical.message,
      };
      const callNames = result.tool_calls.map(tc => tc.function?.name || 'unknown');
      const explorationBatch = callNames.some(name => ['glob', 'grep', 'list_dir', 'file_info'].includes(name));
      const hasRepoMapInBatch = callNames.includes('repo_map');
      if (explorationBatch && !hasRepoMapInBatch && !repoMapUsedThisTurn && !turnRecoveryState.repoMapNudgeUsed) {
        // The batch is intentionally rejected, so do not persist its assistant
        // tool_calls. Replaying them without matching tool results makes strict
        // providers such as MiniMax reject the next request with error 2013.
        this._queueNamedTurnOverlay('repo_map_first');
        turnRecoveryState.repoMapNudgeUsed = true;
        this._debugLog(emitter, 'turn.repo_map_nudge', { callNames });
        continue;
      }
      if (toolCallCount + result.tool_calls.length > this.maxToolCallsPerTurn) {
        const limit = this.maxToolCallsPerTurn;
        const attempted = toolCallCount + result.tool_calls.length;
        const callSummary = callNames.join(', ');
        emitter?.emit('error',
          `Tool-call limit reached for this turn (${limit}). The model tried to issue ${attempted} tool-calls in a single turn: [${callSummary}]. ` +
          `This usually means the model is stuck in a loop or the task is large enough to need more headroom. ` +
          `Raise the limit by adding "maxToolCallsPerTurn": ${limit * 2} to .ettore/config.json, or split the task into smaller turns.`
        );
        emitTurnState('failed', { reason: 'tool_call_limit' });
        this._debugLog(emitter, 'turn.failed', {
          reason: 'tool_call_limit',
          limit,
          attempted,
          callNames,
        });
        return;
      }
      toolCallCount += result.tool_calls.length;
      emitTurnState('tool_call', { tools: callNames });
      this._debugLog(emitter, 'turn.tool_calls', {
        batchSize: result.tool_calls.length,
        total: toolCallCount,
        names: callNames,
      });
      this.messages.push(result.message);

      // If a batch includes ask_user, we must still return one tool result
      // for every tool_call_id in the batch. Some providers reject the next
      // turn if any tool call is left unmatched.
      const askUserCall = result.tool_calls.find(tc => tc.function.name === 'ask_user');
      
      if (askUserCall) {
        let askUserArgs;
        try {
          askUserArgs = JSON.parse(askUserCall.function.arguments);
          if (typeof askUserArgs !== 'object' || askUserArgs === null || Array.isArray(askUserArgs)) askUserArgs = {};
        } catch { askUserArgs = {}; }

        emitter?.emit('toolStart', { id: askUserCall.id, name: 'ask_user', args: askUserArgs });

        const handler = toolHandlers['ask_user'];
        let askUserOutput;
        if (handler) {
          try { askUserOutput = await handler(askUserArgs); }
          catch (e) { askUserOutput = `Error: ${e.message}`; }
        } else {
          askUserOutput = 'Unknown tool: ask_user';
        }

        // Preserve the exact tool_call order when appending tool results.
        // Providers such as MiniMax reject histories where a tool result does
        // not immediately correspond to the next tool_call in the batch.
        for (const tc of result.tool_calls) {
          const toolName = tc.function?.name || 'unknown';
          if (tc.id === askUserCall.id) {
            emitter?.emit('toolEnd', { id: tc.id, name: 'ask_user', args: askUserArgs, output: askUserOutput });
            this.messages.push({ role: 'tool', tool_call_id: tc.id, content: String(askUserOutput) });
            continue;
          }
          const deferred = 'Deferred: skipped because ask_user requires user input before other tool calls in the same batch can safely run.';
          emitter?.emit('toolEnd', { id: tc.id, name: toolName, args: {}, output: deferred });
          this.messages.push({ role: 'tool', tool_call_id: tc.id, content: deferred });
        }
        emitTurnState('tool_result');

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
          // Models routinely get the JSON scalar type wrong while getting the
          // value right — MiniMax sends {"offset":"5020"} for a number field.
          // Fix the type here rather than rejecting an otherwise valid call.
          args = coerceToolArgsToSchema(toolName, args);
          args = normalizeToolArgsForWorkspace(toolName, args, workspacePolicy);
        } catch (jsonErr) {
          const safeRaw = String(tc.function.arguments ?? '').slice(0, 200);
          const output = `Skipped: malformed JSON — ${jsonErr.message}`;
          emitter?.emit('toolEnd', { id: tc.id, name: toolName, args: {}, output });
          return { id: tc.id, name: toolName, args: {}, output: `Error: malformed tool call JSON (${jsonErr.message}). Raw: ${safeRaw}`, parseError: true };
        }
        return { id: tc.id, name: toolName, args, parseError: false };
      });

      const parsed = await Promise.all(parsePromises);
      const validTools = parsed.filter(p => !p.parseError);

      // Fire toolStart for all valid tools immediately
      validTools.forEach(p => emitter?.emit('toolStart', { id: p.id, name: p.name, args: p.args }));

      const executeParsedTool = async (p) => {
        const handler = toolHandlers[p.name];

        // Pre-flight schema validation: catch tool_use blocks emitted with
        // missing/empty required args (seen with MiniMax M2.7 calling
        // read/write/edit with input={}). Returns an actionable error so the
        // model can recover instead of receiving a cryptic Node.js stack.
        const validation = validateToolArgs(p.name, p.args);
        if (!validation.valid) {
          const output = validation.error;
          await this._recordToolExecution(p.name, p.args, output, { skipped: true });
          return { ...p, output, contextOutput: output, skipped: true, invalid: true };
        }

        const access = await authorizeToolAccess(p.name, p.args, workspacePolicy);
        if (!access.allowed) {
          const output = `Error: ${access.error}`;
          await this._recordToolExecution(p.name, p.args, output, { skipped: true });
          return { ...p, output, contextOutput: output, skipped: true, policyDenied: true };
        }

        const duplicate = this._shouldSkipDuplicateTool(p.name, p.args);
        if (duplicate) {
          const output = duplicate.reason;
          await this._recordToolExecution(p.name, p.args, output, { skipped: true });
          return { ...p, output, contextOutput: output, skipped: true, duplicate: true };
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
        let imageAttachment = null;
        let retries = 0;
        if (handler) {
          try {
            output = await executeToolWithTimeout(p.name, () => handler(p.args));
            if (isTransientToolError(output)) {
              const maxRetries = 2;
              for (let attempt = 1; attempt <= maxRetries; attempt++) {
                retries = attempt;
                const backoffMs = Math.min(3000, 700 * (2 ** (attempt - 1)));
                emitter?.emit('toolProgress', {
                  name: p.name,
                  key: p.args?.file_path || p.args?.command || '',
                  message: `Transient error, retry ${attempt}/${maxRetries} in ${Math.round(backoffMs / 1000)}s`,
                });
                await waitMs(backoffMs);
                output = await executeToolWithTimeout(p.name, () => handler(p.args));
                if (!isTransientToolError(output)) break;
              }
            }
          } catch (e) {
            output = `Error: ${e.message}`;
          }
        } else {
          output = `Unknown tool: ${p.name}`;
        }
        if (isWebImageResult(output)) {
          imageAttachment = { ...output.attachment, sourceUrl: output.sourceUrl };
          output = output.message;
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
        if (p.name === 'write' || p.name === 'edit' || p.name === 'apply_patch_structured') {
          mutationToolUsed = true;
          touchedFiles.add(p.args.file_path);
          this._invalidateReadCacheForFile(p.args.file_path);
        }
        // Treat as verification only when a real checker/tester ran. A read of
        // the touched file is useful inspection, but it is not verification.
        // Skip outputs starting with "Error:" — a verifier that failed to
        // launch isn't a real check.
        const looksLikeError = String(output || '').startsWith('Error:');
        if (!looksLikeError) {
          if (p.name === 'run_checks' || p.name === 'run_tests') {
            verificationDone = true;
          }
          if ((p.name === 'bash' || p.name === 'bash_session') && VERIFIER_RE.test(String(p.args.command || ''))) {
            verificationDone = true;
          }
        }
        await this._recordToolExecution(p.name, p.args, output, { summarized });
        if (p.name === 'repo_map') repoMapUsedThisTurn = true;
        this._debugLog(emitter, 'tool.executed', {
          name: p.name,
          retries,
          cached: false,
          summarized,
          outputPreview: String(output).slice(0, 240),
        });
        return { ...p, output, contextOutput, imageAttachment, cached: false };
      };

      const workspaceRevisionBeforeBatch = this.workingMemory.workspaceRevision;
      const runSequentially = toolBatchNeedsSequential(validTools);
      const results = runSequentially
        ? await (async () => {
            const ordered = [];
            for (const p of validTools) ordered.push(await executeParsedTool(p));
            return ordered;
          })()
        : await Promise.all(validTools.map(executeParsedTool));

      const resultById = new Map(results.map(r => [r.id, r]));
      const parsedById = new Map(parsed.map(p => [p.id, p]));

      // Emit tool results in the exact order returned by the model.
      for (const tc of result.tool_calls) {
        const parsedCall = parsedById.get(tc.id);
        if (!parsedCall) continue;
        if (parsedCall.parseError) {
          this.messages.push({ role: 'tool', tool_call_id: parsedCall.id, content: parsedCall.output });
          continue;
        }
        const r = resultById.get(tc.id);
        if (!r) continue;
        emitter?.emit('toolEnd', { id: r.id, name: r.name, args: r.args, output: r.output });
        this.messages.push({ role: 'tool', tool_call_id: r.id, content: String(r.contextOutput ?? r.output) });
      }
      const fetchedImages = results.map(r => r.imageAttachment).filter(Boolean).slice(0, 4);
      if (fetchedImages.length) {
        const sources = fetchedImages.map(image => `- ${image.name}: ${image.sourceUrl}`).join('\n');
        this.messages.push({
          role: 'user',
          content: buildVisionContent(`Images fetched by web_image. Analyze their visual content and continue the task.\nSources:\n${sources}`, fetchedImages),
        });
      }
      emitTurnState('tool_result');

      const duplicateOnlyBatch = results.length > 0 && results.every(r => r.duplicate);
      if (duplicateOnlyBatch) {
        forceTextOnlyNextTurn = true;
        this._queueNamedTurnOverlay('tool_loop_finalize', { reason: 'the last batch repeated tool calls whose results are already available' });
        emitter?.emit('loopRecovery', { reason: 'duplicate_tools', iteration: iterations });
      } else if (this.workingMemory.workspaceRevision === workspaceRevisionBeforeBatch) {
        readOnlyToolBatchCount++;
        if (readOnlyToolBatchCount >= this.maxReadOnlyToolBatches) {
          forceTextOnlyNextTurn = true;
          this._queueNamedTurnOverlay('tool_loop_finalize', { reason: `${readOnlyToolBatchCount} consecutive read-only tool batches have already run` });
          emitter?.emit('loopRecovery', { reason: 'read_only_limit', iteration: iterations });
        }
      } else {
        readOnlyToolBatchCount = 0;
      }

      // Circuit breaker for invalid tool calls. If every tool call in this
      // batch failed schema validation (and the previous batches too), the
      // model is looping on bad calls — abort with an actionable message
      // instead of churning until maxIterations.
      const allInvalid = results.length > 0 && results.every(r => r.invalid);
      const anyParseError = parsed.some(p => p.parseError);
      if (allInvalid || (anyParseError && validTools.length === 0)) {
        turnRecoveryState.invalidToolCallStreak++;
        // At the second consecutive invalid batch, force the next turn to be
        // text-only. The model gets one more chance to respond in prose
        // instead of producing more malformed tool calls. Gentler than a
        // hard abort, and works around models that emit broken tool_call
        // JSON but are otherwise useful.
        if (turnRecoveryState.invalidToolCallStreak === 2) {
          forceTextOnlyNextTurn = true;
          this._queueNamedTurnOverlay('tool_loop_finalize', {
            reason: 'the last two tool batches were invalid; respond in prose without calling more tools',
          });
          emitter?.emit('loopRecovery', { reason: 'invalid_tool_call_force_text', iteration: iterations });
          this._debugLog(emitter, 'turn.invalid_tool_force_text', { streak: turnRecoveryState.invalidToolCallStreak });
          continue;
        }
        if (turnRecoveryState.invalidToolCallStreak < turnRecoveryState.maxInvalidToolCallStreak) {
          this._queueNamedTurnOverlay('invalid_tool_call', {
            streak: turnRecoveryState.invalidToolCallStreak,
            max: turnRecoveryState.maxInvalidToolCallStreak,
          });
          this._debugLog(emitter, 'turn.invalid_tool_nudge', {
            streak: turnRecoveryState.invalidToolCallStreak,
            max: turnRecoveryState.maxInvalidToolCallStreak,
          });
          continue;
        }
        if (turnRecoveryState.invalidToolCallStreak >= turnRecoveryState.maxInvalidToolCallStreak) {
          // Say *what* was rejected. Without this the user gets a verdict with
          // no evidence and no way to tell a model bug from a schema mismatch.
          const rejected = results
            .filter(r => r.invalid)
            .map(r => `  • ${r.name}(${describeArgs(r.args)}) → ${String(r.output || '').replace(/^Error:\s*/i, '')}`)
            .join('\n');
          emitter?.emit(
            'error',
            `Il modello continua a chiamare i tool con argomenti vuoti o non validi (${turnRecoveryState.invalidToolCallStreak} turni di fila). Probabile bug del modello.\n`
            + `Ultime chiamate rifiutate:\n${rejected || '  • (nessun dettaglio disponibile)'}\n`
            + `Suggerimenti: (1) riformula la richiesta in modo più specifico, (2) usa /compress per ridurre il contesto, (3) usa /use per cambiare modello.`
          );
          emitTurnState('failed', { reason: 'invalid_tool_call_loop' });
          this._debugLog(emitter, 'turn.failed', {
            kind: 'invalid_tool_call_loop',
            streak: turnRecoveryState.invalidToolCallStreak,
            rejected: results.filter(r => r.invalid).map(r => ({ name: r.name, args: r.args, error: r.output })),
          });
          return;
        }
      } else {
        turnRecoveryState.invalidToolCallStreak = 0;
      }

      // Cheap lossy shrink before the heavier LLM-driven compress so the
      // big-tool-batch path doesn't burn an LLM call when head-tail elision
      // is enough.
      if (this.compressor.autoEnabled) {
        const shrunken = this.compressor.lossyShrink(this.messages);
        if (shrunken !== this.messages) {
          this.messages = shrunken;
          emitter?.emit('tokenCount', estimateTokens(this.messages));
        }
      }

      // Mid-turn auto-compress: after tools added messages, re-check threshold.
      // Without this, compression only fires once before the loop — large tool
      // batches can push context well past the 30% threshold without a chance
      // to compress until the next user turn.
      if (this.compressor.autoEnabled && this.compressor.needsCompression(this.messages)) {
        this.messages = await this.compressor.compress(this.messages, emitter);
        emitter?.emit('tokenCount', estimateTokens(this.messages));
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
          emitTurnState('failed', { reason: 'timeout' });
          this._debugLog(emitter, 'turn.failed', { kind: 'timeout', reason: reasonText });
        } else {
          emitter?.emit('cancelled');
          emitTurnState('cancelled', { reason: 'user_abort' });
          this._debugLog(emitter, 'turn.cancelled', { reason: String(reasonText || 'aborted') });
        }
        return;
      }
      // The provider rejected the conversation because the model emitted
      // malformed JSON in one of its tool calls. Retry exactly once with a
      // nudge instructing the model to regenerate tool arguments as strict
      // JSON — this recovers from the common "model generates an unterminated
      // string in the second tool call" pattern seen across providers.
      if (isInvalidToolArgsError(e)) {
        const retried = await this._retryAfterInvalidToolArgs(e, emitter);
        if (retried) return;
      }
      emitter?.emit('error', translateProviderError(e));
      emitTurnState('failed', { reason: 'exception' });
      this._debugLog(emitter, 'turn.failed', { kind: 'exception', error: String(e?.message || e) });
      return;
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
      setToolAbortSignal(null);
      setAgentTodoSink(null);
    }

    emitter?.emit('error', `Maximum agent iterations reached (${this.maxIterations}).`);
    emitTurnState('failed', { reason: 'max_iterations' });
    this._debugLog(emitter, 'turn.failed', { kind: 'max_iterations', maxIterations: this.maxIterations });
  }

  reset() {
    const system = this.messages[0];
    this.messages = [system];
    this._todoList = [];
    this._todoDoneIdx = new Set();
    this._todoFromBlock = false;
    this._autoContinueCount = 0;
  }

  setMode(mode) {
    this.mode = mode;
    this._rebuildSystemPrompt();
  }

  setCavemanLevel(level) {
    const next = String(level || '').trim().toLowerCase();
    this.cavemanLevel = next || null;
    this._rebuildSystemPrompt();
    return this.cavemanLevel;
  }

  clearCavemanLevel() {
    this.cavemanLevel = null;
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
    this._systemTemplate = renderSystemPrompt(this.mode, this._workdir, {
      cavemanLevel: this.cavemanLevel,
      provider: this.config.provider,
      model: this.config.model,
    });
    this._systemPromptBase = this._systemTemplate;
    this._refreshActiveSystemPrompt();
    if (this._isLite) applyLitePrompt(this, this._workdir);
    this._memoryReady = this._loadMemory();
  }
}
