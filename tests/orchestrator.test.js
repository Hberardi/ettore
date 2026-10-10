// The orchestrator: a large request split into work packages, each carried out
// by a worker sub-agent in a context of its own, started by Jev before the
// turn's first step.
//
// The rule from jev.test.js holds here too: Jev starts it only when it is
// sure, and with Jev off, unsure or switched off for this, the turn is exactly
// what it was.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

import {
  PLANNER_OPENING,
  WORKER_OPENING,
  buildPlannerMessages,
  describePluginTools,
  orchestrationReport,
  parseWorkPlan,
  planWork,
  runWorkPlan,
  workerBrief,
} from '../src/agents/orchestrator.js';

const tick = ms => new Promise(r => { setTimeout(r, ms); });

const PLAN = {
  rationale: 'tre parti indipendenti',
  tasks: [
    { title: 'Aggiungi il tedesco al sito', kind: 'change', brief: 'Aggiungi de.json e il selettore.', files: ['site/i18n/de.json'] },
    { title: 'Dove sono le stringhe', kind: 'research', brief: 'Trova dove vengono lette le traduzioni.' },
    { title: 'Aggiorna i test', kind: 'change', brief: 'Copri la nuova lingua nei test.' },
    { title: 'Come girano i test', kind: 'research', brief: 'Trova il comando dei test e cosa coprono.' },
  ],
};

// ── the plan ─────────────────────────────────────────────────────────────

test('a plan is read out of fences and prose, and research is moved ahead of the changes', () => {
  const plan = parseWorkPlan(`Ecco il piano:\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\`\nFatto.`);
  assert.deepEqual(plan.tasks.map(t => t.kind), ['research', 'research', 'change', 'change']);
  // Each group keeps the order it was listed in: that is the order it runs in.
  assert.deepEqual(plan.tasks.map(t => t.title), [
    'Dove sono le stringhe', 'Come girano i test', 'Aggiungi il tedesco al sito', 'Aggiorna i test',
  ]);
  assert.deepEqual(plan.tasks.map(t => t.id), [1, 2, 3, 4]);
  assert.deepEqual(plan.tasks[2].files, ['site/i18n/de.json']);
  assert.equal(plan.rationale, 'tre parti indipendenti');
});

test('a request that does not split is not a plan', () => {
  // One package is the planner saying "this is one piece of work".
  assert.equal(parseWorkPlan(JSON.stringify({ tasks: [PLAN.tasks[0]] })), null);
  assert.equal(parseWorkPlan('non riesco a dividerlo'), null);
  assert.equal(parseWorkPlan(''), null);
  assert.equal(parseWorkPlan(JSON.stringify({ tasks: 'tutte' })), null);
  // A package with nothing to do is not a package.
  assert.equal(parseWorkPlan(JSON.stringify({ tasks: [PLAN.tasks[0], { title: 'vuoto', brief: '  ' }] })), null);
});

test('a plan is capped, and an unknown kind is a change', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ title: `p${i}`, kind: i === 0 ? 'analysis' : 'change', brief: `fai ${i}` }));
  const plan = parseWorkPlan(JSON.stringify({ tasks: many }), { maxTasks: 4 });
  assert.equal(plan.tasks.length, 4);
  // Only an explicit "research" is read-only; anything else is treated as
  // work that may write, which is the kind that runs alone.
  assert.ok(plan.tasks.every(t => t.kind === 'change'));
});

test('the planner is told the request and what is known of the codebase, and a failed call is no plan', async () => {
  const withExploration = buildPlannerMessages({ request: 'aggiungi il tedesco', exploration: 'le stringhe sono in site/i18n', repoMap: 'MAPPA' });
  assert.ok(withExploration[0].content.startsWith(PLANNER_OPENING));
  assert.match(withExploration[1].content, /aggiungi il tedesco/);
  assert.match(withExploration[1].content, /site\/i18n/);
  assert.doesNotMatch(withExploration[1].content, /MAPPA/, 'the exploration says more than the map does');
  assert.match(buildPlannerMessages({ request: 'x', repoMap: 'MAPPA' })[1].content, /MAPPA/);

  const seen = [];
  const plan = await planWork({
    async turn(messages, tools) { seen.push({ messages, tools }); return { type: 'text', content: JSON.stringify(PLAN) }; },
  }, { request: 'aggiungi il tedesco al sito e ai test' });
  assert.equal(plan.tasks.length, 4);
  assert.deepEqual(seen[0].tools, [], 'planning is one answer, with no tools');

  assert.equal(await planWork({ async turn() { throw new Error('429'); } }, { request: 'x' }), null);
});

// ── the schedule ─────────────────────────────────────────────────────────

