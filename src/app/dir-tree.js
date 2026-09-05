// Live directory tree for the sidebar.
//
// Keeps a flattened snapshot of the working directory and refreshes it when
// the filesystem underneath changes, so the panel reflects a file being
// created or deleted as it happens rather than at the next prompt.
//
// Three things keep this cheap enough to run beside an agent that is itself
// writing files:
//
//   - the scan never descends into build/vendor directories, and stops at a
//     depth and entry cap, so the cost is bounded no matter what it is pointed
//     at;
//   - watch events for ignored paths are dropped before they can schedule
//     anything, which is what keeps an `npm install` from turning into a
//     rescan storm;
//   - refreshes are debounced and coalesced, so a burst of writes costs one
//     scan rather than one per event.

import { watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

// Directories whose contents are never interesting in a project tree and are
// usually the largest thing on disk.
export const DEFAULT_IGNORE = new Set([
  '.git', '.hg', '.svn',
  'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'coverage', 'target',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache',
  'venv', '.venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.gradle', '.idea', '.vscode', '.terraform',
]);

/**
 * Reads the plain directory and file names out of a .gitignore.
 *
 * Deliberately not a glob engine: only entries that name a path outright
 * (`dist`, `build/`, `/tmp`) are honoured, and anything containing a wildcard,
 * a negation or an inner slash is skipped. A pattern language implemented
 * halfway would hide files the user expects to see, which is worse for a
 * viewing panel than ignoring a few it could have hidden.
 */
export function parseGitignoreNames(text) {
  const names = new Set();
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const bare = line.replace(/\/+$/, '').replace(/^\/+/, '');
    if (!bare || bare.includes('/') || /[*?[\]]/.test(bare)) continue;
    names.add(bare);
  }
  return names;
}

/** True when any path segment is ignored — cheap enough for every watch event. */
export function pathIsIgnored(relPath, ignore) {
  if (!relPath) return false;
  for (const segment of String(relPath).split(/[\\/]/)) {
    if (segment && ignore.has(segment)) return true;
  }
  return false;
}

export class DirectoryTree {
  constructor(root, options = {}) {
    this.root = root;
    this.maxEntries = options.maxEntries ?? 400;
    this.maxDepth = options.maxDepth ?? 4;
    this.debounceMs = options.debounceMs ?? 120;
    // How long a create or delete stays called out after it happens. Long
    // enough to catch the eye while reading, short enough that the panel
    // settles back to a plain tree.
    this.changeNoticeMs = options.changeNoticeMs ?? 5000;
    this.onChange = options.onChange || (() => {});
    this._watchFn = options.watchFn || watch;
    this._now = options.now || (() => Date.now());

    /** @type {{name:string, depth:number, isDir:boolean, path:string, addedAt:number|null}[]} */
    this.entries = [];
    /** Set when the scan hit `maxEntries` and stopped early. */
    this.truncated = false;
    /** Human-readable reason the tree is not live, or null. */
    this.error = null;
    /** The most recent create/delete, for the panel's activity line. */
    this.lastChange = null;

    this._ignore = new Set(DEFAULT_IGNORE);
    this._known = new Set();
    this._recent = new Map();
    this._watchers = [];
    this._timer = null;
    this._signature = '';
    this._shallowMode = false;
    this._scanning = false;
    this._rescanQueued = false;
    this._stopped = false;
    this._started = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;
    await this._loadGitignore();
    await this.refresh({ silent: true });
    this._watch();
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    for (const w of this._watchers) {
      try { w.close(); } catch { /* already gone */ }
    }
    this._watchers = [];
  }

  async _loadGitignore() {
    try {
      const text = await readFile(join(this.root, '.gitignore'), 'utf8');
      for (const name of parseGitignoreNames(text)) this._ignore.add(name);
    } catch {
      // No .gitignore, or unreadable — the defaults are enough.
    }
  }

  /**
   * A single recursive watch covers the whole tree where the platform supports
   * it. Where it does not (Linux before Node 20), fall back to one shallow
   * watcher per scanned directory; and where the kernel refuses outright
   * (inotify limits), keep the snapshot and say so rather than failing.
   */
  _watch() {
    if (this._stopped) return;
    try {
      this._watchers.push(this._watchFn(this.root, { recursive: true }, (_event, filename) => {
        if (filename && pathIsIgnored(String(filename), this._ignore)) return;
        this._schedule();
      }));
      return;
    } catch {
      // Falls through to the per-directory watchers below.
    }
    this._watchShallow();
  }

