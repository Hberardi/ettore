// Jev (TypeSafe System One) as the agent's judgment layer.
//
// The rule these tests exist to hold: Jev may only change an outcome it is
// sure about, and when it is off, failing or unsure the agent behaves exactly
// as it did before the feature existed.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

import { JevClient, JevError, readNoul, readChoice } from '../src/jev/index.js';
import { judgeTurn, resolveVerdict, buildTurnState, TURN_QUESTIONS, PRETURN_FLAGS } from '../src/jev/turn-judge.js';

let dir;
const previousConfigDir = process.env.ETTORE_CONFIG_DIR;
const previousApiKey = process.env.TYPESAFE_API_KEY;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ettore-jev-'));
  process.env.ETTORE_CONFIG_DIR = dir;
  // The developer running this suite may have a real key exported. getJevKey
  // prefers the environment, so leaving it set makes these tests read — and
  // print, on failure — someone's live credential. Never run against it.
  delete process.env.TYPESAFE_API_KEY;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.ETTORE_CONFIG_DIR;
  else process.env.ETTORE_CONFIG_DIR = previousConfigDir;
  if (previousApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = previousApiKey;
  rmSync(dir, { recursive: true, force: true });
});

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(calls.length, { url, init });
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ── the HTTP contract ──────────────────────────────────────────────────────

test('a request carries the documented shape: bearer key, model, state, questions', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({
    model: 'jev-1.13.0',
    answers: { a: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  }));
  const client = new JevClient({ apiKey: 'sk-test', fetchImpl });
  const result = await client.evaluate({ state: 'ciao', questions: { a: { type: 'noul', instructions: 'x' } } });

  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-test');
  assert.equal(call.body.model, 'jev-latest');
  assert.equal(call.body.state, 'ciao');
  assert.deepEqual(Object.keys(call.body.questions), ['a']);
  assert.equal(result.answers.a.noul, 0.9);
  assert.equal(result.usage.input_tokens, 10);
});

test('every question rides in one request, not one request each', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ model: 'jev-1.13.0', answers: {}, usage: {} }));
  const client = new JevClient({ apiKey: 'sk-test', fetchImpl });
  await client.evaluate({ state: 's', questions: TURN_QUESTIONS });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(Object.keys(fetchImpl.calls[0].body.questions).length, Object.keys(TURN_QUESTIONS).length);
});

test('429 is retried with backoff, 401 is not', async () => {
  const flaky = fakeFetch(n => (n === 1
    ? { ok: false, status: 429, text: async () => 'slow down' }
    : jsonResponse({ model: 'm', answers: { a: { type: 'noul', noul: 1 } }, usage: {} })));
  const ok = await new JevClient({ apiKey: 'k', fetchImpl: flaky }).evaluate({
    state: 's', questions: { a: { type: 'noul', instructions: 'x' } },
  });
  assert.equal(ok.answers.a.noul, 1);
  assert.equal(flaky.calls.length, 2);

  const unauthorized = fakeFetch(() => ({ ok: false, status: 401, text: async () => 'bad key' }));
  await assert.rejects(
    () => new JevClient({ apiKey: 'k', fetchImpl: unauthorized }).evaluate({
      state: 's', questions: { a: { type: 'noul', instructions: 'x' } },
    }),
    (e) => e instanceof JevError && e.status === 401 && /API key/i.test(e.message),
  );
  assert.equal(unauthorized.calls.length, 1, 'a rejected key must not be retried');
});

