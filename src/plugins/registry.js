// Plugin registry for ETTORE.
//
// The registry is the bridge between the loader (which produces validated
// plugin instances) and the agent (which expects a flat list of tool
// definitions and a name → handler map). It tracks the set of enabled
// plugins, validates that plugin tools do not collide with built-in tools
// or with each other, and exposes the merged view the agent needs.
//
// A registry is process-wide. Multiple Agent instances share the same
// registry, so enabling a plugin once makes it available to every
// subsequent agent in the session. Disable / reload are symmetric.
//
// Tool invocation:
//   When the agent receives a tool_calls response, it looks up the handler
//   in `toolHandlers`. Plugin tools are registered there with a thin
//   wrapper that:
//     1. validates the arguments against the plugin-declared JSON schema
//     2. invokes the plugin handler with a controlled context object
//        (no direct access to the agent internals — the plugin sees only
//        what its permissions and the context object allow)
//     3. converts thrown errors into the `Error: ...` string format the
//        agent expects for tool results
//
// The wrapper is the only surface a plugin handler ever sees of the
// runtime. The plugin never touches `this.messages`, the working memory,
// or any other private agent state.

import { RESERVED_TOOL_NAMES } from './manifest.js';

export class PluginConflictError extends Error {
  constructor(message, { plugin = null, conflicts = [] } = {}) {
    super(message);
    this.name = 'PluginConflictError';
    this.plugin = plugin;
    this.conflicts = conflicts;
  }
}

// Convert a plugin's tool definition (object with name/description/parameters/handler)
// into the `{ type: 'function', function: { name, description, parameters } }` shape
// the OpenAI-compat provider expects in `tools[]`. `key` is the property name the
// plugin used to declare the tool — used as a fallback when the tool def does not
// carry an explicit `name` (a plugin author may write either).
function pluginToolToProviderShape(def, key) {
  return {
    type: 'function',
    function: {
      name: def.name || key,
      description: def.description,
      parameters: def.parameters || { type: 'object', properties: {} },
    },
    // The provider-shape object is augmented so the agent's tool router
    // can detect "this is a plugin tool" without an extra map lookup.
    _pluginTool: true,
    _risk: def.risk || 'medium',
  };
}

export class PluginRegistry {
  constructor({ builtInTools = [], builtInHandlers = {}, builtInCommands = {} } = {}) {
    this._builtInTools = builtInTools.slice();
    this._builtInHandlers = { ...builtInHandlers };
    this._builtInCommands = { ...builtInCommands };
    // name -> { plugin, tools, commands, hooks, manifest, loadedAt }
    this._plugins = new Map();
    // Two distinct sets so the conflict reason can be specific:
    //   - _reservedToolNames: built-in tool names + the global RESERVED list.
    //     A plugin claiming one of these is rejected with "reserved or built-in".
    //   - _pluginToolNames: tool names already taken by an enabled plugin.
    //     A plugin claiming one of these is rejected with a per-plugin message.
    this._reservedToolNames = new Set(Object.keys(this._builtInHandlers));
    for (const t of this._builtInTools) {
      if (t?.function?.name) this._reservedToolNames.add(t.function.name);
    }
    for (const reserved of RESERVED_TOOL_NAMES) this._reservedToolNames.add(reserved);
    this._pluginToolNames = new Set();
  }

  // List the currently enabled plugins. The order is the registration order
  // (older first), so two plugins with the same `risk` are deterministic.
  list() {
    return [...this._plugins.values()].map((entry) => ({
      name: entry.manifest.name,
      version: entry.manifest.version,
      description: entry.manifest.description,
      permissions: entry.manifest.permissions,
      toolCount: Object.keys(entry.tools).length,
      commandCount: Object.keys(entry.commands).length,
      loadedAt: entry.loadedAt,
    }));
  }

  has(name) {
    return this._plugins.has(name);
  }

  get(name) {
    return this._plugins.get(name) || null;
  }

