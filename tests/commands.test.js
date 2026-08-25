import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinCommands } from '../src/commands/index.js';
import { MissionControl } from '../src/mission/index.js';

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
  assert.match(output, /\/caveman/);
  assert.match(output, /Use \/help <command>/);
});

test('caveman: enables selected level on agent', async () => {
  const seen = [];
  const agent = {
    cavemanLevel: null,
    setCavemanLevel(level) {
      this.cavemanLevel = level;
      seen.push(level);
    },
    clearCavemanLevel() {
      this.cavemanLevel = null;
    },
  };

  const output = await builtinCommands.caveman.handler(['ultra'], { agent });

  assert.equal(agent.cavemanLevel, 'ultra');
  assert.deepEqual(seen, ['ultra']);
  assert.match(output, /Caveman mode: ON \(ultra\)/);
});

test('caveman: reports status and disables mode', async () => {
  const agent = {
    cavemanLevel: 'full',
    setCavemanLevel(level) {
      this.cavemanLevel = level;
    },
    clearCavemanLevel() {
      this.cavemanLevel = null;
    },
  };

  const before = await builtinCommands.caveman.handler([], { agent });
  const off = await builtinCommands.caveman.handler(['off'], { agent });

  assert.match(before, /Caveman mode: ON \(full\)/);
  assert.match(off, /Caveman mode: OFF/);
  assert.equal(agent.cavemanLevel, null);
});

test('help: shows command-specific usage', async () => {
  const output = await builtinCommands.help.handler(['connect'], { commandSystem });

  assert.match(output, /\/connect/);
  assert.match(output, /Usage: \/connect \[provider\] \[api-key\]/);
});

test('mission: reports and clears the current Mission Control state', async () => {
  const mission = new MissionControl();
  mission.startTurn('Build the feature');
  mission.fileChanged({ type: 'write', path: 'src/feature.js' });

  const output = await builtinCommands.mission.handler([], { mission });
  assert.match(output, /Mission /);
  assert.match(output, /Files changed: 1/);

  const cleared = await builtinCommands.mission.handler(['clear'], { mission });
  assert.match(cleared, /cleared/);
  assert.match(await builtinCommands.mission.handler([], { mission }), /No active mission/);
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

test('models refresh: forces a refresh on a single provider', async () => {
  const calls = [];
  const fakeManager = {
    listConnections: () => [{ provider: 'ollama' }],
    isConnected: () => true,
    refreshModels: async (provider, opts) => {
      calls.push([provider, opts]);
      return { success: true, models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    },
  };
  const output = await builtinCommands.models.handler(['refresh', 'ollama'], { connectionManager: fakeManager });
  assert.deepEqual(calls, [['ollama', { force: true }]]);
  assert.match(output, /↻ Refreshed 3 models for ollama/);
});

test('models refresh: refreshes every connected provider when no name given', async () => {
  const refreshed = ['ollama', 'nvidia'];
  const fakeManager = {
    listConnections: () => refreshed.map(p => ({ provider: p })),
    refreshModels: async (provider) => ({ success: provider === 'ollama', models: [{ id: provider }] }),
  };
  const output = await builtinCommands.models.handler(['refresh'], { connectionManager: fakeManager });
  assert.match(output, /↻ Refreshed 1\/2 providers/);
});

test('models refresh: surfaces failures with the provider name', async () => {
  const fakeManager = {
    listConnections: () => [{ provider: 'nvidia' }],
    isConnected: () => true,
    refreshModels: async () => ({ success: false, error: 'HTTP 503' }),
  };
  const output = await builtinCommands.models.handler(['refresh', 'nvidia'], { connectionManager: fakeManager });
  assert.match(output, /✗ Failed to refresh nvidia: HTTP 503/);
});

test('models stale: shows age and freshness for each connected provider', async () => {
  const fakeManager = {
    getModelsCacheStatus: () => [
      { provider: 'ollama', modelsCount: 12, ageMs: 30_000, stale: false, fetchedAt: new Date().toISOString() },
      { provider: 'nvidia', modelsCount: 240, ageMs: 600_000, stale: true, fetchedAt: new Date().toISOString() },
      { provider: 'openai', modelsCount: 0, ageMs: null, stale: true, fetchedAt: null },
    ],
  };
  const output = await builtinCommands.models.handler(['stale'], { connectionManager: fakeManager });
  assert.match(output, /Model catalog cache/);
  assert.match(output, /ollama: 12 models, just now \(fresh\)/);
  assert.match(output, /nvidia: 240 models, 10m ago \(will refresh on next access\)/);
  assert.match(output, /openai: 0 models, never fetched \(will refresh on next access\)/);
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
    await writeFile(join(dir, 'package.json'), '{}\n');
    const output = await builtinCommands.doctor.handler([], {
      version: '1.0.0',
      config: { stream: true, workdir: dir },
      connectionManager: {
        listConnections: () => [],
        getActive: () => null,
        activeProvider: null,
        activeModel: null,
      },
    });

    assert.match(output, /ETTORE doctor/);
    assert.match(output, new RegExp(`Config dir: ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(output, /OK/);
    assert.match(output, /Warnings/);
    assert.match(output, /Failures/);
    assert.match(output, /Next steps/);
    assert.match(output, /Node\.js/);
    assert.match(output, new RegExp(`Working directory writable: ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(output, new RegExp(`Project root detected: ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
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

test('doctor: uses injected connection manager state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-doctor-manager-'));
  const previousConfigDir = process.env.ETTORE_CONFIG_DIR;
  process.env.ETTORE_CONFIG_DIR = dir;
  try {
    const output = await builtinCommands.doctor.handler([], {
      config: { workdir: dir, model: 'ctx-model' },
      connectionManager: {
        listConnections: () => [{ provider: 'fake', modelsCount: 1 }],
        getActive: () => ({ provider: 'fake' }),
        activeProvider: 'fake',
        activeModel: 'fake-model',
      },
    });

    assert.match(output, /Saved provider connections: 1/);
    assert.match(output, /Active provider: fake/);
    assert.match(output, /Active model: fake-model/);
    assert.doesNotMatch(output, /No active provider\/model selected/);
  } finally {
    if (previousConfigDir === undefined) delete process.env.ETTORE_CONFIG_DIR;
    else process.env.ETTORE_CONFIG_DIR = previousConfigDir;
    await rm(dir, { recursive: true, force: true });
  }
});
