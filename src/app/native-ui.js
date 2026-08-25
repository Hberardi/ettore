import { EventEmitter } from 'events';
import { emitKeypressEvents } from 'readline';
import { TUI, THEMES, setTheme } from './tui-native.js';
import { connectionManager, ConnectionManager } from '../providers/index.js';
import { PROVIDER_REGISTRY } from '../providers/registry.js';
import { loadConfig, getConfig } from '../config/index.js';
import { createClient } from '../llm/client.js';
import { Agent } from '../agents/index.js';
import { createSession, saveSession } from '../sessions/index.js';
import { uiBridge } from '../tools/bridge.js';
import { listInstallSessionApprovals, setAutoApprove } from '../tools/index.js';
import { builtinCommands } from '../commands/index.js';
import { getModelPricing, calcCost } from '../utils/pricing.js';
import { stripAllAnsi } from '../utils/ansi.js';
import { getModelCapability } from '../providers/model_capability.js';
import { extractImageReferences } from '../utils/images.js';
import { buildAttachmentPrompt, loadAttachments } from '../utils/attachments.js';
import { chooseFiles } from '../utils/file-picker.js';
import * as loops from '../loops/index.js';
import { MissionControl } from '../mission/index.js';
import { autoResumeDecision, DEFAULT_MAX_AUTO_RESUMES } from './auto-resume.js';

const NON_METERED_PROVIDERS = new Set(['ollama', 'nvidia', 'minimax', 'claude-code']);

// Commands that can change which provider/model is active. After one runs, the
// TUI has to re-read the connection manager: the header, the cost meter and the
// agent instance all cache the previous provider otherwise.
export const CONNECTION_COMMANDS = new Set(['connect', 'use', 'select', 'disconnect']);

/**
 * `/connect <provider>` typed inline should behave like picking that provider
 * from the palette — connect it, make it active, rebuild the agent, open the
 * model picker — instead of printing a text summary and leaving the session on
 * the previous provider. Returns the provider id to route, or null to let the
 * generic command handler take it (unknown provider, or an inline API key).
 *
 * Exported for tests: the TUI command dispatcher itself is a closure.
 */
export function connectProviderToRoute(cmdArgs = [], registry = PROVIDER_REGISTRY) {
  if (cmdArgs.length !== 1) return null;
  const requested = String(cmdArgs[0] || '').trim().toLowerCase();
  return registry.some(entry => entry.id === requested) ? requested : null;
}

function hasLongReasoningWindow(provider, modelId) {
  const p = String(provider || '').toLowerCase();
  const m = String(modelId || '').toLowerCase();
  if (p === 'minimax') return true;
  // Kimi routed through NVIDIA NIM can have long silent reasoning stretches.
  if (p === 'nvidia' && (m.includes('kimi') || m.includes('moonshot'))) return true;
  return false;
}

function sanitizeUiText(value) {
  return stripAllAnsi(String(value ?? '')).replace(/\r/g, '');
}

export function syncModeWithAgent(tui, agent) {
  if (!tui) return 'build';
  tui.mode = tui.mode === 'build' ? 'plan' : 'build';
  agent?.setMode?.(tui.mode);
  tui.needsRender = true;
  return tui.mode;
}

function buildCodeDiffPreview(toolName, args = {}) {
  if (toolName !== 'edit') return null;
  const oldText = String(args.old_string ?? args.oldString ?? '');
  const newText = String(args.new_string ?? args.newString ?? '');
  if (!oldText && !newText) return null;

  const maxLines = 12;
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  return {
    beforeLines: oldLines.slice(0, maxLines),
    afterLines: newLines.slice(0, maxLines),
    truncated: oldLines.length > maxLines || newLines.length > maxLines,
  };
}

function resolveContextWindow() {
  const modelId = connectionManager.activeModel || '';
  const provider = connectionManager.activeProvider || '';
  const models = provider ? connectionManager.listModels(provider) : { success: false, models: [] };
  const activeModelObj = models.success
    ? models.models.find(m => (typeof m === 'string' ? m : m.id) === modelId)
    : null;
  const fromMeta = Number(activeModelObj?.context_length);
  if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
  return getModelPricing(modelId).ctx || 128000;
}

const ANSI = {
  altScreen:    '\x1b[?1049h',
  normalScreen: '\x1b[?1049l',
  clear:        '\x1b[2J',
  home:         '\x1b[H',
  show:         '\x1b[?25h',
  hide:         '\x1b[?25l',
  bracketedPasteOn: '\x1b[?2004h',
  bracketedPasteOff: '\x1b[?2004l',
};

function modelLabel(m) {
  const id = typeof m === 'string' ? m : m.id;
  if (m.free) return `${id} [FREE]`;
  // Providers use `note` for a caveat that must be visible at pick time, e.g. a
  // model the account cannot reach without buying usage credits.
  return m.note ? `${id} [${m.note}]` : id;
}

const SUBMENU_COMMANDS = {
  theme:     () => Object.entries(THEMES).map(([key, val]) => ({ value: key, label: val.label || key, description: `Switch to ${val.label || key} theme` })),
  providers: () => {
    const providers = ConnectionManager.getAvailableProviders();
    return providers.map(p => ({ value: p.name, label: `${p.icon || ''} ${p.name}`, description: p.description + (connectionManager.isConnected(p.name) ? ' ✓ connected' : '') }));
  },
  models: () => {
    const connections = connectionManager.listConnections();
    const items = [];
    for (const conn of connections) {
      const models = connectionManager.listModels(conn.provider);
      if (models.success) {
        for (const m of models.models) {
          const modelId = typeof m === 'string' ? m : m.id;
          const isActive = conn.isActive && modelId === connectionManager.activeModel;
          items.push({ value: `${conn.provider} ${modelId}`, label: modelLabel(m), description: conn.provider + (isActive ? ' ← active' : '') });
        }
      }
    }
    if (items.length === 0) items.push({ value: '__none', label: 'No models available', description: 'Use /connect first' });
    return items;
  },
  use: () => {
    const connections = connectionManager.listConnections();
    const items = [];
    for (const conn of connections) {
      const models = connectionManager.listModels(conn.provider);
      if (models.success) {
        for (const m of models.models) {
          const modelId = typeof m === 'string' ? m : m.id;
          const isActive = conn.isActive && modelId === connectionManager.activeModel;
          items.push({ value: `${conn.provider} ${modelId}`, label: modelLabel(m), description: conn.provider + (isActive ? ' ← active' : '') });
        }
      }
    }
    if (items.length === 0) items.push({ value: '__none', label: 'No connections', description: 'Use /connect first' });
    return items;
  },
  connect: () => {
    const providers = ConnectionManager.getAvailableProviders();
    return providers.map(p => ({
      value: p.name,
      label: `${p.icon || ''} ${p.name}`,
      description: p.description + (connectionManager.isConnected(p.name) ? ' ✓ connected' : '') + (p.requiresKey ? ' 🔑' : '')
    }));
  },
  disconnect: () => {
    const connections = connectionManager.listConnections();
    if (connections.length === 0) return [{ value: '__none', label: 'No connections', description: 'Nothing to disconnect' }];
    return connections.map(c => ({ value: c.provider, label: c.provider, description: `${c.modelsCount} models` + (c.isActive ? ' [active]' : '') }));
  },
  select: () => {
    const connections = connectionManager.listConnections();
    const items = [];
    for (const conn of connections) {
      const models = connectionManager.listModels(conn.provider);
      if (models.success) {
        for (const m of models.models) {
          const modelId = typeof m === 'string' ? m : m.id;
          items.push({ value: `${conn.provider} ${modelId}`, label: modelLabel(m), description: conn.provider });
        }
      }
    }
    if (items.length === 0) items.push({ value: '__none', label: 'No models', description: 'Use /connect first' });
    return items;
  },
  approvals: () => {
    const approvals = listInstallSessionApprovals();
    const byKind = (kind) => approvals.filter(item => item.kind === kind).length;
    return [
      { value: 'list', label: 'Show all approvals', description: `${approvals.length} stored` },
      { value: 'list project', label: 'Project approvals', description: `${byKind('project')} stored` },
      { value: 'list system', label: 'System approvals', description: `${byKind('system')} stored` },
      { value: 'list download', label: 'Download approvals', description: `${byKind('download')} stored` },
      { value: 'clear', label: 'Clear all approvals', description: 'Resets the session approval store' },
      { value: 'clear project', label: 'Clear project approvals', description: 'Forget project install approvals' },
      { value: 'clear system', label: 'Clear system approvals', description: 'Forget system install approvals' },
      { value: 'clear download', label: 'Clear download approvals', description: 'Forget download approvals' },
    ];
  },
};

