// Jev as more than an end-of-turn referee: it asks for a clarification or a
// plan before the turn, watches the turn while it runs, and reads shell
// commands before they run.
//
// The rule from jev.test.js still holds everywhere here: Jev changes only what
// it is sure about, it can add a question or a check but never remove one,
// and with Jev off, failing or unsure, nothing differs from before.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

import { uiBridge } from '../src/tools/bridge.js';
import { isPlainlyReadOnly, judgeCommand, clearCommandJudgeCache } from '../src/jev/command-judge.js';
import {
  createProgressGuardState,
  decideProgressAction,
  progressCheckDue,
  recordBatchForGuard,
  recordToolForGuard,
} from '../src/jev/progress-guard.js';

let dir;
const previousConfigDir = process.env.ETTORE_CONFIG_DIR;
const previousApiKey = process.env.TYPESAFE_API_KEY;
let originalFetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ettore-jev2-'));
  process.env.ETTORE_CONFIG_DIR = dir;
  delete process.env.TYPESAFE_API_KEY;
  originalFetch = globalThis.fetch;
  clearCommandJudgeCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousConfigDir === undefined) delete process.env.ETTORE_CONFIG_DIR;
  else process.env.ETTORE_CONFIG_DIR = previousConfigDir;
  if (previousApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = previousApiKey;
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// One fake Jev for every kind of call, answering by which questions it got.
function fakeJev({ approach = 'direct', confidence = 0.9, ambiguous = 0.1, multiStep = 0.1, difficulty = null, families = {}, independent = 0.1, progress = {}, destructive = 0.1, complete = 0.9 } = {}) {
  const calls = [];
  const fn = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const q = body.questions;
    const answers = {};
    if (q.approach) {
      answers.approach = { type: 'choice', choice: approach, confidence };
      answers.ambiguous = { type: 'noul', noul: ambiguous };
      answers.multi_step = { type: 'noul', noul: multiStep };
      answers.independent_parts = { type: 'noul', noul: independent };
      if (difficulty) answers.difficulty = { type: 'choice', choice: difficulty, confidence };
      for (const [family, value] of Object.entries(families)) {
        answers[`tools_${family}`] = { type: 'noul', noul: value };
      }
    }
    if (q.looping) {
      for (const key of ['looping', 'stuck_on_error', 'off_track']) answers[key] = { type: 'noul', noul: progress[key] ?? 0.1 };
    }
    if (q.destructive) answers.destructive = { type: 'noul', noul: destructive };
    if (q.complete) {
      Object.assign(answers, {
        announced: { noul: 0.1 }, deferred: { noul: 0.1 }, unapplied_code: { noul: 0.1 }, complete: { noul: complete },
      });
    }
    return jsonResponse({ model: 'jev-1.13.0', answers, usage: {} });
  };
  fn.calls = calls;
  return fn;
}

let Agent;
let toolHandlers;
test('setup: load the agent once', async () => {
  ({ Agent } = await import('../src/agents/index.js'));
  ({ toolHandlers } = await import('../src/tools/index.js'));
});

function agentInBuild(client, extra = {}) {
  return new Agent(client, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false, ...extra,
  }, 'build');
}

const textOf = messages => messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');

async function activate() {
  const { activateJev } = await import('../src/jev/index.js');
  activateJev('sk-test-key-value');
}

// ── before the turn ──────────────────────────────────────────────────────

test('an ambiguous request makes the model ask before acting', async () => {
  await activate();
  globalThis.fetch = fakeJev({ ambiguous: 0.92, approach: 'explore', confidence: 0.9 });
  const prompts = [];
  const routes = [];
  const emitter = new EventEmitter();
  emitter.on('jevRoute', r => routes.push(r));
  await agentInBuild({
    async turn(messages) { prompts.push(textOf(messages)); return { type: 'text', content: 'Quale file intendi?' }; },
  }).run('sistemalo come ti ho detto prima, quello là', emitter);
  assert.match(prompts[0], /ask the user ONE short question with `ask_user`/);
  assert.ok(!prompts.some(p => /exploration already done/.test(p)), 'no exploring a request not yet understood');
  assert.ok(routes.some(r => r.done && r.actions.includes('clarify')));
});

