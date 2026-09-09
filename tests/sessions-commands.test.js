// Tests for /sessions, /resume and /new.
//
// Every turn has always written the conversation to disk; nothing ever read it
// back. These cover the half that was missing, and they run against a
// redirected sessions directory so the user's real history is never touched.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { builtinCommands } from '../src/commands/index.js';
import { createSession, saveSession, listSessions, loadSession } from '../src/sessions/index.js';
import { repaintTranscript } from '../src/app/native-ui.js';

let dir;
const previousDir = process.env.ETTORE_SESSIONS_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ettore-sessions-'));
  process.env.ETTORE_SESSIONS_DIR = dir;
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.ETTORE_SESSIONS_DIR;
  else process.env.ETTORE_SESSIONS_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

// Build a saved session with `turns` exchanges in it.
async function seed({ provider = 'anthropic', model = 'claude-opus-5', turns = 1, updated = null } = {}) {
  const session = await createSession(provider, model);
  session.messages = [{ role: 'system', content: 'prompt di sistema' }];
  for (let i = 0; i < turns; i++) {
    session.messages.push({ role: 'user', content: `domanda ${i + 1}` });
    session.messages.push({ role: 'assistant', content: `risposta ${i + 1}` });
  }
  await saveSession(session);
  if (updated) {
    session.updated = updated;
    await saveSession(session);
  }
  return session;
}

// ── the commands exist at all ─────────────────────────────────────────────

test('sessions/resume/new are real commands, not just entries in /help', () => {
  for (const name of ['sessions', 'resume', 'new']) {
    assert.ok(builtinCommands[name], `/${name} must be defined`);
    assert.equal(typeof builtinCommands[name].handler, 'function');
    assert.ok(builtinCommands[name].description, `/${name} needs a description`);
  }
});

test('/help advertises nothing it cannot deliver', async () => {
  const help = await builtinCommands.help.handler('', { commandSystem: { list: () => [] } });
  const advertised = String(help).match(/\b(clear|new|sessions|resume|init|memory|compress|history)\b/g) || [];
  for (const name of new Set(advertised)) {
    assert.ok(builtinCommands[name], `/help lists "${name}" but no such command exists`);
  }
});

// ── /sessions ─────────────────────────────────────────────────────────────

test('/sessions on a fresh install says so instead of showing an empty table', async () => {
  const out = await builtinCommands.sessions.handler('', {});
  assert.equal(out, 'No saved sessions yet.');
});

test('/sessions lists what is on disk, newest first, marking the open one', async () => {
  const older = await seed({ turns: 1, updated: Date.now() - 86_400_000 });
  const newer = await seed({ turns: 3 });

  const out = await builtinCommands.sessions.handler('', { sessionId: newer.id });
  const lines = out.split('\n');
  const newerAt = lines.findIndex((l) => l.includes(newer.id));
  const olderAt = lines.findIndex((l) => l.includes(older.id));
  assert.ok(newerAt > 0 && olderAt > newerAt, 'the most recent session comes first');
  assert.match(lines[newerAt], /3 turn\(s\)/, 'turns counts what the user said, not every message');
  assert.match(lines[newerAt], /current/);
  assert.doesNotMatch(lines[olderAt], /current/);
  assert.match(out, /claude-opus-5/);
});

test('/sessions caps the list and says how many it left out', async () => {
  for (let i = 0; i < 4; i++) await seed();
  const out = await builtinCommands.sessions.handler('2', {});
  assert.match(out, /Saved sessions \(4\)/);
  assert.match(out, /… 2 older/);
});

test('listSessions ignores a corrupt file rather than failing the listing', async () => {
  const good = await seed();
  writeFileSync(join(dir, 'rotta.json'), '{ questo non è json');
  const all = await listSessions();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, good.id);
});

// ── /resume ───────────────────────────────────────────────────────────────

test('/resume <id> hands the session back for the UI to apply', async () => {
  const session = await seed({ turns: 2 });
  const out = await builtinCommands.resume.handler(session.id, { sessionId: 'altra' });
  assert.equal(out.action, 'resumeSession');
  assert.equal(out.session.id, session.id);
  assert.equal(out.session.messages.length, 5);
});

test('/resume with no id takes the most recent session that is not already open', async () => {
  const older = await seed({ updated: Date.now() - 86_400_000 });
  const current = await seed();
  const out = await builtinCommands.resume.handler('', { sessionId: current.id });
  assert.equal(out.action, 'resumeSession');
  assert.equal(out.session.id, older.id, 'skips the one already on screen');
});

test('/resume with nothing else saved says so instead of reloading the open session', async () => {
  const only = await seed();
  const out = await builtinCommands.resume.handler('', { sessionId: only.id });
  assert.match(out, /No other session to resume/);
});

test('/resume of the session already open is refused, not silently redone', async () => {
  const session = await seed();
  const out = await builtinCommands.resume.handler(session.id, { sessionId: session.id });
  assert.match(out, /already open/);
});

