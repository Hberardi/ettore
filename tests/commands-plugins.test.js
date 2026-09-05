import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { PluginRegistry, PluginRuntime } from '../src/plugins/index.js';
import { builtinCommands } from '../src/commands/index.js';
import { uiBridge } from '../src/tools/bridge.js';
import { discoverPlugins } from '../src/plugins/loader.js';

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

test('plugins install with no name offers a choice and acts on it', async () => {
  const dir = await makeTmpDir();
  const seen = [];
  const onAsk = (payload) => {
    seen.push(payload);
    // Pick the first offered plugin, as a user pressing enter would.
    payload.resolve(payload.options[0]);
  };
  uiBridge.on('askUser', onAsk);
  try {
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    const out = await builtinCommands.plugins.handler(['install'], buildContext(runtime, registry));

    assert.equal(seen.length, 1, 'no choice was offered');
    assert.ok(seen[0].options.length >= 1, 'the choice had no options');
    assert.match(out, /✓ Installed/);
    // Installed *and* enabled: stopping at the copy leaves the user a step
    // short of what they asked for.
    assert.match(out, /enabled it/);
    assert.ok(runtime.has(seen[0].options[0].split(' — ')[0]));
  } finally {
    uiBridge.off('askUser', onAsk);
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins install falls back to a usage line where nothing can answer', async () => {
  // A picker nobody can answer would hang a headless caller forever.
  const dir = await makeTmpDir();
  try {
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    const out = await builtinCommands.plugins.handler(['install'], buildContext(runtime, registry));
    assert.match(out, /Usage: \/plugins install <name>/);
    assert.match(out, /git-history/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancelling the picker installs nothing', async () => {
  const dir = await makeTmpDir();
  const onAsk = (payload) => payload.resolve('__cancelled__');
  uiBridge.on('askUser', onAsk);
  try {
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    const out = await builtinCommands.plugins.handler(['install'], buildContext(runtime, registry));
    assert.match(out, /Cancelled/);
    assert.deepEqual(await discoverPlugins(dir), []);
  } finally {
    uiBridge.off('askUser', onAsk);
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugins available flags an installed copy that has fallen behind', async () => {
  // The installed copy is what runs — the runtime loads from the user's plugin
  // directory and never looks at the package's own. A copy left behind by a
  // release keeps running old code while reporting itself installed and
  // enabled, which it is, so nothing on screen contradicts it.
  const { cpSync, appendFileSync } = await import('node:fs');
  const dir = await makeTmpDir();
  try {
    const src = new URL('../examples/plugins/hello-world', import.meta.url).pathname;
    cpSync(src, join(dir, 'hello-world'), { recursive: true });
    appendFileSync(join(dir, 'hello-world', 'index.js'), '\n// diverged\n');

    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    const out = await builtinCommands.plugins.handler(['available'], buildContext(runtime, registry));

    assert.match(out, /Older than the copy shipped with ETTORE/);
    assert.match(out, /hello-world — running an older copy/);
    assert.match(out, /--force to update/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an identical installed copy is not reported as behind', async () => {
  const { cpSync } = await import('node:fs');
  const dir = await makeTmpDir();
  try {
    const src = new URL('../examples/plugins/hello-world', import.meta.url).pathname;
    cpSync(src, join(dir, 'hello-world'), { recursive: true });
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    const out = await builtinCommands.plugins.handler(['available'], buildContext(runtime, registry));
    assert.doesNotMatch(out, /Older than the copy/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a marker file or a README does not count as falling behind', async () => {
  // Only the files that decide behaviour are fingerprinted: enabling a plugin
  // writes a marker into its directory, and that must not read as divergence.
  const { cpSync, writeFileSync } = await import('node:fs');
  const { bundledPluginStates } = await import('../src/plugins/loader.js');
  const dir = await makeTmpDir();
  try {
    const src = new URL('../examples/plugins/hello-world', import.meta.url).pathname;
    cpSync(src, join(dir, 'hello-world'), { recursive: true });
    writeFileSync(join(dir, 'hello-world', '.enabled'), '');
    writeFileSync(join(dir, 'hello-world', 'NOTES.md'), 'local notes');
    const states = await bundledPluginStates({ pluginsDir: dir });
    assert.equal(states.find(s => s.name === 'hello-world').stale, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