test('a multi-step request gets a plan the word heuristics missed', async () => {
  await activate();
  globalThis.fetch = fakeJev({ multiStep: 0.9 });
  const prompts = [];
  const plans = [];
  const emitter = new EventEmitter();
  emitter.on('planningStarted', e => plans.push(e));
  await agentInBuild({
    async turn(messages) { prompts.push(textOf(messages)); return { type: 'text', content: 'Ok.' }; },
  }).run('aggiungi la lingua tedesca al sito e ai test', emitter);
  assert.match(prompts[0], /<plan>/, 'the planning reminder must reach the model');
  assert.ok(plans.some(p => p.source === 'jev'));
});

test('a plan is not forced when planning is switched off', async () => {
  await activate();
  globalThis.fetch = fakeJev({ multiStep: 0.95 });
  const prompts = [];
  await agentInBuild({
    async turn(messages) { prompts.push(textOf(messages)); return { type: 'text', content: 'Ok.' }; },
  }, { requireExplicitPlan: false }).run('aggiungi la lingua tedesca al sito e ai test', new EventEmitter());
  assert.doesNotMatch(prompts[0], /<plan>/);
});

test('a request that needs no code is answered directly', async () => {
  await activate();
  globalThis.fetch = fakeJev({ approach: 'none', confidence: 0.93 });
  const prompts = [];
  await agentInBuild({
    async turn(messages) { prompts.push(textOf(messages)); return { type: 'text', content: 'Una closure è…' }; },
  }).run('cosa è una closure in javascript, in due righe?', new EventEmitter());
  assert.match(prompts[0], /Answer it directly/);
});

test('unsure pre-turn flags change nothing', async () => {
  await activate();
  globalThis.fetch = fakeJev({ ambiguous: 0.6, multiStep: 0.55, confidence: 0.4 });
  const prompts = [];
  await agentInBuild({
    async turn(messages) { prompts.push(textOf(messages)); return { type: 'text', content: 'Ok.' }; },
  }).run('aggiungi un log nella funzione di salvataggio', new EventEmitter());
  assert.doesNotMatch(prompts[0], /ask the user ONE short question|"steps": \[|Answer it directly|exploration already done|delegate this one to `explore`/);
});

// ── while the turn runs ──────────────────────────────────────────────────

test('the guard only checks when there is something to check', () => {
  const state = createProgressGuardState();
  assert.equal(progressCheckDue(state, { toolCallCount: 2 }), null, 'too early');
  assert.equal(progressCheckDue(state, { toolCallCount: 8 }), 'cadence');
  assert.equal(progressCheckDue(state, { toolCallCount: 4, repeatedCount: 3 }), 'repeat');
  recordBatchForGuard(state, [{ output: 'Error: boom' }]);
  recordBatchForGuard(state, [{ output: 'out\n[exit code 1]' }]);
  assert.equal(progressCheckDue(state, { toolCallCount: 4 }), 'errors');
  recordBatchForGuard(state, [{ output: 'fine' }]);
  assert.equal(state.errorStreak, 0, 'a batch that works resets the streak');
  state.lastCheckAt = 8;
  assert.equal(progressCheckDue(state, { toolCallCount: 9, repeatedCount: 5 }), null, 'never two checks back to back');
});

test('the guard corrects once, then stops a turn still going in circles', () => {
  const sure = { value: 0.95, yes: true, decisive: true };
  const no = { value: 0.05, yes: false, decisive: true };
  const state = createProgressGuardState();
  assert.equal(decideProgressAction({ looping: no, stuck_on_error: no, off_track: no }, state).action, 'ok');
  assert.equal(decideProgressAction({ looping: sure }, state).action, 'correct');
  state.corrections = 1;
  assert.equal(decideProgressAction({ looping: sure }, state).action, 'stop');
  assert.equal(decideProgressAction({ off_track: sure }, state).action, 'correct', 'drifting alone never stops a turn');
  assert.equal(decideProgressAction({ looping: { value: 0.6, yes: true, decisive: false } }, state).action, 'ok', 'unsure is not a verdict');
});

test('what the guard remembers of a call is short and says whether it failed', () => {
  const state = createProgressGuardState();
  for (let i = 0; i < 14; i++) recordToolForGuard(state, { name: 'bash', args: { command: `npm test -- ${i}` }, output: 'x'.repeat(1000) + '\n[exit code 1]' });
  assert.equal(state.recent.length, 10);
  assert.ok(state.recent.every(r => r.outcome.length <= 240 && r.failed));
});

// A model that runs the same failing command over and over.
function loopingClient(counter) {
  return {
    async turn(messages, tools) {
      counter.turns++;
      counter.prompts.push(textOf(messages));
      // Handed no tools, a model answers in prose — which is what a stop is.
      if (counter.turns > 12 || !tools?.length) return { type: 'text', content: 'Mi fermo qui.' };
      const calls = [0, 1, 2].map(i => ({
        id: `b${counter.turns}_${i}`,
        type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: `node broken.js --try ${counter.turns}_${i}` }) },
      }));
      return { type: 'tool_calls', tool_calls: calls, message: { role: 'assistant', content: '', tool_calls: calls } };
    },
  };
}