export async function startApp(options = {}) {
  if (!process.stdin.isTTY) {
    console.error('ettore requires an interactive terminal (TTY)');
    process.exit(1);
  }

  process.stdout.write(ANSI.altScreen + ANSI.clear + ANSI.home + ANSI.hide + ANSI.bracketedPasteOn);

  const tui = new TUI();
  const mission = new MissionControl();
  tui.mission = mission.snapshot();
  const syncMission = () => {
    tui.mission = mission.snapshot();
    tui.needsRender = true;
  };
  tui.updateSize();
  const originalMessagesPush = tui.messages.push.bind(tui.messages);
  tui.messages.push = (...items) => {
    const sanitized = items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      if (typeof item.text !== 'string') return item;
      return { ...item, text: sanitizeUiText(item.text) };
    });
    return originalMessagesPush(...sanitized);
  };

  const config = await loadConfig(options);
  tui.safetyProfile = config.safetyProfile || 'balanced';
  tui.dynamicToolRouting = config.dynamicToolRouting !== false;
  let agent = null;

  const rebuildAgent = async ({ announceMemory = false } = {}) => {
    if (!connectionManager.getActive()) {
      agent = null;
      return;
    }
    try {
      config.provider = connectionManager.activeProvider || config.provider;
      config.model = connectionManager.activeModel || config.model;
      config.modelCapability = tui.modelCapability || 'unknown';
      config.contextWindow = resolveContextWindow();
      // Wire the plugin registry into the agent so plugin tools and
      // handlers are merged with the built-in set. The agent caches the
      // merged view, so a fresh `new Agent(...)` is required whenever
      // the plugin set changes — which is exactly what /plugins does by
      // calling this rebuildAgent.
      config.pluginRegistry = pluginRegistry;
      const client = createClient(config);
      agent = new Agent(client, config, tui.mode || 'build');
      if (announceMemory) {
        agent._memoryReady.then((result) => {
          if (result) {
            tui.messages.push({
              role: 'system',
              text: `📚 Memoria progetto caricata — ${result.projectName} (.ettore/memory.md)`,
              tools: [], id: Date.now(),
            });
            tui.needsRender = true;
          }
        }).catch(() => {});
      }
    } catch (_e) {
      agent = null;
    }
  };

  const savedTheme = getConfig('theme');
  if (savedTheme && THEMES[savedTheme]) setTheme(savedTheme, { persist: false });

  // Restore auto-approve state from persisted config so user doesn't have to
  // re-toggle on every session start.
  const savedAutoApprove = getConfig('autoApprove');
  if (savedAutoApprove && typeof savedAutoApprove === 'object') {
    setAutoApprove({
      edits: savedAutoApprove.edits === true,
      installs: savedAutoApprove.installs === true,
    });
  }

  const p = connectionManager.activeProvider || 'unknown';
  const m = connectionManager.activeModel   || 'unknown';
  const session = await createSession(p, m);
  tui.sessionId = session.id;
  tui.provider  = p;
  tui.model     = m;

  // Plugin runtime: one process-wide registry+runtime pair shared with the
  // command dispatcher. boot() is best-effort: a broken plugin is logged
  // and ignored so the rest of the session starts cleanly. The runtime
  // exposes enable/disable/reload that the agent picks up via
  // `rebuildAgent()` so the new tool set is in effect on the next turn.
  // The registry is seeded with the actual built-in tool list so plugin
  // tools merge with — not replace — the core set.
  const { toolDefinitions, toolHandlers } = await import('../tools/index.js');
  const { PluginRegistry, PluginRuntime } = await import('../plugins/index.js');
  const pluginRegistry = new PluginRegistry({
    builtInTools: toolDefinitions,
    builtInHandlers: toolHandlers,
    builtInCommands: {},
  });
  const pluginRuntime = new PluginRuntime({ registry: pluginRegistry });
  try {
    const bootReport = await pluginRuntime.boot();
    if (bootReport.enabled.length > 0 || bootReport.failed.length > 0) {
      // Surface plugin boot result to the user so a broken plugin is
      // visible without /plugins being invoked explicitly.
      if (bootReport.enabled.length > 0) {
        tui.messages.push({
          role: 'system',
          text: `🔌 Plugins loaded (${bootReport.enabled.length}): ${bootReport.enabled.join(', ')}`,
          tools: [], id: Date.now(),
        });
      }
      for (const f of bootReport.failed) {
        tui.messages.push({
          role: 'system',
          text: `⚠ Plugin "${f.name}" failed to load: ${f.error}`,
          tools: [], id: Date.now(),
        });
      }
      tui.needsRender = true;
    }
  } catch (err) {
    tui.messages.push({
      role: 'system',
      text: `⚠ Plugin system error: ${err.message}`,
      tools: [], id: Date.now(),
    });
    tui.needsRender = true;
  }

  const emitter = new EventEmitter();
  connectionManager.setEmitter(emitter);

  // Auto-resume state. When the agent's run() ends with an unfinished plan
  // (`autoContinueExhausted`) or with the model announcing-but-not-acting
  // (`announcementStall`), the TUI used to push a "Scrivi 'continua' per
  // riprendere" message and wait for the user. That made long workflows
  // feel like a confirmation dialog — every multi-step task needed a manual
  // nudge. Instead, we silently kick off another turn with a continuation
  // prompt, up to MAX_AUTO_RESUMES per session. The cap is a safety net
  // against a genuinely stuck model that would otherwise loop forever.
  let autoResumeCount = 0;
  // 10 was too tight: a multi-file task routinely burns that many resumes and
  // then parks on `Scrivi "continua"`. The cap only exists to bound a model
  // that is genuinely stuck — the repeat guard in `autoResumeDecision` catches
  // that case far earlier — so the budget can be generous and configurable.
  const MAX_AUTO_RESUMES = Math.max(1, Number(config.maxAutoResumes) || DEFAULT_MAX_AUTO_RESUMES);
  let pendingAutoResume = null;
  // Fingerprint of the last auto-resumed turn, so a model repeating itself
  // verbatim without running anything stops instead of looping.
  let lastResumeSignature = null;
  // A loop step can legitimately require more tool calls than a normal
  // interactive turn. Keep the global safety cap unchanged, but give loop
  // steps additional headroom and restore the user's value afterwards.
  const LOOP_MAX_TOOL_CALLS_PER_TURN = 160;
  let loopToolCallLimitBefore = null;

  // Drive the agent with the given prompt. Resets the TUI's streaming
  // state, pushes a user message, calls agent.run(), and lets the normal
  // 'complete' / 'error' / 'cancelled' handlers clean up. Used by both
  // `handleInput` (the real prompt) and the auto-resume path (synthetic
  // continuation), so the two flows stay in lockstep.
  async function runAgent(text, imageAttachments = [], displayText = text, { continuation = false } = {}) {
    if (!agent || tui.isRunning) return;
    mission.startTurn(text, { continuation });
    syncMission();
    tui.messages.push({ role: 'user', text: displayText, tools: [], id: Date.now() });
    tui.isRunning = true;
    tui.turnState = 'started';
    tui.streaming = { text: '', tools: [], reasoning: '', waitKind: 'model', lastActivityAt: Date.now(), stallMs: STALL_MS };
    reasoningText = '';
    firstToolSeen = false;
    tui.needsRender = true;
    try {
      await agent.run(text, emitter, { imageAttachments });
    } catch {
      // Errors are surfaced via the 'error' event; nothing to do here.
    }
    session.messages = agent.messages;
    await saveSession(session).catch(() => {});
  }

  // ── /loop runtime ───────────────────────────────────────────────────────
  // A loop is a pre-generated list of prompts that get fed to the agent
  // sequentially in the same conversation. Static plan: the prompts are
  // decided once, then executed mechanically. State lives in the loops
  // module so the /loop command can introspect it via /loop status.
  //
  // startLoop({ plan, name }) is exposed on the command context. The
  // `complete` event handler below advances the queue: when the current
  // step finishes, the next prompt is run automatically via setImmediate
  // so the current event tick finishes (final UI updates render first).
  //
  // The TUI is the only writer to loopRuntime (in the loops module). All
  // mutations go through loops.startLoopRuntime / advanceLoopRuntime /
  // stopLoopRuntime — keeping the mirror-and-module pattern in one place
  // so the /loop status command and the TUI never disagree.

  const startLoop = ({ plan, name }) => {
    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      throw new Error('Loop plan is empty');
    }
    if (tui.isRunning) {
      throw new Error('Cannot start a loop while the agent is running. Wait for the current turn to finish or press Esc to cancel.');
    }
    if (agent && loopToolCallLimitBefore === null) {
      loopToolCallLimitBefore = agent.maxToolCallsPerTurn;
      agent.maxToolCallsPerTurn = Math.max(
        Number(agent.maxToolCallsPerTurn) || 0,
        LOOP_MAX_TOOL_CALLS_PER_TURN,
      );
    }
    loops.startLoopRuntime({ plan, name });
    // Mirror to the TUI so the sidebar can render the active loop status.
    tui.loopStatus = loops.getLoopStatus();
    tui.loopStatusRev = (tui.loopStatusRev || 0) + 1;
    tui.messages.push({
      role: 'system',
      text: `▶ Loop avviato${name ? ` (${name})` : ''}: ${plan.steps.length} step.\n`
        + `  Step 1/${plan.steps.length}: ${plan.steps[0]?.title || 'step 1'}\n`
        + `  /loop status per i dettagli, /loop stop per fermare dopo lo step corrente.`,
      tools: [],
      id: Date.now(),
    });
    tui.needsRender = true;
    // Kick off the first step. The `complete` event handler will keep
    // draining the queue from there.
    const firstPrompt = plan.steps[0]?.prompt;
    if (firstPrompt) {
      setImmediate(() => { runAgent(firstPrompt, []); });
    }
  };

  const restoreLoopToolCallLimit = () => {
    if (loopToolCallLimitBefore === null || !agent) return;
    agent.maxToolCallsPerTurn = loopToolCallLimitBefore;
    loopToolCallLimitBefore = null;
  };

  const stopLoop = () => {
    const wasActive = loops.stopLoopRuntime();
    restoreLoopToolCallLimit();
    if (wasActive) {
      tui.messages.push({
        role: 'system',
        text: '⏹ Loop fermato. Lo step corrente è stato completato.',
        tools: [],
        id: Date.now(),
      });
      tui.needsRender = true;
    }
    // Keep loopStatus in the TUI so the sidebar shows "✓ N/N step" briefly
    // even after a manual stop — the user can confirm the run reached the
    // end. Refresh from the loops module (it now has active=false).
    tui.loopStatus = loops.getLoopStatus();
    tui.loopStatusRev = (tui.loopStatusRev || 0) + 1;
    return wasActive;
  };

  // Refresh the TUI's loopStatus from the canonical loops module state.
  // Called after every advance so the sidebar progress dots stay in sync
  // with the chat's auto-continue and completion messages.
  const refreshTuiLoopStatus = () => {
    tui.loopStatus = loops.getLoopStatus();
    tui.loopStatusRev = (tui.loopStatusRev || 0) + 1;
  };

  let renderPending = false;
  let lastRenderTime = 0;
  const MIN_RENDER_INTERVAL = 16; // 60fps max

  const scheduleRender = () => {
    if (renderPending) return;
    renderPending = true;
    setImmediate(() => {
      const now = Date.now();
      if (now - lastRenderTime < MIN_RENDER_INTERVAL) {
        renderPending = false;
        return; // Skip - will catch next interval
      }
      lastRenderTime = now;
      tui.render();
      tui.needsRender = false;
      renderPending = false;
    });
  };

  let reasoningText = '';
  let firstToolSeen = false;
  let lastToolIntent = '';
  // Streaming token buffer — holds back the trailing tail of each chunk if it
  // could be the start of an unfinished ANSI/SGR sequence, then releases it
  // once the next chunk completes (or invalidates) the pattern. This kills
  // the root cause of orphan codes: a sequence split across two chunks.
  let tokenBuffer = '';
  const STALL_MS = 800;

  // Returns { safe, held } — `safe` can be sanitized & emitted now, `held`
  // stays in the buffer until more data arrives. Conservative: only holds
  // back if the trailing bytes plausibly start an ANSI/SGR sequence.
  const splitStreamBuffer = (buf) => {
    if (!buf) return { safe: '', held: '' };
    const N = buf.length;
    let holdFrom = N;
    const patterns = [
      // Real ESC + bytes that haven't reached a final byte yet
      /\x1b[^A-Za-z@]*$/,
      // [ alone or [ + params with no final byte yet (CSI tail without ESC)
      /\[[0-9;:?]*$/,
      // Escaped literal forms in progress (\x1b... / ...)
      /\\(?:u[0-9a-f]{0,4}|x[0-9a-f]{0,2})(?:\[[0-9;:]*)?$/i,
      // Trailing digits/semicolons (potential start of orphan SGR).
      // No lookbehind — held digits release as soon as a non-digit/`;`
      // arrives, so legit numbers like "port 8080 more" recover next chunk.
      /\d{1,3}(?:;\d{0,3})*;?$/,
    ];
    for (const re of patterns) {
      const m = buf.match(re);
      if (m && m.index < holdFrom) holdFrom = m.index;
    }
    // Never hold back more than 40 chars (safety bound against pathological
    // inputs that would freeze the display).
    if (N - holdFrom > 40) holdFrom = N - 40;
    return { safe: buf.slice(0, holdFrom), held: buf.slice(holdFrom) };
  };

  const sanitizeIntentText = (value, maxLen = 120) => {
    const s = sanitizeUiText(value).replace(/\s+/g, ' ').trim();
    return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
  };

  const sanitizeModelText = (value) => sanitizeUiText(value);

  const summarizeToolIntent = (name, args = {}) => {
    const plan = {
      read: ['Capire il codice rilevante', args.file_path ? `Prossimo passo: leggo ${args.file_path}` : 'Prossimo passo: leggo i file principali'],
      read_pdf: ['Estrarre informazioni dal documento', args.file_path ? `Prossimo passo: analizzo PDF ${args.file_path}` : 'Prossimo passo: analizzo il PDF richiesto'],
      read_doc: ['Estrarre informazioni dal documento', args.file_path ? `Prossimo passo: analizzo file ${args.file_path}` : 'Prossimo passo: analizzo il documento richiesto'],
      read_server_console: ['Capire errori/runtime dell’app', 'Prossimo passo: leggo i log della console server'],
      dev_server: ['Gestire il dev server locale', 'Prossimo passo: avvio/controllo stato o log del server di sviluppo'],
      browser_check: ['Verificare rapidamente una pagina web', 'Prossimo passo: controllo HTTP, titolo e testi attesi della pagina'],
      browser_app: ['Usare l’app web nel browser per trovare gli errori', args.url ? `Prossimo passo: apro ${sanitizeIntentText(args.url)} e leggo la console del browser` : 'Prossimo passo: interagisco con la pagina e leggo la console del browser'],
      desktop_app: ['Usare l’app desktop per trovare gli errori', args.command ? `Prossimo passo: avvio ${sanitizeIntentText(args.command)} e leggo il suo output` : 'Prossimo passo: interagisco con la finestra e leggo l’output dell’app'],
      dep_inspect: ['Analizzare lo stato delle dipendenze del progetto', 'Prossimo passo: controllo pacchetti outdated e possibili vulnerabilità'],
      repo_map: ['Mappare rapidamente la struttura del repository', 'Prossimo passo: costruisco una panoramica dei file chiave ed entrypoint'],
      repo_find_symbol: ['Individuare rapidamente dove vive un simbolo', 'Prossimo passo: cerco occorrenze e definizioni del simbolo richiesto'],
      apply_patch_structured: ['Applicare una patch validata su un file', 'Prossimo passo: verifico match univoco e applico la modifica'],
      run_tests: ['Verificare che le modifiche non rompano il progetto', 'Prossimo passo: eseguo la suite di test appropriata'],
      run_checks: ['Eseguire quality checks completi del progetto', 'Prossimo passo: lancio lint/typecheck/test in profilo sicuro'],
      glob: ['Mappare i file utili al task', args.pattern ? `Prossimo passo: cerco con pattern ${sanitizeIntentText(args.pattern)}` : 'Prossimo passo: cerco i file pertinenti'],
      grep: ['Trovare i punti di codice rilevanti', args.pattern ? `Prossimo passo: cerco "${sanitizeIntentText(args.pattern)}"` : 'Prossimo passo: cerco il pattern richiesto'],
      list_dir: ['Capire la struttura del progetto', args.path ? `Prossimo passo: esploro ${sanitizeIntentText(args.path)}` : 'Prossimo passo: esploro le directory principali'],
      file_info: ['Verificare i dettagli di file/cartelle', args.path ? `Prossimo passo: controllo metadata di ${sanitizeIntentText(args.path)}` : 'Prossimo passo: controllo i metadata necessari'],
      git_status: ['Verificare lo stato del repository', 'Prossimo passo: controllo branch e working tree'],
      git_diff: ['Analizzare le modifiche in corso', 'Prossimo passo: leggo il diff rilevante'],
      websearch: ['Raccogliere informazioni aggiornate', args.query ? `Prossimo passo: cerco "${sanitizeIntentText(args.query)}"` : 'Prossimo passo: effettuo una ricerca web'],
      webfetch: ['Leggere contenuto di una pagina specifica', args.url ? `Prossimo passo: apro ${sanitizeIntentText(args.url)}` : 'Prossimo passo: apro la pagina richiesta'],
      bash: ['Eseguire una verifica operativa', args.command ? `Prossimo passo: eseguo ${sanitizeIntentText(args.command, 80)}` : 'Prossimo passo: eseguo il comando necessario'],
      bash_session: ['Eseguire un comando con stato di shell persistente', args.command ? `Prossimo passo: eseguo nella sessione ${sanitizeIntentText(args.command, 80)}` : 'Prossimo passo: eseguo il comando nella sessione persistente'],
      write: ['Applicare le modifiche richieste', args.file_path ? `Prossimo passo: scrivo ${sanitizeIntentText(args.file_path)}` : 'Prossimo passo: scrivo le modifiche'],
      edit: ['Applicare patch mirata al codice', args.file_path ? `Prossimo passo: modifico ${sanitizeIntentText(args.file_path)}` : 'Prossimo passo: modifico il file richiesto'],
      ask_user: ['Chiarire una scelta necessaria', 'Prossimo passo: chiedo una decisione all’utente'],
    }[name] || ['Raccogliere il contesto necessario', 'Prossimo passo: avvio i controlli iniziali'];

    return `Piano: ${plan[0]}\n${plan[1]}`;
  };

  const ensureStreaming = () => {
    if (!tui.streaming) {
      tui.streaming = { text: '', tools: [], reasoning: '', waitKind: 'model', lastActivityAt: Date.now(), stallMs: STALL_MS };
    } else {
      if (!tui.streaming.waitKind) tui.streaming.waitKind = 'model';
      if (!tui.streaming.lastActivityAt) tui.streaming.lastActivityAt = Date.now();
      if (!tui.streaming.stallMs) tui.streaming.stallMs = STALL_MS;
    }
  };

  emitter.on('token', (text) => {
    ensureStreaming();
    tui.streaming.waitKind = 'model';
    tui.streaming.lastActivityAt = Date.now();
    // Append to cross-chunk buffer, then release only the portion that can't
    // be the start of an unfinished ANSI sequence. Sanitize the released
    // part with the full pipeline (now seeing complete sequences).
    tokenBuffer += String(text || '');
    const { safe, held } = splitStreamBuffer(tokenBuffer);
    tokenBuffer = held;
    if (!safe) return;
    const cleanText = sanitizeModelText(safe);
    if (!firstToolSeen) {
      reasoningText += cleanText;
      tui.streaming.reasoning = reasoningText;
    }
    tui.streaming.text += cleanText;
    scheduleRender();
  });

  emitter.on('thinkStart', () => {
    ensureStreaming();
    tui.streaming.waitKind = 'model';
    tui.streaming.lastActivityAt = Date.now();
    scheduleRender();
  });

  emitter.on('thinkToken', (text) => {
    if (!text) return;
    ensureStreaming();
    tui.streaming.waitKind = 'model';
    tui.streaming.lastActivityAt = Date.now();
    reasoningText += sanitizeModelText(text);
    tui.streaming.reasoning = reasoningText;
    scheduleRender();
  });

  emitter.on('thinkEnd', () => {
    ensureStreaming();
    tui.streaming.waitKind = 'model';
    tui.streaming.lastActivityAt = Date.now();
    tui.streaming.reasoning = reasoningText;
    scheduleRender();
  });

  emitter.on('plan', (plan) => {
    mission.setPlan(plan);
    syncMission();
  });

  emitter.on('decision', (entry) => {
    mission.decision(entry);
    syncMission();
  });

  emitter.on('toolWaveStart', (wave) => {
    mission.startWave(wave);
    syncMission();
  });

  emitter.on('toolWaveEnd', (wave) => {
    mission.endWave(wave);
    syncMission();
  });

  emitter.on('toolStart', ({ id, name, args }) => {
    mission.toolStart({ id, name, args });
    syncMission();
    firstToolSeen = true;
    ensureStreaming();
    tui.streaming.waitKind = 'tool';
    tui.streaming.lastActivityAt = Date.now();
    const intent = summarizeToolIntent(name, args || {});
    if (intent && intent !== lastToolIntent) {
      if (!tui.streaming.text || !tui.streaming.text.trim()) {
        tui.streaming.text = `${intent}\n`;
      } else {
        const parts = String(tui.streaming.text).split('\n');
        if (parts.length >= 2 && parts[0].startsWith('Piano: ') && parts[1].startsWith('Prossimo passo: ')) {
          parts[0] = intent.split('\n')[0] || parts[0];
          parts[1] = intent.split('\n')[1] || parts[1];
          tui.streaming.text = parts.join('\n');
        } else {
          tui.streaming.text += `\n${intent}\n`;
        }
      }
      lastToolIntent = intent;
    }
    // Save current reasoning before starting tool
    tui.streaming.reasoning = reasoningText;
    tui.streaming.tools.push({
      id,
      name,
      args: args || {},
      status: 'running',
      startMs: Date.now(),
      diffPreview: buildCodeDiffPreview(name, args || {}),
    });
    tui.streaming.reasoning = reasoningText;
    reasoningText = '';
    tui.turnState = 'tool_call';
    scheduleRender();
  });

  emitter.on('toolEnd', ({ id, name: _name, output }) => {
    mission.toolEnd({ id, name: _name, output });
    syncMission();
    if (tui.streaming?.tools) {
      const tool = tui.streaming.tools.find(t => t.id === id);
      if (tool) {
        tool.status = 'done';
        tool.durationMs = Date.now() - tool.startMs;
        tool.output = typeof output === 'string' ? output : JSON.stringify(output);
      }
      const stillRunning = tui.streaming.tools.some(t => t.status === 'running');
      tui.streaming.waitKind = stillRunning ? 'tool' : 'model';
      tui.streaming.lastActivityAt = Date.now();
      tui.turnState = stillRunning ? 'tool_call' : 'tool_result';
      scheduleRender();
    }
  });

  emitter.on('turnState', ({ state }) => {
    tui.turnState = state || 'idle';
    if (tui.streaming) {
      if (state === 'tool_call') tui.streaming.waitKind = 'tool';
      if (state === 'tool_result') tui.streaming.waitKind = 'model';
      tui.streaming.lastActivityAt = Date.now();
    }
    scheduleRender();
  });

  // Tools that take minutes (long bash, video_transcript with whisper, large
  // webfetch) emit periodic toolProgress events from the tool handler. Forward
  // them as activity ticks so the stall watchdog doesn't kill a tool that is
  // genuinely working — and show the latest message under the running tool.
  uiBridge.on('toolProgress', ({ name, key, message }) => {
    if (!tui.streaming) return;
    tui.streaming.lastActivityAt = Date.now();
    // Surface agent-level recovery events (e.g. "tool-args-retry") as system
    // messages so the user sees WHY the turn paused instead of staring at
    // a model that just said "let me retry". Without this, the only signal
    // of a malformed tool-call retry is the model's own text, which can
    // look indistinguishable from a real hang.
    if (name === 'tool-args-retry' || name === 'loop-recovery' || name === 'auto-continue') {
      tui.messages.push({
        role: 'system',
        text: `⚠ ${message}`,
        tools: [],
        id: Date.now(),
      });
      tui.needsRender = true;
      return;
    }
    const running = tui.streaming.tools.find(t => t.status === 'running' && t.name === name);
    if (running) {
      running.progress = String(message || '').slice(0, 200);
      running.progressKey = key;
      tui.needsRender = true;
    }
  });

  // Show a confirmation toast when the agent saves project memory
  uiBridge.on('memorySaved', ({ section, projectRoot: _projectRoot }) => {
    tui.messages.push({
      role: 'system',
      text: `✓ Memoria aggiornata — sezione: ${section} (.ettore/memory.md)`,
      tools: [], id: Date.now(),
    });
    tui.needsRender = true;
  });

  // Stream is over: drain whatever was held back. Any incomplete sequence
  // in the tail at this point is genuinely incomplete (model never sent the
  // rest) — full sanitize will strip it.
  const flushTokenBuffer = () => {
    if (!tokenBuffer) return;
    const tail = sanitizeModelText(tokenBuffer);
    tokenBuffer = '';
    if (tail && tui.streaming) {
      if (!firstToolSeen) {
        reasoningText += tail;
        tui.streaming.reasoning = reasoningText;
      }
      tui.streaming.text += tail;
    }
  };

  // A run ended (completed, errored, or cancelled) — drop the task list so the
  // panel clears instead of leaving a stale "Tasks" block in the scrollback.
  // Splice in place: reassigning tui.messages would lose the patched .push above.
  const clearTodoPanel = () => {
    if (!Array.isArray(tui.todos) || tui.todos.length === 0) return;
    for (let i = tui.messages.length - 1; i >= 0; i--) {
      if (tui.messages[i].role === 'todos') tui.messages.splice(i, 1);
    }
    tui.todos = [];
    tui.currentPlan = [];
  };

  emitter.on('complete', (content) => {
    mission.endTurn();
    syncMission();
    tui.isRunning = false;
    tui.turnState = 'completed';
    flushTokenBuffer();
    clearTodoPanel();
    const text  = sanitizeModelText(tui.streaming?.text || content || '');
    const tools = tui.streaming?.tools || [];
    tui.messages.push({ role: 'assistant', text, tools, id: Date.now() });
    tui.streaming   = null;
    reasoningText = '';
    firstToolSeen = false;
    lastToolIntent = '';
    tokenBuffer = '';
    tui.needsRender = true;
    // If a recovery event set pendingAutoResume before the turn finished,
    // fire the continuation now that isRunning is back to false. Defer with
    // setImmediate so the current event loop tick finishes (any final UI
    // updates from the just-completed turn get rendered first).
    if (pendingAutoResume) {
      const text = pendingAutoResume;
      pendingAutoResume = null;
      setImmediate(() => { runAgent(text, [], text, { continuation: true }); });
      return;
    }
    // Auto-resume on a *normal* turn end when the model was clearly mid-work:
    // it ran tools, left plan steps open, announced a next action it never
    // performed, or named work still to do — and stopped anyway, which is what
    // used to force the user to type "continua" after every step. The policy
    // (including the completion check that must not fire on a mid-task
    // "Fatto.") lives in ./auto-resume.js so it is testable on its own. The
    // continuation prompt explicitly lets the model answer "task completo" and
    // stop, so genuinely one-shot tasks don't loop.
    const pendingTodos = Array.isArray(tui.todos)
      ? tui.todos.filter(t => t && t.status === 'pending').length
      : 0;
    const decision = autoResumeDecision({
      text,
      toolCount: Array.isArray(tools) ? tools.length : 0,
      pendingTodos,
      attempts: autoResumeCount,
      maxAttempts: MAX_AUTO_RESUMES,
      lastSignature: lastResumeSignature,
      mode: tui.mode,
    });
    if (decision.resume) {
      autoResumeCount++;
      lastResumeSignature = decision.signature;
      tui.messages.push({
        role: 'system',
        text: `▸ Auto-resume ${autoResumeCount}/${MAX_AUTO_RESUMES}: ${decision.why}.`,
        tools: [],
        id: Date.now(),
      });
      setImmediate(() => {
        runAgent(
          'continua con il prossimo passo. Se il task è davvero completo, rispondi solo "task completo" e fermati.',
          [],
          undefined,
          { continuation: true },
        );
      });
      return;
    }
    // Stopping is fine; stopping without saying why is what makes the CLI feel
    // frozen. `nothing_pending` and `model_done` are ordinary turn ends and
    // stay quiet — the other reasons interrupted work in progress.
    if (decision.reason === 'budget_exhausted' || decision.reason === 'repeated_without_progress') {
      tui.messages.push({
        role: 'system',
        text: `⚠ Mi fermo qui: ${decision.why}.`
          + `\n   Scrivi "continua" per riprendere, oppure indica tu il passo successivo.`,
        tools: [],
        id: Date.now(),
      });
      tui.needsRender = true;
    }
    // /loop: after the agent has fully closed the current turn (auto-resume
    // exhausted or model said "done"), advance the queue and feed the next
    // step to the agent. Runs LAST so intra-step auto-resume gets a chance
    // to finish a half-done step before we move on.
    if (loops.getLoopStatus().active) {
      const beforeTotal = loops.getLoopStatus().totalSteps;
      const next = loops.advanceLoopRuntime();
      refreshTuiLoopStatus();
      if (next) {
        setImmediate(() => { runAgent(next, [], next, { continuation: true }); });
      } else {
        restoreLoopToolCallLimit();
        tui.messages.push({
          role: 'system',
          text: `✓ Loop completato: ${beforeTotal} step eseguiti.`,
          tools: [],
          id: Date.now(),
        });
        tui.needsRender = true;
      }
      return;
    }
  });

  emitter.on('cancelled', () => {
    const loopWasActive = loops.getLoopStatus().active;
    if (loopWasActive) {
      loops.stopLoopRuntime();
      tui.loopStatus = loops.getLoopStatus();
      tui.loopStatusRev = (tui.loopStatusRev || 0) + 1;
    }
    restoreLoopToolCallLimit();
    mission.fail('cancelled');
    syncMission();
    tui.isRunning = false;
    tui.turnState = 'cancelled';
    flushTokenBuffer();
    clearTodoPanel();
    if (tui.streaming?.text) {
      tui.messages.push({ role: 'assistant', text: sanitizeModelText(tui.streaming.text) + ' [cancelled]', tools: tui.streaming.tools || [], id: Date.now() });
    }
    tui.streaming   = null;
    reasoningText = '';
    firstToolSeen = false;
    lastToolIntent = '';
    tokenBuffer = '';
    tui.needsRender = true;
  });

  emitter.on('error', (msg) => {
    const loopWasActive = loops.getLoopStatus().active;
    if (loopWasActive) {
      loops.stopLoopRuntime();
      tui.loopStatus = loops.getLoopStatus();
      tui.loopStatusRev = (tui.loopStatusRev || 0) + 1;
    }
    restoreLoopToolCallLimit();
    mission.fail(msg);
    syncMission();
    tui.isRunning   = false;
    tui.turnState = 'failed';
    tui.streaming   = null;
    lastToolIntent = '';
    tokenBuffer = '';
    clearTodoPanel();
    tui.messages.push({ role: 'assistant', text: `Error: ${msg}`, tools: [], id: Date.now() });
    tui.needsRender = true;
  });

  emitter.on('todoList', (items) => {
    mission.setTodos(items);
    syncMission();
    tui.todos = items.map(text => ({ text, status: 'pending' }));
    tui.currentPlan = [...tui.todos];
    let prevIdx = -1;
    for (let i = tui.messages.length - 1; i >= 0; i--) {
      if (tui.messages[i].role === 'todos') { prevIdx = i; break; }
    }
    if (prevIdx >= 0) tui.messages.splice(prevIdx, 1);
    tui.messages.push({ role: 'todos', items: tui.todos, id: Date.now() });
    scheduleRender();
  });

  emitter.on('todoDone', (idx) => {
    mission.completeTodo(idx);
    syncMission();
    tui.todos.forEach((t, i) => { if (i <= idx) t.status = 'done'; });
    tui.currentPlan = [...tui.todos];
    tui.needsRender = true;
  });

  emitter.on('autoContinue', ({ attempt, max, remaining, stalled }) => {
    const suffix = stalled ? ' — nessun progresso, sollecito il modello' : '';
    tui.messages.push({
      role: 'system',
      text: `▸ Auto-continue ${attempt}/${max}: ${remaining} step rimasti dal piano${suffix}`,
      tools: [],
      id: Date.now(),
    });
    // Keep the streaming bubble alive across the auto-continue so the user
    // sees a continuous run, not a fake "done → restart" flicker.
    if (tui.streaming) {
      tui.streaming.text = '';
      tui.streaming.reasoning = '';
      tui.streaming.waitKind = 'model';
      tui.streaming.lastActivityAt = Date.now();
    }
    tui.needsRender = true;
  });

  // The turn ended with plan steps still open. Without this the run just stops
  // on whatever the model last said — usually an announcement of work it never
  // did — and the CLI looks like it froze.
  emitter.on('autoContinueExhausted', ({ reason, remaining, attempts, pending = [] }) => {
    if (autoResumeCount >= MAX_AUTO_RESUMES) {
      const why = reason === 'no_progress'
        ? 'il modello non ha fatto progressi'
        : `esauriti i ${attempts} tentativi di auto-continue`;
      const list = pending.slice(0, 5).map(step => `   ${step}`).join('\n');
      tui.messages.push({
        role: 'system',
        text: `⚠ Piano incompleto: ${remaining} step ancora aperti (${why}).\n${list}`
          + `${pending.length > 5 ? `\n   … e altri ${pending.length - 5}` : ''}`
          + `\n   Auto-resume esaurito (${MAX_AUTO_RESUMES}). Scrivi "continua" per riprendere manualmente, oppure indica il passo successivo.`,
        tools: [],
        id: Date.now(),
      });
      tui.needsRender = true;
      return;
    }
    autoResumeCount++;
    const list = pending.slice(0, 3).map(step => `   ${step}`).join('\n');
    tui.messages.push({
      role: 'system',
      text: `▸ Auto-resume ${autoResumeCount}/${MAX_AUTO_RESUMES}: ${remaining} step dal piano ancora aperti. Continuo automaticamente.\n${list}`,
      tools: [],
      id: Date.now(),
    });
    pendingAutoResume = 'continua con il prossimo step del piano — esegui, non annunciare';
    tui.needsRender = true;
  });

  // The model kept announcing work instead of doing it, and the retries ran
  // out. Same reason as autoContinueExhausted: say why the run stopped.
  emitter.on('announcementStall', ({ attempts, announcement }) => {
    if (autoResumeCount >= MAX_AUTO_RESUMES) {
      tui.messages.push({
        role: 'system',
        text: `⚠ Il modello ha annunciato un'azione senza eseguirla${announcement ? ` ("${announcement}")` : ''}`
          + ` anche dopo ${attempts} solleciti.\n`
          + `   Auto-resume esaurito (${MAX_AUTO_RESUMES}). Scrivi "fallo" per insistere, oppure indica tu il comando/file esatto su cui lavorare.`,
        tools: [],
        id: Date.now(),
      });
      tui.needsRender = true;
      return;
    }
    autoResumeCount++;
    tui.messages.push({
      role: 'system',
      text: `▸ Auto-resume ${autoResumeCount}/${MAX_AUTO_RESUMES} dopo annuncio non eseguito. Forzo esecuzione (era: "${String(announcement || '').slice(0, 80)}").`,
      tools: [],
      id: Date.now(),
    });
    pendingAutoResume = 'esegui il prossimo passo concreto con un tool — smetti di annunciare cosa farai';
    tui.needsRender = true;
  });

  // Auto-compact notifications. The compressor emits these any time it runs;
  // without these handlers the user sees no feedback that compression happened.
  emitter.on('compressPrivacyNotice', () => {
    tui.messages.push({
      role: 'system',
      text: '▸ Auto-compact attivo: quando il contesto supera ~70% verrà riassunto con una chiamata LLM aggiuntiva. Disattivabile con /compress auto off.',
      tools: [],
      id: Date.now(),
    });
    tui.needsRender = true;
  });

  emitter.on('contextCompressed', ({ tokensBefore, tokensAfter, savedTokens }) => {
    const pct = tokensBefore > 0 ? Math.round((savedTokens / tokensBefore) * 100) : 0;
    const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    tui.messages.push({
      role: 'system',
      text: `▸ Contesto compresso: ~${fmt(tokensBefore)} → ~${fmt(tokensAfter)} tokens (-${pct}%)`,
      tools: [],
      id: Date.now(),
    });
    if (tui.streaming) tui.streaming.lastActivityAt = Date.now();
    tui.needsRender = true;
  });

  emitter.on('compressionFallback', ({ reason }) => {
    tui.messages.push({
      role: 'system',
      text: `⚠ Compressione degradata (riassunto fallback senza LLM): ${reason}`,
      tools: [],
      id: Date.now(),
    });
    tui.needsRender = true;
  });

  // ── Token / cost tracking ──────────────────────────────────────────────────
  // Initialise context window size from the current model
  const _initModelMeta = () => {
    const modelId  = connectionManager.activeModel    || '';
    const provider = connectionManager.activeProvider || '';
    const pricing  = getModelPricing(modelId);
    const meta     = PROVIDER_REGISTRY.find(p => p.id === provider);

    tui.tokenMax    = resolveContextWindow();
    // A model is "free" if the provider needs no key, or if it's an OpenRouter free model
    // (detected via the :free suffix or the free flag stored in the model object)
    const providerModels = connectionManager.listModels(provider);
    const activeModelObj = providerModels.success
      ? providerModels.models.find(m => (typeof m === 'string' ? m : m.id) === modelId)
      : null;
    const isOpenRouterFreeModel = activeModelObj?.free === true || modelId.endsWith(':free');
    const isNonMeteredProvider = NON_METERED_PROVIDERS.has(provider);
    tui.isFreeModel = isNonMeteredProvider || (meta ? !meta.requiresKey : false) || isOpenRouterFreeModel;
    tui.costKnown   = !tui.isFreeModel && pricing.in !== null;

    // Model capability: 'full' | 'lite' | 'unknown'
    // Priority: stored capability from API metadata > model-id inference
    const storedCap = activeModelObj?.capability || null;
    if (storedCap) {
      tui.modelCapability = storedCap;
    } else {
      const inferredCap = getModelCapability(modelId, activeModelObj || {});
      if (inferredCap !== 'unknown') {
        tui.modelCapability = inferredCap;
      } else if (!meta?.requiresKey) {
        tui.modelCapability = 'full'; // ollama/nvidia — local, always capable
      } else if (isOpenRouterFreeModel) {
        tui.modelCapability = 'lite'; // :free models default to lite
      } else {
        tui.modelCapability = 'unknown'; // paid API can still be chat-only
      }
    }
    const cw = tui.tokenMax || 128000;
    config.contextWindow = cw;
    if (agent) {
      agent.contextWindow = cw;
      agent.compressor?.updateContextWindow(cw);
    }
  };
  _initModelMeta();
  await rebuildAgent({ announceMemory: true });

  emitter.on('tokenCount', (n) => {
    mission.setTokenCount(n);
    syncMission();
    tui.tokenCount = n;
    tui.needsRender = true;
  });

  emitter.on('toolRoute', ({ count, names, dynamic }) => {
    tui.routedToolCount = Number(count) || 0;
    tui.routedToolNames = Array.isArray(names) ? names : [];
    tui.dynamicToolRouting = dynamic !== false;
    tui.needsRender = true;
  });

  emitter.on('usage', ({ inputTokens, outputTokens }) => {
    if (!inputTokens && !outputTokens) return;
    mission.addUsage({ inputTokens, outputTokens });
    syncMission();
    tui.inputTokensTotal  += inputTokens  || 0;
    tui.outputTokensTotal += outputTokens || 0;
    // Update context estimate from latest input tokens
    if (inputTokens) tui.tokenCount = inputTokens;
    // Calculate cost
    const modelId = connectionManager.activeModel || '';
    const provider = connectionManager.activeProvider || '';
    const cost = NON_METERED_PROVIDERS.has(provider)
      ? 0
      : calcCost(inputTokens || 0, outputTokens || 0, modelId);
    if (cost !== null) {
      tui.sessionCost += cost;
      tui.costKnown    = true;
    }
    // Optional stderr trace for profiling. Same shape as the one-shot path
    // (src/cli/index.js) so output is comparable across the two entry points.
    if (options.verboseTokens) {
      const costStr = NON_METERED_PROVIDERS.has(provider)
        ? 'n/a'
        : `$${tui.sessionCost.toFixed(4)}`;
      process.stderr.write(
        `📊 turn: in=${inputTokens || 0} out=${outputTokens || 0}  ·  session in=${tui.inputTokensTotal} out=${tui.outputTokensTotal} cost=${costStr}\n`,
      );
    }
    tui.needsRender = true;
  });

  // ConnectionManager fires this whenever a provider model list is fetched
  // (boot refresh, TTL expiry, explicit /models refresh). Surface it in the
  // transcript so the user knows the catalog has moved.
  emitter.on('modelsRefreshed', ({ provider, count, ageMs, forced }) => {
    const minutes = ageMs != null ? Math.round(ageMs / 60_000) : null;
    const detail = minutes != null
      ? `(cache was ${minutes}m old${forced ? ', forced' : ''})`
      : '(initial fetch)';
    tui.messages.push({
      role: 'system',
      text: `↻ Refreshed ${count} models for ${provider} ${detail}`,
      tools: [],
      id: Date.now(),
    });
    tui.needsRender = true;
  });

uiBridge.on('fileChanged', ({ type, path, lines, oldLines, newLines, diff }) => {
  mission.fileChanged({ type, path });
  syncMission();
  const fileName = path.split('/').pop();
  const icon = type === 'write' ? '📝' : '✏️';
  // `write` reports a single line count; `edit` reports the before/after pair.
  // Reading `lines` for both is what produced "app.py (undefined lines)".
  let detail;
  if (Number.isFinite(lines)) {
    detail = `${lines} lines`;
  } else if (Number.isFinite(oldLines) && Number.isFinite(newLines)) {
    const delta = Number.isFinite(diff) ? diff : newLines - oldLines;
    detail = `${oldLines} → ${newLines} lines, ${delta > 0 ? '+' : ''}${delta}`;
  } else {
    detail = 'modificato';
  }
  tui.messages.push({ role: 'system', text: `${icon} ${fileName} (${detail})`, tools: [], id: Date.now() });
  tui.needsRender = true;
});

uiBridge.on('askUser', ({ question, options, resolve, sensitive = false }) => {
  // Defense in depth: even though every internal emitter passes string arrays,
  // an LLM-driven ask_user tool call can hand us objects. Normalize so the TUI
  // never renders "[object Object]" as an option label.
  const safeOptions = Array.isArray(options)
    ? options
        .map((o) => {
          if (o == null) return '';
          if (typeof o === 'string') return o;
          if (typeof o === 'object') {
            const label = o.label ?? o.text ?? o.value ?? o.name;
            return typeof label === 'string' ? label : '';
          }
          return String(o);
        })
        .filter(Boolean)
    : [];
  tui.askUser = { question, options: safeOptions, resolve, sensitive: Boolean(sensitive) };
  tui.askUserIdx = 0;
  tui.askUserInput = '';
  tui.needsRender = true;
});

  const onResize = () => {
    process.stdout.write('\x1b[2J\x1b[H');
    tui.updateSize();
    tui.render();
  };
  process.stdout.on('resize', onResize);

  let running = true;
  let renderLoop = null;
  let stallWatchdog = null;

  const startRenderLoop = () => {
    if (renderLoop) return;
    renderLoop = setInterval(() => {
      if (tui.needsRender || tui.isRunning) {
        tui.render();
        tui.needsRender = false;
        // While waiting on a tool, every frame is "activity" — the user sees
        // the screen updating (pulse + elapsed time), so the stall watchdog
        // shouldn't fire on silent tools that don't emit toolProgress. Without
        // this, a 5-minute read on a slow disk triggers the watchdog at 300s
        // even though the user is seeing the UI tick.
        if (tui.isRunning && tui.streaming?.waitKind === 'tool') {
          tui.streaming.lastActivityAt = Date.now();
        }
      }
    }, 16); // Always 60fps when active
  };

  const _stopRenderLoop = () => {
    if (renderLoop) { clearInterval(renderLoop); renderLoop = null; }
  };

  const startStallWatchdog = () => {
    if (stallWatchdog) return;
    stallWatchdog = setInterval(() => {
      if (!running || !tui.isRunning || !tui.streaming) return;
      if (tui.askUser) return; // waiting for user input is expected
      const last = Number(tui.streaming.lastActivityAt) || 0;
      if (!last) return;
      const idleMs = Date.now() - last;
      // Tool calls can legitimately run for several minutes (large bash,
      // webfetch, big file reads). The model itself is expected to stream
      // tokens regularly, so a shorter timeout applies when waiting on it.
      // Exception: MiniMax M2.7 emits no chunks during internal reasoning,
      // so its model-wait phase needs the longer cap too.
      const waitKind = tui.streaming.waitKind || 'model';
      const provider = connectionManager.activeProvider || '';
      const modelId = connectionManager.activeModel || '';
      const longReasoningModel = hasLongReasoningWindow(provider, modelId);
      // Default thresholds tightened from the old 300/120s. Real-world signal
      // shows the model genuinely never responds in 5 minutes — better to
      // fail fast and let the user retry or switch model than to make them
      // stare at a frozen screen. Override with ETTORE_STALL_TIMEOUT_MS env.
      const overrideMs = Number(process.env.ETTORE_STALL_TIMEOUT_MS) || 0;
      const modelStallMs = overrideMs > 0
        ? overrideMs
        : (longReasoningModel ? 180_000 : 90_000);
      const hardStallMs = waitKind === 'tool' ? 300_000 : modelStallMs;
      // Soft warning at 60s (model) / 120s (tool) — push a system message
      // so the user knows to consider ESC. Doesn't cancel anything; just
      // makes the wait actionable instead of mysterious.
      const softWarnMs = waitKind === 'tool' ? 120_000 : 60_000;
      if (idleMs >= softWarnMs && idleMs < softWarnMs + 1500 && !tui.streaming._softWarned) {
        tui.streaming._softWarned = true;
        const idleSec = Math.round(idleMs / 1000);
        const msg = waitKind === 'tool'
          ? `⚠ Tool fermo da ${idleSec}s — se sembra bloccato, premi ESC per annullare.`
          : `⚠ Modello senza risposta da ${idleSec}s — se continua, premi ESC per annullare o cambia modello con /use.`;
        tui.messages.push({ role: 'system', text: msg, tools: [], id: Date.now() });
        tui.needsRender = true;
      }
      if (idleMs < hardStallMs) return;
      const reason = waitKind === 'tool'
        ? `tool fermo da ${Math.round(idleMs / 1000)}s`
        : `nessun token dal modello da ${Math.round(idleMs / 1000)}s`;
      tui.messages.push({
        role: 'assistant',
        text: `Error: stallo rilevato (${reason}). Operazione annullata automaticamente.\n` +
              `Suggerimenti: (1) riprova con /use per cambiare modello, (2) riduci il contesto con /compress, (3) imposta ETTORE_STALL_TIMEOUT_MS per cambiare la soglia.`,
        tools: [],
        id: Date.now(),
      });
      try { agent?.cancel?.(); } catch {}
      tui.isRunning = false;
      tui.streaming = null;
      tui.needsRender = true;
    }, 1000);
  };

  const stopStallWatchdog = () => {
    if (stallWatchdog) { clearInterval(stallWatchdog); stallWatchdog = null; }
  };

  startRenderLoop();
  startStallWatchdog();

  const commandList = Object.entries(builtinCommands).map(([name, cmd]) => ({
    name,
    description: cmd.description || '',
    usage:       cmd.usage || name,
    aliases:     cmd.aliases || [],
  })).sort((a, b) => a.name.localeCompare(b.name));
  let pendingSlashArgs = [];
  let commandPaletteInput = '';

  const updateCommandPaletteInput = (value) => {
    commandPaletteInput = String(value || '');
    tui.commandInput = commandPaletteInput;
    const parts = commandPaletteInput.trim().split(/\s+/).filter(Boolean);
    const commandName = parts.shift() || '';
    pendingSlashArgs = parts;
    tui.filterCommands(commandName);
  };

  const suggestCommand = (input) => {
    const normalized = input.toLowerCase();
    const allNames = commandList.flatMap(cmd => [cmd.name, ...(cmd.aliases || [])]);
    const prefix = allNames.find(name => name.startsWith(normalized) || normalized.startsWith(name));
    if (prefix) return prefix;

    const distance = (a, b) => {
      const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
      for (let j = 1; j <= b.length; j++) dp[0][j] = j;
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          dp[i][j] = a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]) + 1;
        }
      }
      return dp[a.length][b.length];
    };

    const ranked = allNames
      .map(name => ({ name, score: distance(normalized, name) }))
      .sort((a, b) => a.score - b.score);
    return ranked[0]?.score <= 2 ? ranked[0].name : null;
  };

  const executeCommand = async (cmdName, cmdArgs = []) => {
    const showCommandOutput = (title, text) => {
      const raw = sanitizeUiText(text);
      const lines = raw.split('\n').filter(l => l.trim().length > 0);
      const items = (lines.length ? lines : ['(no output)']).map((line, i) => ({
        value: `line_${i}`,
        label: sanitizeUiText(line),
        description: ''
      }));
      items.unshift({ value: '__header', label: `[/${title || cmdName}]`, description: 'output' });
      tui.openSubMenu('output', items);
    };

    if (cmdName === 'models') {
      const [providerArg] = cmdArgs;
      const connections = connectionManager.listConnections();
      if (connections.length === 0) {
        tui.messages.push({ role: 'system', text: 'No connections. Use /connect first.', tools: [], id: Date.now() });
        tui.needsRender = true;
        return;
      }

      // Opening the model picker is an explicit request for the current
      // catalog, so bypass the normal five-minute cache window.
      await Promise.all(connections.map(c => connectionManager.refreshModels(c.provider, { force: true }).catch(() => null)));

      let items = SUBMENU_COMMANDS.models();
      if (providerArg) {
        const wanted = providerArg.toLowerCase();
        items = items.filter(i => String(i.description || '').toLowerCase().startsWith(wanted));
        if (items.length === 0) {
          tui.messages.push({ role: 'system', text: `No models available for provider: ${providerArg}`, tools: [], id: Date.now() });
          tui.needsRender = true;
          return;
        }
      }

      tui.openSubMenu('models', items);
      return;
    }

    if (cmdName === 'connect') {
      const routed = connectProviderToRoute(cmdArgs);
      if (routed) {
        await handleConnectProvider(routed);
        return;
      }
    }

    // Gestione comandi con slash: /team/doganale → team handler con args ['doganale']
    if (cmdName.includes('/')) {
      const [base, ...sub] = cmdName.split('/');
      const baseCmd = builtinCommands[base];
      if (baseCmd) {
        return executeCommand(base, [...sub, ...cmdArgs]);
      }
    }
    const cmd = builtinCommands[cmdName];
    if (!cmd) {
      const suggestion = suggestCommand(cmdName);
      const text = suggestion
        ? `Unknown command: /${cmdName}\nDid you mean /${suggestion}?\nUse /help to list commands.`
        : `Unknown command: /${cmdName}\nUse /help to list commands.`;
      tui.messages.push({ role: 'system', text, tools: [], id: Date.now() });
      tui.needsRender = true;
      return;
    }
    const context = { commandSystem: { list: () => commandList }, config, version: '1.0.0', agent, history: [], emitter, mission, pluginRuntime, rebuildAgent: () => rebuildAgent(), startLoop, stopLoop };
    try {
      const result = await cmd.handler(cmdArgs, context);
      syncMission();
      if (CONNECTION_COMMANDS.has(cmdName)) {
        tui.provider = connectionManager.activeProvider || tui.provider;
        tui.model = connectionManager.activeModel || tui.model;
        _initModelMeta();
        await rebuildAgent();
      }
      if (result && typeof result === 'object' && result.action === 'exit') { autoSaveSessionMemory().finally(() => { cleanup(); process.exit(0); }); return; }
      if (result && typeof result === 'object' && result.action === 'clear') { tui.messages.length = 0; tui.needsRender = true; return; }
      if (result && typeof result === 'object' && result.action === 'setTheme') { setTheme(result.theme); tui.needsRender = true; return; }
      if (typeof result === 'string' && result.length > 0) {
        showCommandOutput(cmdName, result);
        tui.needsRender = true;
      }
    } catch (e) {
      showCommandOutput(cmdName, `Error: ${e.message}`);
      tui.needsRender = true;
    }
  };

  // Hand the terminal over to a provider's interactive sign-in and take it back
  // afterwards. The TUI owns the alternate screen and raw mode, so both have to
  // be released or the child process never sees a keystroke.
  const runInteractiveLogin = async ({ bin, args }) => {
    const { spawn } = await import('child_process');
    tui.render();
    process.stdin.pause();
    try { process.stdin.setRawMode(false); } catch (_) {}
    process.stdout.write(ANSI.bracketedPasteOff + ANSI.show + ANSI.normalScreen);
    const code = await new Promise(resolve => {
      const child = spawn(bin, args, { stdio: 'inherit' });
      child.on('error', () => resolve(-1));
      child.on('close', c => resolve(c ?? -1));
    });
    process.stdout.write(ANSI.altScreen + ANSI.clear + ANSI.home + ANSI.hide + ANSI.bracketedPasteOn);
    try { process.stdin.setRawMode(true); } catch (_) {}
    process.stdin.resume();
    tui.updateSize();
    tui.needsRender = true;
    return code === 0;
  };

  // Handle connect: provider selected -> ask for API key or connect directly
  const handleConnectProvider = async (providerName) => {
    const meta = PROVIDER_REGISTRY.find(p => p.id === providerName);
    if (!meta) {
      tui.messages.push({ role: 'system', text: `Unknown provider: ${providerName}`, tools: [], id: Date.now() });
      tui.needsRender = true;
      return;
    }

    // If already connected, show models sub-menu
    if (connectionManager.isConnected(providerName)) {
      tui.closeSubMenu();
      tui.closeCommandPalette();
      const models = connectionManager.listModels(providerName);
      if (models.success && models.models.length > 0) {
        const modelItems = models.models.map(m => {
          const modelId = typeof m === 'string' ? m : m.id;
          const isActive = modelId === connectionManager.activeModel;
          return { value: `${providerName} ${modelId}`, label: modelLabel(m), description: providerName + (isActive ? ' ← active' : '') };
        });
        tui.openSubMenu('models', modelItems);
      } else {
        tui.messages.push({ role: 'system', text: `Already connected to ${meta.name}`, tools: [], id: Date.now() });
        tui.needsRender = true;
      }
      return;
    }

    // If provider doesn't require a key (e.g. ollama), connect directly
    if (!meta.requiresKey) {
      tui.closeSubMenu();
      tui.closeCommandPalette();
      tui.messages.push({ role: 'system', text: `Connecting to ${meta.name}…`, tools: [], id: Date.now() });
      tui.needsRender = true;

let result = await connectionManager.connect(providerName);
  // No account signed in yet: this is exactly the moment to ask for one,
  // instead of telling the user to go and run another CLI themselves.
  if (!result.success && result.needsLogin) {
    const login = typeof meta.Class === 'function' ? new meta.Class().loginCommand?.() : null;
    if (login) {
      tui.messages.push({ role: 'system', text: `↗ Signing in to ${meta.name} — the terminal is yours until the browser flow finishes…`, tools: [], id: Date.now() });
      tui.needsRender = true;
      await runInteractiveLogin(login);
      result = await connectionManager.connect(providerName);
    }
  }
  if (result.success) {
    tui.provider = providerName;
    const firstModel = result.models[0] || '';
    if (firstModel) {
      connectionManager.setActive(providerName, firstModel);
      tui.model = firstModel;
      _initModelMeta();
      await rebuildAgent();
    }
const models = connectionManager.listModels(providerName);
  if (models.success && models.models.length > 0) {
    const modelItems = models.models.map(m => {
      const modelId = typeof m === 'string' ? m : m.id;
      const isActive = modelId === connectionManager.activeModel;
      return { value: `${providerName} ${modelId}`, label: modelLabel(m), description: providerName + (isActive ? ' ← active' : '') };
    });
    let msg = `✓ Connected to ${meta.name}! ${result.models.length} models available.`;
    const note = connectionManager.getProvider(providerName)?.connectionNote?.();
    if (note) msg += `\n${note}`;
    if (meta.requiresKey && !NON_METERED_PROVIDERS.has(providerName)) {
      msg += `\n⚠️ This is a paid API — you'll be charged per token.`;
    }
tui.messages.push({ role: 'system', text: msg, tools: [], id: Date.now() });
  tui.needsRender = true;
  tui.openSubMenu('models', modelItems);
} else {
  let msg = `✓ Connected to ${meta.name}!`;
  const note = connectionManager.getProvider(providerName)?.connectionNote?.();
  if (note) msg += `\n${note}`;
  if (meta.requiresKey && !NON_METERED_PROVIDERS.has(providerName)) {
    msg += `\n⚠️ This is a paid API — you'll be charged per token.`;
  }
  tui.messages.push({ role: 'system', text: msg, tools: [], id: Date.now() });
  tui.needsRender = true;
}
} else {
tui.messages.push({ role: 'system', text: `✗ ${result.error}`, tools: [], id: Date.now() });
tui.needsRender = true;
}
return;
}

// Provider requires API key - open API key input mode
    tui.closeSubMenu();
    tui.closeCommandPalette();
    tui.openApiKeyInput(providerName, meta);
  };

  // Handle API key submission (single-step or multi-step for requiresBaseUrl providers)
  const handleApiKeySubmit = async () => {
    const providerName = tui.apiKeyProvider;
    const meta         = tui.apiKeyProviderMeta;

    // ── Multi-step wizard for OpenAI-compatible custom endpoint ─────────────
    if (meta?.requiresBaseUrl) {
      if (tui.apiKeyStep === 'baseUrl') {
        const url = tui.apiKeyBaseUrl.trim();
        if (!url) { tui.apiKeyError = 'Please enter a base URL'; tui.needsRender = true; return; }
        if (!/^https?:\/\//i.test(url)) { tui.apiKeyError = 'URL must start with http:// or https://'; tui.needsRender = true; return; }
        tui.nextApiKeyStep();
        return;
      }
      if (tui.apiKeyStep === 'key') {
        const k = tui.apiKeyValue.trim();
        if (!k) { tui.apiKeyError = 'Please enter an API key'; tui.needsRender = true; return; }
        tui.nextApiKeyStep();
        return;
      }
      // step === 'model' — final step: connect
      const model = tui.apiKeyModelValue.trim();
      if (!model) { tui.apiKeyError = 'Please enter a model name'; tui.needsRender = true; return; }

      const apiKey  = tui.apiKeyValue.trim();
      const baseURL = tui.apiKeyBaseUrl.trim();

      tui.apiKeyConnecting = true;
      tui.needsRender = true;

      const result = await connectionManager.connect(providerName, apiKey, { baseURL, model });

      tui.apiKeyConnecting = false;

      if (result.success) {
        tui.closeApiKeyInput();
        tui.provider = providerName;
        connectionManager.setActive(providerName, model);
        tui.model = model;
        _initModelMeta();
        await rebuildAgent();
        tui.messages.push({ role: 'system', text: `✓ Connected to ${meta?.name || providerName}! Active model: ${model}`, tools: [], id: Date.now() });
        tui.needsRender = true;
      } else {
        tui.apiKeyError = result.error || 'Connection failed';
        tui.needsRender = true;
      }
      return;
    }

    // ── Standard single-step flow ────────────────────────────────────────────
    const apiKey = tui.apiKeyValue.trim();
    if (!apiKey) {
      tui.apiKeyError = 'Please enter an API key';
      tui.needsRender = true;
      return;
    }

    tui.apiKeyConnecting = true;
    tui.needsRender = true;

    const result = await connectionManager.connect(providerName, apiKey);

    tui.apiKeyConnecting = false;

if (result.success) {
  tui.closeApiKeyInput();

  tui.provider = providerName;
  const firstModel = result.models[0] || '';
  if (firstModel) {
    connectionManager.setActive(providerName, firstModel);
    tui.model = firstModel;
    _initModelMeta();
    await rebuildAgent();
  }

const modelList = result.models.slice(0, 10).join(', ');
  const more = result.models.length > 10 ? `… and ${result.models.length - 10} more` : '';
  let msg = `✓ Connected to ${meta?.name || providerName}! ${result.models.length} models available.\n Models: ${modelList}${more ? '\n ' + more : ''}`;
  if (meta?.requiresKey && !NON_METERED_PROVIDERS.has(providerName)) {
    const modelsWithMeta = connectionManager.listModels(providerName);
    const freeCount = modelsWithMeta.success
      ? modelsWithMeta.models.filter(m => m?.free === true || (typeof m === 'string' ? m : m.id).endsWith(':free')).length
      : 0;
    if (freeCount > 0) {
      msg += `\n✓ ${freeCount} free model${freeCount !== 1 ? 's' : ''} disponibili — contrassegnati con [FREE]. Gli altri sono a pagamento.`;
    } else {
      msg += `\n⚠️ This is a paid API — you'll be charged per token.`;
    }
  }
  tui.messages.push({ role: 'system', text: msg, tools: [], id: Date.now() });
  tui.needsRender = true;

  // Open models sub-menu so user can pick a model
  const models = connectionManager.listModels(providerName);
  if (models.success && models.models.length > 0) {
    const modelItems = models.models.map(m => {
      const modelId = typeof m === 'string' ? m : m.id;
      const isActive = modelId === connectionManager.activeModel;
      return { value: `${providerName} ${modelId}`, label: modelLabel(m), description: providerName + (isActive ? ' ← active' : '') };
    });
    tui.openSubMenu('models', modelItems);
}
  } else {
    tui.apiKeyError = result.error || 'Invalid API key';
    tui.apiKeyValue = '';
    tui.needsRender = true;
  }
};

const handleCommandSelect = async (cmdName, presetArgs = []) => {
    if (presetArgs.length > 0) {
      await executeCommand(cmdName, presetArgs);
      return;
    }
    if (SUBMENU_COMMANDS[cmdName]) {
      if (cmdName === 'models' || cmdName === 'use' || cmdName === 'select') {
        const connected = connectionManager.listConnections();
        await Promise.all(connected.map(c => connectionManager.refreshModels(c.provider, { force: true }).catch(() => null)));
      }
      const items = SUBMENU_COMMANDS[cmdName]();
      if (items.length > 0 && items[0].value !== '__none') {
        tui.openSubMenu(cmdName, items);
        return;
      }
    }
    await executeCommand(cmdName, presetArgs);
  };

  const handleSubMenuSelect = async (item) => {
    if (!item || item.value === '__none') {
      tui.closeSubMenu();
      tui.closeCommandPalette();
      return;
    }
    const cmdName = tui.subMenuTitle;

    if (cmdName === 'theme') {
      setTheme(item.value);
      tui.closeSubMenu();
      tui.closeCommandPalette();
      tui.messages.push({ role: 'system', text: `✓ Theme set to ${item.label}`, tools: [], id: Date.now() });
      tui.needsRender = true;
      return;
    }

if (cmdName === 'models' || cmdName === 'use' || cmdName === 'select') {
  const [provider, ...modelParts] = item.value.split(' ');
  const model = modelParts.join(' ');
  const result = connectionManager.setActive(provider, model);
  tui.closeSubMenu();
  tui.closeCommandPalette();
  if (result.success) {
    tui.provider = result.provider;
    tui.model = result.model;
    _initModelMeta();
    await rebuildAgent();

    // Check if the selected model is free via object flag or OpenRouter :free suffix convention
    const modelsList = connectionManager.listModels(provider);
    const modelObj = modelsList.success ? modelsList.models.find(m => (typeof m === 'string' ? m : m.id) === model) : null;
    const isFree = NON_METERED_PROVIDERS.has(provider) || modelObj?.free === true || model.endsWith(':free');

    let msg = `✓ Now using: ${result.provider}/${result.model}`;
    if (!isFree) {
      msg += `\n⚠️  This is a paid API — you'll be charged per token.`;
    }
    // Warn if the model may not support tool-use reliably.
    if (tui.modelCapability === 'lite') {
      msg += `\n⚠️  Modello lite — solo chat semplice, niente coding tools (bash/read/write/edit).`;
      msg += `\n   Usa /use per scegliere un modello FULL con tool-use.`;
    } else if (tui.modelCapability === 'unknown') {
      msg += `\n⚠️  Capability non confermata — i tool vengono inviati, ma il modello potrebbe non gestirli.`;
      msg += `\n   Se l'output è incoerente, usa /use per un modello FULL.`;
    }
    tui.messages.push({ role: 'system', text: msg, tools: [], id: Date.now() });
  } else {
    tui.messages.push({ role: 'system', text: `✗ ${result.error}`, tools: [], id: Date.now() });
  }
tui.needsRender = true;
  return;
}

if (cmdName === 'connect') {
      tui.closeSubMenu();
      tui.closeCommandPalette();
      await handleConnectProvider(item.value);
      return;
    }

    if (cmdName === 'disconnect') {
      const result = await connectionManager.disconnect(item.value);
      tui.closeSubMenu();
      tui.closeCommandPalette();
      tui.messages.push({ role: 'system', text: result.success ? `✓ ${result.message}` : `✗ ${result.error}`, tools: [], id: Date.now() });
      tui.needsRender = true;
      return;
    }

    if (cmdName === 'providers') {
      tui.closeSubMenu();
      tui.closeCommandPalette();
      await handleConnectProvider(item.value);
      return;
    }

    if (cmdName === 'output' || cmdName === 'models') {
      // Read-only display submenus: close on select.
      tui.closeSubMenu();
      tui.closeCommandPalette();
      tui.needsRender = true;
      return;
    }

    tui.closeSubMenu();
    tui.closeCommandPalette();
    await executeCommand(cmdName, [item.value]);
  };

  const handleInput = async (text) => {
    if (!running || (!text && tui.attachments.length === 0)) return;
    if (text.startsWith('/')) {
      // Typed slash commands normally enter through the palette; this branch
      // also handles commands pasted into the regular input.
      const typed = text.slice(1).trim();
      const parts = typed.length ? typed.split(/\s+/) : [];
      const rawCmd = parts[0] || '';
      const cmdTokens = rawCmd ? rawCmd.split('/').filter(Boolean) : [];
      const cmdName = cmdTokens[0] || '';
      const inlineArgs = cmdTokens.slice(1);
      const args = [...inlineArgs, ...parts.slice(1)];

      // A full command pasted into the input never passes through the
      // keypress path that opens the palette on `/`. Execute known commands
      // directly so the first Enter behaves like a typed command's Enter.
      if (cmdName && builtinCommands[cmdName]) {
        pendingSlashArgs = [];
        await executeCommand(cmdName, args);
        return;
      }

      pendingSlashArgs = args;

      // Skill Studio is a web action, not a command that needs a palette
      // confirmation. Execute it on the first Enter so `/skills create`
      // behaves like the user expects and opens the page immediately.
      const directSkillCreate = (cmdName === 'skills' || cmdName === 'skill')
        && ['create', 'new'].includes(String(pendingSlashArgs[0] || '').toLowerCase());
      if (directSkillCreate) {
        const args = pendingSlashArgs;
        pendingSlashArgs = [];
        tui.closeCommandPalette();
        await executeCommand(cmdName === 'skill' ? 'skills' : cmdName, args);
        return;
      }

      tui.openCommandPalette(commandList);
      updateCommandPaletteInput([cmdName, ...pendingSlashArgs].filter(Boolean).join(' '));
      return;
    }
    const cleanUserText = sanitizeModelText(text);
    const imageRefs = extractImageReferences(cleanUserText);
    const selectedPaths = tui.attachments.map(file => file.path);
    let attachments = [];
    try {
      attachments = await loadAttachments([...imageRefs.paths, ...selectedPaths], { cwd: config.workdir });
    } catch (error) {
      tui.messages.push({ role: 'system', text: `Attachment error: ${error.message}`, tools: [], id: Date.now() });
      tui.needsRender = true;
      return;
    }
    const imageAttachments = attachments.filter(file => file.kind === 'image');
    const agentText = buildAttachmentPrompt(imageRefs.text, attachments);
    const displayText = [imageRefs.text, ...attachments.map(file => `📎 ${file.name}`)].filter(Boolean).join('\n');
    tui.clearAttachments();
    if (!agent) {
      tui.messages.push({ role: 'user', text: displayText, tools: [], id: Date.now() });
      tui.messages.push({
        role: 'assistant',
        text: 'Not connected yet.\nUse /connect to choose a provider, or /providers to inspect available options.',
        tools: [],
        id: Date.now()
      });
      tui.needsRender = true;
      return;
    }
    // A new user prompt is the most decisive signal that the user is back
    // in control. Wipe the auto-resume budget so a model that was looping
    // gets a clean budget tied to this new turn, not the previous one's
    // stall count.
    autoResumeCount = 0;
    pendingAutoResume = null;
    lastResumeSignature = null;
    await runAgent(agentText, imageAttachments, displayText);
  };

  const openAttachmentPicker = async () => {
    if (tui.isRunning) return;
    tui.openFilePicker({ selecting: true });
    try {
      const selectedPaths = await chooseFiles({ cwd: config.workdir, multiple: true });
      if (selectedPaths.length === 0) {
        tui.closeFilePicker();
        return;
      }
      const files = await loadAttachments(selectedPaths, { cwd: config.workdir });
      for (const file of files) tui.addAttachment(file);
      tui.closeFilePicker();
    } catch (error) {
      if (tui.filePicker) tui.filePicker.error = error.message;
      tui.needsRender = true;
    }
  };

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let inBracketedPaste = false;
  let bracketedPasteBuffer = '';
  let suppressKeypressUntil = 0;

  const appendPastedText = (rawText) => {
    const normalized = String(rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '');
    if (!normalized) return;
    if (tui.apiKeyInputMode) {
      // API key/baseURL/model fields are single-line; drop pasted newlines.
      const compact = normalized.replace(/\n/g, '');
      if (!compact) return;
      for (const ch of compact) tui.addApiKeyChar(ch);
    } else if (tui.askUser) {
      tui.askUserInput = (tui.askUserInput || '') + normalized.replace(/\n/g, '');
      tui.needsRender = true;
    } else if (tui.commandPaletteOpen) {
      // Keep pasted slash commands in the palette state. Otherwise the first
      // Enter only opens the palette again instead of executing the command.
      const pasted = normalized.replace(/\n/g, ' ');
      const value = commandPaletteInput ? commandPaletteInput + pasted : pasted.replace(/^\/+/, '');
      updateCommandPaletteInput(value);
    } else {
      tui.setInput((tui.input || '') + normalized);
    }
    suppressKeypressUntil = Date.now() + 120;
  };

  process.stdin.on('data', (chunk) => {
    if (!running) return;
    const text = chunk?.toString?.('utf8') || '';
    if (!text) return;

    // Primary path: bracketed paste (ESC[200~ ... ESC[201~)
    if (inBracketedPaste || text.includes('\x1b[200~')) {
      let i = 0;
      while (i < text.length) {
        if (!inBracketedPaste) {
          const start = text.indexOf('\x1b[200~', i);
          if (start === -1) break;
          inBracketedPaste = true;
          bracketedPasteBuffer = '';
          i = start + '\x1b[200~'.length;
          continue;
        }
        const end = text.indexOf('\x1b[201~', i);
        if (end === -1) {
          bracketedPasteBuffer += text.slice(i);
          break;
        }
        bracketedPasteBuffer += text.slice(i, end);
        appendPastedText(bracketedPasteBuffer);
        bracketedPasteBuffer = '';
        inBracketedPaste = false;
        i = end + '\x1b[201~'.length;
      }
      return;
    }

    // Fallback: some terminals send multiline paste without bracketed markers.
    if (text.length > 1 && text.includes('\n')) {
      appendPastedText(text);
    }
  });

  process.stdin.on('keypress', async (str, key) => {
    if (!running) return;
    if (inBracketedPaste) return;
    // Pasting can generate duplicate keypress events for the pasted
    // characters, but Enter must remain responsive so a pasted `/loop` can
    // be submitted immediately.
    if (Date.now() < suppressKeypressUntil
      && key?.name !== 'return' && key?.name !== 'enter') return;

    if (key?.ctrl && key.name === 'c') {
      if (tui.askUser) {
        const resolve = tui.askUser.resolve;
        tui.messages.push({ role: 'system', text: '✗ Cancelled', tools: [], id: Date.now() });
        tui.askUser = null;
        tui.askUserInput = '';
        tui.needsRender = true;
        resolve('__cancelled__');
        return;
      }
      if (tui.apiKeyInputMode) { tui.closeApiKeyInput(); return; }
      if (tui.filePicker) { tui.closeFilePicker(); return; }
      if (tui.subMenuOpen) { tui.closeSubMenu(); tui.closeCommandPalette(); return; }
      if (tui.commandPaletteOpen) { tui.closeCommandPalette(); return; }
      if (tui.isRunning) { agent?.cancel(); } else { autoSaveSessionMemory().finally(() => { cleanup(); process.exit(0); }); }
      return;
    }

    if (key?.name === 'escape') {
      if (tui.askUser) {
        const resolve = tui.askUser.resolve;
        tui.messages.push({ role: 'system', text: '✗ Cancelled', tools: [], id: Date.now() });
        tui.askUser = null;
        tui.askUserInput = '';
        tui.needsRender = true;
        resolve('__cancelled__');
        return;
      }
      if (tui.apiKeyInputMode) { tui.closeApiKeyInput(); return; }
      if (tui.filePicker) { tui.closeFilePicker(); return; }
      if (tui.subMenuOpen) { tui.closeSubMenu(); tui.closeCommandPalette(); return; }
      if (tui.commandPaletteOpen) { pendingSlashArgs = []; tui.closeCommandPalette(); return; }
      if (tui.exitConfirmMode) { tui.exitConfirmMode = false; tui.needsRender = true; return; }
      if (tui.isRunning) agent?.cancel();
      tui.exitConfirmMode = true;
      tui.messages.push({ role: 'system', text: 'Uscire? Premi Y + Invio per confermare, ESC per annullare', tools: [], id: Date.now() });
      tui.needsRender = true;
      return;
    }

    // Ask user mode - separate modal for both multiple-choice and free-text
    if (tui.askUser) {
      const hasOptions = Array.isArray(tui.askUser.options) && tui.askUser.options.length > 0;
      if (hasOptions) {
        if (key?.name === 'up') {
          tui.askUserIdx = Math.max(0, tui.askUserIdx - 1);
          tui.needsRender = true;
          return;
        }
        if (key?.name === 'down') {
          tui.askUserIdx = Math.min(tui.askUser.options.length - 1, tui.askUserIdx + 1);
          tui.needsRender = true;
          return;
        }
        if (key?.name === 'return' || key?.name === 'enter') {
          const choice = tui.askUser.options[tui.askUserIdx];
          const resolve = tui.askUser.resolve;
          tui.messages.push({ role: 'system', text: `✓ Selected: ${choice}`, tools: [], id: Date.now() });
          tui.askUser = null;
          tui.askUserInput = '';
          tui.needsRender = true;
          resolve(choice);
          return;
        }
        return;
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        const answer = (tui.askUserInput || '').trim();
        if (!answer) return;
        const sensitive = Boolean(tui.askUser.sensitive);
        const resolve = tui.askUser.resolve;
        tui.messages.push({
          role: 'system',
          text: sensitive ? '✓ Answered securely' : `✓ Answered: ${answer}`,
          tools: [],
          id: Date.now(),
        });
        tui.askUser = null;
        tui.askUserInput = '';
        tui.needsRender = true;
        resolve(answer);
        return;
      }
      if (key?.name === 'backspace') {
        tui.askUserInput = (tui.askUserInput || '').slice(0, -1);
        tui.needsRender = true;
        return;
      }
      if (str && !key?.ctrl && !key?.meta && str.codePointAt(0) >= 32) {
        tui.askUserInput = (tui.askUserInput || '') + str;
        tui.needsRender = true;
        return;
      }
      return;
    }

  // Exit confirmation mode
  if (tui.exitConfirmMode) {
    if (key?.name === 'return' || key?.name === 'enter') {
      const input = tui.input.trim().toLowerCase();
      tui.exitConfirmMode = false;
      tui.clearInput();
      if (input === 'y' || input === 's') {
        autoSaveSessionMemory().finally(() => { cleanup(); process.exit(0); });
      }
      return;
    }
    if (key?.name === 'escape') {
      tui.exitConfirmMode = false;
      tui.needsRender = true;
      return;
    }
    if (key?.name === 'backspace') {
      tui.removeChar();
      return;
    }
    if (str && str.codePointAt(0) >= 32) {
      tui.addChar(str);
      return;
    }
    return;
  }

  // API key input mode
    if (tui.apiKeyInputMode) {
      if (key?.name === 'return' || key?.name === 'enter') {
        await handleApiKeySubmit();
        return;
      }
      if (key?.name === 'backspace') {
        tui.removeApiKeyChar();
        return;
      }
      if (key?.name === 'left') {
        tui.closeApiKeyInput();
        const items = SUBMENU_COMMANDS.connect();
        tui.openCommandPalette(commandList);
        tui.openSubMenu('connect', items);
        return;
      }
      if (str && !key?.ctrl && !key?.meta && str.codePointAt(0) >= 32) {
        tui.addApiKeyChar(str);
        return;
      }
      return;
    }

    // Sub-menu mode
    if (tui.subMenuOpen) {
      if (key?.name === 'return' || key?.name === 'enter') {
        const item = tui.getSelectedSubItem();
        await handleSubMenuSelect(item);
        return;
      }
      if (key?.name === 'up') { tui.selectSubMenuUp(); return; }
      if (key?.name === 'down') { tui.selectSubMenuDown(); return; }
      if (key?.name === 'pageup') {
        const step = Math.max(1, tui.availableHeight - 4);
        for (let i = 0; i < step; i++) tui.selectSubMenuUp();
        return;
      }
      if (key?.name === 'pagedown') {
        const step = Math.max(1, tui.availableHeight - 4);
        for (let i = 0; i < step; i++) tui.selectSubMenuDown();
        return;
      }
      if (key?.name === 'home') {
        tui.subMenuIndex = 0;
        tui.subMenuScrollOffset = 0;
        tui.needsRender = true;
        return;
      }
      if (key?.name === 'end') {
        tui.subMenuIndex = tui.subMenuFiltered.length - 1;
        tui.subMenuScrollOffset = Math.max(0, tui.subMenuFiltered.length - (tui.availableHeight - 4));
        tui.needsRender = true;
        return;
      }
      if (key?.name === 'backspace') {
        if (tui.subMenuFilter.length > 0) {
          tui.filterSubMenu(tui.subMenuFilter.slice(0, -1));
        } else {
          tui.closeSubMenu();
          tui.commandPaletteOpen = true;
        }
        return;
      }
      if (key?.name === 'left') {
        tui.closeSubMenu();
        tui.commandPaletteOpen = true;
        return;
      }
      if (str && !key?.ctrl && !key?.meta && str.codePointAt(0) >= 32) {
        tui.filterSubMenu(tui.subMenuFilter + str);
        return;
      }
      return;
    }

    // Command palette mode
    if (tui.commandPaletteOpen) {
      if (key?.name === 'return' || key?.name === 'enter') {
        const cmd = tui.getSelectedCommand();
        if (cmd) {
          tui.commandPaletteOpen = false;
          tui.commandFilter = '';
          tui.commandInput = '';
          commandPaletteInput = '';
          const args = pendingSlashArgs;
          pendingSlashArgs = [];
          await handleCommandSelect(cmd.name, args);
        } else {
          pendingSlashArgs = [];
          tui.closeCommandPalette();
        }
        return;
      }
      if (key?.name === 'up') { tui.selectCommandUp(); return; }
      if (key?.name === 'down') { tui.selectCommandDown(); return; }
      if (key?.name === 'pageup') {
        const step = Math.max(1, tui.availableHeight - 2);
        for (let i = 0; i < step; i++) tui.selectCommandUp();
        return;
      }
      if (key?.name === 'pagedown') {
        const step = Math.max(1, tui.availableHeight - 2);
        for (let i = 0; i < step; i++) tui.selectCommandDown();
        return;
      }
      if (key?.name === 'home') {
        tui.commandIndex = 0;
        tui.commandScrollOffset = 0;
        tui.needsRender = true;
        return;
      }
      if (key?.name === 'end') {
        tui.commandIndex = tui.commandFiltered.length - 1;
        tui.commandScrollOffset = Math.max(0, tui.commandFiltered.length - (tui.availableHeight - 2));
        tui.needsRender = true;
        return;
      }
      if (key?.name === 'backspace') {
        if (commandPaletteInput.length > 0) {
          updateCommandPaletteInput(commandPaletteInput.slice(0, -1));
        } else {
          pendingSlashArgs = [];
          tui.closeCommandPalette();
        }
        return;
      }
      if (str && !key?.ctrl && !key?.meta && str.codePointAt(0) >= 32) {
        updateCommandPaletteInput(commandPaletteInput + str);
        return;
      }
      return;
    }

    // Exit confirmation mode
    if (tui.exitConfirmMode) {
      if (str === 'y' || str === 'Y') {
        tui.exitConfirmMode = false;
        autoSaveSessionMemory().finally(() => { cleanup(); process.exit(0); });
        return;
      }
      tui.exitConfirmMode = false;
      tui.needsRender = true;
      return;
    }

    // Normal mode
    if (key?.ctrl && key.name === 'u') { tui.clearInput(); return; }

    if (key?.ctrl && key.name === 'o') {
      if (!tui.filePicker) await openAttachmentPicker();
      return;
    }

    if (tui.filePicker) {
      return;
    }

    if (key?.name === 'return' || key?.name === 'enter') {
      const text = tui.input.trim();
      tui.clearInput();
      tui.scrollOffset = 0;
      if (text) await handleInput(text);
      return;
    }

    if (key?.name === 'backspace') {
      if (!tui.input && tui.attachments.length > 0) {
        tui.removeLastAttachment();
        return;
      }
      tui.removeChar();
      return;
    }
    if (key?.name === 'tab') {
      syncModeWithAgent(tui, agent);
      return;
    }
    if (key?.name === 'up') { tui.scrollOffset += 3; tui.needsRender = true; return; }
    if (key?.name === 'down') { tui.scrollOffset = Math.max(0, tui.scrollOffset - 3); tui.needsRender = true; return; }
    if (key?.name === 'pageup') { tui.scrollOffset += Math.max(1, Math.floor(tui.availableHeight * 0.8)); tui.needsRender = true; return; }
    if (key?.name === 'pagedown') { tui.scrollOffset = Math.max(0, tui.scrollOffset - Math.max(1, Math.floor(tui.availableHeight * 0.8))); tui.needsRender = true; return; }

    if (str === '/' && tui.input === '' && !tui.isRunning) {
      pendingSlashArgs = [];
      commandPaletteInput = '';
      tui.openCommandPalette(commandList);
      return;
    }

    if (str && !key?.ctrl && !key?.meta && str.codePointAt(0) >= 32) {
      tui.addChar(str);
      return;
    }
  });

  /**
   * Extract a compact session summary from conversation messages (no LLM call).
   * Saves the summary to .ettore/memory.md before exit.
   */
  async function autoSaveSessionMemory() {
    if (!agent) return;
    const userMsgs = (agent.messages || []).filter(m => m.role === 'user');
    if (userMsgs.length === 0) return; // nothing to save

    try {
      const { updateMemorySection } = await import('../memory/index.js');
      const root = agent._workdir || process.cwd();

      // Collect user topics (keep a wider history window)
      const topics = userMsgs
        .map(m => {
          const content = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.filter(block => block?.type === 'text').map(block => block.text || '').join(' ')
              : '';
          return content.slice(0, 140).replace(/\n/g, ' ').trim();
        })
        .filter(Boolean)
        .slice(-20);

      // Collect latest assistant outcomes
      const assistantMsgs = (agent.messages || [])
        .filter(m => m.role === 'assistant' && typeof m.content === 'string')
        .map(m => m.content.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(-8)
        .map(t => t.slice(0, 200));

      // Collect file paths observed in tool outputs
      const filePaths = new Set();
      for (const m of agent.messages) {
        if (m.role === 'tool' && typeof m.content === 'string') {
          const matches = m.content.match(/(?:^|\s)(\/[\w./\-_]+\.\w+)/gm) || [];
          matches.forEach(p => filePaths.add(p.trim()));
        }
      }

      // Collect tool usage stats
      const toolCounts = {};
      for (const m of agent.messages) {
        if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
        for (const tc of m.tool_calls) {
          const name = tc?.function?.name;
          if (!name) continue;
          toolCounts[name] = (toolCounts[name] || 0) + 1;
        }
      }
      const toolSummary = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => `${name}:${count}`)
        .join(', ');

      const date = new Date().toISOString().slice(0, 10);
      let note = `[${date}] Sessione — ${topics.length} richieste utente.`;
      if (topics.length > 0) note += `\nArgomenti: ${topics.join(' | ')}`;
      if (assistantMsgs.length > 0) note += `\nEsiti assistente: ${assistantMsgs.join(' | ')}`;
      if (filePaths.size > 0) note += `\nFile toccati: ${[...filePaths].slice(0, 30).join(', ')}`;
      if (toolSummary) note += `\nTool usati: ${toolSummary}`;

      await updateMemorySection(root, 'DECISIONS', note, 'append');
    } catch { /* silent — never block exit */ }
  }

  const cleanup = () => {
    running = false;
    clearInterval(renderLoop);
    stopStallWatchdog();
    process.stdout.off('resize', onResize);
    try { process.stdin.setRawMode(false); } catch (_) {}
    process.stdout.write(ANSI.bracketedPasteOff + ANSI.show + ANSI.normalScreen + ANSI.clear + ANSI.home);
  };

  process.on('SIGTERM', () => { autoSaveSessionMemory().finally(() => { cleanup(); process.exit(0); }); });
  tui.render();

  return new Promise((resolve) => {
    process.stdin.on('end', () => { cleanup(); resolve(); });
  });
}
