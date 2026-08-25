import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { Agent } from '../src/agents/index.js';
import { toolDefinitions, toolHandlers } from '../src/tools/index.js';
import { PluginRegistry, PluginRuntime } from '../src/plugins/index.js';

function makeEmitter() {
  const emitter = new EventEmitter();
  const errors = [];
  emitter.on('error', error => errors.push(String(error)));
  return { emitter, errors };
}

function agentConfig(workdir, extra = {}) {
  return {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir,
    contextWindow: 128000,
    verifyAfterEdit: false,
    dynamicToolRouting: false, // we want ALL tool definitions in this test
    maxToolsPerRequest: 28,
    ...extra,
  };
}

async function makeTmpDir() {
  return await mkdtemp(join(tmpdir(), 'ettore-agent-plugin-test-'));
}

async function makeFakePlugin(parentDir, name, code = '', manifestOverride = {}) {
  const dir = join(parentDir, name);
  await mkdir(dir, { recursive: true });
  const manifest = {
    name,
    version: '1.0.0',
    apiVersion: '1',
    main: 'index.js',
    description: `${name} plugin`,
    ...manifestOverride,
  };
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest));
  const defaultCode = `
export const tools = {
  greet: { description: 'say hi', handler: async () => 'hi' },
};
export const commands = {};
export const hooks = {};
`;
  await writeFile(join(dir, manifest.main), code || defaultCode);
  return dir;
}

test('Agent: without pluginRegistry, behavior is identical to baseline', async () => {
  let observedTools = null;
  const client = {
    async turn(_messages, tools) {
      observedTools = tools.map(t => t.function.name);
      return { type: 'text', content: 'done' };
    },
  };
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter } = makeEmitter();
  await agent.run('hi', emitter);
  assert.ok(observedTools.length > 0);
  // No plugin tool should be present.
  assert.ok(!observedTools.includes('greet'));
});

