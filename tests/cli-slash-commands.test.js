// `ettore /connect claude-code` typed at the shell.
//
// The one-shot path handed "/connect claude-code" to the configured model as a
// question — which answered with an unexplained `400 status code (no body)` —
// or, with nothing configured, refused with "Not connected. … use /connect",
// the very command just typed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSlashCommand } from '../src/cli/index.js';

const commands = {
  connect: {
    aliases: [],
    handler: async (args, context) => `connected ${args.join(' ')}${context.connectionManager ? ' (manager)' : ''}`,
  },
  theme: { aliases: [], handler: async () => ({ action: 'setTheme', theme: 'forest' }) },
  keys: { aliases: ['k'], handler: async () => 'Error: nothing stored' },
  boom: { aliases: [], handler: async () => { throw new Error('exploded'); } },
};

test('a known command runs, with its arguments, before anything needs a connection', async () => {
  const result = await runSlashCommand('/connect claude-code', { commands, manager: {} });
  assert.deepEqual(result, { handled: true, ok: true, output: 'connected claude-code (manager)' });
});

test('aliases work, and an Error: result is reported as a failure', async () => {
  const result = await runSlashCommand('/k', { commands });
  assert.equal(result.handled, true);
  assert.equal(result.ok, false);
  assert.match(result.output, /nothing stored/);
});

test('a command that only changes the TUI says so instead of doing nothing', async () => {
  const result = await runSlashCommand('/theme forest', { commands });
  assert.equal(result.ok, true);
  assert.match(result.output, /inside `ettore`/);
});

test('a command that throws is an error, not a crash', async () => {
  const result = await runSlashCommand('/boom', { commands });
  assert.deepEqual(result, { handled: true, ok: false, output: 'Error: exploded' });
});

test('a prompt that merely starts with a slash still goes to the model', async () => {
  const noPluginCommands = async () => ({ registry: { getAllCommands: () => ({}) } });
  for (const prompt of ['/tmp/app.log spiegami questo errore', '/unknown thing', 'connect me', ' /etc/hosts cosa contiene?']) {
    assert.equal((await runSlashCommand(prompt, { commands, plugins: noPluginCommands })).handled, false, prompt);
  }
});

test('a plugin command runs from the shell too — `ettore /ci`', async () => {
  const seen = [];
  const plugins = async () => ({
    registry: {
      getAllCommands: () => ({
        ci: { handler: async (args, ctx) => { seen.push([args, ctx.extra.workspace]); return { handled: true, output: 'CI on main: success' }; } },
      }),
    },
  });
  const result = await runSlashCommand('/ci main', { commands, plugins });
  assert.deepEqual(result, { handled: true, ok: true, output: 'CI on main: success' });
  assert.deepEqual(seen, [['main', process.cwd()]]);
});

test('/plugins from the shell gets a plugin runtime to work with', async () => {
  let given = null;
  const table = { plugins: { aliases: ['plugin'], handler: async (_args, ctx) => { given = ctx.pluginRuntime; return 'ok'; } } };
  const runtime = { list: () => [] };
  await runSlashCommand('/plugins list', { commands: table, plugins: async () => ({ runtime, registry: {} }) });
  assert.equal(given, runtime);
});

test('the real command table is used by default', async () => {
  const result = await runSlashCommand('/sidebar');
  assert.equal(result.handled, true);
  assert.match(result.output, /Right panel/);
});

test('/connect with nobody signed in hands over to the sign-in, then connects', async () => {
  let attempts = 0;
  const signedIn = [];
  const table = {
    connect: {
      aliases: [],
      handler: async () => {
        attempts++;
        return attempts === 1
          ? 'Error: Not signed in to your Anthropic account.\nNext: sign in, then retry /connect claude-code.'
          : 'Connected to claude-code!';
      },
    },
  };
  const result = await runSlashCommand('/connect claude-code', {
    commands: table,
    login: async (provider) => { signedIn.push(provider); return true; },
  });
  assert.deepEqual(signedIn, ['claude-code']);
  assert.equal(result.ok, true);
  assert.match(result.output, /Connected/);
});

test('a sign-in that fails or is abandoned leaves the original message', async () => {
  const table = {
    connect: { aliases: [], handler: async () => 'Error: Not signed in.\nNext: sign in, then retry /connect claude-code.' },
  };
  const result = await runSlashCommand('/connect claude-code', { commands: table, login: async () => false });
  assert.equal(result.ok, false);
  assert.match(result.output, /Next: sign in/);
});

test('/use claude-code takes a model newer than the list, as the README promises', async () => {
  const { builtinCommands } = await import('../src/commands/index.js');
  const set = [];
  const manager = {
    isConnected: () => true,
    listModels: () => ({ success: true, models: [{ id: 'sonnet' }, { id: 'opus' }] }),
    setActive: (provider, model) => { set.push(`${provider}/${model}`); return { success: true, provider, model }; },
  };
  const ok = await builtinCommands.use.handler(['claude-code', 'claude-opus-9-9'], { connectionManager: manager });
  assert.match(ok, /Now using: claude-code\/claude-opus-9-9/);

  const refused = await builtinCommands.use.handler(['openai', 'not-a-model'], { connectionManager: manager });
  assert.match(refused, /Model not found/, 'a provider with a real catalogue still checks it');
  assert.deepEqual(set, ['claude-code/claude-opus-9-9']);
});

test('the stall watchdog gives Claude Code the long window its bridge already uses', async () => {
  const { hasLongReasoningWindow } = await import('../src/app/native-ui.js');
  assert.equal(hasLongReasoningWindow('claude-code', 'claude-opus-5-5'), true);
  assert.equal(hasLongReasoningWindow('openai', 'gpt-4o'), false);
});
