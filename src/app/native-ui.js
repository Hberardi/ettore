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
import { listInstallSessionApprovals } from '../tools/index.js';
import { builtinCommands } from '../commands/index.js';
import { getModelPricing, calcCost } from '../utils/pricing.js';
import { stripAllAnsi } from '../utils/ansi.js';
import { getModelCapability } from '../providers/model_capability.js';

const NON_METERED_PROVIDERS = new Set(['ollama', 'nvidia', 'minimax']);

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
  return m.free ? `${id} [FREE]` : id;
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

  const p = connectionManager.activeProvider || 'unknown';
  const m = connectionManager.activeModel   || 'unknown';
  const session = await createSession(p, m);
  tui.sessionId = session.id;
  tui.provider  = p;
  tui.model     = m;

  const emitter = new EventEmitter();

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
  const STALL_MS = 1800;

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
      glob: ['Mappare i file utili al task', args.pattern ? `Prossimo passo: cerco con pattern ${sanitizeIntentText(args.pattern)}` : 'Prossimo passo: cerco i file pertinenti'],
      grep: ['Trovare i punti di codice rilevanti', args.pattern ? `Prossimo passo: cerco "${sanitizeIntentText(args.pattern)}"` : 'Prossimo passo: cerco il pattern richiesto'],
      list_dir: ['Capire la struttura del progetto', args.path ? `Prossimo passo: esploro ${sanitizeIntentText(args.path)}` : 'Prossimo passo: esploro le directory principali'],
      file_info: ['Verificare i dettagli di file/cartelle', args.path ? `Prossimo passo: controllo metadata di ${sanitizeIntentText(args.path)}` : 'Prossimo passo: controllo i metadata necessari'],
      git_status: ['Verificare lo stato del repository', 'Prossimo passo: controllo branch e working tree'],
      git_diff: ['Analizzare le modifiche in corso', 'Prossimo passo: leggo il diff rilevante'],
      websearch: ['Raccogliere informazioni aggiornate', args.query ? `Prossimo passo: cerco "${sanitizeIntentText(args.query)}"` : 'Prossimo passo: effettuo una ricerca web'],
      webfetch: ['Leggere contenuto di una pagina specifica', args.url ? `Prossimo passo: apro ${sanitizeIntentText(args.url)}` : 'Prossimo passo: apro la pagina richiesta'],
      bash: ['Eseguire una verifica operativa', args.command ? `Prossimo passo: eseguo ${sanitizeIntentText(args.command, 80)}` : 'Prossimo passo: eseguo il comando necessario'],
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

  emitter.on('toolStart', ({ id, name, args }) => {
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
    scheduleRender();
  });

  emitter.on('toolEnd', ({ id, name: _name, output }) => {
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
      tui.render(); // Immediate render for tool completion
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

  // The run has finished — every step is done by definition. Drop the task
  // list from the conversation so the panel clears instead of leaving a stale
  // "Tasks" block in the scrollback. Splice in place: reassigning tui.messages
  // would lose the patched .push above.
  const completePendingTodos = () => {
    if (!Array.isArray(tui.todos) || tui.todos.length === 0) return;
    for (let i = tui.messages.length - 1; i >= 0; i--) {
      if (tui.messages[i].role === 'todos') tui.messages.splice(i, 1);
    }
    tui.todos = [];
    tui.currentPlan = [];
  };

  emitter.on('complete', (content) => {
    tui.isRunning = false;
    flushTokenBuffer();
    completePendingTodos();
    const text  = sanitizeModelText(tui.streaming?.text || content || '');
    const tools = tui.streaming?.tools || [];
    tui.messages.push({ role: 'assistant', text, tools, id: Date.now() });
    tui.streaming   = null;
    reasoningText = '';
    firstToolSeen = false;
    lastToolIntent = '';
    tokenBuffer = '';
    tui.needsRender = true;
  });

  emitter.on('cancelled', () => {
    tui.isRunning = false;
    flushTokenBuffer();
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
    tui.isRunning   = false;
    tui.streaming   = null;
    lastToolIntent = '';
    tokenBuffer = '';
    tui.messages.push({ role: 'assistant', text: `Error: ${msg}`, tools: [], id: Date.now() });
    tui.needsRender = true;
  });

  emitter.on('todoList', (items) => {
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
    tui.todos.forEach((t, i) => { if (i <= idx) t.status = 'done'; });
    tui.currentPlan = [...tui.todos];
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
    tui.tokenCount = n;
    tui.needsRender = true;
  });

  emitter.on('usage', ({ inputTokens, outputTokens }) => {
    if (!inputTokens && !outputTokens) return;
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
    tui.needsRender = true;
  });

uiBridge.on('fileChanged', ({ type, path, lines }) => {
  const fileName = path.split('/').pop();
  const icon = type === 'write' ? '📝' : '✏️';
  tui.messages.push({ role: 'system', text: `${icon} ${fileName} (${lines} lines)`, tools: [], id: Date.now() });
  tui.needsRender = true;
});

uiBridge.on('askUser', ({ question, options, resolve }) => {
  const safeOptions = Array.isArray(options) ? options : [];
  tui.askUser = { question, options: safeOptions, resolve };
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
      const waitKind = tui.streaming.waitKind || 'model';
      const hardStallMs = waitKind === 'tool' ? 300_000 : 120_000;
      if (idleMs < hardStallMs) return;
      const reason = waitKind === 'tool'
        ? `tool fermo da ${Math.round(idleMs / 1000)}s`
        : `nessun token dal modello da ${Math.round(idleMs / 1000)}s`;
      tui.messages.push({
        role: 'assistant',
        text: `Error: stallo rilevato (${reason}). Operazione annullata automaticamente.`,
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

      await Promise.all(connections.map(c => connectionManager.refreshModels(c.provider).catch(() => null)));

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
    const context = { commandSystem: { list: () => commandList }, config, version: '1.0.0', agent, history: [] };
    try {
      const result = await cmd.handler(cmdArgs, context);
      if (result && typeof result === 'object' && result.action === 'exit') { autoSaveSessionMemory().finally(() => { cleanup(); process.exit(0); }); return; }
      if (result && typeof result === 'object' && result.action === 'clear') { tui.messages = []; tui.needsRender = true; return; }
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

const result = await connectionManager.connect(providerName);
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
    if (meta.requiresKey && !NON_METERED_PROVIDERS.has(providerName)) {
      msg += `\n⚠️ This is a paid API — you'll be charged per token.`;
    }
tui.messages.push({ role: 'system', text: msg, tools: [], id: Date.now() });
  tui.needsRender = true;
  tui.openSubMenu('models', modelItems);
} else {
  let msg = `✓ Connected to ${meta.name}!`;
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
        await Promise.all(connected.map(c => connectionManager.refreshModels(c.provider).catch(() => null)));
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
    if (tui.modelCapability === 'lite' || tui.modelCapability === 'unknown') {
      const capLabel = tui.modelCapability === 'unknown' ? 'non confermato per tool-use' : 'lite';
      msg += `\n⚠️  Modello ${capLabel} — solo chat semplice, niente coding tools (bash/read/write/edit).`;
      msg += `\n   Usa /use per scegliere un modello FULL con tool-use.`;
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
    if (!running || !text) return;
    if (text.startsWith('/')) {
      // Slash commands are form-first: never execute directly from input.
      // Open command palette with prefilled filter so the user always
      // confirms via the dedicated UI form/submenu.
      const typed = text.slice(1).trim();
      const parts = typed.length ? typed.split(/\s+/) : [];
      const rawCmd = parts[0] || '';
      const cmdTokens = rawCmd ? rawCmd.split('/').filter(Boolean) : [];
      const cmdName = cmdTokens[0] || '';
      const inlineArgs = cmdTokens.slice(1);
      pendingSlashArgs = [...inlineArgs, ...parts.slice(1)];
      tui.openCommandPalette(commandList);
      if (cmdName) tui.filterCommands(cmdName);
      return;
    }
    const cleanUserText = sanitizeModelText(text);
    tui.messages.push({ role: 'user', text: cleanUserText, tools: [], id: Date.now() });
    tui.needsRender = true;
    if (!agent) {
      tui.messages.push({
        role: 'assistant',
        text: 'Not connected yet.\nUse /connect to choose a provider, or /providers to inspect available options.',
        tools: [],
        id: Date.now()
      });
      tui.needsRender = true;
      return;
    }
    tui.isRunning = true;
    tui.streaming = { text: '', tools: [], reasoning: '', waitKind: 'model', lastActivityAt: Date.now(), stallMs: STALL_MS };
    reasoningText = '';
    firstToolSeen = false;
    tui.needsRender = true;
    agent.run(cleanUserText, emitter).then(async () => {
      session.messages = agent.messages;
      await saveSession(session).catch(() => {});
    }).catch(() => {});
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
    tui.setInput((tui.input || '') + normalized);
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
    if (Date.now() < suppressKeypressUntil) return;

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
        const resolve = tui.askUser.resolve;
        tui.messages.push({ role: 'system', text: `✓ Answered: ${answer}`, tools: [], id: Date.now() });
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
        if (tui.commandFilter.length > 0) {
          tui.commandFilter = tui.commandFilter.slice(0, -1);
          tui.filterCommands(tui.commandFilter);
        } else {
          pendingSlashArgs = [];
          tui.closeCommandPalette();
        }
        return;
      }
      if (str && !key?.ctrl && !key?.meta && str.codePointAt(0) >= 32) {
        tui.commandFilter += str;
        tui.filterCommands(tui.commandFilter);
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

    if (key?.name === 'return' || key?.name === 'enter') {
      const text = tui.input.trim();
      tui.clearInput();
      tui.scrollOffset = 0;
      if (text) await handleInput(text);
      return;
    }

    if (key?.name === 'backspace') { tui.removeChar(); return; }
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
        .map(m => (typeof m.content === 'string' ? m.content : '').slice(0, 140).replace(/\n/g, ' ').trim())
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