test('research runs together, changes one at a time and each told what came before', async () => {
  const plan = parseWorkPlan(JSON.stringify(PLAN));
  let inFlight = 0;
  const peak = { research: 0, change: 0 };
  const sawReports = {};
  const order = [];

  const results = await runWorkPlan(plan, {
    runWorker: async (task, { reports }) => {
      inFlight++;
      peak[task.kind] = Math.max(peak[task.kind], inFlight);
      sawReports[task.title] = reports.map(r => r.task.title);
      await tick(25);
      inFlight--;
      order.push(task.title);
      return { ok: true, output: `fatto: ${task.title}`, files: task.kind === 'change' ? [`${task.id}.js`] : [] };
    },
  });

  assert.equal(peak.research, 2, 'both research packages at once');
  assert.equal(peak.change, 1, 'never two workers writing at the same time');
  assert.deepEqual(order.slice(2), ['Aggiungi il tedesco al sito', 'Aggiorna i test'], 'changes in the order listed, after the research');
  assert.deepEqual(sawReports['Dove sono le stringhe'], [], 'research starts from the request alone');
  assert.deepEqual(sawReports['Aggiungi il tedesco al sito'], ['Dove sono le stringhe', 'Come girano i test']);
  assert.deepEqual(sawReports['Aggiorna i test'], ['Dove sono le stringhe', 'Come girano i test', 'Aggiungi il tedesco al sito']);
  assert.ok(results.every(r => r.ok && !r.skipped));
});

test('a change that fails stops the line; a research that fails does not', async () => {
  const plan = parseWorkPlan(JSON.stringify(PLAN));
  const started = [];
  const results = await runWorkPlan(plan, {
    runWorker: async (task) => {
      started.push(task.title);
      if (task.title === 'Dove sono le stringhe') throw new Error('rate limit');
      if (task.title === 'Aggiungi il tedesco al sito') return { ok: false, output: 'Error: non ci sono riuscito' };
      return { ok: true, output: 'ok' };
    },
  });
  assert.ok(started.includes('Aggiungi il tedesco al sito'), 'a failed research package does not hold up the changes');
  assert.ok(!started.includes('Aggiorna i test'), 'the package written to build on a failed one must not start');
  const byTitle = Object.fromEntries(results.map(r => [r.task.title, r]));
  assert.match(byTitle['Dove sono le stringhe'].output, /rate limit/);
  assert.equal(byTitle['Dove sono le stringhe'].ok, false);
  assert.equal(byTitle['Aggiorna i test'].skipped, true);

  const report = orchestrationReport(plan, results);
  assert.match(report, /Dove sono le stringhe — research — FAILED/);
  assert.match(report, /Aggiorna i test — change — NOT STARTED/);
  assert.match(report, /Carry out yourself the packages marked FAILED or NOT STARTED \(1, 3, 4\)/);
});

test('an interrupted run starts nothing more', async () => {
  const plan = parseWorkPlan(JSON.stringify(PLAN));
  const controller = new AbortController();
  const started = [];
  const results = await runWorkPlan(plan, {
    signal: controller.signal,
    runWorker: async (task) => {
      started.push(task.title);
      if (task.kind === 'change') controller.abort();
      return { ok: true, output: 'ok' };
    },
  });
  assert.deepEqual(started.filter(t => /test$/.test(t) && t.startsWith('Aggiorna')), []);
  assert.equal(results.at(-1).skipped, true);
});

test('a worker is told its package, the request, and what the others did — and nothing asks it to do the rest', () => {
  const plan = parseWorkPlan(JSON.stringify(PLAN));
  const brief = workerBrief(plan.tasks[2], {
    request: 'aggiungi il tedesco al sito e ai test',
    index: 2,
    total: 4,
    reports: [{ task: plan.tasks[0], ok: true, output: 'Le stringhe sono in site/i18n/*.json.' }],
  });
  assert.ok(brief.startsWith(WORKER_OPENING));
  assert.match(brief, /package 3 of 4/);
  assert.match(brief, /YOUR PACKAGE: Aggiungi il tedesco al sito/);
  assert.match(brief, /site\/i18n\/de\.json/);
  assert.match(brief, /only your package/);
  assert.match(brief, /Le stringhe sono in site\/i18n/);
  assert.match(workerBrief(plan.tasks[0], { request: 'x' }), /READ-ONLY/);
});

// ── plugins in the plan ──────────────────────────────────────────────────

const PLUGIN_TOOLS = [
  { name: 'db_query', plugin: 'fakedb', description: 'Run a read-only SQL query.', readOnly: true },
  { name: 'db_write', plugin: 'fakedb', description: 'Insert or update rows.', readOnly: false },
  { name: 'ci_failures', plugin: 'ci', description: 'Why the last CI run failed.', readOnly: true },
];

