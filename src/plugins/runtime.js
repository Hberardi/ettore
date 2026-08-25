// Plugin runtime for ETTORE.
//
// The runtime wires the loader (disk → memory) and the registry (memory →
// agent-visible tools and commands). It is the only object the agent needs
// to talk to for plugin operations: `runtime.enable(name)`,
// `runtime.disable(name)`, `runtime.reload(name)`, `runtime.list()`.
//
// Lifecycle:
//   enable(name):
//     1. resolve the plugin directory under the plugins root
//     2. read and validate the manifest
//     3. import the entry-point module
//     4. validate the module exports
//     5. validate that the plugin's tools/commands do not collide with
//        already-registered names
//     6. call the plugin's onLoad hook with a controlled api object
//     7. register the plugin in the registry
//     8. mark the plugin as enabled on disk (`.enabled` marker)
//
//   disable(name):
//     1. call onUnload hook (best-effort; errors are swallowed)
//     2. unregister from the registry
//     3. remove the `.enabled` marker from disk
//
//   reload(name):
//     disable then enable, in that order. State from the previous instance
//     is dropped — the new instance starts fresh.
//
// Persistence:
//   The set of enabled plugins is stored on disk as `<pluginDir>/.enabled`.
//   No central registry file is maintained: the disk is the source of truth,
//   so two Ettore processes pointing at the same plugins directory see the
//   same enabled set without coordination.

import {
  loadAllPlugins,
  readManifest,
  importPlugin,
  markEnabledOnDisk,
  markDisabledOnDisk,
  discoverPlugins,
  PluginLoadError,
} from './loader.js';
import { ManifestError } from './manifest.js';
import { PluginConflictError } from './registry.js';

export class PluginRuntime {
  constructor({ registry, pluginsDir = null } = {}) {
    if (!registry) throw new Error('PluginRuntime requires a registry');
    this._registry = registry;
    this._pluginsDir = pluginsDir;
  }

  // Load every plugin whose on-disk `.enabled` marker exists. Called at
  // agent start. Failures are collected, not thrown — the agent must keep
  // starting even if one plugin is broken.
  async boot() {
    const results = await loadAllPlugins({ onlyEnabled: true, pluginsDir: this._pluginsDir });
    const report = { enabled: [], failed: [] };
    for (const entry of results) {
      if (!entry.plugin) {
        // Either not enabled (skipped) or failed to load. Only the failed
        // ones are reported back; the rest are ignored.
        if (entry.error) report.failed.push({ name: entry.name, error: entry.error });
        continue;
      }
      try {
        // Re-run registry validation in case another process enabled a
        // plugin with a colliding name between boot and now.
        this._registry.register(entry.plugin);
        await this._callOnLoadSafely(entry.plugin);
        report.enabled.push(entry.plugin.manifest.name);
      } catch (err) {
        report.failed.push({
          name: entry.name,
          error: err?.message || String(err),
        });
      }
    }
    return report;
  }

  list() {
    return this._registry.list();
  }

  get(name) {
    return this._registry.get(name);
  }

  has(name) {
    return this._registry.has(name);
  }

  // Enable a plugin by name. The name MUST match a directory under the
  // plugins root. Returns the loaded manifest on success.
  async enable(name) {
    if (!name || typeof name !== 'string') {
      throw new PluginLoadError('plugin name is required', { plugin: name });
    }
    if (this._registry.has(name)) {
      return this._registry.get(name).manifest;
    }

    // Locate the plugin directory.
    const candidates = await discoverPlugins(this._pluginsDir);
    const candidate = candidates.find((c) => c.name === name);
    if (!candidate) {
      throw new PluginLoadError(`plugin not found: ${name}`, { plugin: name });
    }

    // Load + register.
    const manifest = await readManifest(candidate.dir);
    const { mod, validated } = await importPlugin(manifest);
    const loadedPlugin = {
      manifest,
      ...validated,
      // The raw module is kept so the runtime (and tests) can call hooks
      // / handlers later, and so the plugin retains access to its own
      // module-scoped state (counters, cached config, etc.). It is NEVER
      // serialized to disk or sent over the wire.
      _module: mod,
      loadedAt: new Date().toISOString(),
    };
    this._registry.register(loadedPlugin);

    try {
      await this._callOnLoadSafely(loadedPlugin);
    } catch (err) {
      // onLoad failure: unregister so the agent does not see partial state.
      this._registry.unregister(name);
      throw err;
    }

    // Persist the enabled state. Best-effort: if the disk write fails, the
    // plugin is still registered for the current session, but the user
    // will be told that persistence failed.
    let persisted = false;
    try {
      persisted = await markEnabledOnDisk(candidate.dir);
    } catch (err) {
      // Swallow — the in-memory state is what matters for this session.
    }
    return { manifest, persistedOnDisk: persisted };
  }