test('with Jev sure the turn is looping, it is told to change course, then stopped', async () => {
  await activate();
  globalThis.fetch = fakeJev({ progress: { looping: 0.94, stuck_on_error: 0.9 } });
  const originalBash = toolHandlers.bash;
  toolHandlers.bash = async () => 'TypeError: x is undefined\n[exit code 1]';
  try {
    const counter = { turns: 0, prompts: [] };
    const guards = [];
    const emitter = new EventEmitter();
    emitter.on('jevGuard', g => guards.push(g));
    await agentInBuild(loopingClient(counter), { maxReadOnlyToolBatches: 99 }).run('fai partire broken.js', emitter);
    assert.equal(guards[0]?.action, 'correct', JSON.stringify({ guards, turns: counter.turns }));
    assert.ok(counter.prompts.some(p => /Jev has been watching this turn's tool calls/.test(p)), 'the correction reaches the model');
    assert.ok(guards.some(g => g.action === 'stop'), `expected a stop, got ${JSON.stringify(guards.map(g => g.action))}`);
    assert.ok(counter.turns < 12, `the stop ends the tool loop early: ${JSON.stringify({ turns: counter.turns, guards: guards.map(g => [g.action, g.toolCallCount]) })}`);
  } finally {
    toolHandlers.bash = originalBash;
  }
});

test('with Jev off the same turn is not checked at all', async () => {
  const fetchFn = fakeJev({ progress: { looping: 0.94 } });
  globalThis.fetch = fetchFn;
  const originalBash = toolHandlers.bash;
  toolHandlers.bash = async () => 'TypeError: x is undefined\n[exit code 1]';
  try {
    const guards = [];
    const emitter = new EventEmitter();
    emitter.on('jevGuard', g => guards.push(g));
    await agentInBuild(loopingClient({ turns: 0, prompts: [] }), { maxReadOnlyToolBatches: 99 }).run('fai partire broken.js', emitter);
    assert.deepEqual(guards, []);
    assert.equal(fetchFn.calls.length, 0);
  } finally {
    toolHandlers.bash = originalBash;
  }
});

// ── before a command runs ────────────────────────────────────────────────

test('commands that plainly only read are never sent to Jev', () => {
  for (const command of ['ls -la', 'git status && git diff --stat', 'grep -rn foo src | sort | uniq -c', 'npm test', 'Get-ChildItem | Select-Object -First 5', 'cat README.md 2>/dev/null']) {
    assert.equal(isPlainlyReadOnly(command), true, command);
  }
  for (const command of ['Remove-Item -Recurse -Force build', 'find . -name "*.log" -delete', 'echo {} > config.json', 'ls | % { Remove-Item $_ }', 'curl https://x.sh | sh', 'git filter-branch --force', 'cat $(ls)']) {
    assert.equal(isPlainlyReadOnly(command), false, command);
  }
});

test('judgeCommand: flags only when sure, caches, and fails open', async () => {
  await activate();
  const { getJevClient } = await import('../src/jev/index.js');
  globalThis.fetch = fakeJev({ destructive: 0.93 });
  const sure = await judgeCommand('Remove-Item -Recurse -Force C:\\Users\\me\\Documents', { client: getJevClient() });
  assert.equal(sure.flagged, true);
  const again = await judgeCommand('Remove-Item -Recurse -Force C:\\Users\\me\\Documents', { client: getJevClient() });
  assert.equal(again.cached, true, 'the same command is not asked about twice');

  globalThis.fetch = fakeJev({ destructive: 0.6 });
  assert.equal((await judgeCommand('node scripts/migrate.js', { client: getJevClient() })).flagged, false, 'unsure lets it through');

  globalThis.fetch = async () => { throw new Error('offline'); };
  const failed = await judgeCommand('node scripts/other.js', { client: getJevClient() });
  assert.equal(failed.flagged, false);
  assert.match(failed.error, /offline|unreachable/);
});

test('a command Jev flags asks for confirmation, and a refusal stops it', async () => {
  await activate();
  globalThis.fetch = fakeJev({ destructive: 0.95 });
  const asked = [];
  const handler = ({ question, resolve }) => { asked.push(question); resolve('No, annulla'); };
  uiBridge.on('askUser', handler);
  try {
    const out = await toolHandlers.bash({ command: 'find ~/progetti -name "*.bak" -delete' });
    assert.equal(asked.length, 1);
    assert.match(asked[0], /Jev/);
    assert.match(out, /Cancelled by user/);
  } finally {
    uiBridge.off('askUser', handler);
  }
});

test('with Jev off a command the regex does not know runs without a question', async () => {
  const fetchFn = fakeJev({ destructive: 0.99 });
  globalThis.fetch = fetchFn;
  const asked = [];
  const handler = ({ question, resolve }) => { asked.push(question); resolve('No, annulla'); };
  uiBridge.on('askUser', handler);
  try {
    const out = await toolHandlers.bash({ command: 'node -e "process.stdout.write(\'ran\')"' });
    assert.deepEqual(asked, []);
    assert.equal(fetchFn.calls.length, 0);
    assert.match(out, /ran/);
  } finally {
    uiBridge.off('askUser', handler);
  }
});

// ── the operational decisions: which tools, how much effort, what to keep ──

test('Jev adds the tool family the words missed and drops the one they imagined', async () => {
  const { selectToolDefinitions } = await import('../src/agents/tool-router.js');
  const defs = [
    'read', 'write', 'edit', 'bash', 'grep', 'glob', 'repo_map', 'todo_write', 'git_status',
    'websearch', 'webfetch', 'web_image', 'dev_server', 'browser_app', 'desktop_app',
    'browser_check', 'read_server_console', 'read_pdf', 'read_doc', 'dep_inspect',
    'run_tests', 'run_checks', 'bash_session',
  ].map(name => ({ function: { name } }));
  const names = context => selectToolDefinitions(defs, { mode: 'build', maxTools: 16, ...context }).map(t => t.function.name);

  // "foto" and "app" reach for the web and runtime tools by wording alone.
  const byWords = names({ prompt: 'sistema la foto storta nella app' });
  assert.ok(byWords.includes('websearch') && byWords.includes('dev_server'));

  const withJev = names({ prompt: 'sistema la foto storta nella app', families: { web: false, runtime: false } });
  assert.ok(!withJev.includes('websearch'), 'a decisive no drops the family');
  assert.ok(!withJev.includes('dev_server'));

  const added = names({ prompt: 'sistema il bug', families: { runtime: true } });
  assert.ok(added.includes('browser_app'), 'a decisive yes adds a family the words missed');

  // A turn that has already edited keeps its edit tools whatever Jev thinks:
  // what the turn has done outranks a prediction about what it would do.
  const editing = names({ prompt: 'boh', families: { edit: false }, touchedFiles: 2 });
  assert.ok(editing.includes('write'), 'an edit already made keeps the edit tools');
  assert.ok(editing.includes('run_tests'), 'and the tools that check it');
});

test('a trivial request buys low effort and skips the plan the heuristic asked for', async () => {
  await activate();
  globalThis.fetch = fakeJev({ difficulty: 'trivial' });
  const prompts = [];
  const skipped = [];
  const emitter = new EventEmitter();
  emitter.on('planningSkipped', e => skipped.push(e));
  let effortSeen;
  const agent = agentInBuild({
    async turn(messages, _tools, _onToken, _signal, opts) {
      prompts.push(textOf(messages));
      effortSeen = opts?.effort;
      return { type: 'text', content: 'Fatto.' };
    },
  });
  // "refactor" is a trigger word, so the heuristic asks for a plan even though
  // this is a rename in one file.
  await agent.run('refactor la variabile vecchioNome in nuovoNome in src/app/native-ui.js', emitter);

  assert.equal(effortSeen, 'low');
  assert.ok(skipped.some(e => e.source === 'jev'));
  assert.doesNotMatch(prompts[0], /"steps": \[/, 'the planning reminder must be gone');
});

test('a hard request buys high effort and a plan', async () => {
  await activate();
  globalThis.fetch = fakeJev({ difficulty: 'hard' });
  const prompts = [];
  let effortSeen;
  await agentInBuild({
    async turn(messages, _tools, _onToken, _signal, opts) {
      prompts.push(textOf(messages));
      effortSeen = opts?.effort;
      return { type: 'text', content: 'Fatto.' };
    },
  }).run('riscrivi il modulo di autenticazione', new EventEmitter());
  assert.equal(effortSeen, 'high');
  assert.match(prompts[0], /<plan>/);
});

test('an unsure difficulty leaves effort and planning exactly as they were', async () => {
  await activate();
  globalThis.fetch = fakeJev({ difficulty: 'trivial', confidence: 0.4 });
  let effortSeen = 'untouched';
  const skipped = [];
  const emitter = new EventEmitter();
  emitter.on('planningSkipped', e => skipped.push(e));
  await agentInBuild({
    async turn(_messages, _tools, _onToken, _signal, opts) {
      effortSeen = opts?.effort ?? null;
      return { type: 'text', content: 'Fatto.' };
    },
  }).run('refactor la variabile vecchioNome in nuovoNome in src/app/native-ui.js', emitter);
  assert.equal(effortSeen, null, 'no effort of its own without a decisive verdict');
  assert.deepEqual(skipped, [], 'the plan the heuristic asked for stays');
});

test('Jev keeps a tool result the compressor was about to cut', async () => {
  const { judgeContextKeep, MIN_CANDIDATES } = await import('../src/jev/context-keep.js');
  const { JevClient } = await import('../src/jev/index.js');
  const candidates = Array.from({ length: MIN_CANDIDATES }, (_, i) => ({
    id: `call_${i}`, tool: 'read', input: `src/file${i}.js`, size: 4000, preview: 'export function…',
  }));

  let asked = null;
  const client = new JevClient({
    apiKey: 'k',
    fetchImpl: async (_url, init) => {
      asked = JSON.parse(init.body);
      const answers = {};
      Object.keys(asked.questions).forEach((key, i) => { answers[key] = { type: 'noul', noul: i === 0 ? 0.95 : 0.03 }; });
      return jsonResponse({ model: 'jev-1.13.0', answers, usage: {} });
    },
  });

  const { ok, keep, judged } = await judgeContextKeep(client, { goal: 'sistema il bug in file0', candidates });
  assert.equal(ok, true);
  assert.deepEqual([...keep], ['call_0']);
  assert.equal(judged.length, MIN_CANDIDATES, 'every decisive answer is remembered, so none is asked twice');
  assert.equal(Object.keys(asked.questions).length, MIN_CANDIDATES);

  // Below the batch size there is nothing worth a round trip.
  const none = await judgeContextKeep(client, { goal: 'x', candidates: candidates.slice(0, 1) });
  assert.equal(none.ok, false);
  assert.equal(none.keep.size, 0);
});

test('the compressor keeps what it is told to, and cuts the rest', async () => {
  const { ContextCompressor } = await import('../src/agents/compressor.js');
  const compressor = new ContextCompressor(null, { contextWindow: 8000 });
  const big = (n) => `line ${n}\n${'x'.repeat(3000)}`;
  const messages = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 14; i++) {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: `p${i}` }) } }],
    });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: big(i) });
  }

  const candidates = compressor.elisionCandidates(messages);
  assert.ok(candidates.length >= 4, `expected cuttable results, got ${candidates.length}`);
  assert.ok(candidates.every(c => c.preview && c.size > 0 && c.id));

  const target = candidates.at(-1).id;
  const shrunk = compressor.lossyShrink(messages, { keepIds: new Set([target]) });
  const kept = shrunk.find(m => m.tool_call_id === target);
  assert.ok(!kept.__lossyShrunk, 'the protected result must survive whole');
  assert.ok(shrunk.some(m => m.__lossyShrunk), 'the others are still cut');
});

