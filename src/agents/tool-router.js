const BASE_PLAN = [
  'repo_map',
  'repo_find_symbol',
  'read',
  'grep',
  'glob',
  'list_dir',
  'file_info',
  'git_status',
  'git_diff',
  'ask_user',
];

const BASE_BUILD = [
  'repo_map',
  'repo_find_symbol',
  'read',
  'grep',
  'git_status',
  'git_diff',
  'ask_user',
  'todo_write',
  'memory_write',
];

// Changing files is what build mode is *for*. These used to be gated behind
// an edit-intent regex over the current prompt, so any turn whose wording did
// not look like an edit request — "continua", "vai avanti", the auto-resume
// continuation, a bug report like "il menu non si vede" — reached the model
// with no way to write. It then correctly answered that it had no writing
// tool, and the run stalled on an explanation instead of a change. Worse, the
// recovery overlay that orders the model to "use write/edit tools" was sent
// with those very tools removed.
const MUTATION_TOOLS = ['write', 'edit', 'apply_patch_structured'];

// Running things and checking the result stays situational: useful around an
// edit, noise in the middle of a plain question.
const EXEC_TOOLS = ['run_checks', 'run_tests', 'bash_session'];

const EDIT_TOOLS = [...MUTATION_TOOLS, ...EXEC_TOOLS];

const VERIFY_TOOLS = ['run_checks', 'run_tests', 'bash', 'bash_session', 'read', 'git_diff'];
const WEB_TOOLS = ['websearch', 'webfetch', 'web_image'];
const DOCUMENT_TOOLS = ['read_pdf', 'read_doc'];
const RUNTIME_TOOLS = ['dev_server', 'browser_app', 'desktop_app', 'browser_check', 'read_server_console'];
const DEPENDENCY_TOOLS = ['dep_inspect', 'bash'];

const EDIT_INTENT_RE = /\b(edit|modify|change|update|fix|create|write|implement|patch|refactor|build|add|remove|rename|modifica|cambia|aggiorna|correggi|crea|scrivi|implementa|sistema|aggiungi|rimuovi|rinomina)\b/i;
// A recovery overlay demanding an edit is an edit request, whoever wrote it.
const EDIT_OVERLAY_RE = /\bwrite\b|\bedit\b|carry out the announced action/i;
// "continua" and friends carry no intent of their own: they continue whatever
// the previous prompt asked for, so the caller's sticky intent must survive.
const CONTINUATION_PROMPT_RE = /^\s*(?:continua|prosegui|vai(?:\s+avanti)?|avanti|procedi|dai|ok(?:ay)?|va\s+bene|continue|go\s+on|keep\s+going|next|proceed|resume)\b/i;

const WEB_INTENT_RE = /\b(latest|current|today|news|web|online|website|url|docs?|documentation|internet|image|images|photo|picture|aggiornat[oaie]|oggi|notizie|sito|pagina|immagin[ei]|foto)\b/i;
const DOCUMENT_INTENT_RE = /\b(pdf|docx?|odt|document[oi]?)\b/i;
const VIDEO_INTENT_RE = /\b(youtube|youtu\.be|video|trascrivi|transcript)\b/i;
const RUNTIME_INTENT_RE = /\b(server|browser|page|frontend|runtime|console|logs?|localhost|porta|errore.*avvio|app|apps?|webapp|desktop|gui|ui|window|finestra|schermata|screenshot|click|clicca|electron|tk|qt|gtk|prova(?:re|la|lo)?|test(?:are|a)?\s+l['’]?app)\b/i;
const DEPENDENCY_INTENT_RE = /\b(dependenc|package|npm|pnpm|yarn|pip|cargo|vulnerab|audit|dipendenz|pacchett)\b/i;
const SHELL_INTENT_RE = /\b(command|shell|terminal|bash|script|execute|run|comando|terminale|esegui)\b/i;

export function promptHasEditIntent(text) {
  return EDIT_INTENT_RE.test(String(text || ''));
}

export function isContinuationPrompt(text) {
  return CONTINUATION_PROMPT_RE.test(String(text || ''));
}

function addMany(target, names) {
  for (const name of names) target.add(name);
}


// Words too common to distinguish one tool from another, in the two languages
// prompts here are written in.
const RANK_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'use', 'using',
  'run', 'get', 'set', 'all', 'any', 'per', 'del', 'della', 'delle', 'dei',
  'con', 'una', 'uno', 'che', 'come', 'nel', 'nella', 'sul', 'sulla', 'fai',
  'tool', 'file', 'data',
]);