test('a missing key fails before any request is made', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({}));
  await assert.rejects(
    () => new JevClient({ apiKey: null, fetchImpl }).evaluate({ state: 's', questions: { a: {} } }),
    /jev active/i,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

// ── reading answers ────────────────────────────────────────────────────────

test('a Noul near the middle is not a decision', () => {
  assert.deepEqual(readNoul({ noul: 0.95 }), { value: 0.95, yes: true, decisive: true });
  assert.deepEqual(readNoul({ noul: 0.02 }), { value: 0.02, yes: false, decisive: true });
  assert.equal(readNoul({ noul: 0.55 }).decisive, false);
  assert.equal(readNoul({ noul: 0.44 }).decisive, false);
  assert.equal(readNoul(undefined).decisive, false);
});

test('a Choice below the confidence floor is not a decision', () => {
  assert.equal(readChoice({ choice: 'billing', confidence: 0.81 }).decisive, true);
  assert.equal(readChoice({ choice: 'billing', confidence: 0.4 }).decisive, false);
  assert.equal(readChoice({}).decisive, false);
});

// ── the gate that protects the agent ───────────────────────────────────────

test('resolveVerdict: Jev overrides only when decisive', () => {
  assert.deepEqual(resolveVerdict(false, { yes: true, decisive: true }), { value: true, source: 'jev' });
  assert.deepEqual(resolveVerdict(true, { yes: false, decisive: true }), { value: false, source: 'jev' });
  assert.deepEqual(resolveVerdict(true, { yes: true, decisive: true }), { value: true, source: 'agreed' });
  // Unsure, absent, or Jev off: the heuristic stands, untouched.
  assert.deepEqual(resolveVerdict(true, { yes: false, decisive: false }), { value: true, source: 'heuristic' });
  assert.deepEqual(resolveVerdict(false, undefined), { value: false, source: 'heuristic' });
});

test('judgeTurn returns empty verdicts instead of throwing when Jev fails', async () => {
  const broken = { evaluate: async () => { throw new JevError('network down'); } };
  const result = await judgeTurn(broken, { prompt: 'p', reply: 'r' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.verdicts, {});
  assert.match(result.error, /network down/);

  const off = await judgeTurn(null, { prompt: 'p', reply: 'r' });
  assert.equal(off.ok, false);
  assert.deepEqual(off.verdicts, {});
});

test('judgeTurn reads one verdict per question', async () => {
  const client = {
    evaluate: async () => ({
      answers: {
        announced: { type: 'noul', noul: 0.93 },
        deferred: { type: 'noul', noul: 0.05 },
        unapplied_code: { type: 'noul', noul: 0.5 },
        complete: { type: 'noul', noul: 0.1 },
      },
      usage: {},
    }),
  };
  const { ok, verdicts } = await judgeTurn(client, { prompt: 'p', reply: 'r' });
  assert.equal(ok, true);
  assert.equal(verdicts.announced.yes, true);
  assert.equal(verdicts.announced.decisive, true);
  assert.equal(verdicts.deferred.yes, false);
  assert.equal(verdicts.unapplied_code.decisive, false, 'exactly 0.5 is not a decision');
});

test('the state handed to Jev names the turn, and is bounded', () => {
  const state = buildTurnState({
    prompt: 'x'.repeat(20000),
    reply: 'y'.repeat(20000),
    toolsRan: 3,
    filesTouched: Array.from({ length: 50 }, (_, i) => `f${i}.js`),
    verificationDone: true,
  });
  assert.equal(state.user_request.length, 8000);
  assert.equal(state.assistant_reply.length, 8000);
  assert.equal(state.tools_used_this_turn, 3);
  assert.equal(state.files_changed_this_turn.length, 20);
  assert.equal(state.verification_ran, true);
});

// ── activation ─────────────────────────────────────────────────────────────

test('activate stores the key encrypted, deactivate keeps it unless told to forget', async () => {
  const { activateJev, deactivateJev, isJevEnabled, getJevKey, getJevClient } = await import('../src/jev/index.js');
  const { readFileSync, readdirSync } = await import('node:fs');

  const { masked } = activateJev('sk-super-secret-value');
  // The project's masking convention: first four, last four, nothing between.
  assert.equal(masked, 'sk-s...alue');
  assert.doesNotMatch(masked, /super-secret/);
  assert.equal(isJevEnabled(), true);
  assert.equal(getJevKey(), 'sk-super-secret-value');
  assert.ok(getJevClient(), 'an enabled Jev yields a client');

  const dumped = readdirSync(dir).map(f => {
    try { return readFileSync(join(dir, f), 'utf-8'); } catch { return ''; }
  }).join('\n');
  assert.doesNotMatch(dumped, /sk-super-secret-value/, 'the key must never hit disk in plaintext');

  deactivateJev();
  assert.equal(isJevEnabled(), false);
  assert.equal(getJevKey(), 'sk-super-secret-value', 'off is not forget');
  assert.equal(getJevClient(), null, 'a disabled Jev yields no client');

  deactivateJev({ forget: true });
  assert.equal(getJevKey(), null);
});

test('/jev drives activation, status and deactivation', async () => {
  const { builtinCommands } = await import('../src/commands/index.js');
  const jev = builtinCommands.jev;
  assert.ok(jev, '/jev must exist');

  assert.match(await jev.handler(['status'], {}), /off/i);
  assert.match(await jev.handler(['active'], {}), /Missing API key/i);

  const activated = await jev.handler(['active', 'sk-abc123456789'], {});
  assert.match(activated, /Jev on/);
  assert.doesNotMatch(activated, /sk-abc123456789/, 'the key is never echoed in full');
  assert.match(await jev.handler(['status'], {}), /on/);

  assert.match(await jev.handler(['out'], {}), /off/i);
  assert.match(await jev.handler(['status'], {}), /saved but not in use/i);

  // The words the user actually types are the ones that work.
  assert.match(await jev.handler(['active'], {}), /Jev on/);
  assert.match(await jev.handler(['out', 'forget'], {}), /deleted/i);

  assert.match(await jev.handler(['nonsense'], {}), /Unknown \/jev subcommand/);
});

// ── the agent with Jev off ─────────────────────────────────────────────────

test('with Jev off the agent never calls it and keeps its own judgment', async () => {
  const { Agent } = await import('../src/agents/index.js');
  let fetched = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; return jsonResponse({}); };
  try {
    const agent = new Agent({
      async turn() { return { type: 'text', content: 'Ecco il riepilogo: tutto a posto.' }; },
    }, {
      provider: 'test', model: 'gpt-4o', modelCapability: 'full',
      workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
    }, 'build');
    const emitter = new EventEmitter();
    const judgments = [];
    emitter.on('jevJudgment', j => judgments.push(j));
    const result = await agent.run('spiegami una cosa', emitter);
    assert.match(String(result), /riepilogo/);
    assert.equal(fetched, 0, 'no network call when Jev is off');
    assert.deepEqual(judgments, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('with Jev on and sure, a turn it judges unfinished is pushed on', async () => {
  const { Agent } = await import('../src/agents/index.js');
  const { activateJev } = await import('../src/jev/index.js');
  activateJev('sk-test-key-value');

  const originalFetch = globalThis.fetch;
  let jevCalls = 0;
  globalThis.fetch = async () => {
    jevCalls++;
    return jsonResponse({
      model: 'jev-1.13.0',
      answers: {
        // Wording the regexes do not catch, meaning they should: the model
        // says it is going to do the work rather than doing it.
        announced: { type: 'noul', noul: 0.96 },
        deferred: { type: 'noul', noul: 0.1 },
        unapplied_code: { type: 'noul', noul: 0.1 },
        complete: { type: 'noul', noul: 0.04 },
      },
      usage: { input_tokens: 120, output_tokens: 12 },
    });
  };

  try {
    let turns = 0;
    const seen = [];
    const agent = new Agent({
      async turn(messages) {
        turns++;
        seen.push(messages.length);
        if (turns === 1) {
          // No "ora scrivo"/"I'll write" trigger word in sight.
          return { type: 'text', content: 'La soluzione richiede una modifica a config.js.' };
        }
        return { type: 'text', content: 'Fatto, file aggiornato.' };
      },
    }, {
      provider: 'test', model: 'gpt-4o', modelCapability: 'full',
      workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
    }, 'build');

    const emitter = new EventEmitter();
    const recoveries = [];
    const judgments = [];
    emitter.on('loopRecovery', r => recoveries.push(r.reason));
    emitter.on('jevJudgment', j => judgments.push(j));

    const result = await agent.run('modifica config.js', emitter);

    assert.ok(jevCalls >= 1, 'Jev must be consulted at the end of the turn');
    assert.ok(judgments.length >= 1, 'the judgment is surfaced to the UI');
    assert.equal(judgments[0].verdicts.announced, 0.96);
    assert.ok(turns >= 2, 'the turn was pushed on instead of ending');
    assert.match(String(result), /Fatto/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('with Jev on but unsure, the agent keeps exactly its own verdict', async () => {
  const { Agent } = await import('../src/agents/index.js');
  const { activateJev } = await import('../src/jev/index.js');
  activateJev('sk-test-key-value');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    model: 'jev-1.13.0',
    answers: {
      announced: { type: 'noul', noul: 0.52 },
      deferred: { type: 'noul', noul: 0.49 },
      unapplied_code: { type: 'noul', noul: 0.5 },
      complete: { type: 'noul', noul: 0.55 },
    },
    usage: {},
  });
  try {
    let turns = 0;
    const agent = new Agent({
      async turn() {
        turns++;
        return { type: 'text', content: 'Ecco la risposta alla tua domanda.' };
      },
    }, {
      provider: 'test', model: 'gpt-4o', modelCapability: 'full',
      workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
    }, 'build');
    const emitter = new EventEmitter();
    const recoveries = [];
    emitter.on('loopRecovery', r => recoveries.push(r.reason));
    await agent.run('domanda semplice', emitter);
    assert.equal(turns, 1, 'an unsure Jev must not push the turn on');
    assert.deepEqual(recoveries, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('TYPESAFE_API_KEY alone turns Jev on, and /jev out still wins over it', async () => {
  const { isJevEnabled, deactivateJev, getJevKey } = await import('../src/jev/index.js');
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'sk-from-the-environment';
  try {
    // No command run, no key saved: exporting the variable is enough.
    assert.equal(getJevKey(), 'sk-from-the-environment');
    assert.equal(isJevEnabled(), true);

    // An explicit off beats the variable, so turning it off never means
    // hunting down where the export lives.
    deactivateJev();
    assert.equal(isJevEnabled(), false);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test('the sidebar says Jev is on without anyone having to ask', async () => {
  const { TUI } = await import('../src/app/tui-native.js');
  const tui = new TUI();
  assert.equal(tui.jevActive, false, 'off is the default, and off draws no row');
  // The sidebar is clipped to the terminal height, which is 0 without a TTY.
  tui.rows = 40;
  tui.cols = 120;
  tui.version = '1.6.0';
  Object.defineProperty(tui, 'availableHeight', { value: 60, configurable: true });

  const draw = () => tui._renderSidebar(30).map(line => tui._stripAnsi(line)).join('\n');
  assert.doesNotMatch(draw(), /jev/i, 'off is the default state and draws nothing');

  tui.jevActive = true;
  tui.jevLastMs = 814;
  const rendered = draw();
  assert.match(rendered, /jev\s+on/, `expected a jev row, got:\n${rendered}`);
  assert.match(rendered, /814ms/);
});

test('the counters record real traffic, and a failure is counted as a failure', async () => {
  const { JevClient, getJevStats, resetJevStats } = await import('../src/jev/index.js');
  resetJevStats();

  const ok = fakeFetch(() => jsonResponse({
    model: 'jev-1.13.0',
    answers: { a: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: 296, output_tokens: 20 },
  }));
  const client = new JevClient({ apiKey: 'k', fetchImpl: ok });
  const question = { a: { type: 'noul', instructions: 'x' } };
  await client.evaluate({ state: 's', questions: question });
  await client.evaluate({ state: 's', questions: question });

  let stats = getJevStats();
  assert.equal(stats.calls, 2);
  assert.equal(stats.failures, 0);
  // Proof of a real round trip: neither of these is something the CLI knows
  // on its own — the server sent them back.
  assert.equal(stats.lastModel, 'jev-1.13.0');
  assert.equal(stats.inputTokens, 592);
  assert.equal(stats.outputTokens, 40);
  assert.ok(stats.lastAt, 'the time of the last call is recorded');

  const refused = fakeFetch(() => ({ ok: false, status: 401, text: async () => 'bad key' }));
  await assert.rejects(() => new JevClient({ apiKey: 'k', fetchImpl: refused })
    .evaluate({ state: 's', questions: question }));

  stats = getJevStats();
  assert.equal(stats.calls, 2, 'a refused call is not a successful one');
  assert.equal(stats.failures, 1);
  assert.match(stats.lastError, /API key/i);
  resetJevStats();
});

test('/jev status reports the traffic, not just the switch', async () => {
  const { builtinCommands } = await import('../src/commands/index.js');
  const { activateJev, resetJevStats } = await import('../src/jev/index.js');
  resetJevStats();
  activateJev('sk-abc123456789');

  const before = await builtinCommands.jev.handler(['status'], {});
  assert.match(before, /No calls yet this session/i);

  const { JevClient } = await import('../src/jev/index.js');
  await new JevClient({
    apiKey: 'k',
    fetchImpl: fakeFetch(() => jsonResponse({
      model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 10, output_tokens: 1 },
    })),
  }).evaluate({ state: 's', questions: { a: { type: 'noul', instructions: 'x' } } });

  const after = await builtinCommands.jev.handler(['status'], {});
  assert.match(after, /1 ok, 0 failed/);
  assert.match(after, /jev-1\.13\.0/);
  assert.match(after, /10 in, 1 out/);
  resetJevStats();
});

// ── auto-continue without a plan: Jev only ────────────────────────────────

function jevAnswering(complete, extra = {}) {
  return async () => jsonResponse({
    model: 'jev-1.13.0',
    answers: {
      announced: { type: 'noul', noul: 0.1 },
      deferred: { type: 'noul', noul: 0.1 },
      unapplied_code: { type: 'noul', noul: 0.1 },
      complete: { type: 'noul', noul: complete },
      ...extra,
    },
    usage: {},
  });
}

// A turn that edits a file and then stops, with no <todo> plan anywhere.
function toolThenStopClient(counter) {
  return {
    async turn() {
      counter.turns++;
      if (counter.turns === 1) {
        const tc = {
          id: 'e1',
          type: 'function',
          function: { name: 'edit', arguments: JSON.stringify({ file_path: 'a.js', old_string: 'a', new_string: 'b' }) },
        };
        return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
      }
      return { type: 'text', content: 'Task completo.' };
    },
  };
}

function agentInBuild(client) {
  return new Agent(client, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  }, 'build');
}

let Agent;
test('setup: load the agent once', async () => {
  ({ Agent } = await import('../src/agents/index.js'));
});

test('with Jev sure the work is unfinished, a planless turn continues by itself', async () => {
  const { activateJev } = await import('../src/jev/index.js');
  const { toolHandlers } = await import('../src/tools/index.js');
  activateJev('sk-test-key-value');
  const originalEdit = toolHandlers.edit;
  toolHandlers.edit = async () => 'Edited a.js (1 line changed)';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = jevAnswering(0.03);   // decisively "not complete"
  try {
    const counter = { turns: 0 };
    const emitter = new EventEmitter();
    const pushes = [];
    emitter.on('autoContinue', e => pushes.push(e));
    await agentInBuild(toolThenStopClient(counter)).run('sistema a.js', emitter);
    assert.ok(counter.turns > 2, `expected the turn to be pushed on, got ${counter.turns} turns`);
    assert.ok(pushes.some(p => p.source === 'jev'), 'the push must be attributed to Jev');
  } finally {
    globalThis.fetch = originalFetch;
    toolHandlers.edit = originalEdit;
  }
});

test('the same turn with Jev OFF behaves exactly as before — no push', async () => {
  const { toolHandlers } = await import('../src/tools/index.js');
  const originalEdit = toolHandlers.edit;
  toolHandlers.edit = async () => 'Edited a.js (1 line changed)';
  let fetched = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; return jsonResponse({}); };
  try {
    // No activateJev: this is every user who never turned it on.
    const counter = { turns: 0 };
    const emitter = new EventEmitter();
    const pushes = [];
    emitter.on('autoContinue', e => pushes.push(e));
    await agentInBuild(toolThenStopClient(counter)).run('sistema a.js', emitter);
    assert.equal(fetched, 0, 'Jev must not be contacted when it is off');
    assert.deepEqual(pushes, [], 'no plan and no Jev means no push, as before');
    assert.equal(counter.turns, 2, 'the turn ends where it always did');
  } finally {
    globalThis.fetch = originalFetch;
    toolHandlers.edit = originalEdit;
  }
});

test('an unsure Jev does not push a planless turn either', async () => {
  const { activateJev } = await import('../src/jev/index.js');
  const { toolHandlers } = await import('../src/tools/index.js');
  activateJev('sk-test-key-value');
  const originalEdit = toolHandlers.edit;
  toolHandlers.edit = async () => 'Edited a.js (1 line changed)';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = jevAnswering(0.45);   // inside the undecided band
  try {
    const counter = { turns: 0 };
    const emitter = new EventEmitter();
    const pushes = [];
    emitter.on('autoContinue', e => pushes.push(e));
    await agentInBuild(toolThenStopClient(counter)).run('sistema a.js', emitter);
    assert.deepEqual(pushes, []);
    assert.equal(counter.turns, 2);
  } finally {
    globalThis.fetch = originalFetch;
    toolHandlers.edit = originalEdit;
  }
});

test('a turn that ran no tools is never pushed, however sure Jev is', async () => {
  const { activateJev } = await import('../src/jev/index.js');
  activateJev('sk-test-key-value');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = jevAnswering(0.01);
  try {
    let turns = 0;
    const emitter = new EventEmitter();
    const pushes = [];
    emitter.on('autoContinue', e => pushes.push(e));
    await agentInBuild({
      async turn() { turns++; return { type: 'text', content: 'La risposta è 42.' }; },
    }).run('quanto fa la domanda fondamentale?', emitter);
    assert.equal(turns, 1, 'answering a question is not unfinished work');
    assert.deepEqual(pushes, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── routing the investigation, before the turn ────────────────────────────

function jevRouting(choice, confidence) {
  return async () => jsonResponse({
    model: 'jev-1.13.0',
    answers: { approach: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } },
    usage: {},
  });
}

test('a request that needs a codebase-wide search is explored before the first step', async () => {
  const { activateJev } = await import('../src/jev/index.js');
  activateJev('sk-test-key-value');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = jevRouting('explore', 0.88);
  try {
    const prompts = [];
    const emitter = new EventEmitter();
    const routes = [];
    const started = [];
    emitter.on('jevRoute', r => routes.push(r));
    emitter.on('toolStart', e => started.push(e));
    await agentInBuild({
      async turn(messages) {
        const text = messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
        prompts.push(text);
        // The first call is the sub-agent's; it reports back.
        if (/exploration sub-agent/i.test(text) && !/exploration already done/.test(text)) {
          return { type: 'text', content: 'Il login passa da src/auth/login.js:12 a src/auth/session.js:40.' };
        }
        return { type: 'text', content: 'Ecco come funziona il flusso.' };
      },
    }).run('come funziona il flusso di autenticazione da cima a fondo?', emitter);

    assert.ok(routes.some(r => r.choice === 'explore' && r.decisive && r.actions.includes('explore')));
    assert.ok(started.some(e => e.name === 'explore' && e.jev), 'the exploration is shown as a tool Jev started');
    const mainTurn = prompts.find(text => /exploration already done/.test(text));
    assert.ok(mainTurn, 'the main model must start with the report in its conversation');
    assert.match(mainTurn, /src\/auth\/login\.js:12/);
    assert.doesNotMatch(mainTurn, /delegate this one to `explore`/i, 'no nudge once the work is done');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a confident "direct" leaves the turn exactly as it was', async () => {
  const { activateJev } = await import('../src/jev/index.js');
  activateJev('sk-test-key-value');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = jevRouting('direct', 0.91);
  try {
    let promptSeenByModel = '';
    await agentInBuild({
      async turn(messages) {
        promptSeenByModel = messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
        return { type: 'text', content: 'Fatto.' };
      },
    }).run('aggiungi una riga di log in src/app/native-ui.js', new EventEmitter());
    assert.doesNotMatch(promptSeenByModel, /delegate this one to `explore`/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an unconfident routing verdict changes nothing', async () => {
  const { activateJev } = await import('../src/jev/index.js');
  activateJev('sk-test-key-value');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = jevRouting('explore', 0.42);   // below the confidence floor
  try {
    let promptSeenByModel = '';
    await agentInBuild({
      async turn(messages) {
        promptSeenByModel = messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
        return { type: 'text', content: 'Fatto.' };
      },
    }).run('dove sta la logica che decide il routing degli strumenti?', new EventEmitter());
    assert.doesNotMatch(promptSeenByModel, /delegate this one to `explore`/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('with Jev off no routing call is made and no nudge appears', async () => {
  let fetched = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; return jsonResponse({}); };
  try {
    let promptSeenByModel = '';
    const emitter = new EventEmitter();
    const routes = [];
    emitter.on('jevRoute', r => routes.push(r));
    await agentInBuild({
      async turn(messages) {
        promptSeenByModel = messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
        return { type: 'text', content: 'Fatto.' };
      },
    }).run('come funziona il flusso di autenticazione da cima a fondo?', emitter);
    assert.equal(fetched, 0);
    assert.deepEqual(routes, []);
    assert.doesNotMatch(promptSeenByModel, /delegate this one to `explore`/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('short messages and continuations do not pay for a routing call', async () => {
  const { activateJev } = await import('../src/jev/index.js');
  activateJev('sk-test-key-value');
  // The end-of-turn judgment is a different call and still happens; only the
  // routing one — the one that asks `approach` — is what this test counts.
  let routingCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (JSON.parse(init.body).questions.approach) routingCalls++;
    return jevRouting('explore', 0.9)();
  };
  try {
    const client = { async turn() { return { type: 'text', content: 'Ok.' }; } };
    await agentInBuild(client).run('ciao', new EventEmitter());
    assert.equal(routingCalls, 0, 'a two-word message is not worth a round trip');

    await agentInBuild(client).run('continua', new EventEmitter());
    assert.equal(routingCalls, 0, 'a continuation already carries the previous intent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── skills chosen by meaning rather than by shared words ──────────────────

function jevPreTurn({ approach = 'direct', confidence = 0.9, skills = {} } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const answers = {
      approach: { type: 'choice', choice: approach, confidence, probabilities: { [approach]: confidence } },
    };
    // Map each skill question back by the description it carries.
    for (const [id, q] of Object.entries(body.questions)) {
      if (!id.startsWith('skill_')) continue;
      const covers = q.instructions.skill_covers;
      const match = Object.entries(skills).find(([desc]) => covers.includes(desc));
      answers[id] = { type: 'noul', noul: match ? match[1] : 0.5 };
    }
    return jsonResponse({ model: 'jev-1.13.0', answers, usage: {} });
  };
}

function agentWithSkills(client, skillList) {
  const skillSystem = {
    getAllSkills: () => skillList,
    matchSkills: (prompt) => skillList.filter(s => (s.triggers || []).some(t => prompt.includes(t))),
    getPromptForSkills: (skills) => (skills.length ? `\nSKILLS: ${skills.map(s => s.name).join(', ')}\n` : ''),
    loadAllSkills: async () => {},
  };
  return new Agent(client, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
    skillSystem,
  }, 'build');
}

const SKILLS = [
  { name: 'web-design', description: 'Creare e modificare pagine e siti web', enabled: true, triggers: ['funziona'] },
  { name: 'debug', description: 'Analisi e risoluzione bug nel codice', enabled: true, triggers: [] },
];

test('Jev drops a skill the word scoring matched by coincidence', async () => {
  const { activateJev } = await import('../src/jev/index.js');
  activateJev('sk-test-key-value');
  const originalFetch = globalThis.fetch;
  // "questo non funziona" shares a word with the web skill and means nothing
  // like it; Jev is sure it does not apply, and sure that debug does.
  globalThis.fetch = jevPreTurn({ skills: { 'siti web': 0.03, 'risoluzione bug': 0.95 } });
  try {
    let promptSeen = '';
    const emitter = new EventEmitter();
    const changes = [];
    emitter.on('jevSkills', e => changes.push(e));
    await agentWithSkills({
      async turn(messages) {
        promptSeen = String(messages[0]?.content || '');
        return { type: 'text', content: 'Guardo il bug.' };
      },
    }, SKILLS).run('questo non funziona, il salvataggio va in errore', emitter);

    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0].before, ['web-design']);
    assert.deepEqual(changes[0].after, ['debug']);
    assert.match(promptSeen, /SKILLS: debug/);
    assert.doesNotMatch(promptSeen, /web-design/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an unsure Jev leaves the word scoring alone', async () => {
  const { activateJev } = await import('../src/jev/index.js');
  activateJev('sk-test-key-value');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = jevPreTurn({ skills: { 'siti web': 0.55, 'risoluzione bug': 0.5 } });
  try {
    let promptSeen = '';
    const emitter = new EventEmitter();
    const changes = [];
    emitter.on('jevSkills', e => changes.push(e));
    await agentWithSkills({
      async turn(messages) {
        promptSeen = String(messages[0]?.content || '');
        return { type: 'text', content: 'Ok.' };
      },
    }, SKILLS).run('questo non funziona, il salvataggio va in errore', emitter);
    assert.deepEqual(changes, [], 'nothing decisive means nothing changes');
    assert.match(promptSeen, /SKILLS: web-design/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('both decisions ride in one request, not two', async () => {
  const { activateJev, resetJevStats, getJevStats } = await import('../src/jev/index.js');
  activateJev('sk-test-key-value');
  resetJevStats();
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return jevPreTurn({ approach: 'explore', confidence: 0.9 })(url, init);
  };
  try {
    await agentWithSkills({
      async turn() { return { type: 'text', content: 'Fatto.' }; },
    }, SKILLS).run('come funziona il flusso di salvataggio da cima a fondo?', new EventEmitter());

    const preTurn = bodies.filter(b => b.questions.approach);
    assert.equal(preTurn.length, 1, 'one pre-turn call, however many skills');
    // The approach, the two request flags and one question per enabled
    // skill, together.
    assert.equal(Object.keys(preTurn[0].questions).length, 1 + Object.keys(PRETURN_FLAGS).length + SKILLS.length);
    resetJevStats();
    assert.equal(getJevStats().calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('with Jev off, skills are chosen exactly as before', async () => {
  let fetched = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; return jsonResponse({}); };
  try {
    let promptSeen = '';
    const emitter = new EventEmitter();
    const changes = [];
    emitter.on('jevSkills', e => changes.push(e));
    await agentWithSkills({
      async turn(messages) {
        promptSeen = String(messages[0]?.content || '');
        return { type: 'text', content: 'Ok.' };
      },
    }, SKILLS).run('questo non funziona, il salvataggio va in errore', emitter);
    assert.equal(fetched, 0);
    assert.deepEqual(changes, []);
    assert.match(promptSeen, /SKILLS: web-design/, 'the word scoring still decides');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