test('the planner is told which plugin tools the workers have, and which are read-only', () => {
  assert.equal(describePluginTools(PLUGIN_TOOLS), [
    'fakedb:',
    '- db_query [read-only] — Run a read-only SQL query.',
    '- db_write — Insert or update rows.',
    'ci:',
    '- ci_failures [read-only] — Why the last CI run failed.',
  ].join('\n'));
  const [system, user] = buildPlannerMessages({ request: 'fix the report', pluginTools: PLUGIN_TOOLS });
  assert.match(user.content, /PLUGIN TOOLS THE WORKERS HAVE/);
  assert.match(user.content, /- db_write — Insert or update rows\./);
  assert.match(system.content, /"tools":\["<plugin tool name>"/);
  // No plugins, no section: the planner is not told about tools nobody has.
  assert.doesNotMatch(buildPlannerMessages({ request: 'fix the report' })[1].content, /PLUGIN TOOLS/);
});

test('a long catalogue is cut at whole tools and says how many it left out', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    name: `tool_${i}`, plugin: `plugin_${Math.floor(i / 6)}`, description: 'x'.repeat(130), readOnly: false,
  }));
  const text = describePluginTools(many);
  assert.ok(text.length < 3400, `expected a capped catalogue, got ${text.length} chars`);
  const shown = (text.match(/^- tool_/gm) || []).length;
  assert.match(text, new RegExp(`… and ${60 - shown} more plugin tools not listed\\.$`));
});

test('a package keeps the plugin tools that exist, and one that needs a writing tool is a change', () => {
  const plan = parseWorkPlan(JSON.stringify({
    tasks: [
      { title: 'Read the orders', kind: 'research', brief: 'Query the orders table.', tools: ['db_query', 'no_such_tool', 'db_query'] },
      { title: 'Fix the totals', kind: 'research', brief: 'Update the wrong rows.', tools: ['db_query', 'db_write'] },
      { title: 'Update the code', kind: 'change', brief: 'Fix the calculation.' },
    ],
  }), { pluginTools: PLUGIN_TOOLS });
  assert.deepEqual(plan.tasks.map(t => [t.title, t.kind, t.tools]), [
    ['Read the orders', 'research', ['db_query']],
    // Called research, but a read-only worker would be refused db_write.
    ['Fix the totals', 'change', ['db_query', 'db_write']],
    ['Update the code', 'change', []],
  ]);
  // With no plugins installed, a tool the planner made up is dropped.
  const bare = parseWorkPlan(JSON.stringify({ tasks: [
    { title: 'a', kind: 'research', brief: 'x', tools: ['db_query'] },
    { title: 'b', kind: 'change', brief: 'y' },
  ] }));
  assert.deepEqual(bare.tasks.map(t => [t.kind, t.tools]), [['research', []], ['change', []]]);
});

test('a worker is told which plugin tools its package was given', () => {
  const brief = workerBrief({ id: 1, title: 'Read the orders', kind: 'research', brief: 'Query.', files: [], tools: ['db_query'] }, { request: 'r', total: 2 });
  assert.match(brief, /PLUGIN TOOLS FOR THIS PACKAGE: db_query\./);
  const plain = workerBrief({ id: 1, title: 'x', kind: 'change', brief: 'y', files: [], tools: [] }, { request: 'r', total: 2 });
  assert.doesNotMatch(plain, /PLUGIN TOOLS/);
});

// ── inside a turn, started by Jev ────────────────────────────────────────

let dir;
let work;
const previousConfigDir = process.env.ETTORE_CONFIG_DIR;
let originalFetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ettore-orch-cfg-'));
  work = mkdtempSync(join(tmpdir(), 'ettore-orch-work-'));
  process.env.ETTORE_CONFIG_DIR = dir;
  delete process.env.TYPESAFE_API_KEY;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousConfigDir === undefined) delete process.env.ETTORE_CONFIG_DIR;
  else process.env.ETTORE_CONFIG_DIR = previousConfigDir;
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