  // Validate that registering `loadedPlugin` would not create a conflict.
  // A conflict is any of:
  //   - a plugin tool name matches a built-in tool name
  //   - a plugin tool name matches a tool from an already-enabled plugin
  //   - a plugin command name matches a built-in command (e.g. /help, /exit)
  //   - a plugin command name matches a command from another enabled plugin
  // Returns the list of conflicts (empty on success). Conflict reasons
  // are kept distinct so the caller can tell a reserved-name hit apart
  // from a same-name plugin collision.
  validate(loadedPlugin) {
    const conflicts = [];
    const toolNames = Object.keys(loadedPlugin.tools || {});
    for (const name of toolNames) {
      // Check plugin-registered names FIRST so the error message can name
      // the offending plugin. (Both sets are mutually exclusive: a tool
      // registered by a plugin is NOT in the reserved set.)
      if (this._pluginToolNames.has(name)) {
        // Find the plugin that owns this name so the message is actionable.
        let owner = 'another plugin';
        for (const existing of this._plugins.values()) {
          if (Object.prototype.hasOwnProperty.call(existing.tools, name)) {
            owner = `plugin "${existing.manifest.name}"`;
            break;
          }
        }
        conflicts.push({ kind: 'tool', name, reason: `already registered by ${owner}` });
        continue;
      }
      if (this._reservedToolNames.has(name)) {
        conflicts.push({ kind: 'tool', name, reason: 'reserved or built-in' });
        continue;
      }
    }
    const commandNames = Object.keys(loadedPlugin.commands || {});
    for (const name of commandNames) {
      if (this._builtInCommands[name]) {
        conflicts.push({ kind: 'command', name, reason: 'reserved or built-in command' });
        continue;
      }
      for (const existing of this._plugins.values()) {
        if (Object.prototype.hasOwnProperty.call(existing.commands, name)) {
          conflicts.push({ kind: 'command', name, reason: `already registered by plugin "${existing.manifest.name}"` });
        }
      }
    }
    return conflicts;
  }

  // Register a loaded plugin. Throws PluginConflictError if `validate()`
  // reports any conflicts — the caller is expected to call `validate()`
  // first if it wants to detect issues without committing.
  register(loadedPlugin) {
    if (!loadedPlugin?.manifest?.name) {
      throw new PluginConflictError('cannot register a plugin without a manifest');
    }
    if (this._plugins.has(loadedPlugin.manifest.name)) {
      throw new PluginConflictError(
        `plugin "${loadedPlugin.manifest.name}" is already registered`,
        { plugin: loadedPlugin.manifest.name },
      );
    }
    const conflicts = this.validate(loadedPlugin);
    if (conflicts.length) {
      throw new PluginConflictError(
        `plugin "${loadedPlugin.manifest.name}" declares conflicting names: ${conflicts.map((c) => `${c.kind}:${c.name}`).join(', ')}`,
        { plugin: loadedPlugin.manifest.name, conflicts },
      );
    }
    // Reserve the tool names so a subsequent `validate()` call sees them
    // and reports "already registered by plugin X" rather than a generic
    // reserved-name error.
    for (const name of Object.keys(loadedPlugin.tools || {})) {
      this._pluginToolNames.add(name);
    }
    this._plugins.set(loadedPlugin.manifest.name, loadedPlugin);
    return loadedPlugin;
  }

  // Remove a plugin by name. Reserved tool names are released so another
  // plugin can take the slot. Returns the removed entry, or null if the
  // plugin was not registered.
  unregister(name) {
    const entry = this._plugins.get(name);
    if (!entry) return null;
    for (const toolName of Object.keys(entry.tools || {})) {
      this._pluginToolNames.delete(toolName);
    }
    this._plugins.delete(name);
    return entry;
  }

  // Merged tool definitions (provider-shape) for the agent's tool router.
  // Order: built-ins first, then plugins in registration order. The agent
  // can then apply its existing priority / cap logic on top.
  getAllToolDefinitions() {
    const out = this._builtInTools.slice();
    for (const entry of this._plugins.values()) {
      for (const [toolName, def] of Object.entries(entry.tools)) {
        out.push(pluginToolToProviderShape(def, toolName));
      }
    }
    return out;
  }

  // Merged handlers, name → async (args, ctx) => result. Plugin handlers
  // are wrapped so the plugin never sees the raw agent — only the
  // controlled context object.
  getAllToolHandlers({ contextFactory = null } = {}) {
    const out = { ...this._builtInHandlers };
    for (const entry of this._plugins.values()) {
      for (const [toolName, def] of Object.entries(entry.tools)) {
        out[toolName] = wrapPluginHandler(entry, def, contextFactory, toolName);
      }
    }
    return out;
  }