test('Agent: with pluginRegistry, plugin tools are exposed in the tool list', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'one');
    // Seed the registry with the actual built-in tool list so the
    // merged view matches what the TUI/CLI would produce in production.
    const registry = new PluginRegistry({
      builtInTools: toolDefinitions,
      builtInHandlers: toolHandlers,
      builtInCommands: {},
    });
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await runtime.enable('one');

    let observedTools = null;
    const client = {
      async turn(_messages, tools) {
        observedTools = tools.map(t => t.function.name);
        return { type: 'text', content: 'done' };
      },
    };
    const agent = new Agent(client, agentConfig(process.cwd(), { pluginRegistry: registry }));
    const { emitter } = makeEmitter();
    await agent.run('hi', emitter);
    // Built-in tools still present.
    assert.ok(observedTools.length > 10);
    // Plugin tool merged in.
    assert.ok(observedTools.includes('greet'), `plugin tool not in ${observedTools.join(',')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Agent: dynamic routing keeps enabled plugin tools discoverable', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'one');
    const registry = new PluginRegistry({
      builtInTools: toolDefinitions,
      builtInHandlers: toolHandlers,
      builtInCommands: {},
    });
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await runtime.enable('one');

    let observedTools = [];
    const client = {
      async turn(_messages, tools) {
        observedTools = tools.map(t => t.function.name);
        return { type: 'text', content: 'done' };
      },
    };
    const agent = new Agent(client, agentConfig(process.cwd(), {
      dynamicToolRouting: true,
      maxToolsPerRequest: 16,
      pluginRegistry: registry,
    }));
    const { emitter } = makeEmitter();
    await agent.run('use the available tools', emitter);
    assert.ok(observedTools.includes('greet'), `plugin tool not routed: ${observedTools.join(',')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Agent: plugin tool calls are routed to the plugin handler', async () => {
  const dir = await makeTmpDir();
  try {
    let handlerInvocations = 0;
    let lastArgs = null;
    const code = `
export const tools = {
  echo: {
    description: 'echo args back',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    handler: async (args, ctx) => {
      globalThis.__count = (globalThis.__count || 0) + 1;
      return 'ECHO:' + args.value + ':' + ctx.plugin;
    },
  },
};
export const commands = {};
export const hooks = {};
`;
    await makeFakePlugin(dir, 'one', code);
    const registry = new PluginRegistry({
      builtInTools: toolDefinitions,
      builtInHandlers: toolHandlers,
      builtInCommands: {},
    });
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await runtime.enable('one');

    let turn = 0;
    const client = {
      async turn(_messages, _tools) {
        turn++;
        if (turn === 1) {
          return {
            type: 'tool_calls',
            tool_calls: [{
              id: 'c1',
              type: 'function',
              function: { name: 'echo', arguments: JSON.stringify({ value: 'hi' }) },
            }],
            message: { role: 'assistant', content: '', tool_calls: [{
              id: 'c1', type: 'function', function: { name: 'echo', arguments: JSON.stringify({ value: 'hi' }) },
            }] },
          };
        }
        return { type: 'text', content: 'finished' };
      },
    };
    const agent = new Agent(client, agentConfig(process.cwd(), { pluginRegistry: registry }));
    const { emitter, errors } = makeEmitter();
    const result = await agent.run('echo something', emitter);
    // The plugin handler returned a string; the second turn should pick it
    // up from the tool result and return 'finished'.
    assert.equal(result, 'finished');
    // The tool result message should contain the plugin's echo output.
    const toolMsg = agent.messages.find(m => m.role === 'tool' && m.tool_call_id === 'c1');
    assert.ok(toolMsg, 'expected tool result message');
    assert.match(toolMsg.content, /ECHO:hi:one/);
    assert.deepEqual(errors, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Agent: plugin handler errors are surfaced as Error: strings in tool results', async () => {
  const dir = await makeTmpDir();
  try {
    const code = `
export const tools = {
  boom: { description: 'always fails', handler: async () => { throw new Error('kaboom'); } },
};
export const commands = {};
export const hooks = {};
`;
    await makeFakePlugin(dir, 'one', code);
    const registry = new PluginRegistry({
      builtInTools: toolDefinitions,
      builtInHandlers: toolHandlers,
      builtInCommands: {},
    });
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await runtime.enable('one');

    let turn = 0;
    const client = {
      async turn(_messages, _tools) {
        turn++;
        if (turn === 1) {
          return {
            type: 'tool_calls',
            tool_calls: [{
              id: 'c1',
              type: 'function',
              function: { name: 'boom', arguments: '{}' },
            }],
            message: { role: 'assistant', content: '', tool_calls: [{
              id: 'c1', type: 'function', function: { name: 'boom', arguments: '{}' },
            }] },
          };
        }
        return { type: 'text', content: 'done' };
      },
    };
    const agent = new Agent(client, agentConfig(process.cwd(), { pluginRegistry: registry }));
    const { emitter } = makeEmitter();
    await agent.run('go', emitter);
    const toolMsg = agent.messages.find(m => m.role === 'tool' && m.tool_call_id === 'c1');
    assert.ok(toolMsg);
    assert.match(toolMsg.content, /Error: plugin "one" tool "boom" failed: kaboom/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Agent: enabling a plugin AFTER the agent was built does not retroactively expose it', async () => {
  // This documents the current contract: the agent merges plugin tools
  // at construction time. Adding plugins later requires rebuilding the
  // agent (the TUI /plugins command does this via rebuildAgent).
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'one');
    const registry = new PluginRegistry({
      builtInTools: toolDefinitions,
      builtInHandlers: toolHandlers,
      builtInCommands: {},
    });
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });

    let observedTools = null;
    const client = {
      async turn(_messages, tools) {
        observedTools = tools.map(t => t.function.name);
        return { type: 'text', content: 'done' };
      },
    };
    const agent = new Agent(client, agentConfig(process.cwd(), { pluginRegistry: registry }));
    // Plugin is NOT yet enabled when the agent is built.
    const { emitter } = makeEmitter();
    await agent.run('hi', emitter);
    assert.ok(!observedTools.includes('greet'));

    // Enable the plugin after the agent is built. Subsequent runs of the
    // SAME agent instance still do not see it (cached merge).
    await runtime.enable('one');
    const { emitter: em2 } = makeEmitter();
    await agent.run('hi again', em2);
    assert.ok(!observedTools.includes('greet'),
      'the same Agent instance does not re-merge on enable — rebuild is required');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Agent: building a NEW agent after enable picks up the new tool', async () => {
  // Companion to the previous test: building a fresh Agent with the
  // same registry DOES pick up the plugin tool.
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'one');
    const registry = new PluginRegistry({
      builtInTools: toolDefinitions,
      builtInHandlers: toolHandlers,
      builtInCommands: {},
    });
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await runtime.enable('one');

    let observedTools = null;
    const client = {
      async turn(_messages, tools) {
        observedTools = tools.map(t => t.function.name);
        return { type: 'text', content: 'done' };
      },
    };
    const agent = new Agent(client, agentConfig(process.cwd(), { pluginRegistry: registry }));
    const { emitter } = makeEmitter();
    await agent.run('hi', emitter);
    assert.ok(observedTools.includes('greet'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