// Jev's answers by which questions it was sent. `orchestrate` is only
// answered when asked: the agent leaves the question out when it could not
// act on a yes.
function fakeJev({ orchestrate = 0.1, approach = 'direct', confidence = 0.9, ambiguous = 0.1, difficulty = null } = {}) {
  const calls = [];
  const fn = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const q = body.questions;
    const answers = {};
    if (q.approach) {
      answers.approach = { type: 'choice', choice: approach, confidence };
      answers.ambiguous = { type: 'noul', noul: ambiguous };
      answers.multi_step = { type: 'noul', noul: 0.9 };
      answers.independent_parts = { type: 'noul', noul: 0.1 };
      if (difficulty) answers.difficulty = { type: 'choice', choice: difficulty, confidence };
      if (q.orchestrate) answers.orchestrate = { type: 'noul', noul: orchestrate };
    }
    if (q.complete) {
      Object.assign(answers, { announced: { noul: 0.1 }, deferred: { noul: 0.1 }, unapplied_code: { noul: 0.1 }, complete: { noul: 0.9 } });
    }
    if (q.destructive) answers.destructive = { type: 'noul', noul: 0.1 };
    if (q.needs_approval) answers.needs_approval = { type: 'noul', noul: 0.1 };
    const ok = { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers, usage: {} }), text: async () => '' };
    return ok;
  };
  fn.calls = calls;
  fn.preTurnCalls = () => calls.filter(c => c.questions.approach);
  return fn;
}

let Agent;
test('setup: load the agent once', async () => {
  ({ Agent } = await import('../src/agents/index.js'));
});

async function activate() {
  const { activateJev } = await import('../src/jev/index.js');
  activateJev('sk-test-key-value');
}

function agentIn(client, extra = {}) {
  return new Agent(client, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: work, contextWindow: 128000, verifyAfterEdit: false, ...extra,
  }, 'build');
}

const textOf = messages => messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
const firstUser = messages => String(messages.find(m => m?.role === 'user')?.content || '');
const isPlanner = messages => String(messages[0]?.content || '').startsWith(PLANNER_OPENING);
const isWorker = messages => firstUser(messages).startsWith(WORKER_OPENING);
const packageOf = messages => firstUser(messages).match(/YOUR PACKAGE: (.+)/)?.[1] || '';

// A client that plays all three roles: the planner, each worker, and the main
// agent. `worker` and `main` are scripts the test supplies.
function scripted({ plan = PLAN, worker, main, seen = {} }) {
  seen.planner = [];
  seen.workers = [];
  seen.main = [];
  return {
    async turn(messages, tools, onToken) {
      if (isPlanner(messages)) {
        seen.planner.push(textOf(messages));
        onToken?.('{');
        return { type: 'text', content: typeof plan === 'string' ? plan : JSON.stringify(plan) };
      }
      if (isWorker(messages)) {
        const entry = { title: packageOf(messages), brief: firstUser(messages), tools: (tools || []).map(t => t.function.name) };
        seen.workers.push(entry);
        return worker ? worker(messages, entry) : { type: 'text', content: `Fatto: ${entry.title}.` };
      }
      seen.main.push(textOf(messages));
      return main ? main(messages) : { type: 'text', content: 'Tutto a posto.' };
    },
  };
}

const REQUEST = 'aggiungi la lingua tedesca al sito, aggiorna i test e documenta tutto nel README';

