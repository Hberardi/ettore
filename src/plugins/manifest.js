// Plugin manifest schema and validation for ETTORE.
//
// A plugin lives in `~/.config/ettore/plugins/<name>/` with two required
// files: `plugin.json` (this manifest) and the entry-point module
// referenced by `main` (default `index.js`). The manifest declares the
// metadata the loader needs to validate, register, and surface the plugin;
// the module exports the actual tool/command/hook implementations.
//
// Design notes:
//   - The manifest is intentionally small. Tool schemas and command
//     descriptions live in the module (so a plugin author can co-locate
//     implementation with metadata) — the manifest only carries what the
//     loader MUST know before importing the module.
//   - Validation is strict by default. A bad version, a duplicate name, or
//     a missing main file is a hard failure at load time, not a soft warning.
//     Plugins that load partially produce surprising behavior downstream.
//   - Permissions are declared up front so the user can grant (or deny)
//     them as a single action at enable time, not get prompted per tool.

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const KEBAB_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SUPPORTED_API_VERSIONS = new Set(['1']);

// Reserved tool names. Plugins may NOT register a tool with one of these —
// the names are owned by the core runtime and overriding them would either
// break safety guarantees (bash, write) or be confusing in the UI
// (todo_write drives the progress panel and must be in control of the agent
// loop, not a plugin).
const RESERVED_TOOL_NAMES = new Set([
  'bash',
  'bash_session',
  'write',
  'edit',
  'read',
  'read_pdf',
  'read_doc',
  'todo_write',
  'ask_user',
  'memory_write',
  'apply_patch_structured',
  'glob',
  'grep',
  'list_dir',
  'file_info',
  'git_status',
  'git_diff',
  'websearch',
  'webfetch',
  'dev_server',
  'browser_check',
  'browser_app',
  'desktop_app',
  'repo_map',
  'repo_find_symbol',
  'dep_inspect',
  'run_tests',
  'run_checks',
  'web_image',
  'video_describe',
  'video_transcript',
  'audio_read',
  'music_video',
]);

const KNOWN_PERMISSIONS = new Set([
  'fs:read',
  'fs:write',
  'network:http',
  'network:https',
  'shell:exec',
  'memory:read',
  'memory:write',
  'agent:tools', // may call other tools
  'agent:emit',  // may emit events on the agent emitter
]);

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_VERSION_LENGTH = 32;
export const MAX_PERMISSIONS = 16;
export const MAX_MAIN_PATH_LENGTH = 256;

export class ManifestError extends Error {
  constructor(message, { field = null, code = 'manifest_invalid' } = {}) {
    super(message);
    this.name = 'ManifestError';
    this.field = field;
    this.code = code;
  }
}

