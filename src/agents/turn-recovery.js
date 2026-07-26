const MUTATION_TOOLS = new Set(['write', 'edit', 'apply_patch_structured']);
const EXPLORATION_TOOLS = new Set(['glob', 'grep', 'list_dir', 'file_info', 'read', 'repo_find_symbol']);
const STATEFUL_TOOLS = new Set(['bash_session', 'dev_server']);

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
  if (/(?:^|\n|\.\s+)\s*(?:ora\s+|adesso\s+)?(scrivo|creo|aggiorno|modifico|implemento|sistemo|applico|procedo|sostituisco|aggiungo|rimuovo|inserisco|riscrivo)\b/i.test(body)) {
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

export function toolBatchNeedsSequential(validTools = []) {
  if (validTools.length <= 1) return false;
  const names = validTools.map(t => t.name);
  if (names.some(name => STATEFUL_TOOLS.has(name))) return true;
  if (names.includes('repo_map') && names.some(name => EXPLORATION_TOOLS.has(name))) return true;
  if (names.some(name => MUTATION_TOOLS.has(name))) return true;
  return false;
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
    repoMapNudgeUsed: false,
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
      `You modified ${touchedCount} file(s) (${touchedList}) but did not verify them. Verification policy: first call \`run_checks\` with profile="quick". If run_checks is unavailable or fails due to missing setup, run targeted verifiers (\`node -c <file>\`, \`python -m py_compile <file>\`, \`tsc --noEmit\`, \`eslint <file>\` / \`ruff check <file>\`, or focused tests). If checks fail, fix and re-run checks. Only after a clean verification, give a brief summary.`,
    auto_continue_stalled: ({ pendingLines }) =>
      'The previous auto-continue produced no progress: no step was marked complete, no file was touched, no tool ran. These steps are still open:\n'
      + `${pendingLines}\n\n`
      + 'Do not restate the plan and do not announce what you are about to do — that is what stalled the last turn. Either call the tools that finish the next step right now, or, if a step cannot be done, say which one and why in one sentence. Mark each finished step with todo_write (or a <done:N> marker) so progress is actually recorded.',
    auto_continue: ({ attempt, max, pendingLines }) =>
      `You stopped, but the following steps from your initial plan are still incomplete (auto-continue ${attempt}/${max}):\n${pendingLines}\n\nContinue without asking for confirmation. Use tools, emit <done:N> markers as you complete each, and only stop when every item is done or you genuinely need user input.`,
    repo_map_first: () =>
      'Before broad exploration, call repo_map first to build a high-level repository map. Then continue with targeted glob/grep/read calls only where needed.',
    invalid_tool_call: ({ streak, max }) =>
      `Your last tool call batch was invalid (${streak}/${max - 1} warning before abort). Stop repeating malformed tool calls. Re-read each tool schema carefully and call exactly one or more valid tools with complete JSON arguments. Do not use empty objects for tools like read/write/edit. If you cannot supply valid arguments, answer briefly and explain what is missing.`,
    native_tool_calls: () =>
      'Your last message contained tool-call markup (<invoke>, <tool_call>, <parameter>) written as plain text. Text like that is never executed. Call tools through the native tool-calling API only — never print the XML protocol into your answer. Retry the step now with real tool calls, or, if you cannot, say plainly what you need.',
    tool_loop_finalize: ({ reason }) =>
      `Tool use is now disabled for this recovery turn because ${reason || 'the tool loop stopped making progress'}. Do not request or simulate more tool calls. Use the results and images already present in the conversation, answer the user directly, and clearly state any limitation or failed fetch.`,
  };
  const template = templates[kind];
  if (!template) return '';
  return String(template(data) || '').trim();
}