test('a large job is split, carried out by workers, and the main agent opens on their reports', async () => {
  await activate();
  globalThis.fetch = fakeJev({ orchestrate: 0.93 });
  const seen = {};
  const events = { routes: [], plan: null, done: null, workers: [], planning: [] };
  const emitter = new EventEmitter();
  emitter.on('jevRoute', r => events.routes.push(r));
  emitter.on('orchestrationPlan', p => { events.plan = p; });
  emitter.on('orchestrationDone', d => { events.done = d; });
  emitter.on('planningSkipped', e => events.planning.push(e));
  emitter.on('toolStart', e => { if (e.name === 'worker') events.workers.push(e.args); });
  // The plan is never shown, but a planner writing in silence would be
  // cancelled by the stall watchdog: its tokens must count as a sign of life.
  let alive = 0;
  emitter.on('subagentProgress', () => { alive++; });

  const out = await agentIn(scripted({ seen })).run(REQUEST, emitter);
  assert.ok(alive > 0, 'the turn must hear that the planner is getting somewhere');

  assert.equal(out, 'Tutto a posto.');
  assert.equal(seen.planner.length, 1, 'one planning call');
  assert.match(seen.planner[0], /aggiungi la lingua tedesca/);

  // One worker per package, research first. The two research workers run
  // together, so which of them reaches the model first is not fixed; the
  // changes are, and they come after.
  const titles = seen.workers.map(w => w.title);
  assert.deepEqual(titles.slice(0, 2).sort(), ['Come girano i test', 'Dove sono le stringhe']);
  assert.deepEqual(titles.slice(2), ['Aggiungi il tedesco al sito', 'Aggiorna i test']);
  // Read-only by construction for research, able to write for a change — and
  // neither can delegate again.
  const research = seen.workers[0];
  const change = seen.workers[2];
  for (const forbidden of ['write', 'edit', 'bash']) {
    assert.equal(research.tools.includes(forbidden), false, `a research worker was handed ${forbidden}`);
  }
  assert.ok(research.tools.includes('read'));
  assert.ok(change.tools.includes('edit') && change.tools.includes('write'));
  assert.equal(change.tools.includes('explore'), false);
  // The change workers were told what the research found.
  assert.match(change.brief, /Fatto: Dove sono le stringhe\./);

  // The main agent starts from the reports, not from a request to plan.
  assert.equal(seen.main.length, 1);
  assert.match(seen.main[0], /\[Orchestrator — work already carried out\]/);
  assert.match(seen.main[0], /### 3\. Aggiungi il tedesco al sito — change — done/);
  assert.doesNotMatch(seen.main[0], /<plan>/, 'the work is done: no plan is asked for');

  assert.deepEqual(events.plan.tasks.map(t => t.kind), ['research', 'research', 'change', 'change']);
  assert.deepEqual(events.workers.map(w => w.package), ['1/4', '2/4', '3/4', '4/4']);
  assert.equal(events.done.done, 4);
  assert.ok(events.routes.some(r => !r.done && r.actions.includes('orchestrate')), 'the wait has a reason');
  assert.ok(events.routes.some(r => r.done && r.actions.includes('orchestrate')));
  // A worker's request is a brief the harness wrote: Jev is not asked to route it.
  assert.equal(globalThis.fetch.preTurnCalls().length, 1);
});

test('what a worker writes is on disk, and counts as the turn\'s own change', async () => {
  await activate();
  globalThis.fetch = fakeJev({ orchestrate: 0.93 });
  const target = join(work, 'de.json');
  const seen = {};
  const finished = [];
  const emitter = new EventEmitter();
  emitter.on('turnState', () => {});
  emitter.on('orchestrationDone', d => finished.push(d));

  const worker = (messages, entry) => {
    if (entry.title !== 'Aggiungi il tedesco al sito') return { type: 'text', content: `Fatto: ${entry.title}.` };
    if (messages.some(m => m.role === 'tool')) return { type: 'text', content: `Scritto ${target}.` };
    return {
      type: 'tool_calls',
      tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: target, content: '{"ciao":"hallo"}\n' }) } }],
    };
  };

  await agentIn(scripted({ seen, worker })).run(REQUEST, emitter);

  assert.ok(existsSync(target), 'the worker really wrote the file');
  assert.equal(readFileSync(target, 'utf8'), '{"ciao":"hallo"}\n');
  assert.equal(finished[0].files, 1);
  assert.match(seen.main[0], new RegExp(`FILES CHANGED BY THE WORKERS: .*de\\.json`));
});

test('after the workers, the main agent still has its todo list and its tools', async () => {
  await activate();
  globalThis.fetch = fakeJev({ orchestrate: 0.93 });
  let mainTurns = 0;
  let todoResult = '';
  const todoLists = [];
  const emitter = new EventEmitter();
  emitter.on('todoList', items => todoLists.push(items));
  emitter.on('toolEnd', info => { if (info.name === 'todo_write' && !info.subagent) todoResult = String(info.output); });

  await agentIn(scripted({
    main: () => {
      mainTurns++;
      // Every nested run() clears the module-level todo sink on its way out.
      if (mainTurns === 1) {
        return {
          type: 'tool_calls',
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ action: 'set', items: ['controlla', 'riferisci'] }) } }],
        };
      }
      return { type: 'text', content: '<done:1>\n<done:2>\nFatto.' };
    },
  })).run(REQUEST, emitter);

  assert.doesNotMatch(todoResult, /only available during an agent turn/i);
  assert.deepEqual(todoLists.at(-1), ['controlla', 'riferisci']);
});

test('an unsure Jev orchestrates nothing', async () => {
  await activate();
  globalThis.fetch = fakeJev({ orchestrate: 0.6 });
  const seen = {};
  await agentIn(scripted({ seen })).run(REQUEST, new EventEmitter());
  assert.equal(seen.planner.length, 0);
  assert.equal(seen.workers.length, 0);
  assert.doesNotMatch(seen.main[0], /Orchestrator/);
});

test('with Jev off the same request is one turn, as before', async () => {
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error('must not be called'); };
  const seen = {};
  await agentIn(scripted({ seen })).run(REQUEST, new EventEmitter());
  assert.equal(fetched, 0);
  assert.equal(seen.planner.length + seen.workers.length, 0);
});

