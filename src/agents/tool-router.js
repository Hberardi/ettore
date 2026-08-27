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
  // registry is attached, keep their schemas discoverable in build mode so
  // dynamic routing does not silently make an enabled plugin unusable.
  const pluginToolNames = mode === 'build' && context.includePluginTools
    ? definitions.filter(tool => tool?._pluginTool).map(tool => tool.function?.name).filter(Boolean)
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

  const priority = [
    'repo_map',
    'read',
    'grep',
    'ask_user',
    // Ahead of the contextual families: losing the ability to write to make
    // room for, say, a web search is never the right trade in build mode.
    ...(mode === 'build' ? MUTATION_TOOLS : []),
    ...pluginToolNames,
    ...contextualPriority,
    ...(editIntent ? EDIT_TOOLS : []),
    ...(mode === 'plan' ? BASE_PLAN : BASE_BUILD),
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
