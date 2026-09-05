import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { PluginRegistry, PluginRuntime } from '../src/plugins/index.js';
import { builtinCommands } from '../src/commands/index.js';

async function makeTmpDir() {
  return await mkdtemp(join(tmpdir(), 'ettore-plugins-cmd-test-'));
}

async function makeFakePlugin(parentDir, name, manifestOverride = {}, code = '') {
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
  hello: { description: 'say hi', handler: async () => 'hi' },
};
export const commands = {
  ping: { description: 'ping', handler: async () => 'pong' },
};
export const hooks = {};
`;
  await writeFile(join(dir, manifest.main), code || defaultCode);
  return dir;
}

function buildContext(runtime, registry) {
  let agent = { messages: [], _workdir: '/tmp' };
  return {
    pluginRuntime: runtime,
    config: { workdir: '/tmp' },
    agent,
    history: [],
    emitter: { emit() {} },
    rebuildAgent: async () => { /* no-op in tests */ },
  };
}

test('plugins command: without runtime, returns a friendly message', async () => {
  const cmd = builtinCommands.plugins;
  const out = await cmd.handler([], {});
  assert.match(out, /Plugin system not initialized/);
});

test('plugins command: list returns empty when no plugins are enabled', async () => {
  const dir = await makeTmpDir();
  try {
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    const cmd = builtinCommands.plugins;
    const out = await cmd.handler(['list'], buildContext(runtime, registry));
    assert.match(out, /No plugins enabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins command: list shows enabled plugins with versions and counts', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'alpha');
    await makeFakePlugin(dir, 'beta');
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await runtime.enable('alpha');
    const out = await builtinCommands.plugins.handler(['list'], buildContext(runtime, registry));
    assert.match(out, /Enabled plugins \(1\)/);
    assert.match(out, /alpha\s+v1\.0\.0/);
    assert.ok(!/beta/.test(out.split('Enabled plugins')[1] || ''));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins command: available lists on-disk plugins with enabled tags', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'one');
    await makeFakePlugin(dir, 'two');
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await runtime.enable('one');
    const out = await builtinCommands.plugins.handler(['available'], buildContext(runtime, registry));
    // The listing now separates what is installed from what merely ships with
    // ETTORE, since a fresh install has the second and none of the first.
    assert.match(out, /Installed plugins \(2\)/);
    assert.match(out, /one \[enabled\]/);
    assert.match(out, /two(?! \[enabled\])/);
    assert.match(out, /Bundled with ETTORE/);
    assert.match(out, /git-history/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins command: enable without name returns usage hint', async () => {
  const dir = await makeTmpDir();
  try {
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    const out = await builtinCommands.plugins.handler(['enable'], buildContext(runtime, registry));
    assert.match(out, /Usage: \/plugins enable <name>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins command: enable succeeds and calls rebuildAgent', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'one');
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    let rebuilt = 0;
    const ctx = buildContext(runtime, registry);
    ctx.rebuildAgent = async () => { rebuilt += 1; };
    const out = await builtinCommands.plugins.handler(['enable', 'one'], ctx);
    assert.match(out, /Plugin "one" enabled/);
    assert.equal(runtime.has('one'), true);
    assert.equal(rebuilt, 1, 'rebuildAgent should be called after enable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins command: enable reports error for non-existent plugin', async () => {
  const dir = await makeTmpDir();
  try {
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    const out = await builtinCommands.plugins.handler(['enable', 'ghost'], buildContext(runtime, registry));
    assert.match(out, /Error enabling plugin "ghost"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins command: disable an enabled plugin triggers rebuild and unregister', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'one');
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await runtime.enable('one');
    let rebuilt = 0;
    const ctx = buildContext(runtime, registry);
    ctx.rebuildAgent = async () => { rebuilt += 1; };
    const out = await builtinCommands.plugins.handler(['disable', 'one'], ctx);
    assert.match(out, /Plugin "one" disabled/);
    assert.equal(runtime.has('one'), false);
    assert.equal(rebuilt, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins command: disable of a non-enabled plugin is a no-op', async () => {
  const dir = await makeTmpDir();
  try {
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    const out = await builtinCommands.plugins.handler(['disable', 'nope'], buildContext(runtime, registry));
    assert.match(out, /is not enabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins command: reload re-runs the plugin lifecycle', async () => {
  const dir = await makeTmpDir();
  try {
    let loads = 0;
    const code = `
export const tools = {};
export const commands = {};
export const hooks = {
  onLoad: async () => { globalThis.__loads = (globalThis.__loads || 0) + 1; },
  onUnload: async () => {},
};
`;
    await makeFakePlugin(dir, 'one', {}, code);
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await runtime.enable('one');
    const ctx = buildContext(runtime, registry);
    ctx.rebuildAgent = async () => {};
    const out = await builtinCommands.plugins.handler(['reload', 'one'], ctx);
    assert.match(out, /Plugin "one" reloaded/);
    // After reload, the plugin is still enabled.
    assert.equal(runtime.has('one'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins command: info shows detailed metadata for an enabled plugin', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'one', { description: 'A test plugin' });
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await runtime.enable('one');
    const out = await builtinCommands.plugins.handler(['info', 'one'], buildContext(runtime, registry));
    assert.match(out, /Plugin: one/);
    assert.match(out, /Version: 1\.0\.0/);
    assert.match(out, /A test plugin/);
    assert.match(out, /Tools \(1\):/);
    assert.match(out, /- hello/);
    assert.match(out, /Status: enabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins command: info falls back to on-disk manifest when not enabled', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'one', { description: 'A test plugin' });
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    // Note: NOT enabled.
    const out = await builtinCommands.plugins.handler(['info', 'one'], buildContext(runtime, registry));
    assert.match(out, /on disk, not enabled/);
    assert.match(out, /Use \/plugins enable one to activate it/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins command: unknown subcommand returns usage', async () => {
  const dir = await makeTmpDir();
  try {
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    const out = await builtinCommands.plugins.handler(['frobnicate'], buildContext(runtime, registry));
    assert.match(out, /Usage: \/plugins/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins command: aliases work (plugin → plugins)', async () => {
  const cmd = builtinCommands.plugins;
  assert.deepEqual(cmd.aliases, ['plugin']);
});