test('switched off, the question is not even asked', async () => {
  await activate();
  const { setOrchestrationEnabled, isOrchestrationEnabled } = await import('../src/jev/index.js');
  assert.equal(isOrchestrationEnabled(), true, 'on unless switched off');
  setOrchestrationEnabled(false);
  globalThis.fetch = fakeJev({ orchestrate: 0.99 });
  const seen = {};
  await agentIn(scripted({ seen })).run(REQUEST, new EventEmitter());
  assert.equal(seen.planner.length, 0);
  const [call] = globalThis.fetch.preTurnCalls();
  assert.equal('orchestrate' in call.questions, false);

  // And a user who asked to see a plan before any work gets the plan, not workers.
  setOrchestrationEnabled(true);
  globalThis.fetch = fakeJev({ orchestrate: 0.99 });
  const forced = {};
  await agentIn(scripted({ seen: forced }), { explicitPlan: 'always' }).run(REQUEST, new EventEmitter());
  assert.equal(forced.planner.length, 0);
  assert.match(forced.main[0], /<plan>/);
});

test('a request nobody understands yet, or one Jev also calls trivial, is not handed out', async () => {
  await activate();
  globalThis.fetch = fakeJev({ orchestrate: 0.95, ambiguous: 0.93 });
  const ambiguous = {};
  await agentIn(scripted({ seen: ambiguous })).run(REQUEST, new EventEmitter());
  assert.equal(ambiguous.planner.length, 0);
  assert.match(ambiguous.main[0], /ask the user ONE short question/);

  globalThis.fetch = fakeJev({ orchestrate: 0.95, difficulty: 'trivial' });
  const trivial = {};
  await agentIn(scripted({ seen: trivial })).run(REQUEST, new EventEmitter());
  assert.equal(trivial.planner.length, 0);
});

test('a planner that does not split the request leaves the turn to the main agent', async () => {
  await activate();
  globalThis.fetch = fakeJev({ orchestrate: 0.93 });
  const seen = {};
  const routes = [];
  const emitter = new EventEmitter();
  emitter.on('jevRoute', r => routes.push(r));
  const out = await agentIn(scripted({ seen, plan: { tasks: [PLAN.tasks[0]] } })).run(REQUEST, emitter);
  assert.equal(out, 'Tutto a posto.');
  assert.equal(seen.planner.length, 1);
  assert.equal(seen.workers.length, 0);
  assert.doesNotMatch(seen.main[0], /Orchestrator/);
  assert.ok(!routes.some(r => r.done && r.actions.includes('orchestrate')));
});

test('a worker that fails is reported, and what it left is handed to the main agent', async () => {
  await activate();
  globalThis.fetch = fakeJev({ orchestrate: 0.93 });
  const seen = {};
  const worker = (_messages, entry) => {
    if (entry.title === 'Aggiungi il tedesco al sito') throw new Error('provider down');
    return { type: 'text', content: `Fatto: ${entry.title}.` };
  };
  const done = [];
  const emitter = new EventEmitter();
  emitter.on('error', () => {});
  emitter.on('orchestrationDone', d => done.push(d));
  await agentIn(scripted({ seen, worker })).run(REQUEST, emitter);

  assert.ok(!seen.workers.some(w => w.title === 'Aggiorna i test'), 'the package after a failed change does not start');
  assert.match(seen.main[0], /Aggiungi il tedesco al sito — change — FAILED/);
  assert.match(seen.main[0], /Aggiorna i test — change — NOT STARTED/);
  assert.equal(done[0].done, 2);
});

test('the exploration Jev ran first is what the planner splits from', async () => {
  await activate();
  globalThis.fetch = fakeJev({ orchestrate: 0.93, approach: 'explore' });
  const seen = { planner: [], workers: [], main: [] };
  const client = {
    async turn(messages, tools) {
      if (isPlanner(messages)) { seen.planner.push(textOf(messages)); return { type: 'text', content: JSON.stringify(PLAN) }; }
      if (isWorker(messages)) { seen.workers.push(packageOf(messages)); return { type: 'text', content: 'Fatto.' }; }
      if (firstUser(messages).startsWith('You are an exploration sub-agent')) {
        return { type: 'text', content: 'Le traduzioni sono lette in site/i18n/loader.js:12.' };
      }
      seen.main.push(textOf(messages));
      void tools;
      return { type: 'text', content: 'Ok.' };
    },
  };
  await agentIn(client).run(REQUEST, new EventEmitter());
  assert.match(seen.planner[0], /site\/i18n\/loader\.js:12/, 'the split is made knowing where things live');
  assert.equal(seen.workers.length, 4);
  assert.match(seen.main[0], /exploration already done[\s\S]*Orchestrator — work already carried out/);
});

