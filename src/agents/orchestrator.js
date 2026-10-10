// Splitting a large request into work packages, and running them.
//
// One agent carrying a large job keeps everything it read for the first part
// in the context it writes the last part with: the transcript fills with the
// searches behind work that is already finished, the compressor starts cutting,
// and by the fourth file the model is working from stumps. A worker per package
// gives each part a context of its own, and the main agent keeps only what the
// parts reported.
//
// Jev decides WHETHER a request is worth splitting — a yes/no it can answer
// from the request alone (see ORCHESTRATE_QUESTION in jev/turn-judge.js). It
// does not write, so the split itself is one call to the model the session is
// already on. Everything here is the part in between: what the planner is
// asked, what counts as a usable plan, what a worker is told, the order the
// packages run in, and what the main agent reads when they are done.
//
// Nothing here knows about the Agent class. The caller hands in `runWorker`,
// which is what makes the schedule testable without a model.

export const ORCHESTRATE_MAX_TASKS = 5;
// Read-only packages run together, this many at a time.
export const ORCHESTRATE_PARALLEL_RESEARCH = 3;
export const WORKER_REPORT_MAX_CHARS = 4000;
const BRIEF_MAX_CHARS = 6000;
const CONTEXT_MAX_CHARS = 8000;

// The first words of the planner's system prompt. Kept as a constant because a
// fake client in a test tells the planner call from a turn by them.
export const PLANNER_OPENING = 'You split a software request into work packages';

const PLANNER_SYSTEM_PROMPT = `${PLANNER_OPENING} for an orchestrator. Each package is carried out by a separate worker agent that sees NONE of this conversation — only the brief you write for it, the original request, and the reports of the workers that ran before it.

There are two kinds of package:
- "research": read-only. The worker searches and reads, and reports what it found. All research packages run AT THE SAME TIME, before any change, so none of them may depend on another.
- "change": the worker edits files and runs commands. Change packages run ONE AFTER ANOTHER in the order you list them, and each worker is given the reports of every package before it.

Rules:
- Between 2 and {MAX} packages. Do not pad: if the request is really one piece of work, return a single package and it will be handled without workers.
- A package is a piece of work in its own right — something you could hand to a developer with a short brief. Not a step ("open the file"), not the whole request.
- Two change packages must not need the same file at the same point of the work. If they would, they are one package.
- Each brief is self-contained: say what to do, where (paths, symbols) when you know, and what "done" looks like. Never write "as discussed" or "as planned".
- Name files only when they appear in the request or in the context you were given. Do not invent paths.
- Do not add a final package that only verifies, tests everything or writes the summary: the main agent does that once the workers are done.
- When PLUGIN TOOLS are listed, the workers have them, and a package that needs one names it in "tools" — that is how its worker is handed it. A research worker can only use the ones marked read-only: a package that needs any other plugin tool is a "change" package, even if it edits no file. Name only tools from the list.
- Write titles and briefs in the language of the request.

Output JSON only — no prose, no markdown fences. The shape:

{"rationale":"<one sentence: why this split>","tasks":[{"title":"<short name, max 80 chars>","kind":"research"|"change","brief":"<what the worker has to do>","files":["<path>", "..."],"tools":["<plugin tool name>", "..."]}]}`;

const PLUGIN_TOOLS_MAX_CHARS = 3000;

/**
 * The plugin tools as the planner reads them: one block per plugin, one line
 * per tool. A long catalogue is cut at whole tools, and says how many it left
 * out.
 *
 * @param {Array<{name: string, plugin: string, description: string, readOnly: boolean}>} pluginTools
 */
