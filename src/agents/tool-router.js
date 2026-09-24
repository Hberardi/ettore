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

// `glob`, `list_dir` and `file_info` were in BASE_PLAN but not here, so build
// mode shipped a system prompt telling the model to "use glob/grep for
// targeted drill-down" and to "prefer list_dir/file_info over bash for project
// inspection" while routing away every one of those tools. The model was left
// with `grep` and a rule it could not follow.
const BASE_BUILD = [
  'repo_map',
  'repo_find_symbol',
  'read',
  'grep',
  'glob',
  // Delegating a search costs nothing when it is not used and saves the
  // context that a search would otherwise fill, so it belongs in the base set
  // rather than behind a keyword: the turns that need it are exactly the ones
  // whose wording gives no hint that a long search is coming.
  'explore',
  // The universal escape hatch, and the one whose absence hurts most: it used
  // to be gated on a shell-intent regex, so any turn phrased as a question
  // rather than an order arrived unable to run a single command. The system
  // prompt's "prefer list_dir/file_info/git_status over bash" is what keeps it
  // from being over-used; routing it away only made the tasks that genuinely
  // needed a shell impossible.
  'bash',
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
// The read-only half, for plan mode: look at what is already running, start
// nothing and drive nothing.
const PLAN_RUNTIME_TOOLS = ['browser_check', 'read_server_console'];
const DEPENDENCY_TOOLS = ['dep_inspect', 'bash'];

// Tools that top up whatever slots the intent families leave free.
//
// Intent matching decides *priority*; it must not decide *availability* while
// the request still has room. It used to do both, and the cost was a model
// that could not do the job it was handed: "controlla se il progetto compila"
// and "quanti test falliscono?" matched no family, so they reached the model
// with no `bash`, no `run_checks` and no `run_tests` — nothing that can
// compile or run anything — and the answer was improvised from reading source.
// "il bottone non risponde" arrived without `browser_app`.
//
// Order is by how badly the absence hurts: not being able to run a command at
// all comes first, driving a real app next, the network last. Tools with a
// per-call price or a narrow pipeline (music video, video_describe, web_image,
// desktop_app) are deliberately absent — those stay intent-gated.
const BUILD_FILL = [
  'run_checks',
  'run_tests',
  'list_dir',
  'file_info',
  'bash_session',
  'read_server_console',
  'dev_server',
  'browser_app',
  'websearch',
  'webfetch',
  'browser_check',
  'dep_inspect',
  'read_pdf',
  'read_doc',
];

// Plan mode promises to read and not to write, so its fill is read-only.
const PLAN_FILL = [
  'read_server_console',
  'browser_check',
  'dep_inspect',
  'websearch',
  'webfetch',
  'read_pdf',
  'read_doc',
];

const EDIT_INTENT_RE = /\b(edit|modify|change|update|fix|create|write|implement|patch|refactor|build|add|remove|rename|modifica|cambia|aggiorna|correggi|crea|scrivi|implementa|sistema|aggiungi|rimuovi|rinomina)\b/i;
// A recovery overlay demanding an edit is an edit request, whoever wrote it.
const EDIT_OVERLAY_RE = /\bwrite\b|\bedit\b|carry out the announced action/i;
// "continua" and friends carry no intent of their own: they continue whatever
// the previous prompt asked for, so the caller's sticky intent must survive.
const CONTINUATION_PROMPT_RE = /^\s*(?:continua|prosegui|vai(?:\s+avanti)?|avanti|procedi|dai|ok(?:ay)?|va\s+bene|continue|go\s+on|keep\s+going|next|proceed|resume)\b/i;

const WEB_INTENT_RE = /\b(latest|current|today|news|web|online|website|url|docs?|documentation|internet|image|images|photo|picture|aggiornat[oaie]|oggi|notizie|sito|pagina|immagin[ei]|foto)\b/i;
const DOCUMENT_INTENT_RE = /\b(pdf|docx?|odt|document[oi]?)\b/i;
const VIDEO_INTENT_RE = /\b(youtube|youtu\.be|video|trascrivi|transcript)\b/i;
// The music-video pipeline the build prompt describes. Its tools sat in no
// routing family, so with dynamic routing on — the default — the model was
// walked through a pipeline it had never been handed the tools to run.
const MUSIC_VIDEO_TOOLS = ['audio_read', 'generate_scene_image', 'generate_scene_clip', 'lyrics_to_srt', 'assemble_music_video'];
const MUSIC_VIDEO_INTENT_RE = /\b(music ?video|video ?musicale|videoclip|canzone|song|brano|mp3|wav|flac|lyrics|testo della canzone|storyboard)\b/i;
// Bug reports about a running interface rarely name the runtime: what the user
// writes is "il bottone non risponde quando ci clicco" or "il menu non si
// vede". `click|clicca` matched neither "clicco" nor "cliccando", and no word
// for the thing being clicked was listed at all, so the turn that most needed
// to open the app and read its console was the one routed without the tools
// that can.
const RUNTIME_INTENT_RE = /\b(server|browser|page|frontend|runtime|console|logs?|localhost|porta|errore.*avvio|app|apps?|webapp|desktop|gui|ui|window|finestra|schermata|screenshot|clicc\w*|click\w*|bottone|bottoni|pulsante|pulsanti|button|menu|men[uù]|form|electron|tk|qt|gtk|prova(?:re|la|lo)?|test(?:are|a)?\s+l['’]?app)\b/i;
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

  // Jev's reading of what the turn needs, where it has one. The regex families
  // below say what a prompt *looks* like — "image" and "foto" reach for the
  // web tools, "app" and "ui" for the runtime ones — which both pads every
  // request with schemas the turn never uses and, when the wording misses,
  // leaves out the tool the turn needed. A decisive answer settles it in
  // either direction; an unsure one, or no Jev at all, leaves the regex in
  // charge exactly as before. See src/jev/turn-judge.js.
  const families = context.families || {};
  const needs = (family, byWords) => (typeof families[family] === 'boolean' ? families[family] : byWords);

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
  // The turn's own history wins over any prediction: a turn that has already
  // edited something keeps the tools it edited with.
  const editUnderway = EDIT_OVERLAY_RE.test(overlay)
    || context.editIntentSticky === true
    || context.mutationToolUsed
    || context.touchedFiles > 0;
  const editIntent = mode === 'build' && (editUnderway || needs('edit', EDIT_INTENT_RE.test(prompt)));

  if (editIntent) {
    addMany(selected, EXEC_TOOLS);
  }
  // Build only. VERIFY_TOOLS carries `bash`, `run_checks`, `run_tests` and
  // `bash_session`, and this branch had no mode check — so a plan-mode turn
  // whose prompt tripped the verification flag was handed a shell, in the one
  // mode whose whole promise to the user is that it will not change anything.
  if (mode === 'build' && (/verify|did not verify|quality checks?/i.test(overlay) || context.verificationNeeded)) {
    addMany(selected, VERIFY_TOOLS);
  }
  if (/repo_map first/i.test(overlay)) selected.add('repo_map');
  if (needs('web', WEB_INTENT_RE.test(prompt))) {
    addMany(selected, WEB_TOOLS);
    contextualPriority.push(...WEB_TOOLS);
  }
  if (needs('document', DOCUMENT_INTENT_RE.test(prompt))) {
    addMany(selected, DOCUMENT_TOOLS);
    contextualPriority.push(...DOCUMENT_TOOLS);
  }
  if (needs('video', VIDEO_INTENT_RE.test(prompt))) {
    selected.add('video_transcript');
    selected.add('video_describe');
    contextualPriority.push('video_transcript', 'video_describe');
  }
  // Build only: these write files and bill per generated clip.
  if (mode === 'build' && needs('music_video', MUSIC_VIDEO_INTENT_RE.test(prompt))) {
    addMany(selected, MUSIC_VIDEO_TOOLS);
    // Ahead of the other prompt families: a music-video request also reads
    // as "video" and often as "foto", and those schemas must not crowd out
    // the pipeline's last step under the tool cap.
    contextualPriority.unshift(...MUSIC_VIDEO_TOOLS);
  }
  if (needs('runtime', RUNTIME_INTENT_RE.test(prompt))) {
    // Starting a dev server or driving a real app is not reading, so plan mode
    // gets only the two that observe something already running — the same two
    // its system prompt tells the model it has.
    const runtime = mode === 'build' ? RUNTIME_TOOLS : PLAN_RUNTIME_TOOLS;
    addMany(selected, runtime);
    contextualPriority.push(...runtime);
  }
  if (needs('dependency', DEPENDENCY_INTENT_RE.test(prompt))) {
    // `dep_inspect` reads; the `bash` beside it does not, and asking about npm
    // packages is not consent to run them.
    const dependency = mode === 'build' ? DEPENDENCY_TOOLS : ['dep_inspect'];
    addMany(selected, dependency);
    contextualPriority.push(...dependency);
  }
  if (mode === 'build' && SHELL_INTENT_RE.test(prompt)) {
    selected.add('bash');
    selected.add('bash_session');
    contextualPriority.push('bash', 'bash_session');
  }

  const maxTools = Math.max(4, Number(context.maxTools) || 16);
  const byName = new Map(definitions.map(tool => [tool.function?.name, tool]));

  // Top up the free slots. The intent families above answer "what does this
  // prompt look like"; they are not an answer to "what might this turn need",
  // and while slots are still free the second question has no reason to be
  // decided by the first. See BUILD_FILL for what the old behaviour cost.
  const fill = mode === 'plan' ? PLAN_FILL : BUILD_FILL;
  for (const name of fill) {
    if (selected.size >= maxTools) break;
    if (selected.has(name) || !byName.has(name)) continue;
    selected.add(name);
  }

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
    // Find the code, read it, change it — in that order, and ahead of anything
    // a keyword match brought in. `glob` belongs with read/grep: they are the
    // same job, locating the code the turn is about.
    'repo_map',
    'read',
    'grep',
    'glob',
    'ask_user',
    // Ahead of the contextual families: losing the ability to write to make
    // room for, say, a web search is never the right trade in build mode.
    ...(mode === 'build' ? MUTATION_TOOLS : []),
    // Then the three whose absence changes what the agent can do at all: run a
    // command, record a finished step — the progress panel and the
    // auto-continue both read what todo_write writes, and a turn with no way
    // to mark a step reads to the loop exactly like a turn that finished none
    // — and see what is already modified.
    'bash',
    'todo_write',
    'git_status',
    // Prompt-relevant families outrank a generic plugin tool: they were chosen
    // because of what was asked, and the plugin share was not.
    ...contextualPriority,
    ...(editIntent ? EDIT_TOOLS : []),
    ...pluginGuaranteed,
    ...(mode === 'plan' ? BASE_PLAN : BASE_BUILD),
    ...fill,
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