// Validate a manifest object. Throws ManifestError on the first failure.
// `pluginRoot` is the absolute directory the manifest was read from — used
// to format path-related error messages and to allow relative `main` paths.
export function validateManifest(manifest, pluginRoot = null) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ManifestError('manifest must be a JSON object', { field: 'root' });
  }

  // name
  if (typeof manifest.name !== 'string' || !manifest.name) {
    throw new ManifestError('"name" is required and must be a non-empty string', { field: 'name' });
  }
  if (manifest.name.length > MAX_NAME_LENGTH) {
    throw new ManifestError(`"name" must be at most ${MAX_NAME_LENGTH} characters`, { field: 'name' });
  }
  if (!KEBAB_RE.test(manifest.name)) {
    throw new ManifestError(
      '"name" must be kebab-case (lowercase letters, digits, and single hyphens, starting with a letter)',
      { field: 'name' },
    );
  }

  // version
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) {
    throw new ManifestError(
      '"version" is required and must be a valid semver string (e.g. "1.0.0" or "2.1.3-beta.1")',
      { field: 'version' },
    );
  }
  if (manifest.version.length > MAX_VERSION_LENGTH) {
    throw new ManifestError(`"version" must be at most ${MAX_VERSION_LENGTH} characters`, { field: 'version' });
  }

  // apiVersion
  if (typeof manifest.apiVersion !== 'string') {
    throw new ManifestError('"apiVersion" is required and must be a string', { field: 'apiVersion' });
  }
  if (!SUPPORTED_API_VERSIONS.has(manifest.apiVersion)) {
    throw new ManifestError(
      `"apiVersion" must be one of: ${[...SUPPORTED_API_VERSIONS].join(', ')}`,
      { field: 'apiVersion' },
    );
  }

  // main
  if (typeof manifest.main !== 'string' || !manifest.main) {
    throw new ManifestError('"main" is required and must be a non-empty string', { field: 'main' });
  }
  if (manifest.main.length > MAX_MAIN_PATH_LENGTH) {
    throw new ManifestError(`"main" must be at most ${MAX_MAIN_PATH_LENGTH} characters`, { field: 'main' });
  }
  if (manifest.main.includes('\0')) {
    throw new ManifestError('"main" must not contain null bytes', { field: 'main' });
  }
  // Reject four dangerous shapes:
  //   - absolute POSIX path (`/abs/path.js`)
  //   - absolute Windows path (`C:\evil.js`)
  //   - leading-dot relative path (`../x.js`, `./x.js`)
  //   - parent-segment anywhere (`subdir/../../x.js`)
  // The first three are obvious attempts to escape; the last is sneakier and
  // catches a path that LOOKS relative but resolves outside the plugin dir.
  if (
    /^[\/\\]/.test(manifest.main)
    || /^\.+\//.test(manifest.main)
    || /\.\.\//.test(manifest.main)
    || /^[A-Za-z]:[\\/]/.test(manifest.main)
  ) {
    throw new ManifestError('"main" must be a relative path inside the plugin directory', { field: 'main' });
  }

  // description (optional)
  if (manifest.description != null) {
    if (typeof manifest.description !== 'string') {
      throw new ManifestError('"description" must be a string when present', { field: 'description' });
    }
    if (manifest.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new ManifestError(`"description" must be at most ${MAX_DESCRIPTION_LENGTH} characters`, { field: 'description' });
    }
  }

  // author (optional)
  if (manifest.author != null && typeof manifest.author !== 'string') {
    throw new ManifestError('"author" must be a string when present', { field: 'author' });
  }

  // license (optional)
  if (manifest.license != null && typeof manifest.license !== 'string') {
    throw new ManifestError('"license" must be a string when present', { field: 'license' });
  }

  // permissions (optional, array of strings from KNOWN_PERMISSIONS)
  if (manifest.permissions != null) {
    if (!Array.isArray(manifest.permissions)) {
      throw new ManifestError('"permissions" must be an array when present', { field: 'permissions' });
    }
    if (manifest.permissions.length > MAX_PERMISSIONS) {
      throw new ManifestError(`"permissions" may not exceed ${MAX_PERMISSIONS} entries`, { field: 'permissions' });
    }
    for (const [i, perm] of manifest.permissions.entries()) {
      if (typeof perm !== 'string') {
        throw new ManifestError(`"permissions[${i}]" must be a string`, { field: `permissions[${i}]` });
      }
      if (!KNOWN_PERMISSIONS.has(perm)) {
        throw new ManifestError(
          `"permissions[${i}]" is not a known permission. Known: ${[...KNOWN_PERMISSIONS].join(', ')}`,
          { field: `permissions[${i}]` },
        );
      }
    }
    // No duplicates.
    const seen = new Set();
    for (const perm of manifest.permissions) {
      if (seen.has(perm)) {
        throw new ManifestError(`"permissions" contains a duplicate: "${perm}"`, { field: 'permissions' });
      }
      seen.add(perm);
    }
  }

  return {
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    main: manifest.main,
    description: manifest.description || '',
    author: manifest.author || '',
    license: manifest.license || '',
    permissions: manifest.permissions || [],
    // The path to the plugin root is filled in by the loader so the
    // runtime can resolve the entry-point relative to it.
    root: pluginRoot,
  };
}