test('/jev orchestrate switches it on and off and says which it is', async () => {
  const { builtinCommands } = await import('../src/commands/index.js');
  const jev = builtinCommands.jev.handler;
  assert.match(await jev(['orchestrate']), /Orchestrator: on/);
  assert.match(await jev(['orchestrate', 'off']), /Orchestrator: off/);
  const { isOrchestrationEnabled } = await import('../src/jev/index.js');
  assert.equal(isOrchestrationEnabled(), false);
  assert.match(await jev(['orchestrate', 'on']), /Orchestrator: on/);
  assert.match(await jev(['orchestrate', 'forse']), /Usage/);
});

// ── plugins reach the workers ────────────────────────────────────────────

async function registryWithFakeDb(calls) {
  const { PluginRegistry } = await import('../src/plugins/index.js');
  const { toolDefinitions, toolHandlers } = await import('../src/tools/index.js');
  const registry = new PluginRegistry({ builtInTools: toolDefinitions, builtInHandlers: toolHandlers });
  registry.register({
    manifest: { name: 'fakedb', version: '1.0.0' },
    tools: {
      db_query: {
        description: 'Run a read-only SQL query against the orders database.',
        risk: 'low',
        parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
        handler: async ({ sql }) => { calls.push(['db_query', sql]); return '3 rows'; },
      },
      db_write: {
        description: 'Insert or update rows in the orders database.',
        risk: 'high',
        parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
        handler: async ({ sql }) => { calls.push(['db_write', sql]); return '1 row updated'; },
      },
    },
    commands: {},
    hooks: {},
  });
  return registry;
}

const callTool = (id, name, args) => {
  const tc = { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
};
const toolResults = messages => messages.filter(m => m.role === 'tool').map(m => String(m.content));

const DB_PLAN = {
  rationale: 'leggere, poi correggere',
  tasks: [
    { title: 'Leggi gli ordini', kind: 'research', brief: 'Interroga la tabella ordini.', tools: ['db_query'] },
    { title: 'Correggi i totali', kind: 'change', brief: 'Aggiorna le righe sbagliate.', tools: ['db_write'] },
  ],
};

test('workers have the plugins: the planner hears of them, and each package gets the tools it named', async () => {
  await activate();
  globalThis.fetch = fakeJev({ orchestrate: 0.93 });
  const calls = [];
  const seen = {};
  const plugins = [];
  const emitter = new EventEmitter();
  emitter.on('toolStart', (e) => { if (e.plugin) plugins.push([e.name, e.plugin, Boolean(e.subagent)]); });

  const client = scripted({
    plan: DB_PLAN,
    seen,
    worker: (messages, entry) => {
      if (toolResults(messages).length) return { type: 'text', content: `Fatto: ${entry.title}. ${toolResults(messages)[0]}` };
      return entry.title === 'Leggi gli ordini'
        ? callTool('q1', 'db_query', { sql: 'select * from orders' })
        : callTool('w1', 'db_write', { sql: 'update orders set total = 1' });
    },
  });
  await agentIn(client, { pluginRegistry: await registryWithFakeDb(calls) }).run(REQUEST, emitter);

  assert.match(seen.planner[0], /PLUGIN TOOLS THE WORKERS HAVE/);
  assert.match(seen.planner[0], /- db_query \[read-only\]/);
  assert.match(seen.planner[0], /- db_write — Insert or update rows/);

  // One entry per worker turn; the first of each is what it was offered.
  const research = seen.workers.find(w => w.title === 'Leggi gli ordini');
  const change = seen.workers.find(w => w.title === 'Correggi i totali');
  assert.ok(research.tools.includes('db_query'), `the research worker must be offered db_query, got ${research.tools}`);
  assert.ok(!research.tools.includes('db_write'), 'a read-only worker is not offered a plugin tool that writes');
  assert.match(research.brief, /PLUGIN TOOLS FOR THIS PACKAGE: db_query/);
  assert.ok(change.tools.includes('db_write'), `the change worker must be offered db_write, got ${change.tools}`);
  assert.ok(change.tools.includes('db_query'));

  assert.deepEqual(calls, [['db_query', 'select * from orders'], ['db_write', 'update orders set total = 1']]);
  // The TUI names the plugin a tool belongs to, in a worker as in the main agent.
  assert.deepEqual(plugins, [['db_query', 'fakedb', true], ['db_write', 'fakedb', true]]);
});

test('a read-only worker that calls a writing plugin tool by name is refused, and the tool does not run', async () => {
  await activate();
  globalThis.fetch = fakeJev({ orchestrate: 0.93 });
  const calls = [];
  const seen = {};
  const refused = [];
  const client = scripted({
    plan: { rationale: 'x', tasks: [DB_PLAN.tasks[0], { title: 'Documenta', kind: 'change', brief: 'Scrivi le note.' }] },
    seen,
    worker: (messages, entry) => {
      const results = toolResults(messages);
      if (results.length) { refused.push(...results); return { type: 'text', content: `Fatto: ${entry.title}.` }; }
      // Not among the tools it was offered — a model can still name it.
      return entry.title === 'Leggi gli ordini'
        ? callTool('w1', 'db_write', { sql: 'delete from orders' })
        : { type: 'text', content: `Fatto: ${entry.title}.` };
    },
  });
  await agentIn(client, { pluginRegistry: await registryWithFakeDb(calls) }).run(REQUEST, new EventEmitter());

  assert.deepEqual(calls, [], 'db_write must not have run');
  assert.equal(refused.length, 1);
  assert.match(refused[0], /plugin tool "db_write" can change things, and this agent is read-only/);
});

test('the exploration sub-agent still gets no plugin tools', async () => {
  const offered = [];
  const agent = agentIn({
    async turn(_messages, tools) {
      offered.push((tools || []).map(t => t.function.name));
      return { type: 'text', content: 'found it' };
    },
  }, { pluginRegistry: await registryWithFakeDb([]) });
  const run = options => agent._runSubagent({ prompt: 'where is the orders code?', mode: 'plan', maxIterations: 2, maxToolCalls: 2, timeoutMs: 5000, ...options }, new EventEmitter(), null);

  await run({});
  assert.ok(!offered[0].some(name => name.startsWith('db_')), `explore must not see plugin tools, got ${offered[0]}`);
  await run({ plugins: true });
  assert.ok(offered[1].includes('db_query'));
  assert.ok(!offered[1].includes('db_write'));
});

test('with tool routing off, plan mode still offers the read-only plugin tools', async () => {
  const offered = [];
  const agent = new Agent({
    async turn(_messages, tools) {
      offered.push((tools || []).map(t => t.function.name));
      return { type: 'text', content: 'ok' };
    },
  }, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full', workdir: work, contextWindow: 128000,
    verifyAfterEdit: false, dynamicToolRouting: false, pluginRegistry: await registryWithFakeDb([]),
  }, 'plan');
  await agent.run('quanti ordini ci sono?', new EventEmitter());
  assert.ok(offered[0].includes('db_query'));
  assert.ok(!offered[0].includes('db_write'));
  assert.ok(!offered[0].includes('write'));
});