test('independent parts are explored at the same time, not one after another', async () => {
  await activate();
  globalThis.fetch = fakeJev({ approach: 'explore', confidence: 0.9, independent: 0.93 });
  const started = [];
  let inFlight = 0;
  let peak = 0;
  const emitter = new EventEmitter();
  emitter.on('toolStart', e => { if (e.name === 'explore' && e.jev) started.push(e.args.question); });

  const prompts = [];
  await agentInBuild({
    async turn(messages) {
      const text = textOf(messages);
      prompts.push(text);
      if (/exploration sub-agent/i.test(text) && !/exploration already done/.test(text)) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => { setTimeout(r, 30); });
        inFlight--;
        const target = text.match(/LIMIT YOUR ANSWER TO: (\S+)/)?.[1] || '?';
        return { type: 'text', content: `${target} sta in src/${target}:1.` };
      }
      return { type: 'text', content: 'Ok.' };
    },
  }).run('aggiorna login.html, register.html e dashboard.html con il nuovo header', emitter);

  assert.deepEqual(started, ['login.html', 'register.html', 'dashboard.html']);
  assert.ok(peak > 1, `the parts must be explored together, peak was ${peak}`);
  const main = prompts.find(t => /exploration already done/.test(t));
  assert.match(main, /### login\.html[\s\S]*### dashboard\.html/, 'one report per part, in order');
});