// Validate a plugin module's exports. Returns a normalized description of
// the tools, commands, and hooks the module provides. The shapes are
// deliberately permissive on input and normalized on output so plugins can
// be written with the minimum boilerplate.
export function validatePluginModule(mod) {
  if (mod == null || typeof mod !== 'object') {
    throw new ManifestError('plugin module must export an object (default export or named exports)');
  }

  // Tools
  const tools = mod.tools || {};
  if (typeof tools !== 'object' || Array.isArray(tools)) {
    throw new ManifestError('"tools" must be an object: { [toolName]: { name, description, parameters, handler } }');
  }
  const normalizedTools = {};
  for (const [toolName, def] of Object.entries(tools)) {
    normalizedTools[toolName] = validateToolDefinition(toolName, def);
  }

  // Commands
  const commands = mod.commands || {};
  if (typeof commands !== 'object' || Array.isArray(commands)) {
    throw new ManifestError('"commands" must be an object: { [commandName]: { description, handler } }');
  }
  const normalizedCommands = {};
  for (const [cmdName, def] of Object.entries(commands)) {
    normalizedCommands[cmdName] = validateCommandDefinition(cmdName, def);
  }

  // Hooks
  const hooks = mod.hooks || {};
  if (typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new ManifestError('"hooks" must be an object: { onLoad?, onUnload?, onBeforeTool? }');
  }
  if (hooks.onLoad != null && typeof hooks.onLoad !== 'function') {
    throw new ManifestError('"hooks.onLoad" must be a function when present');
  }
  if (hooks.onUnload != null && typeof hooks.onUnload !== 'function') {
    throw new ManifestError('"hooks.onUnload" must be a function when present');
  }
  if (hooks.onBeforeTool != null && typeof hooks.onBeforeTool !== 'function') {
    throw new ManifestError('"hooks.onBeforeTool" must be a function when present');
  }
  if (hooks.onAfterTool != null && typeof hooks.onAfterTool !== 'function') {
    throw new ManifestError('"hooks.onAfterTool" must be a function when present');
  }

  return {
    tools: normalizedTools,
    commands: normalizedCommands,
    hooks: {
      onLoad: hooks.onLoad || null,
      onUnload: hooks.onUnload || null,
      onBeforeTool: hooks.onBeforeTool || null,
      onAfterTool: hooks.onAfterTool || null,
    },
  };
}

function validateToolDefinition(toolName, def) {
  if (def == null || typeof def !== 'object' || Array.isArray(def)) {
    throw new ManifestError(`tool "${toolName}" must be an object with { name, description, parameters, handler }`);
  }
  if (def.name != null && typeof def.name !== 'string') {
    throw new ManifestError(`tool "${toolName}".name must be a string when present`);
  }
  if (typeof def.description !== 'string' || !def.description) {
    throw new ManifestError(`tool "${toolName}".description is required and must be a non-empty string`);
  }
  if (def.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ManifestError(`tool "${toolName}".description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (def.parameters != null) {
    if (typeof def.parameters !== 'object' || Array.isArray(def.parameters)) {
      throw new ManifestError(`tool "${toolName}".parameters must be a JSON Schema object when present`);
    }
  }
  if (typeof def.handler !== 'function') {
    throw new ManifestError(`tool "${toolName}".handler is required and must be a function`);
  }
  return {
    name: def.name || toolName,
    description: def.description,
    parameters: def.parameters || { type: 'object', properties: {} },
    handler: def.handler,
    risk: ['low', 'medium', 'high'].includes(def.risk) ? def.risk : 'medium',
  };
}

function validateCommandDefinition(cmdName, def) {
  if (def == null || typeof def !== 'object' || Array.isArray(def)) {
    throw new ManifestError(`command "${cmdName}" must be an object with { description, handler }`);
  }
  if (typeof def.description !== 'string' || !def.description) {
    throw new ManifestError(`command "${cmdName}".description is required and must be a non-empty string`);
  }
  if (def.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ManifestError(`command "${cmdName}".description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (typeof def.handler !== 'function') {
    throw new ManifestError(`command "${cmdName}".handler is required and must be a function`);
  }
  return {
    name: def.name || cmdName,
    description: def.description,
    usage: typeof def.usage === 'string' ? def.usage.slice(0, 200) : '',
    handler: def.handler,
  };
}

export { RESERVED_TOOL_NAMES, KNOWN_PERMISSIONS, SUPPORTED_API_VERSIONS };