  async disable(name) {
    if (!name || typeof name !== 'string') {
      throw new PluginLoadError('plugin name is required', { plugin: name });
    }
    const entry = this._registry.get(name);
    if (!entry) {
      return { removed: false, reason: 'not_enabled' };
    }
    // Best-effort onUnload; errors are recorded but do not block unregister.
    let onUnloadError = null;
    const fn = entry.hooks?.onUnload;
    if (typeof fn === 'function') {
      try { await fn(); } catch (err) { onUnloadError = err?.message || String(err); }
    }
    this._registry.unregister(name);
    // Best-effort disk cleanup. If the marker is already gone, that is fine.
    try { await markDisabledOnDisk(entry.manifest.root); } catch {}
    return { removed: true, onUnloadError };
  }

  async reload(name) {
    if (!this._registry.has(name)) {
      // Not enabled — just try to enable. `enable` throws if the plugin
      // does not exist on disk; that is the right behavior here.
      return this.enable(name);
    }
    await this.disable(name);
    return this.enable(name);
  }

  // Construct the api object passed to a plugin's onLoad hook. The api
  // is intentionally small: anything the plugin could misuse is omitted,
  // and anything the plugin genuinely needs is documented.
  //
  // The api is built per-plugin because some fields (signal, log channel)
  // may vary across invocations, and the plugin is allowed to keep a
  // reference to the api for later use (e.g. in tool handlers).
  _buildPluginApi(loadedPlugin, { emitter = null, workspaceRoot = null } = {}) {
    const manifest = loadedPlugin.manifest;
    return {
      manifest,
      // The plugin's declared permissions. Use this to gate logic in
      // the plugin: `if (api.permissions.includes('fs:write')) { ... }`.
      permissions: manifest.permissions.slice(),
      // Workspace root (read-only). The plugin may inspect this to know
      // where it is running, but it must use the per-tool context to
      // access files (which honors workspace-policy).
      workspaceRoot,
      // Emit an event on the agent bus. The emitter may be null in
      // non-interactive contexts (tests, one-shot mode).
      emit: (event, data) => {
        if (!emitter || typeof emitter.emit !== 'function') return;
        try { emitter.emit(`plugin:${manifest.name}:${event}`, data); } catch {}
      },
      // Log a message. The runtime tags it with the plugin name so a
      // log filter can scope output to a single plugin.
      log: (level, message) => {
        const lvl = ['debug', 'info', 'warn', 'error'].includes(String(level)) ? String(level) : 'info';
        const tag = `[plugin:${manifest.name}]`;
        if (lvl === 'error') console.error(tag, message);
        else if (lvl === 'warn') console.warn(tag, message);
        else console.log(tag, message);
      },
      // Read a project-memory entry (if the plugin was granted
      // memory:read). Returns null on miss or when the permission is
      // missing — the plugin must handle the null case.
      readMemory: async (key) => {
        if (!manifest.permissions.includes('memory:read')) return null;
        try {
          const { readMemoryEntry } = await import('../memory/index.js');
          return await readMemoryEntry(key);
        } catch {
          return null;
        }
      },
    };
  }

  async _callOnLoadSafely(loadedPlugin) {
    const fn = loadedPlugin.hooks?.onLoad;
    if (typeof fn !== 'function') return;
    const api = this._buildPluginApi(loadedPlugin);
    await fn(api);
  }
}

export { PluginLoadError, ManifestError, PluginConflictError };