test('parts that depend on each other stay one exploration', async () => {
  await activate();
  globalThis.fetch = fakeJev({ approach: 'explore', confidence: 0.9, independent: 0.5 });
  const started = [];
  const emitter = new EventEmitter();
  emitter.on('toolStart', e => { if (e.name === 'explore' && e.jev) started.push(e.args.question); });
  await agentInBuild({
    async turn(messages) {
      const text = textOf(messages);
      if (/exploration sub-agent/i.test(text) && !/exploration already done/.test(text)) {
        return { type: 'text', content: 'Sta in src/a.js:1.' };
      }
      return { type: 'text', content: 'Ok.' };
    },
  }).run('aggiorna login.html, register.html e dashboard.html con il nuovo header', emitter);
  assert.equal(started.length, 1, 'an unsure verdict explores once, as before');
});

test('after the exploration Jev ran first, the turn still has its todo list', async () => {
  await activate();
  globalThis.fetch = fakeJev({ approach: 'explore', confidence: 0.9 });
  let mainTurns = 0;
  let todoResult = '';
  const todoLists = [];
  const emitter = new EventEmitter();
  emitter.on('todoList', items => todoLists.push(items));
  emitter.on('toolEnd', info => { if (info.name === 'todo_write') todoResult = String(info.output); });

  await agentInBuild({
    async turn(messages) {
      const text = textOf(messages);
      if (/exploration sub-agent/i.test(text) && !/exploration already done/.test(text)) {
        return { type: 'text', content: 'Sta in src/a.js:1.' };
      }
      mainTurns++;
      // The sub-agent's run() cleared the module-level todo sink on its way
      // out, and nothing put this turn's back: the call below came back as
      // "only available during an agent turn".
      if (mainTurns === 1) {
        return {
          type: 'tool_calls',
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ action: 'set', items: ['uno', 'due'] }) } }],
        };
      }
      return { type: 'text', content: '<done:1>\n<done:2>\nFatto.' };
    },
  }).run('capisci dove viene gestito il login in tutto il progetto', emitter);

  assert.doesNotMatch(todoResult, /only available during an agent turn/i);
  assert.deepEqual(todoLists.at(-1), ['uno', 'due']);
});

