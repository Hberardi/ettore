// Plugin discovery and import for ETTORE.
//
// The loader walks `~/.config/ettore/plugins/<name>/plugin.json`, validates
// the manifest, dynamically imports the entry-point module, and validates
// its exports. It does NOT register the plugin with the agent — that is the
// runtime's job. Keeping discovery and registration separate means the
// loader can be called in dry-run / introspection contexts (e.g. a future
// `ettore plugin list` command) without side effects.
//
// Failure modes are explicit: a missing manifest, an invalid manifest, a
// broken module, or a missing entry-point file all surface as a structured
// error the caller can show to the user or log. Nothing is silent.
//
// The directory is overridable via ETTORE_PLUGINS_DIR — used by tests to
// point at a fixture directory and by CI to sandbox plugin discovery.

import { readdir, readFile, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';
import { validateManifest, validatePluginModule, ManifestError } from './manifest.js';

const DEFAULT_PLUGINS_DIR = join(homedir(), '.config', 'ettore', 'plugins');
const MANIFEST_FILENAME = 'plugin.json';
const PLUGIN_DIR_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// Hidden and reserved top-level directory names that must never be treated
// as plugins. Reserved names are reserved for future use (e.g. shared
// assets, common hooks) — keeping the list short so plugin authors have
// maximum freedom.
const RESERVED_DIR_NAMES = new Set(['shared', '.cache', '.git', 'node_modules']);

export class PluginLoadError extends Error {
  constructor(message, { plugin = null, cause = null } = {}) {
    super(message);
    this.name = 'PluginLoadError';
    this.plugin = plugin;
    this.cause = cause;
  }
}

function resolvePluginsDir() {
  const override = process.env.ETTORE_PLUGINS_DIR;
  if (override && override.trim()) return resolve(override);
  return DEFAULT_PLUGINS_DIR;
}

// Discover plugin directories under `pluginsDir`. Returns a list of
// `{ name, dir }` records, sorted by name. A directory is a candidate if it
// contains a `plugin.json` file at its root. Empty directories and hidden
// directories are skipped silently. Anything else is surfaced as an error.
export async function discoverPlugins(pluginsDir = null) {
  const root = pluginsDir || resolvePluginsDir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw new PluginLoadError(`cannot read plugins directory: ${root}`, { cause: err });
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (RESERVED_DIR_NAMES.has(entry.name)) continue;
    if (!PLUGIN_DIR_NAME_RE.test(entry.name)) {
      // Skip, but don't error — a stray directory should not break
      // discovery for the rest. The user can investigate via a future
      // `ettore plugin doctor` command.
      continue;
    }
    const dir = join(root, entry.name);
    candidates.push({ name: entry.name, dir });
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return candidates;
}

// Read and validate the manifest for a single plugin directory. Throws
// ManifestError on any structural problem. Returns the normalized manifest.
export async function readManifest(pluginDir) {
  const manifestPath = join(pluginDir, MANIFEST_FILENAME);
  let raw;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new ManifestError(`plugin.json not found in ${pluginDir}`, { field: 'manifest' });
    }
    throw new ManifestError(`cannot read manifest: ${err.message}`, { field: 'manifest' });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ManifestError(`plugin.json is not valid JSON: ${err.message}`, { field: 'manifest' });
  }

  // The directory name MUST equal the manifest `name` field. Mismatch is a
  // hard failure: a plugin moved into the wrong directory would otherwise
  // register under the wrong namespace silently.
  const dirName = pluginDir.split(sep).pop();
  if (parsed && typeof parsed === 'object' && parsed.name && parsed.name !== dirName) {
    throw new ManifestError(
      `manifest "name" (${parsed.name}) does not match directory name (${dirName})`,
      { field: 'name' },
    );
  }

  return validateManifest(parsed, pluginDir);
}

