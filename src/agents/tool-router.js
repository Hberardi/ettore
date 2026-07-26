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

const EDIT_TOOLS = [
  'write',
  'edit',
  'apply_patch_structured',
  'run_checks',
  'run_tests',
  'bash_session',
];

const VERIFY_TOOLS = ['run_checks', 'run_tests', 'bash', 'bash_session', 'read', 'git_diff'];
const WEB_TOOLS = ['websearch', 'webfetch', 'web_image'];
const DOCUMENT_TOOLS = ['read_pdf', 'read_doc'];
const RUNTIME_TOOLS = ['dev_server', 'browser_check', 'read_server_console'];
const DEPENDENCY_TOOLS = ['dep_inspect', 'bash'];

const EDIT_INTENT_RE = /\b(edit|modify|change|update|fix|create|write|implement|patch|refactor|build|add|remove|rename|modifica|cambia|aggiorna|correggi|crea|scrivi|implementa|sistema|aggiungi|rimuovi|rinomina)\b/i;
const WEB_INTENT_RE = /\b(latest|current|today|news|web|online|website|url|docs?|documentation|internet|image|images|photo|picture|aggiornat[oaie]|oggi|notizie|sito|pagina|immagin[ei]|foto)\b/i;
const DOCUMENT_INTENT_RE = /\b(pdf|docx?|odt|document[oi]?)\b/i;
const VIDEO_INTENT_RE = /\b(youtube|youtu\.be|video|trascrivi|transcript)\b/i;
const RUNTIME_INTENT_RE = /\b(server|browser|page|frontend|runtime|console|logs?|localhost|porta|errore.*avvio)\b/i;
const DEPENDENCY_INTENT_RE = /\b(dependenc|package|npm|pnpm|yarn|pip|cargo|vulnerab|audit|dipendenz|pacchett)\b/i;
const SHELL_INTENT_RE = /\b(command|shell|terminal|bash|script|execute|run|comando|terminale|esegui)\b/i;

function addMany(target, names) {
  for (const name of names) target.add(name);
}

export function selectToolDefinitions(definitions = [], context = {}) {
  if (context.isLite) return [];

  const mode = context.mode === 'plan' ? 'plan' : 'build';
  const prompt = String(context.prompt || '');
  const overlay = String(context.overlay || '');
  const selected = new Set(mode === 'plan' ? BASE_PLAN : BASE_BUILD);
  const contextualPriority = [];
  const editIntent = mode === 'build' && (
    EDIT_INTENT_RE.test(prompt) ||
    context.mutationToolUsed ||
    context.touchedFiles > 0
  );

  if (editIntent) {
    addMany(selected, EDIT_TOOLS);
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