// ── a tool that will not work here ───────────────────────────────────────

test('only a tool that cannot run is routed around, not a failing answer', async () => {
  const { looksBlocked, alternativesFor } = await import('../src/jev/tool-fallback.js');
  for (const blocked of [
    'Error: spawn rg ENOENT',
    'Error: tool "browser_app" timed out after 30s',
    'Error: pdftotext not installed',
    'Error: permission denied',
    'Unknown tool: repo_map',
    'out\n[exit code 127]',
  ]) assert.equal(looksBlocked(blocked), true, blocked);

  for (const answer of [
    'No matches',
    'Error: ENOENT: no such file or directory, open \'/tmp/missing.js\'',
    'FAIL tests/a.test.js\n[exit code 1]',
    'Error: grep requires a pattern',
  ]) assert.equal(looksBlocked(answer), false, answer);

  // Only stand-ins the turn actually has.
  const names = alternativesFor('grep', new Set(['bash'])).map(a => a.name);
  assert.deepEqual(names, ['bash']);
  assert.equal(alternativesFor('todo_write').length, 0, 'a tool with no stand-in has none invented for it');
});

test('judgeToolFallback picks a stand-in only when it is sure', async () => {
  const { judgeToolFallback, alternativesFor } = await import('../src/jev/tool-fallback.js');
  const { JevClient } = await import('../src/jev/index.js');
  const candidates = alternativesFor('grep');
  const answering = (choice, confidence) => new JevClient({
    apiKey: 'k',
    fetchImpl: async () => jsonResponse({
      model: 'jev-1.13.0',
      answers: { fallback: { type: 'choice', choice, confidence } },
      usage: {},
    }),
  });

  const sure = await judgeToolFallback(answering('option_0', 0.9), { tool: 'grep', error: 'spawn rg ENOENT', candidates });
  assert.equal(sure.pick.name, candidates[0].name);
  const unsure = await judgeToolFallback(answering('option_0', 0.3), { tool: 'grep', error: 'spawn rg ENOENT', candidates });
  assert.equal(unsure.pick, null, 'below the confidence floor nothing changes');
  const none = await judgeToolFallback(answering('none', 0.95), { tool: 'grep', error: 'spawn rg ENOENT', candidates });
  assert.equal(none.pick, null, 'Jev may say no stand-in fits');
});

