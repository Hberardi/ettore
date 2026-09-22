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
function fakeJev({ approach = 'direct', confidence = 0.9, ambiguous = 0.1, multiStep = 0.1, progress = {}, destructive = 0.1, complete = 0.9 } = {}) {
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
