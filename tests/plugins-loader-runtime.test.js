import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  discoverPlugins,
  readManifest,
  importPlugin,
  loadAllPlugins,
  isEnabledOnDisk,
  markEnabledOnDisk,
  markDisabledOnDisk,
  PluginLoadError,
} from '../src/plugins/loader.js';
import { PluginRegistry, PluginConflictError } from '../src/plugins/registry.js';
import { PluginRuntime } from '../src/plugins/runtime.js';
import { ManifestError } from '../src/plugins/manifest.js';

async function makeTmpDir() {
  return await mkdtemp(join(tmpdir(), 'ettore-plugin-test-'));
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
export const tools = {};
export const commands = {};
export const hooks = {};
`;
  await writeFile(join(dir, manifest.main), code || defaultCode);
  return dir;
}

test('discoverPlugins: returns empty array when the directory does not exist', async () => {
  const dir = join(tmpdir(), `ettore-missing-${Date.now()}-${Math.random()}`);
  const out = await discoverPlugins(dir);
  assert.deepEqual(out, []);
});

test('discoverPlugins: lists valid plugin directories and skips invalid ones', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'alpha');
    await makeFakePlugin(dir, 'beta');
    // Skipped: not kebab-case start, but here it IS kebab. Add a hidden dir.
    await mkdir(join(dir, '.hidden'), { recursive: true });
    // Skipped: file, not directory.
    await writeFile(join(dir, 'stray.txt'), 'not a dir');
    const out = await discoverPlugins(dir);
    const names = out.map((c) => c.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readManifest: rejects when plugin.json is missing', async () => {
  const dir = await makeTmpDir();
  try {
    await mkdir(join(dir, 'lonely'), { recursive: true });
    await assert.rejects(() => readManifest(join(dir, 'lonely')), ManifestError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readManifest: rejects when name does not match directory', async () => {
  const dir = await makeTmpDir();
  try {
    const pluginDir = join(dir, 'actual-name');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'different-name', version: '1.0.0', apiVersion: '1', main: 'index.js',
    }));
    await assert.rejects(() => readManifest(pluginDir), /does not match/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readManifest: rejects malformed JSON', async () => {
  const dir = await makeTmpDir();
  try {
    const pluginDir = join(dir, 'bad');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), '{not valid json');
    await assert.rejects(() => readManifest(pluginDir), /not valid JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateManifest: rejects path that escapes via parent segments', async () => {
  // This used to be tested at the importPlugin level, but the regex in
  // validateManifest already rejects any `main` containing `..` segments.
  // The remaining escape check in resolveEntryPoint is defense in depth
  // against a path that LOOKS valid but resolves outside (e.g. via a
  // symlink at runtime); we keep it but exercise the manifest-level
  // rejection here as the primary guard.
  const dir = await makeTmpDir();
  try {
    const pluginDir = join(dir, 'evil');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'evil', version: '1.0.0', apiVersion: '1', main: 'a/../b/../../outside.js',
    }));
    await assert.rejects(() => readManifest(pluginDir), /must be a relative path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('importPlugin: rejects when entry point does not exist', async () => {
  const dir = await makeTmpDir();
  try {
    // Build a plugin directory whose manifest points at an entry-point
    // file that does not exist. The helper would otherwise create the
    // file with a default body, which would mask the "not found" path.
    const pluginDir = join(dir, 'missing-entry');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'missing-entry', version: '1.0.0', apiVersion: '1', main: 'nope.js',
    }));
    // Deliberately do NOT create nope.js.
    const manifest = await readManifest(pluginDir);
    await assert.rejects(() => importPlugin(manifest), /entry point not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadAllPlugins: returns a row per candidate with either plugin or error', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'good');
    await mkdir(join(dir, 'broken'), { recursive: true });
    await writeFile(join(dir, 'broken', 'plugin.json'), '{ not json');
    const rows = await loadAllPlugins({ pluginsDir: dir });
    assert.equal(rows.length, 2);
    const good = rows.find((r) => r.name === 'good');
    const bad = rows.find((r) => r.name === 'broken');
    assert.ok(good.plugin);
    assert.match(bad.error, /not valid JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadAllPlugins: onlyEnabled skips plugins without the .enabled marker', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'one');
    await makeFakePlugin(dir, 'two');
    await markEnabledOnDisk(join(dir, 'one'));
    const rows = await loadAllPlugins({ onlyEnabled: true, pluginsDir: dir });
    const names = rows.map((r) => r.name).sort();
    assert.deepEqual(names, ['one', 'two']);
    const one = rows.find((r) => r.name === 'one');
    const two = rows.find((r) => r.name === 'two');
    assert.ok(one.plugin);
    assert.equal(two.plugin, null);
    assert.equal(two.enabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enable / disable / reload lifecycle on the runtime', async () => {
  const dir = await makeTmpDir();
  try {
    const pluginCode = `
let onLoadCalled = 0;
let onUnloadCalled = 0;
export const tools = {
  greet: { description: 'say hi', handler: async ({ name }) => 'hi ' + name },
};
export const commands = {};
export const hooks = {
  onLoad: async () => { onLoadCalled++; },
  onUnload: async () => { onUnloadCalled++; },
};
export const _state = { get onLoadCalled() { return onLoadCalled; }, get onUnloadCalled() { return onUnloadCalled; } };
`;
    await makeFakePlugin(dir, 'lifecycle', {}, pluginCode);
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });

    // Initially: no plugins enabled
    assert.equal(runtime.list().length, 0);

    // Enable
    const enabled = await runtime.enable('lifecycle');
    assert.equal(enabled.manifest.name, 'lifecycle');
    assert.ok(runtime.has('lifecycle'));
    assert.equal(runtime.list().length, 1);
    assert.equal(await isEnabledOnDisk(join(dir, 'lifecycle')), true);

    // Disable
    const removed = await runtime.disable('lifecycle');
    assert.equal(removed.removed, true);
    assert.equal(runtime.has('lifecycle'), false);
    assert.equal(await isEnabledOnDisk(join(dir, 'lifecycle')), false);

    // Re-enable
    await runtime.enable('lifecycle');
    assert.ok(runtime.has('lifecycle'));

    // Reload = disable + enable. `loadedAt` is regenerated on every enable,
    // so we compare the stable metadata only.
    const beforeList = runtime.list();
    await runtime.reload('lifecycle');
    const afterList = runtime.list();
    assert.equal(afterList.length, beforeList.length);
    for (let i = 0; i < afterList.length; i++) {
      const a = afterList[i];
      const b = beforeList[i];
      assert.equal(a.name, b.name);
      assert.equal(a.version, b.version);
      assert.equal(a.description, b.description);
      assert.equal(a.toolCount, b.toolCount);
      assert.equal(a.commandCount, b.commandCount);
      assert.deepEqual(a.permissions, b.permissions);
    }
    assert.ok(runtime.has('lifecycle'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime: enable throws when the plugin does not exist on disk', async () => {
  const dir = await makeTmpDir();
  try {
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await assert.rejects(() => runtime.enable('ghost'), /plugin not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime: enable refuses to register a plugin with a colliding tool name', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'first', {}, `
export const tools = { shared: { description: 'x', handler: async () => '' } };
export const commands = {};
export const hooks = {};
`);
    await makeFakePlugin(dir, 'second', {}, `
export const tools = { shared: { description: 'x', handler: async () => '' } };
export const commands = {};
export const hooks = {};
`);
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await runtime.enable('first');
    await assert.rejects(() => runtime.enable('second'), PluginConflictError);
    // Second plugin must NOT be partially enabled.
    assert.equal(await isEnabledOnDisk(join(dir, 'second')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime: boot() loads all enabled plugins, collects failures', async () => {
  const dir = await makeTmpDir();
  try {
    await makeFakePlugin(dir, 'one', {}, `
export const tools = { a: { description: 'a', handler: async () => '' } };
export const commands = {};
export const hooks = {};
`);
    await makeFakePlugin(dir, 'two', {}, `
export const tools = { b: { description: 'b', handler: async () => '' } };
export const commands = {};
export const hooks = {};
`);
    await markEnabledOnDisk(join(dir, 'one'));
    // two is NOT enabled — boot should skip it.
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    const report = await runtime.boot();
    assert.deepEqual(report.enabled, ['one']);
    assert.equal(report.failed.length, 0);
    assert.equal(runtime.list().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime: onLoad hook receives an api object with permissions and helpers', async () => {
  const dir = await makeTmpDir();
  try {
    const code = `
let captured = null;
export const tools = {};
export const commands = {};
export const hooks = {
  onLoad: async (api) => { captured = api; },
};
export const _captured = () => captured;
`;
    await makeFakePlugin(dir, 'hooky', { permissions: ['fs:read', 'memory:write'] }, code);
    const registry = new PluginRegistry();
    const runtime = new PluginRuntime({ registry, pluginsDir: dir });
    await runtime.enable('hooky');
    // Re-import to read captured state. ESM module cache means we can
    // access the same instance via the registry.
    const entry = runtime.get('hooky');
    const mod = entry._module;
    const api = mod._captured();
    assert.ok(api);
    assert.deepEqual(api.permissions, ['fs:read', 'memory:write']);
    assert.equal(typeof api.log, 'function');
    assert.equal(typeof api.emit, 'function');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
