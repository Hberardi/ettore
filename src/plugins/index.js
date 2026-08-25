// Public entry point for the ETTORE plugin system.
//
// The plugin system is split into four small files:
//   - manifest.js: schema validation for plugin.json and module exports
//   - loader.js:   disk discovery and dynamic import
//   - registry.js: in-memory tool/command/hook merging with conflict checks
//   - runtime.js:  lifecycle (enable / disable / reload / boot) and the
//                  api object passed to onLoad hooks
//
// This index re-exports the public surface. The agent code only needs to
// import from here — the file-level split is an implementation detail.

export { PluginRegistry, PluginConflictError } from './registry.js';
export { PluginRuntime, PluginLoadError, ManifestError } from './runtime.js';
export {
  ManifestError as ManifestValidationError,
  validateManifest,
  validatePluginModule,
  RESERVED_TOOL_NAMES,
  KNOWN_PERMISSIONS,
  SUPPORTED_API_VERSIONS,
} from './manifest.js';
export {
  discoverPlugins,
  loadAllPlugins,
  isEnabledOnDisk,
  markEnabledOnDisk,
  markDisabledOnDisk,
  resolvePluginsDir,
  DEFAULT_PLUGINS_DIR,
} from './loader.js';