test('/resume of an unknown id lists the ids that do exist', async () => {
  const session = await seed();
  const out = await builtinCommands.resume.handler('inesistente', {});
  assert.match(out, /No session "inesistente"/);
  assert.match(out, new RegExp(session.id), 'the reply shows what could be resumed instead');
});

test('/resume of a corrupt file names the file instead of throwing', async () => {
  writeFileSync(join(dir, 'rotta.json'), '{ mezzo scritto');
  const out = await builtinCommands.resume.handler('rotta', {});
  assert.match(out, /Session "rotta" cannot be read/);
});

test('/resume of a session with no conversation in it is refused', async () => {
  writeFileSync(join(dir, 'vuota.json'), JSON.stringify({ id: 'vuota', updated: Date.now() }));
  const out = await builtinCommands.resume.handler('vuota', {});
  assert.match(out, /no conversation in it/);
});

// ── /new ──────────────────────────────────────────────────────────────────

test('/new asks the UI for a fresh session', async () => {
  const out = await builtinCommands.new.handler('', {});
  assert.deepEqual(out, { action: 'newSession' });
});

// ── what the screen shows after a resume ──────────────────────────────────

test('repaintTranscript shows the conversation and hides the plumbing', () => {
  const tui = { messages: [{ role: 'user', text: 'vecchio', tools: [], id: 1 }] };
  const shown = repaintTranscript(tui, [
    { role: 'system', content: 'prompt di sistema' },
    { role: 'user', content: 'leggi il file' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'x' }] },
    { role: 'tool', tool_call_id: 'x', content: 'contenuto del file' },
    { role: 'assistant', content: 'ecco cosa contiene' },
  ]);

  assert.equal(shown, 2);
  assert.equal(tui.messages.length, 2, 'the previous transcript is replaced, not appended to');
  assert.deepEqual(tui.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(tui.messages[0].text, 'leggi il file');
  assert.equal(tui.messages[1].text, 'ecco cosa contiene');
  // Every entry needs the shape the renderer expects, or the redraw throws.
  for (const m of tui.messages) {
    assert.ok(Array.isArray(m.tools));
    assert.equal(typeof m.id, 'number');
  }
});

test('repaintTranscript survives an empty or malformed history', () => {
  const tui = { messages: [{ role: 'user', text: 'x', tools: [], id: 1 }] };
  assert.equal(repaintTranscript(tui, []), 0);
  assert.equal(tui.messages.length, 0);
  assert.equal(repaintTranscript(tui, undefined), 0);
  assert.equal(repaintTranscript(tui, [{ role: 'assistant', content: null }]), 0);
});

// ── the round trip that was never closed ──────────────────────────────────

test('a conversation written by a turn can be read back by another process', async () => {
  const session = await createSession('openai', 'gpt-4o');
  session.messages = [
    { role: 'system', content: 'prompt' },
    { role: 'user', content: 'ciao' },
    { role: 'assistant', content: 'ciao a te' },
  ];
  assert.equal(await saveSession(session), true);

  const reloaded = await loadSession(session.id);
  assert.deepEqual(reloaded.messages, session.messages);
  assert.equal(reloaded.model, 'gpt-4o');
  assert.ok(reloaded.updated >= reloaded.created);
});

// ── what the UI does with the action ──────────────────────────────────────

test('resuming keeps this process system prompt and restores only the conversation', async () => {
  const { applyResumedSession } = await import('../src/app/native-ui.js');
  const tui = { messages: [], sessionId: 'vecchia' };
  const agent = {
    messages: [
      { role: 'system', content: 'prompt CORRENTE, con gli strumenti di adesso' },
      { role: 'user', content: 'roba del turno in corso' },
    ],
  };
  const session = {
    id: 'abc123',
    messages: [
      { role: 'system', content: 'prompt VECCHIO, di un altro modello' },
      { role: 'user', content: 'domanda salvata' },
      { role: 'assistant', content: 'risposta salvata' },
    ],
  };

  const turns = applyResumedSession({ tui, agent, session });

  assert.equal(turns, 1);
  assert.equal(tui.sessionId, 'abc123');
  // Exactly one system message, and it is the live one: restoring the saved
  // prompt would advertise tools this agent may not have.
  const system = agent.messages.filter((m) => m.role === 'system');
  assert.equal(system.length, 1);
  assert.match(system[0].content, /CORRENTE/);
  assert.equal(agent.messages[0].role, 'system', 'the system prompt stays first');
  assert.deepEqual(agent.messages.slice(1).map((m) => m.content), ['domanda salvata', 'risposta salvata']);
  assert.equal(tui.messages.length, 2);
});

test('a new session forgets the conversation but not the agent', async () => {
  const { clearConversation } = await import('../src/app/native-ui.js');
  const tui = { messages: [{ role: 'user', text: 'x', tools: [], id: 1 }] };
  const agent = {
    messages: [
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'ciao' },
      { role: 'assistant', content: 'ciao' },
    ],
  };
  clearConversation({ tui, agent });
  assert.deepEqual(agent.messages, [{ role: 'system', content: 'prompt' }]);
  assert.equal(tui.messages.length, 0);
});