function rankTokens(value) {
  return new Set(String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !RANK_STOP.has(w)));
}

/**
 * Orders plugin tool names by how well each matches the prompt.
 *
 * Lexical only — name and description against the words asked for, with a
 * shared prefix counting for less than an exact word so an Italian prompt can
 * still reach an English tool name. It cannot know what a plugin does; it can
 * tell that "restore del database" has more to do with `pg_restore_wizard`
 * than with `excel_set_style`, and that is the whole of what the arbitrary
 * ordering was missing. Ties keep their original order, so a prompt that
 * matches nothing behaves exactly as before.
 */
export function rankPluginTools(definitions, names, prompt) {
  const wanted = rankTokens(prompt);
  if (!wanted.size || names.length <= 1) return names.slice();
  const byName = new Map(definitions.map(d => [d.function?.name, d]));

  const ranked = names
    .map((name, index) => {
      const def = byName.get(name);
      const terms = rankTokens(`${name} ${def?.function?.description || ''}`);
      let score = 0;
      for (const term of terms) {
        if (wanted.has(term)) { score += 1; continue; }
        for (const word of wanted) {
          const [short, long] = word.length <= term.length ? [word, term] : [term, word];
          if (short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3) {
            score += 0.5;
            break;
          }
        }
      }
      return { name, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // A prompt that matches nothing leaves every tool at zero, and strict order
  // then hands the whole floor to whichever plugin registered first — six
  // plugins, four slots, one plugin. Spreading the unmatched ones round-robin
  // gives each plugin a chance to be seen. Scored tools are untouched: when
  // the prompt does say something, it decides.
  const scored = ranked.filter(r => r.score > 0).map(r => r.name);
  const unscored = ranked.filter(r => r.score === 0);
  const byPlugin = new Map();
  for (const item of unscored) {
    const plugin = byName.get(item.name)?._pluginName || '';
    if (!byPlugin.has(plugin)) byPlugin.set(plugin, []);
    byPlugin.get(plugin).push(item.name);
  }
  const spread = [];
  const queues = [...byPlugin.values()];
  while (queues.some(q => q.length)) {
    for (const q of queues) if (q.length) spread.push(q.shift());
  }
  return [...scored, ...spread];
}

export function selectToolDefinitions(definitions = [], context = {}) {
  if (context.isLite) return [];

  const mode = context.mode === 'plan' ? 'plan' : 'build';
  const prompt = String(context.prompt || '');
  const overlay = String(context.overlay || '');
  const selected = new Set(mode === 'plan' ? BASE_PLAN : BASE_BUILD);
  // Plan mode is read-only by design; build mode always keeps its hands.
  if (mode === 'build') addMany(selected, MUTATION_TOOLS);
  const contextualPriority = [];
  // Plugin tools are not part of the static core tool lists above. When a
  // registry is attached, keep their schemas discoverable so dynamic routing
  // does not silently make an enabled plugin unusable.
  //
  // Plan mode promises to read and not to write, and the host cannot inspect
  // what a plugin's handler does — so a tool of unstated risk stays out of it,
  // which is why an enabled plugin used to be invisible there entirely. A tool
  // its author declares `risk: 'low'` is admitted: the claim is explicit and
  // greppable, made by the same author whose code was already chosen to run,
  // and without it a read-only plugin is unusable in the mode built for
  // reading.
  const pluginToolNames = context.includePluginTools
    ? definitions
      .filter(tool => tool?._pluginTool && (mode === 'build' || tool._risk === 'low'))
      .map(tool => tool.function?.name)
      .filter(Boolean)
    : [];
  for (const name of pluginToolNames) selected.add(name);
  const editIntent = mode === 'build' && (
    EDIT_INTENT_RE.test(prompt) ||
    EDIT_OVERLAY_RE.test(overlay) ||
    context.editIntentSticky === true ||
    context.mutationToolUsed ||
    context.touchedFiles > 0
  );

  if (editIntent) {
    addMany(selected, EXEC_TOOLS);
  }
  if (/verify|did not verify|quality checks?/i.test(overlay) || context.verificationNeeded) {
    addMany(selected, VERIFY_TOOLS);
    contextualPriority.push(...VERIFY_TOOLS);
  }
  if (/repo_map first/i.test(overlay)) selected.add('repo_map');
  if (WEB_INTENT_RE.test(prompt)) {
    addMany(selected, WEB_TOOLS);
    contextualPriority.push(...WEB_TOOLS);
  }
  if (DOCUMENT_INTENT_RE.test(prompt)) {
    addMany(selected, DOCUMENT_TOOLS);
    contextualPriority.push(...DOCUMENT_TOOLS);
  }
  if (VIDEO_INTENT_RE.test(prompt)) {
    selected.add('video_transcript');
    contextualPriority.push('video_transcript');
  }
  if (RUNTIME_INTENT_RE.test(prompt)) {
    addMany(selected, RUNTIME_TOOLS);
    contextualPriority.push(...RUNTIME_TOOLS);
  }
  if (DEPENDENCY_INTENT_RE.test(prompt)) {
    addMany(selected, DEPENDENCY_TOOLS);
    contextualPriority.push(...DEPENDENCY_TOOLS);
  }
  if (mode === 'build' && SHELL_INTENT_RE.test(prompt)) {
    selected.add('bash');
    selected.add('bash_session');
    contextualPriority.push('bash', 'bash_session');
  }

  const maxTools = Math.max(4, Number(context.maxTools) || 16);
  const byName = new Map(definitions.map(tool => [tool.function?.name, tool]));
  const ordered = [];
  for (const tool of definitions) {
    if (selected.has(tool.function?.name)) ordered.push(tool);
  }

  if (ordered.length <= maxTools) return ordered;

  // Plugin tools used to sit above every core family here, which was harmless
  // while a plugin meant two tools and fatal once it meant thirty-seven: six
  // enabled plugins filled 21 of the 28 slots and left the agent without
  // `bash`, `run_tests`, `todo_write` or `git_status` — unable to do its own
  // job while perfectly able to do theirs.
  //
  // They keep a reserved share instead. Enough that an enabled plugin is never
  // silently unusable, bounded so it cannot displace the toolkit the CLI is
  // built on. Which of them make the cut is arbitrary when there are more than
  // the share allows — ranking them by relevance would need the router to
  // understand what a plugin does, and it cannot.
  // A guaranteed minimum rather than a ceiling: a small share is placed ahead
  // of the core families so an enabled plugin can never be squeezed out
  // entirely, and the remainder queues behind them to fill whatever the core
  // set leaves. Capping the share instead would waste slots — six plugins and
  // a cap of 28 left seven empty while excluding twenty-eight tools.
  //
  // Which ones make the cut is decided by the prompt, not by the order the
  // plugins happened to register in. That order put `excel-full`'s thirteen
  // tools ahead of everything and left all seventeen of `pgadmin`'s out, so
  // asking for a database restore reached a model that had never been offered
  // `pg_restore_wizard` — the page could not open because the tool was not
  // there to call.
  const ranked = rankPluginTools(definitions, pluginToolNames, `${prompt} ${overlay}`);
  const pluginFloor = Math.max(1, Math.floor(maxTools / 4));
  const pluginGuaranteed = ranked.slice(0, pluginFloor);
  const pluginRest = ranked.slice(pluginFloor);

  const priority = [
    'repo_map',
    'read',
    'grep',
    'ask_user',
    // Ahead of the contextual families: losing the ability to write to make
    // room for, say, a web search is never the right trade in build mode.
    ...(mode === 'build' ? MUTATION_TOOLS : []),
    // Prompt-relevant families outrank a generic plugin tool: they were chosen
    // because of what was asked, and the plugin share was not.
    ...contextualPriority,
    ...(editIntent ? EDIT_TOOLS : []),
    ...pluginGuaranteed,
    ...(mode === 'plan' ? BASE_PLAN : BASE_BUILD),
    ...pluginRest,
  ];
  const result = [];
  const used = new Set();
  for (const name of priority) {
    if (!selected.has(name) || used.has(name) || !byName.has(name)) continue;
    result.push(byName.get(name));
    used.add(name);
    if (result.length >= maxTools) break;
  }
  return result;
}

export function selectedToolNames(definitions = []) {
  return definitions.map(tool => tool.function?.name).filter(Boolean);
}
