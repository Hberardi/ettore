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
import { judgeTurn, resolveVerdict, buildTurnState, TURN_QUESTIONS } from '../src/jev/turn-judge.js';

let dir;
const previousConfigDir = process.env.ETTORE_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ettore-jev-'));
  process.env.ETTORE_CONFIG_DIR = dir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.ETTORE_CONFIG_DIR;
  else process.env.ETTORE_CONFIG_DIR = previousConfigDir;
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