export function describePluginTools(pluginTools = []) {
  const byPlugin = new Map();
  for (const tool of pluginTools) {
    if (!tool?.name) continue;
    const plugin = tool.plugin || 'plugin';
    if (!byPlugin.has(plugin)) byPlugin.set(plugin, []);
    byPlugin.get(plugin).push(tool);
  }
  const lines = [];
  let used = 0;
  let left = pluginTools.filter(tool => tool?.name).length;
  for (const [plugin, tools] of byPlugin) {
    const block = [`${plugin}:`];
    for (const tool of tools) {
      const what = String(tool.description || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      block.push(`- ${tool.name}${tool.readOnly ? ' [read-only]' : ''}${what ? ` — ${what}` : ''}`);
    }
    const size = block.join('\n').length + 1;
    if (lines.length && used + size > PLUGIN_TOOLS_MAX_CHARS) break;
    lines.push(...block);
    used += size;
    left -= tools.length;
  }
  if (left > 0) lines.push(`… and ${left} more plugin tool${left === 1 ? '' : 's'} not listed.`);
  return lines.join('\n');
}

/** The two messages the planner call is made of. */
export function buildPlannerMessages({ request, exploration = '', repoMap = '', pluginTools = [], maxTasks = ORCHESTRATE_MAX_TASKS } = {}) {
  const parts = [`REQUEST:\n${String(request || '').slice(0, CONTEXT_MAX_CHARS)}`];
  if (exploration) {
    parts.push(`WHAT AN EXPLORATION OF THE CODEBASE ALREADY FOUND:\n${String(exploration).slice(0, CONTEXT_MAX_CHARS)}`);
  } else if (repoMap) {
    parts.push(`MAP OF THE REPOSITORY:\n${String(repoMap).slice(0, CONTEXT_MAX_CHARS / 2)}`);
  }
  // A planner that does not know a database or a GitHub plugin is installed
  // cannot hand that part of the job to anyone: it plans around the shell.
  const plugins = describePluginTools(pluginTools);
  if (plugins) parts.push(`PLUGIN TOOLS THE WORKERS HAVE, besides the built-in ones:\n${plugins}`);
  parts.push('Return only the JSON object described in the system instructions.');
  return [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT.replace('{MAX}', String(maxTasks)) },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

// Models wrap JSON in fences or a sentence of preamble even when told not to.
function readJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* try the next reading */ }
  }
  return null;
}

/**
 * The planner's answer as a plan, or null when it is not one worth running:
 * unparseable, or fewer than two packages — a single package is the planner
 * saying the request does not split, and the turn then proceeds as it always
 * did.
 *
 * Research packages are moved ahead of the changes, each group keeping the
 * order it was listed in: that is the order they run in.
 *
 * A package's `tools` are the plugin tools it asked for, kept only when they
 * exist. One that asks for a plugin tool that is not read-only is a change,
 * whatever the planner called it: a research worker is read-only and would be
 * refused the very tool its package depends on.
 */
export function parseWorkPlan(text, { maxTasks = ORCHESTRATE_MAX_TASKS, pluginTools = [] } = {}) {
  const raw = readJsonObject(text);
  const listed = Array.isArray(raw?.tasks) ? raw.tasks : [];
  const known = new Map(pluginTools.filter(tool => tool?.name).map(tool => [tool.name, tool]));
  const tasks = listed
    .map((task, i) => {
      const tools = [...new Set((Array.isArray(task?.tools) ? task.tools : []).map(name => String(name || '').trim()))]
        .filter(name => known.has(name))
        .slice(0, 8);
      const research = String(task?.kind || '').trim().toLowerCase() === 'research'
        && tools.every(name => known.get(name).readOnly);
      return {
        title: String(task?.title || '').trim().replace(/\s+/g, ' ').slice(0, 120) || `Package ${i + 1}`,
        kind: research ? 'research' : 'change',
        brief: String(task?.brief || '').trim().slice(0, BRIEF_MAX_CHARS),
        files: (Array.isArray(task?.files) ? task.files : [])
          .map(file => String(file || '').trim())
          .filter(Boolean)
          .slice(0, 12),
        tools,
      };
    })
    .filter(task => task.brief.length > 0)
    .slice(0, Math.max(1, maxTasks));
  if (tasks.length < 2) return null;
  const ordered = [...tasks.filter(t => t.kind === 'research'), ...tasks.filter(t => t.kind === 'change')];
  return {
    rationale: String(raw?.rationale || '').trim().slice(0, 600),
    tasks: ordered.map((task, i) => ({ id: i + 1, ...task })),
  };
}

