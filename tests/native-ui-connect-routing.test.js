import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTION_COMMANDS, connectProviderToRoute } from '../src/app/native-ui.js';
import { PROVIDER_REGISTRY } from '../src/providers/registry.js';

// Regression: `/connect claude-code` typed inline used to fall through to the
// generic command handler, which printed "Connected to …" while the TUI, the
// cost meter and the agent stayed on the previously active provider — the
// command looked like it did nothing at all.

test('a bare /connect <provider> routes to the interactive provider flow', () => {
  assert.equal(connectProviderToRoute(['claude-code']), 'claude-code');
  assert.equal(connectProviderToRoute(['ollama']), 'ollama');
  assert.equal(connectProviderToRoute([' Anthropic ']), 'anthropic');
});

test('every registry provider is routable by id', () => {
  for (const entry of PROVIDER_REGISTRY) {
    assert.equal(connectProviderToRoute([entry.id]), entry.id);
  }
});

test('an inline API key or an unknown provider stays on the generic handler', () => {
  // The generic handler is the one that knows how to consume a key argument.
  assert.equal(connectProviderToRoute(['openai', 'sk-test']), null);
  assert.equal(connectProviderToRoute(['nope']), null);
  assert.equal(connectProviderToRoute([]), null);
  assert.equal(connectProviderToRoute(['']), null);
});

test('commands that can change the active connection trigger a TUI resync', () => {
  for (const name of ['connect', 'use', 'select', 'disconnect']) {
    assert.ok(CONNECTION_COMMANDS.has(name), name);
  }
  assert.ok(!CONNECTION_COMMANDS.has('help'));
});