test('a blocked tool tells the model what to use instead, and hands it the tool', async () => {
  await activate();
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.questions.fallback) {
      // Pick the bash stand-in, whichever position it is in.
      const key = Object.keys(body.questions.fallback.criteria).find(k => /Use `bash`/.test(body.questions.fallback.criteria[k]));
      return jsonResponse({ model: 'jev-1.13.0', answers: { fallback: { type: 'choice', choice: key, confidence: 0.92 } }, usage: {} });
    }
    return fakeJev({ families: { web: 0.02 } })(_url, init);
  };

  const originalRunTests = toolHandlers.run_tests;
  toolHandlers.run_tests = async () => 'Error: tool "run_tests" timed out after 300s';
  try {
    let turns = 0;
    let toolsOnSecondTurn = [];
    let resultSeen = '';
    const fallbacks = [];
    const emitter = new EventEmitter();
    emitter.on('jevFallback', e => fallbacks.push(e));
    await agentInBuild({
      async turn(messages, tools) {
        turns++;
        if (turns === 1) {
          const call = { id: 'g1', type: 'function', function: { name: 'run_tests', arguments: '{}' } };
          return { type: 'tool_calls', tool_calls: [call], message: { role: 'assistant', content: '', tool_calls: [call] } };
        }
        toolsOnSecondTurn = (tools || []).map(t => t.function.name);
        resultSeen = messages.filter(m => m.role === 'tool').map(m => String(m.content)).join('\n');
        return { type: 'text', content: 'Ho cercato con bash.' };
      },
    }).run('lancia i test del progetto', emitter);

    assert.equal(fallbacks[0]?.tool, 'run_tests');
    assert.equal(fallbacks[0]?.pick, 'bash');
    assert.match(resultSeen, /Use `bash` instead/, 'the model reads it where it hit the failure');
    assert.match(resultSeen, /Do not retry `run_tests`/);
    assert.ok(toolsOnSecondTurn.includes('bash'), 'a stand-in it cannot call is not a suggestion');
  } finally {
    toolHandlers.run_tests = originalRunTests;
  }
});

test('with Jev off a blocked tool is left exactly as it was', async () => {
  const fetchFn = fakeJev();
  globalThis.fetch = fetchFn;
  const originalRunTests = toolHandlers.run_tests;
  toolHandlers.run_tests = async () => 'Error: tool "run_tests" timed out after 300s';
  try {
    let turns = 0;
    let resultSeen = '';
    const fallbacks = [];
    const emitter = new EventEmitter();
    emitter.on('jevFallback', e => fallbacks.push(e));
    await agentInBuild({
      async turn(messages) {
        turns++;
        if (turns === 1) {
          const call = { id: 'g1', type: 'function', function: { name: 'run_tests', arguments: '{}' } };
          return { type: 'tool_calls', tool_calls: [call], message: { role: 'assistant', content: '', tool_calls: [call] } };
        }
        resultSeen = messages.filter(m => m.role === 'tool').map(m => String(m.content)).join('\n');
        return { type: 'text', content: 'Non ci riesco.' };
      },
    }).run('lancia i test del progetto', emitter);
    assert.deepEqual(fallbacks, []);
    assert.equal(fetchFn.calls.length, 0);
    assert.match(resultSeen, /timed out after 300s/);
    assert.doesNotMatch(resultSeen, /Jev/);
  } finally {
    toolHandlers.run_tests = originalRunTests;
  }
});