/**
 * Ask the model for the split. Returns the plan, or null when there is none
 * to run — the call failed, the answer was not JSON, the request does not
 * split. Never throws: no plan means the turn goes on without workers.
 */
export async function planWork(client, context = {}, { signal = null, maxTasks = ORCHESTRATE_MAX_TASKS, onToken = null, turnOptions = {} } = {}) {
  try {
    const messages = buildPlannerMessages({ ...context, maxTasks });
    const result = await client.turn(messages, [], onToken, signal, turnOptions);
    const content = result?.type === 'text' ? result.content : '';
    return parseWorkPlan(content, { maxTasks, pluginTools: context.pluginTools || [] });
  } catch {
    return null;
  }
}

// The opening line of every worker brief. A sub-agent is told what it is in
// its prompt, and that is also how a test tells a worker's turns apart.
export const WORKER_OPENING = 'You are a worker sub-agent';

const WORKER_RULES = {
  research: 'Your package is READ-ONLY: search and read, change nothing. '
    + 'Report what you found with file:line references — where the relevant code lives, how the parts involved work together, what a change would have to touch. '
    + 'Do not propose the change itself.',
  change: 'Carry out your package, and only your package: the other packages belong to other workers, and doing their work makes two of you edit the same files. '
    + 'The files earlier workers report as changed are already changed on disk — read them before you build on them, and do not redo their work. '
    + 'Check what you changed before you stop (a syntax check, the tests that cover it). '
    + 'End with a short report: which files you changed and how, what you checked and with what result, and anything you had to leave open.',
};

function clip(text, max) {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max)}\n[truncated at ${max} characters]` : value;
}

/** What one worker is told. `reports` are the packages that finished before it. */
export function workerBrief(task, { request = '', index = 0, total = 1, reports = [] } = {}) {
  const lines = [
    `${WORKER_OPENING}. An orchestrator split a larger request into ${total} work packages and you have been given ONE of them (package ${index + 1} of ${total}). `
      + 'You work in a context of your own: you see none of the main conversation, and only your final answer travels back.',
    WORKER_RULES[task.kind] || WORKER_RULES.change,
    `YOUR PACKAGE: ${task.title}\n${task.brief}`,
  ];
  if (task.files?.length) lines.push(`FILES IT CONCERNS: ${task.files.join(', ')}`);
  if (task.tools?.length) {
    lines.push(`PLUGIN TOOLS FOR THIS PACKAGE: ${task.tools.join(', ')}. They are among your tools: use them for what they are for rather than working around them with the shell.`);
  }
  lines.push(`THE ORIGINAL REQUEST — for context; the whole of it is not yours to complete:\n${clip(request, 4000)}`);
  if (reports.length) {
    lines.push('WHAT THE PACKAGES BEFORE YOURS REPORTED:\n\n'
      + reports.map(r => `### ${r.task.id}. ${r.task.title} — ${statusOf(r)}\n${clip(r.output, WORKER_REPORT_MAX_CHARS)}`).join('\n\n'));
  }
  return lines.join('\n\n');
}

function statusOf(result) {
  if (!result || result.skipped) return 'NOT STARTED';
  return result.ok ? 'done' : 'FAILED';
}

/**
 * Run the packages: research together, then the changes one at a time.
 *
 * Reading is safe to do in parallel and writing is not — two workers editing
 * the same tree at once overwrite each other, and each would be reasoning
 * about files the other is halfway through changing. So a change package
 * starts only when the one before it has finished, and is told what that one
 * did.
 *
 * A change package that fails stops the line: the packages after it were
 * written to build on it, and the main agent — which gets every report,
 * including the failure — is better placed to carry on than a worker briefed
 * for a state that never came about. A failed research package stops nothing.
 *
 * @param {object} plan  from parseWorkPlan
 * @param {object} options
 * @param {(task, ctx: {index, total, reports}) => Promise<{ok, output, files?}>} options.runWorker
 * @returns {Promise<Array<{task, ok, output, files, skipped}>>} one entry per package, in plan order
 */
