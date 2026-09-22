const MUTATION_TOOLS = new Set(['write', 'edit', 'apply_patch_structured']);
const EXPLORATION_TOOLS = new Set(['glob', 'grep', 'list_dir', 'file_info', 'read', 'repo_find_symbol']);
const STATEFUL_TOOLS = new Set(['bash_session', 'dev_server', 'browser_app', 'desktop_app']);

export function userLikelyRequestedWorkspaceEdit(prompt) {
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

export function responseLooksLikeUnappliedCode(text) {
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

export function responseAnnouncesUnexecutedAction(text) {
  const body = String(text || '');
  if (!body.trim()) return false;
  if (/(?:^|\n)\s*(piano|plan|prossim[oa]\s+pass[oi]?|next\s+steps?)\s*[:.]/i.test(body)) {
    return true;
  }
  if (/(?:^|\n|\.\s+)\s*(?:ora\s+|adesso\s+)?(scrivo|creo|aggiorno|modifico|implemento|sistemo|applico|procedo|proseguo|riparto|riprendo|sostituisco|aggiungo|rimuovo|inserisco|riscrivo)\b/i.test(body)) {
    return true;
  }
  if (/(?:^|\n|\.\s+)\s*(?:ora\s+|adesso\s+)?(diagnostico|verifico|controllo|analizzo|esamino|ispeziono|indago|leggo|apro|esploro|mappo|cerco(?!\s+di\b))\b(?:\s+(?:subito|ora|adesso))?/i.test(body)) {
    return true;
  }
  if (/(?:^|\n|\.\s+)\s*(now\s+i'?ll|next\s+i'?ll|let\s+me\s+(?:write|create|update|modify|fix|edit|add|implement)|i'?ll\s+(?:write|create|update|modify|fix|edit|add|implement)|i'?m\s+going\s+to\s+(?:write|create|update|modify)|about\s+to\s+(?:write|create|update|modify))/i.test(body)) {
    return true;
  }
  return false;
}

// The line the model used to announce work it never did. Quoted back at it in
// the escalated overlay — naming the exact sentence lands better than a
// generic "you announced something".
export function extractAnnouncement(text) {
  const matches = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && responseAnnouncesUnexecutedAction(line));
  if (!matches.length) return '';
  // Prefer the concrete next action over a bare "Piano:" / "Plan:" header —
  // quoting "Prossimo passo: cerco X" back at the model is far more pointed
  // than quoting the title of the plan.
  const specific = matches.find(line => !/^\s*(piano|plan)\s*[:.]/i.test(line));
  return (specific || matches[0]).slice(0, 160);
}

// The "I'll do it later" shape, which an announcement detector misses by
// design: the model is not claiming to act now, it is parking the work on a
// condition it cannot observe — usually the tools coming back. Nothing wakes
// it up, so the turn ends with the user holding a promise instead of an answer.
const RESUMPTION_VERBS = /\b(?:parto|riparto|riprendo|riprender[oò]|continuo|continuer[oò]|proseguo|proseguir[oò]|procedo|attendo|aspetto|riprendiamo|i'?ll\s+(?:resume|restart|continue|proceed|start|retry|pick\s+up)|i\s+will\s+(?:resume|continue|proceed|start)|resuming|waiting|standing\s+by)\b/i;

const DEFERRAL_CONDITIONS = /(?:\bappena\b|\bquando\b|\bpi[uù]\s+tardi\b|\bin\s+seguito\b|\bsuccessivamente\b|\bpi[uù]\s+avanti\b|\bprossimo\s+turno\b|\bas\s+soon\s+as\b|\bonce\b|\bwhen\s+(?:the\s+)?tools?\b|\blater\b|\bnext\s+turn\b)/i;

// The outage named outright. Checked only on a turn that already has no tools,
// where there is no innocent reading of "i tool sono disabilitati" — outside
// that gate the same sentence could be the model explaining itself correctly.
const TOOL_STATE = /\b(?:tool|tools|strument[oi])\b[^.\n]{0,48}\b(?:disabilitat\w*|disattivat\w*|non\s+disponibil\w*|bloccat\w*|torn\w+|ritorn\w+|riattiv\w+|disponibil\w*|disabled|unavailable|blocked|back|available|re-?enabled)/i;

export function responseDefersWork(text) {
  const body = String(text || '');
  if (!body.trim()) return false;
  if (TOOL_STATE.test(body)) return true;
  return RESUMPTION_VERBS.test(body) && DEFERRAL_CONDITIONS.test(body);
}

// The sentence that did the deferring, quoted back at the model — the same
// trick [[extractAnnouncement]] uses, and for the same reason.
export function extractDeferral(text) {
  const match = String(text || '')
    .split(/\n|(?<=[.!?])\s+/)
    .map(line => line.trim())
    .find(line => line && responseDefersWork(line));
  return match ? match.slice(0, 160) : '';
}

// Phrases that only make sense when the whole job is over. Deliberately
// narrow: a partial "il primo step è completato" must NOT match, because
// resuming one turn too many costs a round-trip while stopping one turn too
// early costs the user a manual nudge.
const COMPLETION_PATTERNS = [
  /\btask\s+(?:complet[oai]|completat[oa]|finit[oa]|terminat[oa]|done|complete[d]?)\b/i,
  /\b(?:lavoro|attivit[àa]|implementazione|modifica|refactor|migrazione)\s+(?:completat[oa]|finit[oa]|conclus[oa]|terminat[oa])\b/i,
  /\bho\s+(?:finito|completato|concluso|terminato)\b/i,
  /\b(?:tutto|e[' ]?\s*tutto)\s+(?:fatto|pronto|completato|a\s+posto|sistemato)\b/i,
  /\ball\s+done\b|\bthat'?s\s+it\b|\bwork\s+complete\b|\bnothing\s+(?:else\s+)?left\b/i,
];

// A standalone "Fatto." on its own line is a real completion signal; the same
// word inside a sentence is not.
const STANDALONE_DONE = /^(?:fatto|done|completato|pronto)[.!]?$/i;

// Anything here means the model is still mid-job, and it vetoes a completion
// match found in the same tail. "primo/secondo/step" are included because
// "ho completato il primo file" is a progress report, not a finish line.
const CONTINUATION_MARKERS = new RegExp(
  '\\b(?:'
  + 'prossim[oi]\\s+(?:pass[oi]|step)|next\\s+steps?|'
  + 'manca(?:no)?|rest(?:a|ano)|rimane|rimangono|da\\s+fare|ancora\\s+(?:aperti|apert[oa]|da)|'
  + 'continuo|proseguo|procedo|passo\\s+a|'
  + 'ora|adesso|poi|quindi|'
  + 'prim[oa]|second[oa]|terz[oa]|parzial\\w*|in\\s+corso|step\\s+\\d'
  + ')\\b',
  'i',
);

// The decision only looks at the closing lines: a long answer can mention
// "ho finito di leggere il file" halfway through and still be mid-task.
export function tailOf(text, lines = 2) {
  const rows = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (!rows.length) return '';
  return rows.slice(-lines).join(' ');
}

export function modelDeclaredCompletion(text) {
  const body = String(text || '').trim();
  if (!body) return false;

  const rows = body.split('\n').map(line => line.trim()).filter(Boolean);
  const lastRow = rows[rows.length - 1] || '';
  if (STANDALONE_DONE.test(lastRow)) return true;

  const tail = tailOf(body, 2);
  if (!COMPLETION_PATTERNS.some(re => re.test(tail))) return false;
  // "Ho completato il refactor, ora aggiorno i test" — the completion phrase
  // is real but scoped to a step, not the task.
  if (CONTINUATION_MARKERS.test(tail)) return false;
  return true;
}


// ── Targets the user named and the turn never went near ─────────────────────
//
// The loop can already tell when the model announced work it did not do, when
// it deferred, and when a declared step is still open. What none of those see
// is the quiet half-finish: "aggiorna navbar.html e footer.html", two files
// asked for, one touched, a confident summary, turn over. No step was left
// unticked because no step list existed, nothing was announced, nothing was
// deferred — the work simply stopped one file short.
//
// A file the user named by path is a file the turn is about. If no tool call
// in the whole turn so much as mentioned it, the request was not carried out
// on it, and that is checkable without spending an LLM call on a judge.

// Extensions that make a token a file rather than a version string or a
// sentence. Deliberately an allowlist: `1.4.4`, `v2.0` and `etc.` all look
// like paths to a permissive pattern.
const FILE_EXT = new RegExp(
  '\\.(?:js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php'
  + '|sh|bash|zsh|json|jsonc|ya?ml|toml|ini|env|cfg|conf|md|mdx|rst|txt|csv|tsv'
  + '|css|scss|sass|less|html?|xml|svg|vue|svelte|sql|proto|lock|gradle|make)$',
  'i',
);

// `Node.js`, `Vue.js` and friends are the names of tools, not files in the
// repository, and a prompt that mentions the runtime must not be read as a
// request to edit a file called after it.
const NOT_A_FILE = new Set([
  'node.js', 'next.js', 'nuxt.js', 'vue.js', 'react.js', 'three.js', 'd3.js',
  'express.js', 'ember.js', 'backbone.js', 'chart.js', 'jquery.js', 'alpine.js',
  'socket.io', 'crypto.js', 'js', 'ts',
]);

const PATH_TOKEN_RE = /[A-Za-z0-9_@.~-]+(?:\/[A-Za-z0-9_@.~-]+)*/g;

export function promptFileTargets(prompt) {
  const text = String(prompt || '');
  const found = [];
  const seen = new Set();
  for (const raw of text.match(PATH_TOKEN_RE) || []) {
    const token = raw.replace(/[.,;:!?]+$/, '');
    if (!FILE_EXT.test(token)) continue;
    const key = token.toLowerCase();
    if (NOT_A_FILE.has(key) || seen.has(key)) continue;
    seen.add(key);
    found.push(token);
    // A prompt naming a dozen files is a bulk request; chasing each one turns
    // the gate into the thing that never lets a turn end.
    if (found.length >= 6) break;
  }
  return found;
}

/**
 * Targets from the prompt that no tool call in the turn referred to.
 *
 * `referenced` is the concatenation of every tool call's arguments for the
 * turn — matching on the basename is deliberately loose: a turn that read
 * `./src/navbar.html` or grepped for `navbar.html` has demonstrably gone near
 * the file, and the gate is here to catch the file nothing went near at all.
 */
export function unaddressedTargets(prompt, referenced = '') {
  const haystack = String(referenced || '').toLowerCase();
  if (!haystack) return promptFileTargets(prompt);
  return promptFileTargets(prompt).filter((target) => {
    const base = target.split('/').pop().toLowerCase();
    return !haystack.includes(base);
  });
}

export function toolBatchNeedsSequential(validTools = []) {
  if (validTools.length <= 1) return false;
  const names = validTools.map(t => t.name);
  if (names.some(name => STATEFUL_TOOLS.has(name))) return true;
  if (names.includes('repo_map') && names.some(name => EXPLORATION_TOOLS.has(name))) return true;
  if (names.some(name => MUTATION_TOOLS.has(name))) return true;
  return false;
}

// Return execution waves for a tool batch. Most read-only calls share one
// wave and run concurrently. Repository mapping remains a first wave when it
// is mixed with exploration, preserving the model-facing repo_map-first rule
// while allowing the remaining reads to run together. Stateful tools and
// mutations stay one-per-wave because their order can affect later calls.
export function toolBatchExecutionGroups(validTools = []) {
  if (validTools.length <= 1) return validTools.length ? [validTools] : [];
  const names = validTools.map(t => t.name);

  if (names.some(name => STATEFUL_TOOLS.has(name)) || names.some(name => MUTATION_TOOLS.has(name))) {
    return validTools.map(tool => [tool]);
  }

  const hasRepoMap = names.includes('repo_map');
  const hasOtherExploration = names.some(name => EXPLORATION_TOOLS.has(name) && name !== 'repo_map');
  if (hasRepoMap && hasOtherExploration) {
    const repoMaps = validTools.filter(tool => tool.name === 'repo_map');
    const rest = validTools.filter(tool => tool.name !== 'repo_map');
    return rest.length ? [repoMaps, rest] : [repoMaps];
  }

  return [validTools];
}

export function createTurnRecoveryState() {
  return {
    // Announcement/snippet stalls get more than one shot: models that narrate
    // instead of acting tend to do it repeatedly, and a single retry left the
    // turn ending silently on "Prossimo passo: …" every time after that.
    workspaceEditRetries: 0,
    maxWorkspaceEditRetries: 2,
    lastWorkspaceEditProgress: null,
    verifyRetryUsed: false,
    // One shot only. A model that parks the work twice is not going to deliver
    // on a third ask, and each attempt costs a full round-trip.
    deferralRetryUsed: false,
    repoMapNudgeUsed: false,
    // One shot. The gate is a safety net for the half-finished turn, not a
    // negotiation: a model that answers the first ask with another summary
    // will answer the second one the same way.
    unaddressedTargetsRetryUsed: false,
    // Resumes spent on a reply the provider cut off at max_tokens. Bounded so
    // a model that only ever emits 8k of prose cannot spin the turn forever.
    truncationResumes: 0,
    maxTruncationResumes: 3,
    invalidToolCallStreak: 0,
    maxInvalidToolCallStreak: 3,
  };
}

export function buildTurnOverlay(kind, data = {}) {
  const templates = {
    workspace_edit_retry: () =>
      'You announced an action but did not perform it. The user asked for real workspace changes. Do not stop at prose, plans, or code snippets. Read any needed files, then use write/edit tools to actually create or modify files in the working directory now. After the edits, give a brief summary.',
    workspace_edit_retry_hard: ({ announcement }) =>
      'You have now ended two turns in a row by announcing work instead of doing it'
      + (announcement ? `, most recently: "${announcement}"` : '')
      + '. Stop planning. This turn must contain tool calls that carry out the announced action — grep/read to locate the code, then write/edit to change it. Do not restate the plan, do not describe what you are about to do, and do not end this turn with "Prossimo passo" or any equivalent. If the action genuinely cannot be performed, name the specific blocker in one sentence and ask nothing else.',
    verify_after_edit: ({ touchedCount, touchedList }) =>
      `You modified ${touchedCount} file(s) (${touchedList}) but did not verify them since your last edit. This project has no detected test suite, so the code cannot be released until a check has passed on its current state: run targeted verifiers (\`node -c <file>\`, \`python -m py_compile <file>\`, \`tsc --noEmit\`, \`eslint <file>\` / \`ruff check <file>\`, or run the program / focused tests). If a check fails, fix and re-run it. Only after a clean verification, give a brief summary.`,
    release_gate_failing: ({ attempt, max, excerpt, ranBy }) =>
      `RELEASE BLOCKED (${attempt}/${max}): the project's test suite is NOT green on the code as it stands${ranBy === 'harness' ? ' — ETTORE ran it before letting the turn end' : ''}. You may not declare the task done while any test fails. Output of the run:\n\n${excerpt}\n\nRead the failures, find the cause, and fix it. If a failure comes from your change, fix the code, not the test — change a test only when the behaviour it asserts was deliberately changed by the task. Then run the full suite again (\`run_tests\`) and finish only when it passes.`,
    auto_continue_stalled: ({ pendingLines }) =>
      'The previous auto-continue produced no progress: no step was marked complete, no file was touched, no tool ran. These steps are still open:\n'
      + `${pendingLines}\n\n`
      + 'Do not restate the plan and do not announce what you are about to do — that is what stalled the last turn. Either call the tools that finish the next step right now, or, if a step cannot be done, say which one and why in one sentence. Mark each finished step with todo_write (or a <done:N> marker) so progress is actually recorded.',
    auto_continue: ({ attempt, max, pendingLines }) =>
      `You stopped, but the following steps from your initial plan are still incomplete (auto-continue ${attempt}/${max}):\n${pendingLines}\n\nContinue without asking for confirmation. Use tools, emit <done:N> markers as you complete each, and only stop when every item is done or you genuinely need user input.`,
    // Only reachable with Jev on: the harness has no calibrated read of "is
    // this actually finished" without it, and a regex must never drive a turn
    // that has no declared plan to measure against.
    jev_unfinished: ({ attempt, max }) =>
      `You ended the turn, but the request you were given has not been carried out in full (continuing ${attempt}/${max}).`
      + ' Do not summarize again and do not describe what you would do next — that is not progress.'
      + ' Carry out the remaining part now with tool calls.'
      + ' If the rest genuinely cannot be done — it needs a decision only the user can make, a credential, a machine you cannot reach —'
      + ' say which part and why in one sentence, and stop.',
    // Only reachable with Jev on, like jev_unfinished above.
    explore_first: () =>
      'Before searching by hand, delegate this one to `explore`. It answers a question about the codebase in a separate read-only context and returns a short report with file:line references, so the repo_map, glob, grep and read output it needs never enters this conversation — which is what keeps the context for the actual work.'
      + ' Ask it one self-contained question naming the symbols, files or behaviour you are after, since it sees none of this conversation.'
      + ' Go straight to the tools yourself only if you already know the exact paths to read.',
    // The rest of the Jev overlays below are reachable only with Jev on and
    // decisive, like explore_first.
    jev_clarify: () =>
      'Jev read this request and judged it cannot be carried out as written: something only the user can supply is missing.'
      + ' Before any other tool, ask the user ONE short question with `ask_user` that names exactly what is missing — which file or feature, which of the readings they mean, what the result should be — offering the likely answers as options.'
      + ' Do not guess and do not start the work until they answer. If on reflection nothing is actually missing, go ahead and do the work.',
    jev_answer_directly: () =>
      'Jev judged that this request needs no look at the code: it is a question about a concept, a chat message, or a task already specified in full. Answer it directly; call tools only if the answer genuinely depends on something in the workspace.',
    jev_course_correct: ({ issues = [] }) => {
      const described = {
        looping: 'you keep repeating the same kind of action without getting closer to the goal',
        stuck_on_error: 'the same error keeps coming back and your attempts have not changed approach',
        off_track: 'your recent calls are about something the request did not ask for',
      };
      const list = issues.map(key => described[key] || key).join('; and ');
      return `Jev has been watching this turn's tool calls and judged that ${list}.`
        + ' Stop and change course before the next call: re-read the original request, say in one sentence what is actually blocking you, and then take a genuinely different step —'
        + ' read the code behind the error instead of re-running it, narrow the search, or go back to the part of the request still open.'
        + ' If the blocker is something only the user can resolve, ask them with `ask_user` rather than trying again.';
    },
    unaddressed_targets: ({ targetList }) =>
      `The request named ${targetList}, and nothing in this turn read, searched or changed `
      + 'it — so whatever was asked for it has not been done. Either carry out the request on it now '
      + '(locate it first if you do not know where it is), or, if it should genuinely be left alone — '
      + 'it does not exist, the change does not apply to it, the user meant something else — say which '
      + 'and why in one sentence. Do not repeat the summary you just gave.',
    repo_map_first: () =>
      'Before broad exploration, call repo_map first to build a high-level repository map. Then continue with targeted glob/grep/read calls only where needed.',
    invalid_tool_call: ({ streak, max }) =>
      `Your last tool call batch was invalid (${streak}/${max - 1} warning before abort). Stop repeating malformed tool calls. Re-read each tool schema carefully and call exactly one or more valid tools with complete JSON arguments. Do not use empty objects for tools like read/write/edit. If you cannot supply valid arguments, answer briefly and explain what is missing.`,
    native_tool_calls: () =>
      'Your last message contained tool-call markup (<invoke>, <tool_call>, <parameter>) written as plain text. Text like that is never executed. Call tools through the native tool-calling API only — never print the XML protocol into your answer. Retry the step now with real tool calls, or, if you cannot, say plainly what you need.',
    output_truncated: ({ attempt, max }) =>
      'Your previous message was cut off by the output token limit — it is not a finished answer, and the user has only seen the part that made it through.'
      + ` Continue from exactly where it stopped (resume ${attempt}/${max}), mid-sentence if that is where the cut fell.`
      + ' Do not restart, do not repeat what you already wrote, and do not summarize it. If the cut landed inside a tool call, issue that tool call again now as a proper native call.'
      + ' Keep the remainder shorter: finish the work in the tokens you have left.',
    // "Tool use is now disabled for this recovery turn" read to the model like
    // a temporary outage it could sit out, and models answered by promising to
    // resume "as soon as tools are back" — which nothing ever triggers. The
    // wording now states the part that was missing: there is no later.
    tool_loop_finalize: ({ reason }) =>
      `This is the last turn of this request and it runs without tools, because ${reason || 'the tool loop stopped making progress'}.`
      + ' The tools are not coming back later in this turn, and nothing you postpone gets picked up automatically:'
      + ' no further work happens unless the user sends a new message.'
      + ' So do not announce next steps, do not promise to resume, and do not wait for anything to become available.'
      + ' Answer now from the results already in this conversation — what you did, what you found —'
      + ' and state plainly what stayed incomplete or failed, so the user can decide what to ask for next.'
      + ' Do not request or simulate more tool calls.',
    // Second line of defence for when the model defers anyway.
    deliver_now: ({ quote }) =>
      'Your last answer postponed the work instead of delivering it'
      + (quote ? ` ("${quote}")` : '')
      + '. Nothing resumes on its own: this turn has no tools, and there is no later turn unless the user writes again.'
      + ' Replace that answer now with the real one — report what you actually did and found in this conversation,'
      + ' name what is still incomplete, and stop there. No plans, no promises, no waiting.',
  };
  const template = templates[kind];
  if (!template) return '';
  return String(template(data) || '').trim();
}