test('plan mode refuses a built-in tool that changes things, even when the model names it unasked', async () => {
  const target = join(work, 'written-in-plan-mode.txt');
  const results = [];
  let turn = 0;
  const client = {
    async turn(messages) {
      results.push(...toolResults(messages).slice(results.length));
      turn++;
      if (turn === 1) return callTool('w1', 'write', { file_path: target, content: 'x' });
      if (turn === 2) return callTool('b1', 'bash', { command: `touch ${target}`, workdir: work });
      return { type: 'text', content: 'ok' };
    },
  };
  const config = { provider: 'test', model: 'gpt-4o', modelCapability: 'full', workdir: work, contextWindow: 128000, verifyAfterEdit: false };
  await new Agent(client, config, 'plan').run('guarda il progetto', new EventEmitter());
  assert.equal(existsSync(target), false, 'nothing may be written in plan mode');
  assert.equal(results.length, 2);
  assert.match(results[0], /"write" changes things, and this agent is read-only/);
  assert.match(results[1], /"bash" changes things, and this agent is read-only/);

  // The same call in build mode is carried out.
  turn = 0;
  results.length = 0;
  await new Agent(client, config, 'build').run('crea il file', new EventEmitter());
  assert.equal(existsSync(target), true);
});

test('what plan mode refuses is what the router keeps out of it, and nothing that only reads', async () => {
  const { isBuildOnlyTool } = await import('../src/agents/tool-router.js');
  for (const name of ['write', 'edit', 'apply_patch_structured', 'bash', 'bash_session', 'run_tests', 'run_checks', 'dev_server', 'browser_app', 'desktop_app', 'assemble_music_video']) {
    assert.equal(isBuildOnlyTool(name), true, `${name} changes things`);
  }
  for (const name of ['read', 'grep', 'glob', 'list_dir', 'git_diff', 'websearch', 'webfetch', 'browser_check', 'read_server_console', 'dep_inspect', 'ask_user', 'todo_write', 'explore', 'audio_read', 'read_pdf']) {
    assert.equal(isBuildOnlyTool(name), false, `${name} only reads`);
  }
});