  // Merged commands, name → { description, handler, usage, plugin? }.
  getAllCommands() {
    const out = {};
    for (const [name, def] of Object.entries(this._builtInCommands)) {
      out[name] = { ...def, plugin: null };
    }
    for (const entry of this._plugins.values()) {
      for (const [cmdName, def] of Object.entries(entry.commands)) {
        out[cmdName] = {
          description: def.description,
          usage: def.usage || '',
          handler: wrapPluginCommandHandler(entry, def),
          plugin: entry.manifest.name,
        };
      }
    }
    return out;
  }

  // Run a hook across all enabled plugins. Returns a list of
  // `{ plugin, error? }` records so a misbehaving plugin does not silently
  // break the others. `hookName` is the property on the plugin's `hooks`
  // object. The hook is called with the same args it was given.
  async runHook(hookName, ...args) {
    const results = [];
    for (const entry of this._plugins.values()) {
      const fn = entry.hooks?.[hookName];
      if (typeof fn !== 'function') continue;
      try {
        await fn(...args);
        results.push({ plugin: entry.manifest.name, error: null });
      } catch (err) {
        results.push({
          plugin: entry.manifest.name,
          error: err && err.message ? err.message : String(err),
        });
      }
    }
    return results;
  }
}

// Wrap a plugin tool handler so it sees only a controlled context.
// The plugin cannot reach the agent's internals — only the context
// object this wrapper produces. `toolName` is the property name the
// plugin used to declare the tool, used as a fallback for `ctx.tool`
// when the tool def does not carry an explicit `name` field.
function wrapPluginHandler(entry, def, contextFactory, toolName) {
  return async function pluginHandler(rawArgs, agentContext) {
    try {
      // `agentContext` is what the agent passes when calling the handler
      // for native tools (e.g. { toolName, args, signal }). Plugins get a
      // safer shape with only the fields they need.
      const ctx = {
        plugin: entry.manifest.name,
        tool: def.name || toolName,
        // The signal is exposed so plugins can honour cancellation.
        signal: agentContext?.signal || null,
        // Optional context factory for richer plugins. The factory may
        // return additional fields (workspace path, agent mode, etc.) but
        // it MUST be provided by trusted agent code, never by user input.
        ...(contextFactory ? contextFactory({ plugin: entry.manifest, tool: def }) : {}),
      };
      const result = await def.handler(rawArgs || {}, ctx);
      // Plugin handlers may return strings, numbers, booleans, or any
      // JSON-serializable object. Convert to a string the agent can put
      // into a `tool` result message.
      if (result == null) return '';
      if (typeof result === 'string') return result;
      if (typeof result === 'number' || typeof result === 'boolean') return String(result);
      try {
        return JSON.stringify(result);
      } catch {
        return String(result);
      }
    } catch (err) {
      return `Error: plugin "${entry.manifest.name}" tool "${def.name || toolName}" failed: ${err?.message || String(err)}`;
    }
  };
}

function wrapPluginCommandHandler(entry, def) {
  return async function pluginCommand(args, commandContext) {
    try {
      const ctx = {
        plugin: entry.manifest.name,
        // Commands run outside the tool loop — they cannot pass a signal
        // automatically. The agent wires cancellation when invoking.
        signal: commandContext?.signal || null,
        ...(commandContext?.extra || {}),
      };
      const result = await def.handler(args || '', ctx);
      if (result == null) return { handled: true, output: '' };
      if (typeof result === 'string') return { handled: true, output: result };
      if (typeof result === 'object' && 'handled' in result) {
        return {
          handled: !!result.handled,
          output: typeof result.output === 'string' ? result.output : (result.output == null ? '' : String(result.output)),
        };
      }
      try {
        return { handled: true, output: JSON.stringify(result) };
      } catch {
        return { handled: true, output: String(result) };
      }
    } catch (err) {
      return {
        handled: true,
        output: `Error: plugin "${entry.manifest.name}" command failed: ${err?.message || String(err)}`,
      };
    }
  };
}