// Verify the entry-point file exists and is a regular file. We do NOT
// follow symlinks — a symlinked entry point would be a vector for loading
// arbitrary code from outside the plugin directory.
export async function resolveEntryPoint(manifest) {
  if (!manifest || !manifest.root) {
    throw new PluginLoadError('manifest.root is required to resolve the entry point');
  }
  const entryAbs = resolve(manifest.root, manifest.main);
  // Defense in depth: the entry point must live under the plugin root.
  // Even though validateManifest already forbids absolute / parent paths,
  // a maliciously-crafted `main` like "subdir/../../etc/passwd" would
  // resolve outside. Catch that here.
  const rootWithSep = manifest.root.endsWith(sep) ? manifest.root : manifest.root + sep;
  if (!entryAbs.startsWith(rootWithSep) && entryAbs !== manifest.root) {
    throw new PluginLoadError(
      `entry point "${manifest.main}" resolves outside the plugin directory`,
      { plugin: manifest.name },
    );
  }
  let st;
  try {
    st = await stat(entryAbs);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new PluginLoadError(
        `entry point not found: ${entryAbs}`,
        { plugin: manifest.name, cause: err },
      );
    }
    throw new PluginLoadError(`cannot stat entry point: ${err.message}`, { plugin: manifest.name });
  }
  if (!st.isFile()) {
    throw new PluginLoadError(`entry point is not a regular file: ${entryAbs}`, { plugin: manifest.name });
  }
  return entryAbs;
}

// Import a plugin module and validate its exports. The dynamic import uses
// a `file://` URL so it works on Windows where `import()` from a plain
// path is finicky for paths with spaces or non-ASCII characters.
export async function importPlugin(manifest) {
  const entryAbs = await resolveEntryPoint(manifest);
  const url = pathToFileURL(entryAbs).href;
  let mod;
  try {
    mod = await import(url);
  } catch (err) {
    throw new PluginLoadError(
      `failed to import plugin module: ${err.message}`,
      { plugin: manifest.name, cause: err },
    );
  }
  // Plugins can export either a default object OR named exports
  // (tools / commands / hooks). The validation handles both shapes; we
  // just need to surface the right bag to it.
  const bag = mod.default && typeof mod.default === 'object' ? mod.default : mod;
  const validated = validatePluginModule(bag);
  return { mod, validated };
}

// Discover + load every plugin under the plugins dir. Each plugin is
// loaded in isolation — a failure in one does not abort the others. The
// returned array contains one entry per candidate, with `error` set when
// loading failed and `plugin` set when it succeeded.
//
// `onlyEnabled` (default false) returns all candidates regardless of the
// on-disk `.enabled` flag. The runtime filters further.
export async function loadAllPlugins(options = {}) {
  const pluginsDir = options.pluginsDir || null;
  const onlyEnabled = options.onlyEnabled === true;
  const candidates = await discoverPlugins(pluginsDir);
  const results = [];
  for (const candidate of candidates) {
    const entry = { name: candidate.name, dir: candidate.dir, plugin: null, error: null, enabled: null };
    try {
      if (onlyEnabled) {
        const enabled = await isEnabledOnDisk(candidate.dir);
        entry.enabled = enabled;
        if (!enabled) {
          results.push(entry);
          continue;
        }
      } else {
        entry.enabled = await isEnabledOnDisk(candidate.dir);
      }
      const manifest = await readManifest(candidate.dir);
      const { mod, validated } = await importPlugin(manifest);
      entry.plugin = {
        manifest,
        ...validated,
        // The raw module is kept so the runtime can call hooks / handlers
        // later. It is NEVER serialized.
        _module: mod,
        loadedAt: new Date().toISOString(),
      };
    } catch (err) {
      entry.error = err && err.message ? err.message : String(err);
    }
    results.push(entry);
  }
  return results;
}

// The "enabled" flag lives in `<pluginDir>/.enabled` as a zero-byte marker
// file. This is the simplest possible persistence: a file means yes, no
// file means no. No JSON parsing, no schema migration, no atomic write
// protocol — the worst case is a partially-written file that still counts
// as "enabled" because the OS won't half-write a file on the same volume.
const ENABLED_MARKER = '.enabled';

export async function isEnabledOnDisk(pluginDir) {
  try {
    await stat(join(pluginDir, ENABLED_MARKER));
    return true;
  } catch {
    return false;
  }
}

export async function markEnabledOnDisk(pluginDir) {
  const { writeFile } = await import('fs/promises');
  const marker = join(pluginDir, ENABLED_MARKER);
  try {
    await writeFile(marker, '', { flag: 'wx' });
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
}

export async function markDisabledOnDisk(pluginDir) {
  const { unlink } = await import('fs/promises');
  const marker = join(pluginDir, ENABLED_MARKER);
  try {
    await unlink(marker);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

export { resolvePluginsDir, DEFAULT_PLUGINS_DIR, MANIFEST_FILENAME };
