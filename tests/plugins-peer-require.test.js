// Tests for optional-dependency resolution in plugins.
//
// The defect these cover: a bundled plugin declares its optional dependency in
// ETTORE's package.json and used to load it with
// `createRequire(import.meta.url)`. That resolves correctly while the plugin
// sits in examples/plugins/ — which is the only place the tests ever ran it —
// and fails once installed to ~/.config/ettore/plugins/, where resolution
// walks up through the user's home directory instead. Two plugins spent that
// whole time reporting a dependency as "not installed" while it was installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeRequirePeer, CLI_ROOT } from '../src/plugins/peer-require.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import { PluginRuntime } from '../src/plugins/runtime.js';

// A directory shaped like an installed plugin: outside the checkout, with
// nothing resolvable above it.
function fakeInstalledPlugin() {
  return mkdtempSync(join(tmpdir(), 'ettore-plugin-'));
}

// Drop a working module into a plugin's own node_modules.
function plantModule(root, name, body) {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), body);
  return dir;
}

test("an installed plugin reaches ETTORE's own dependencies", () => {
  const root = fakeInstalledPlugin();
  try {
    // `chalk` is a runtime dependency of ETTORE and lives nowhere near a
    // plugin installed under the user's config directory.
    const requirePeer = makeRequirePeer(root);
    assert.ok(requirePeer.resolve('chalk').startsWith(CLI_ROOT), 'resolved out of the CLI install');
    assert.ok(requirePeer('chalk'), 'and actually loads');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the old approach is what fails — this is the regression being guarded', async () => {
  const root = fakeInstalledPlugin();
  try {
    const { createRequire } = await import('node:module');
    const naive = createRequire(join(root, 'index.js'));
    assert.throws(() => naive.resolve('chalk'), /Cannot find module/,
      'resolving from the installed location cannot see the CLI: that was the bug');
    // And the fix, on the very same directory.
    assert.ok(makeRequirePeer(root).resolve('chalk'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plugin's own copy wins over ETTORE's", () => {
  const root = fakeInstalledPlugin();
  try {
    plantModule(root, 'chalk', 'module.exports = { mine: true };');
    const loaded = makeRequirePeer(root)('chalk');
    assert.equal(loaded.mine, true, 'the plugin decides which copy it uses');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing dependency is tagged, and says where to install it', () => {
  const root = fakeInstalledPlugin();
  try {
    const requirePeer = makeRequirePeer(root);
    let caught;
    try { requirePeer('non-esiste-affatto'); } catch (err) { caught = err; }
    assert.ok(caught, 'it throws');
    assert.equal(caught.code, 'PEER_NOT_INSTALLED', 'tagged, so a plugin can keep its own advice');
    assert.equal(caught.dependency, 'non-esiste-affatto');
    assert.match(caught.message, new RegExp(CLI_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.throws(() => requirePeer.resolve('non-esiste-affatto'), { code: 'PEER_NOT_INSTALLED' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dependency that is present but broken is not reported as missing', () => {
  const root = fakeInstalledPlugin();
  try {
    plantModule(root, 'rotto', 'throw new Error("esplodo al caricamento");');
    let caught;
    try { makeRequirePeer(root)('rotto'); } catch (err) { caught = err; }
    // The two failures need opposite handling: "install it" is useless advice
    // for a module that is installed and throwing.
    assert.match(caught.message, /esplodo al caricamento/);
    assert.notEqual(caught.code, 'PEER_NOT_INSTALLED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dependency of a dependency going missing is not blamed on the plugin', () => {
  const root = fakeInstalledPlugin();
  try {
    plantModule(root, 'incompleto', "module.exports = require('un-modulo-che-manca');");
    let caught;
    try { makeRequirePeer(root)('incompleto'); } catch (err) { caught = err; }
    assert.equal(caught.code, 'MODULE_NOT_FOUND');
    assert.notEqual(caught.code, 'PEER_NOT_INSTALLED');
    assert.match(caught.message, /un-modulo-che-manca/, 'names the module actually missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the resolver reaches the plugin through both surfaces ─────────────────

function fakeLoadedPlugin(root, { onLoad = null, tools = {} } = {}) {
  return {
    manifest: {
      name: 'finto', version: '1.0.0', apiVersion: '1', main: 'index.js',
      description: '', author: '', license: '', permissions: [], root,
    },
    tools,
    commands: {},
    hooks: { onLoad, onUnload: null, onBeforeTool: null, onAfterTool: null },
  };
}

test('onLoad receives a resolver bound to the plugin directory', async () => {
  const root = fakeInstalledPlugin();
  try {
    let seen = null;
    const plugin = fakeLoadedPlugin(root, { onLoad: (api) => { seen = api; } });
    const runtime = new PluginRuntime({ registry: new PluginRegistry() });
    await runtime._callOnLoadSafely(plugin);

    assert.equal(typeof seen.requirePeer, 'function');
    assert.ok(seen.requirePeer.resolve('chalk'), 'and it can see ETTORE dependencies');
    assert.deepEqual(seen.requirePeer.roots, [root, CLI_ROOT], 'plugin first, CLI second');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tool handler gets the same resolver in its context', async () => {
  const root = fakeInstalledPlugin();
  try {
    let ctxSeen = null;
    const registry = new PluginRegistry();
    registry.register(fakeLoadedPlugin(root, {
      tools: {
        prova: {
          description: 'restituisce cosa vede nel contesto',
          parameters: { type: 'object', properties: {} },
          handler: async (_args, ctx) => { ctxSeen = ctx; return 'ok'; },
        },
      },
    }));

    const handlers = registry.getAllToolHandlers();
    await handlers.prova({}, {});
    assert.equal(typeof ctxSeen.requirePeer, 'function');
    assert.ok(ctxSeen.requirePeer.resolve('chalk'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the bundled plugins no longer resolve from their own file location', () => {
  // The three that declare optional dependencies. Reading the source is the
  // point here: `createRequire(import.meta.url)` used on its own is precisely
  // the pattern that breaks after installation.
  for (const name of ['excel-full', 'pgadmin', 'edi-ftp']) {
    const src = readFileSync(join(CLI_ROOT, 'examples', 'plugins', name, 'index.js'), 'utf-8');
    assert.match(src, /api\.requirePeer/, `${name} must capture the runtime resolver`);
    assert.doesNotMatch(src, /const requirePeer = createRequire/, `${name} must not resolve only from its own path`);
  }
});