export async function runWorkPlan(plan, {
  runWorker,
  signal = null,
  onTaskStart = null,
  onTaskEnd = null,
  parallel = ORCHESTRATE_PARALLEL_RESEARCH,
} = {}) {
  const tasks = plan?.tasks || [];
  const total = tasks.length;
  const results = tasks.map(task => ({ task, ok: false, output: '', files: [], skipped: true }));
  const finished = () => results.filter(r => !r.skipped);

  const runOne = async (index, reports) => {
    const task = tasks[index];
    if (signal?.aborted) return;
    onTaskStart?.(task, index);
    let outcome;
    try {
      outcome = await runWorker(task, { index, total, reports });
    } catch (error) {
      outcome = { ok: false, output: `Error: ${error?.message || error}` };
    }
    results[index] = {
      task,
      ok: Boolean(outcome?.ok),
      output: String(outcome?.output || ''),
      files: Array.isArray(outcome?.files) ? outcome.files : [],
      skipped: false,
    };
    onTaskEnd?.(task, index, results[index]);
  };

  const research = tasks.map((task, i) => (task.kind === 'research' ? i : -1)).filter(i => i !== -1);
  const changes = tasks.map((task, i) => (task.kind === 'research' ? -1 : i)).filter(i => i !== -1);

  // A small pool rather than Promise.all over everything: each worker is a
  // whole agent loop against the same provider, and its rate limit.
  const queue = [...research];
  const lanes = Array.from({ length: Math.max(1, Math.min(parallel, queue.length)) }, async () => {
    while (queue.length) await runOne(queue.shift(), []);
  });
  await Promise.all(lanes);

  for (const index of changes) {
    if (signal?.aborted) break;
    await runOne(index, finished());
    if (!results[index].ok) break;
  }
  return results;
}

/** Every file the workers changed, once each, in the order first touched. */
export function changedFiles(results = []) {
  return [...new Set(results.flatMap(r => r.files || []))];
}

/**
 * What the main agent reads when the workers are done. It goes into the
 * conversation as a message: the main agent did none of this work and saw
 * none of it, and it is the one that has to answer for the result.
 */
export function orchestrationReport(plan, results = [], { files = changedFiles(results) } = {}) {
  const open = results.filter(r => r.skipped || !r.ok);
  const head = '[Orchestrator — work already carried out]\n'
    + `Jev judged this request large enough to split, so it was divided into ${results.length} work packages and each was handed to a worker sub-agent in a context of its own, before your first step. `
    + 'Their reports follow. The work happened in THIS workspace — the files they name are already changed on disk — but nothing they read or ran is in your conversation.\n\n'
    + 'Your part now:\n'
    + '1. Check that the result holds together: open the files you need to see, and run the tests or checks.\n'
    + (open.length
      ? `2. Carry out yourself the package${open.length === 1 ? '' : 's'} marked FAILED or NOT STARTED (${open.map(r => r.task.id).join(', ')}).\n`
      : '2. Do not redo a package that is reported done.\n')
    + '3. Fix whatever does not fit together.\n'
    + '4. Tell the user what was done, in your own words — they have not seen these reports.';
  const body = results.map(r =>
    `### ${r.task.id}. ${r.task.title} — ${r.task.kind} — ${statusOf(r)}\n`
    + (r.skipped ? 'This package was not started.' : clip(r.output, WORKER_REPORT_MAX_CHARS) || 'The worker returned no report.'));
  const tail = files.length ? `\n\nFILES CHANGED BY THE WORKERS: ${files.join(', ')}` : '';
  return `${head}${plan?.rationale ? `\n\nWHY IT WAS SPLIT THIS WAY: ${plan.rationale}` : ''}\n\n${body.join('\n\n')}${tail}`;
}
