import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinCommands } from '../src/commands/index.js';

const commandSystem = {
  list: () => Object.entries(builtinCommands).map(([name, cmd]) => ({
    name,
    description: cmd.description || '',
    usage: cmd.usage || name,
    aliases: cmd.aliases || [],
  })),
};

test('help: shows first steps and grouped commands', async () => {
  const output = await builtinCommands.help.handler([], { commandSystem });

  assert.match(output, /ETTORE help/);
  assert.match(output, /First steps/);
  assert.match(output, /\/connect/);
  assert.match(output, /Core commands/);
  assert.match(output, /\/doctor/);
  assert.match(output, /Use \/help <command>/);
});

test('help: shows command-specific usage', async () => {
  const output = await builtinCommands.help.handler(['connect'], { commandSystem });

  assert.match(output, /\/connect/);
  assert.match(output, /Usage: \/connect \[provider\] \[api-key\]/);
});

test('connect: lists providers with key requirements', async () => {
  const fakeManager = {
    isConnected: () => false,
  };
  const output = await builtinCommands.connect.handler([], { connectionManager: fakeManager });

  assert.match(output, /Available providers:/);
  assert.match(output, /openai/);
  assert.match(output, /key:/);
  assert.match(output, /ollama/);
  assert.match(output, /no key required/);
  assert.match(output, /\/doctor/);
});

test('connect: requires API key only for keyed providers', async () => {
  const output = await builtinCommands.connect.handler(['openai'], {});

  assert.match(output, /Please provide API key for openai/);
  assert.match(output, /Usage: \/connect openai <api-key>/);
});

test('connect: supports no-key providers and auto-selects first model', async () => {
  const calls = [];
  const fakeManager = {
    isConnected: () => false,
    getActive: () => null,
    connect: async (provider, apiKey) => {
      calls.push(['connect', provider, apiKey]);
      return { success: true, message: 'Connected to ollama!', models: [{ id: 'llama3.1' }] };
    },
    setActive: (provider, model) => {
      calls.push(['setActive', provider, model]);
      return { success: true, provider, model };
    },
  };

  const output = await builtinCommands.connect.handler(['ollama'], { connectionManager: fakeManager });

  assert.deepEqual(calls, [
    ['connect', 'ollama', null],
    ['setActive', 'ollama', 'llama3.1'],
  ]);
  assert.match(output, /Connected to ollama!/);
  assert.match(output, /Available models:/);
  assert.match(output, /llama3\.1/);
  assert.match(output, /Active model selected: ollama\/llama3\.1/);
});

test('connect: includes actionable next step on provider failure', async () => {
  const secret = 'sk-test-secret-1234567890';
  const fakeManager = {
    isConnected: () => false,
    connect: async () => ({ success: false, error: `connection refused for ${secret}` }),
  };

  const output = await builtinCommands.connect.handler(['ollama', secret], { connectionManager: fakeManager });

  assert.match(output, /Error: connection refused for sk-t\.\.\.7890/);
  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /make sure Ollama is running/);
});

test('models: points to connect when no providers are connected', async () => {
  const fakeManager = {
    listConnections: () => [],
  };

  const output = await builtinCommands.models.handler([], { connectionManager: fakeManager });

  assert.match(output, /No connected providers/);
  assert.match(output, /\/connect ollama/);
});

test('models: provider-specific missing connection gives exact connect hint', async () => {
  const fakeManager = {
    isConnected: () => false,
  };

  const output = await builtinCommands.models.handler(['ollama'], { connectionManager: fakeManager });

  assert.match(output, /Not connected to ollama/);
  assert.match(output, /Use \/connect ollama first/);
});

test('models: lists active model and model metadata', async () => {
  const fakeManager = {
    activeModel: 'gpt-4o',
    listConnections: () => [{ provider: 'openai', isActive: true }],
    refreshModels: async () => ({ success: true }),
    listModels: () => ({
      success: true,
      models: [
        { id: 'gpt-4o', capability: 'full' },
        { id: 'gpt-4o-mini', free: true },
      ],
    }),
  };

  const output = await builtinCommands.models.handler([], { connectionManager: fakeManager });

  assert.match(output, /OPENAI ✓/);
  assert.match(output, /gpt-4o - cap: full ← active/);
  assert.match(output, /gpt-4o-mini - free/);
  assert.match(output, /\/use <provider> <model>/);
});

test('use: shows quick select when provider is connected but no model provided', async () => {
  const fakeManager = {
    isConnected: () => true,
    refreshModels: async () => ({ success: true }),
    listModels: () => ({
      success: true,
      models: [{ id: 'llama3.1' }, { id: 'qwen2.5' }],
    }),
  };

  const output = await builtinCommands.use.handler(['ollama'], { connectionManager: fakeManager });

  assert.match(output, /Models for OLLAMA/);
  assert.match(output, /Quick select: \/use ollama llama3\.1/);
});

test('use: rejects unknown model before setting active', async () => {
  const calls = [];
  const fakeManager = {
    isConnected: () => true,
    listModels: () => ({
      success: true,
      models: [{ id: 'llama3.1' }],
    }),
    setActive: (...args) => {
      calls.push(args);
      return { success: true };
    },
  };

  const output = await builtinCommands.use.handler(['ollama', 'missing-model'], { connectionManager: fakeManager });

  assert.equal(calls.length, 0);
  assert.match(output, /Model not found for ollama: missing-model/);
  assert.match(output, /Run \/models ollama/);
});

test('status: includes connection diagnostics', async () => {
  const output = await builtinCommands.status.handler([], {
    version: '1.0.0',
    config: { stream: true, workdir: '/tmp/project' },
  });

  assert.match(output, /Provider:/);
  assert.match(output, /Connection:/);
  assert.match(output, /Saved connections:/);
  assert.match(output, /Working dir: \/tmp\/project/);
});

test('doctor: reports local diagnostics and next steps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-doctor-'));
  const previousConfigDir = process.env.ETTORE_CONFIG_DIR;
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.ETTORE_CONFIG_DIR = dir;
  process.env.OPENAI_API_KEY = 'sk-test-secret-1234567890';
  try {
    const output = await builtinCommands.doctor.handler([], {
      version: '1.0.0',
      config: { stream: true, workdir: process.cwd() },
    });

    assert.match(output, /ETTORE doctor/);
    assert.match(output, new RegExp(`Config dir: ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(output, /OK/);
    assert.match(output, /Warnings/);
    assert.match(output, /Failures/);
    assert.match(output, /Next steps/);
    assert.match(output, /Node\.js/);
    assert.match(output, /Config directory permissions:/);
    assert.match(output, /Environment API keys present for: openai/);
    assert.doesNotMatch(output, /sk-test-secret/);
  } finally {
    if (previousConfigDir === undefined) delete process.env.ETTORE_CONFIG_DIR;
    else process.env.ETTORE_CONFIG_DIR = previousConfigDir;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    await rm(dir, { recursive: true, force: true });
  }
});