  _watchShallow() {
    this._shallowMode = true;
    for (const w of this._watchers) {
      try { w.close(); } catch { /* already gone */ }
    }
    this._watchers = [];
    const dirs = [this.root, ...this.entries.filter(e => e.isDir).map(e => join(this.root, e.path))];
    // One watcher per directory is a file descriptor each; past a few hundred
    // this stops being a good trade against just not being live.
    for (const dir of dirs.slice(0, 200)) {
      try {
        this._watchers.push(this._watchFn(dir, { recursive: false }, () => this._schedule()));
      } catch (err) {
        if (err?.code === 'EMFILE' || err?.code === 'ENOSPC') {
          this.error = 'snapshot only (watch limit)';
          return;
        }
      }
    }
    if (!this._watchers.length) this.error = 'snapshot only (not watchable)';
  }

  _schedule() {
    if (this._stopped) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.refresh().catch(() => { /* a transient scan failure is not fatal */ });
    }, this.debounceMs);
    this._timer.unref?.();
  }

  /**
   * Rescans and reports whether anything the panel draws actually moved.
   * Concurrent calls collapse: a refresh arriving mid-scan queues exactly one
   * follow-up, so a long write burst cannot stack scans.
   */
  async refresh({ silent = false } = {}) {
    if (this._scanning) { this._rescanQueued = true; return false; }
    this._scanning = true;
    let changed = false;
    try {
      const scanned = await this._scan();
      changed = this._applyScan(scanned, silent);
    } finally {
      this._scanning = false;
    }
    if (this._rescanQueued && !this._stopped) {
      this._rescanQueued = false;
      const again = await this.refresh({ silent });
      changed = changed || again;
    }
    // Without a recursive watch, a directory created after startup would
    // never be watched — re-arm whenever the shape of the tree moved.
    if (changed && this._shallowMode && !this._stopped) this._watchShallow();
    if (changed && !silent) this.onChange(this);
    return changed;
  }

  _applyScan(scanned, silent) {
    const now = this._now();
    const seen = new Set(scanned.entries.map(e => e.path));

    // First scan establishes the baseline; without this every file in the
    // project would flash as "just created" on startup.
    if (!silent) {
      for (const path of seen) {
        if (!this._known.has(path)) {
          this._recent.set(path, { kind: 'added', at: now });
          this.lastChange = { kind: 'added', path, at: now };
        }
      }
      for (const path of this._known) {
        if (!seen.has(path)) {
          this._recent.delete(path);
          this.lastChange = { kind: 'removed', path, at: now };
        }
      }
    }
    for (const [path, info] of this._recent) {
      if (now - info.at > this.changeNoticeMs) this._recent.delete(path);
    }
    if (this.lastChange && now - this.lastChange.at > this.changeNoticeMs) this.lastChange = null;

    const before = this._signature;
    this.entries = scanned.entries.map(e => ({ ...e, addedAt: this._recent.get(e.path)?.at ?? null }));
    this.truncated = scanned.truncated;
    this._known = seen;
    this._signature = this.entries.map(e => `${e.path}${e.addedAt ? '+' : ''}`).join('\n');
    return this._signature !== before;
  }

  async _scan() {
    const entries = [];
    let truncated = false;

    const walk = async (dir, relDir, depth) => {
      if (truncated || depth > this.maxDepth) return;
      let listing;
      try {
        listing = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // removed mid-scan, or unreadable — just leave it out
      }
      const dirs = [];
      const files = [];
      for (const item of listing) {
        if (this._ignore.has(item.name)) continue;
        // A symlinked directory can point back up the tree; following it is
        // how a file browser hangs. Listed, never descended into.
        (item.isDirectory() && !item.isSymbolicLink() ? dirs : files).push(item);
      }
      const byName = (a, b) => a.name.localeCompare(b.name);
      dirs.sort(byName);
      files.sort(byName);

      for (const item of [...dirs, ...files]) {
        if (entries.length >= this.maxEntries) { truncated = true; return; }
        const rel = relDir ? `${relDir}${sep}${item.name}` : item.name;
        const isDir = item.isDirectory() && !item.isSymbolicLink();
        entries.push({ name: item.name, depth, isDir, path: rel });
        if (isDir) await walk(join(dir, item.name), rel, depth + 1);
        if (truncated) return;
      }
    };

    await walk(this.root, '', 0);
    return { entries, truncated };
  }
}
