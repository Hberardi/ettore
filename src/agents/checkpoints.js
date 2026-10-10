// What the files looked like before a request touched them, so the request
// can be taken back.
//
// One checkpoint per user request — the turn the user started plus every
// continuation ETTORE ran in their name. It holds, for each file the request
// changed, the state that file was in before the first change: its bytes, or
// the fact that it was not there. `/undo` puts that state back; `/redo`
// reverses the undo.
//
// The before-state comes from two places:
//
//   - write/edit/apply_patch_structured name their file, so it is read just
//     before the tool runs.
//   - A shell command names nothing. Before it runs, every file git already
//     reports as dirty is read (a later change to one of those cannot be
//     recovered from git). After it, anything else the command changed was
//     clean before it, so its old content is whatever HEAD held when the
//     command started, and a path HEAD does not know did not exist.
//
// Nothing here writes to the repository: no stash, no index, no objects. The
// copies live in memory for the session and are capped.
//
// Two things `/undo` refuses to guess at, and reports instead:
//
//   - A file that has changed again since the request finished. Someone has
//     been working on it; restoring would throw that away.
//   - A file whose before-state was never seen — too large to keep, a change
//     inside a directory git lists as one untracked entry, a path that only
//     appeared because a .gitignore changed.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const GIT_TIMEOUT_MS = 5000;
const MAX_CHECKPOINTS = 20;
// A file larger than this is not copied; a change to it cannot be undone.
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Across every checkpoint kept. Past it the oldest checkpoints are dropped.
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
// With more dirty paths than this, reading them all before every shell
// command costs more than the rare undo it would make possible.
const MAX_DIRTY_PRECAPTURE = 400;
// A commit, a pull or a branch switch that moves more files than this is not
// something to take back file by file.
const MAX_HISTORY_FILES = 300;
// A file created by a command has a birth time inside the command's run. The
// slack covers clock granularity, not a guess about speed.
const BIRTH_SLACK_MS = 2000;

function git(args, cwd, { buffer = false } = {}) {
  return new Promise((resolvePromise) => {
    execFile('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_FILE_BYTES * 2,
      encoding: buffer ? 'buffer' : 'utf8',
    }, (error, stdout) => {
      resolvePromise(error ? null : stdout);
    });
  });
}

const digest = bytes => createHash('sha1').update(bytes).digest('hex');

/**
 * The state of `path` on disk right now.
 * @returns {Promise<{kind: 'file', content: Buffer, mode: number, birthMs: number}
 *   | {kind: 'absent'} | {kind: 'unknown', reason: string}>}
 */
async function readState(path, maxBytes = MAX_FILE_BYTES) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'unknown', reason: 'could not be read' };
  }
  if (info.isDirectory()) return { kind: 'unknown', reason: 'is a directory' };
  if (!info.isFile()) return { kind: 'unknown', reason: 'is not a regular file' };
  if (info.size > maxBytes) return { kind: 'unknown', reason: 'is too large to keep a copy of' };
  try {
    return { kind: 'file', content: await readFile(path), mode: info.mode & 0o777, birthMs: info.birthtimeMs };
  } catch {
    return { kind: 'unknown', reason: 'could not be read' };
  }
}

const signatureOf = state => (state.kind === 'file' ? digest(state.content) : state.kind);

function sameState(a, b) {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'file' || a.content.equals(b.content);
}

async function writeState(path, state) {
  if (state.kind === 'absent') {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, state.content);
  if (Number.isInteger(state.mode)) await chmod(path, state.mode).catch(() => {});
}

// ─── Line counts ─────────────────────────────────────────────────────────────

const isBinary = bytes => bytes.subarray(0, 8000).includes(0);

function splitLines(bytes) {
  const text = bytes.toString('utf8');
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Past this many differing lines the exact answer costs more than it is worth
// for a one-line summary; lines are then matched by content, ignoring order.
const MAX_DIFF_DISTANCE = 4000;

/**
 * Lines added and removed going from `before` to `after` — what
 * `git diff --numstat` would print.
 */
export function countLineChanges(before, after) {
  let start = 0;
  let endA = before.length;
  let endB = after.length;
  while (start < endA && start < endB && before[start] === after[start]) start++;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) { endA--; endB--; }
  const a = before.slice(start, endA);
  const b = after.slice(start, endB);
  if (!a.length || !b.length) return { added: b.length, removed: a.length };

  // Myers' shortest edit script, distances only.
  const max = a.length + b.length;
  const limit = Math.min(max, MAX_DIFF_DISTANCE);
  const v = new Int32Array(2 * limit + 2);
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[limit + k - 1] < v[limit + k + 1]);
      let x = down ? v[limit + k + 1] : v[limit + k - 1] + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      v[limit + k] = x;
      if (x >= a.length && y >= b.length) {
        // d = removed + added, and added - removed = b.length - a.length.
        const added = (d + b.length - a.length) / 2;
        return { added, removed: d - added };
      }
    }
  }

  const counts = new Map();
  for (const line of a) counts.set(line, (counts.get(line) || 0) + 1);
  let common = 0;
  for (const line of b) {
    const left = counts.get(line) || 0;
    if (left > 0) { counts.set(line, left - 1); common++; }
  }
  return { added: b.length - common, removed: a.length - common };
}

// ─── The store ───────────────────────────────────────────────────────────────

export class CheckpointStore {
  constructor({
    maxCheckpoints = MAX_CHECKPOINTS,
    maxFileBytes = MAX_FILE_BYTES,
    maxTotalBytes = MAX_TOTAL_BYTES,
    gitFn = git,
  } = {}) {
    this.maxCheckpoints = maxCheckpoints;
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this._git = gitFn;
    this.checkpoints = [];
    this.redoStack = [];
    this.current = null;
    this._seq = 0;
    this._realDirs = new Map();
  }

  // One name per file. The tools name a file by the path the model wrote and
  // git by the repository root; through a symlinked directory those are two
  // spellings of one file, and two entries for it would restore it twice, to
  // two different states. The directory is resolved rather than the file,
  // which may not exist yet.
  async _key(raw, cwd = process.cwd()) {
    const path = resolve(cwd, String(raw));
    const dir = dirname(path);
    let real = this._realDirs.get(dir);
    if (real === undefined) {
      real = await realpath(dir).catch(() => dir);
      if (this._realDirs.size > 2000) this._realDirs.clear();
      this._realDirs.set(dir, real);
    }
    return join(real, basename(path));
  }

  /** Opens the checkpoint for a new user request and makes it the current one. */
  begin(label = '') {
    this._closeCurrent();
    // A new request is a new line of history: what was undone before it can
    // no longer be redone on top of it.
    this.redoStack = [];
    this.current = {
      id: ++this._seq,
      label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      startedAt: Date.now(),
      entries: new Map(),
      undone: false,
      // Set when a shell command moved HEAD: the files can be put back, the
      // commits it made cannot.
      historyMoved: false,
    };
    this.checkpoints.push(this.current);
    this._trim();
    return this.current.id;
  }

  // Copies taken "in case" a shell command changed the file, which it then
  // did not, are dead weight once the request is over.
  _closeCurrent() {
    const cp = this.current;
    if (!cp) return;
    for (const [path, entry] of cp.entries) {
      if (!entry.touched) cp.entries.delete(path);
    }
    if (cp.entries.size === 0) this.checkpoints = this.checkpoints.filter(other => other !== cp);
    this.current = null;
  }

  _bytes() {
    let total = 0;
    for (const cp of this.checkpoints) {
      for (const entry of cp.entries.values()) {
        if (entry.before.kind === 'file') total += entry.before.content.length;
      }
    }
    return total;
  }

  _trim() {
    while (this.checkpoints.length > this.maxCheckpoints) this.checkpoints.shift();
    while (this.checkpoints.length > 1 && this._bytes() > this.maxTotalBytes) this.checkpoints.shift();
  }

  /**
   * Records the state of each path as it is now, unless this request already
   * has one for it: the first state seen is the state before the request.
   */
  async captureBefore(paths, { cwd = process.cwd() } = {}) {
    const cp = this.current;
    if (!cp) return;
    await Promise.all([...new Set(paths)].filter(Boolean).map(async (raw) => {
      const path = await this._key(raw, cwd);
      if (cp.entries.has(path)) return;
      // Reserved before the read, so two tools in one batch cannot both
      // record a state for the same file.
      const entry = { before: { kind: 'unknown', reason: 'could not be read' }, after: null, touched: false };
      cp.entries.set(path, entry);
      entry.before = await readState(path, this.maxFileBytes);
    }));
  }

  /** Marks paths as changed by the request and records what they hold now. */
  async noteAfter(paths, { cwd = process.cwd() } = {}) {
    const cp = this.current;
    if (!cp) return;
    await Promise.all([...new Set(paths)].filter(Boolean).map(async (raw) => {
      const path = await this._key(raw, cwd);
      const entry = cp.entries.get(path);
      if (!entry) return;
      entry.touched = true;
      entry.after = signatureOf(await readState(path, this.maxFileBytes));
    }));
  }

  /**
   * Before a shell command: copy what git cannot give back later.
   * @param {null | {root: string, entries: Map<string, string>}} snapshot
   *   from snapshotWorkspace, or null outside a git work tree.
   * @returns {Promise<object|null>} a token for shellAfter.
   */
  async shellBefore(snapshot) {
    if (!this.current || !snapshot) return null;
    const head = (await this._git(['rev-parse', '--verify', '--quiet', 'HEAD'], snapshot.root))?.trim() || null;
    const dirty = [...snapshot.entries.keys()].filter(path => !path.endsWith('/'));
    const precaptured = dirty.length <= MAX_DIRTY_PRECAPTURE;
    if (precaptured) await this.captureBefore(dirty.map(path => join(snapshot.root, path)));
    return { root: snapshot.root, head, startedAt: Date.now(), dirty: new Set(snapshot.entries.keys()), precaptured };
  }

  /**
   * After a shell command: work out the before-state of what it changed.
   * @param {object|null} token from shellBefore
   * @param {string[]} changed absolute paths, from diffSnapshots
   */
  async shellAfter(token, changed = []) {
    const cp = this.current;
    if (!cp) return;
    if (!token) {
      // Outside git the paths were read out of the command text, after it
      // ran: there is no before-state to be had.
      for (const path of changed) this._setUnknown(cp, await this._key(path), 'was changed by a shell command outside a git repository');
      return;
    }
    const root = await this._key(token.root);
    const rel = path => relative(root, path).split(sep).join('/');
    const paths = new Set();
    for (const path of changed) paths.add(await this._key(path));

    // A command that commits what it changed leaves the file clean before and
    // clean after, so the status diff never sees it. HEAD moving is the tell,
    // and the two commits say which files went with it.
    const head = (await this._git(['rev-parse', '--verify', '--quiet', 'HEAD'], token.root))?.trim() || null;
    if (head !== token.head) {
      cp.historyMoved = true;
      if (token.head && head) {
        const names = await this._git(['diff', '--name-only', '-z', token.head, head], token.root);
        const files = String(names || '').split('\0').filter(Boolean);
        if (files.length > MAX_HISTORY_FILES) {
          this._setUnknown(cp, root, `had ${files.length} files changed by a git command that moved HEAD`);
        } else {
          for (const file of files) paths.add(await this._key(join(token.root, file)));
        }
      }
    }
    if (!paths.size) return;

    // A .gitignore edit makes files that were always there show up as new.
    const ignoreChanged = [...paths].some(path => basename(path) === '.gitignore');
    const touched = [];

    for (const path of paths) {
      const relPath = rel(path);
      const state = await readState(path, this.maxFileBytes);

      if (state.kind === 'unknown' && state.reason === 'is a directory') {
        // git lists a directory with nothing tracked in it as one entry.
        if (token.dirty.has(`${relPath}/`)) {
          this._setUnknown(cp, path, 'is an untracked directory that already had files in it');
          continue;
        }
        const listing = await this._git(['ls-files', '--others', '--exclude-standard', '-z', '--', relPath], token.root);
        for (const file of String(listing || '').split('\0').filter(Boolean)) {
          const filePath = await this._key(join(token.root, file));
          if (!cp.entries.has(filePath)) {
            const now = await readState(filePath, this.maxFileBytes);
            cp.entries.set(filePath, { before: this._inferAbsent(now, token, ignoreChanged), after: null, touched: false });
          }
          touched.push(filePath);
        }
        continue;
      }

      if (!cp.entries.has(path)) {
        const before = token.dirty.has(relPath)
          // It was dirty and was not copied: too many dirty paths to read.
          ? { kind: 'unknown', reason: 'already had uncommitted changes that were not copied' }
          // Not dirty before the command: its content was HEAD's.
          : await this._stateAtHead(token, relPath, state, ignoreChanged);
        cp.entries.set(path, { before, after: null, touched: false });
      }
      touched.push(path);
    }
    await this.noteAfter(touched);
    this._trim();
  }

  // What a file that was clean before the command held: HEAD's copy of it.
  // "HEAD has no such path" and "git could not say" are kept apart — the
  // first means the file is new, and treating the second the same way would
  // have `/undo` delete a file it merely failed to read.
  async _stateAtHead(token, relPath, now, ignoreChanged) {
    if (!token.head) return this._inferAbsent(now, token, ignoreChanged);
    const listing = await this._git(['ls-tree', '-l', '-z', token.head, '--', relPath], token.root);
    if (listing === null) return { kind: 'unknown', reason: 'could not be read from git' };
    const match = /^(\d+) (\w+) [0-9a-f]+\s+(\S+)\t/.exec(listing);
    if (!match) return this._inferAbsent(now, token, ignoreChanged);
    const [, mode, type, size] = match;
    if (type !== 'blob' || mode === '120000') return { kind: 'unknown', reason: 'is not a regular file' };
    if (Number(size) > this.maxFileBytes) return { kind: 'unknown', reason: 'is too large to keep a copy of' };
    const content = await this._git(['cat-file', '--filters', `${token.head}:${relPath}`], token.root, { buffer: true });
    if (!content) return { kind: 'unknown', reason: 'could not be read from git' };
    return { kind: 'file', content, mode: mode === '100755' ? 0o755 : 0o644 };
  }

  // A path HEAD does not know and git did not report before the command is
  // new — unless it was only hidden: ignored until a .gitignore changed, or
  // moved here from somewhere else. Its birth time tells the two apart, and
  // deleting on a guess is not an undo.
  _inferAbsent(now, token, ignoreChanged) {
    if (now.kind !== 'file') return { kind: 'absent' };
    const born = Number(now.birthMs) || 0;
    if (born > 0 ? born >= token.startedAt - BIRTH_SLACK_MS : !ignoreChanged) return { kind: 'absent' };
    return { kind: 'unknown', reason: 'may have existed before the command (it is older than the command)' };
  }

  _setUnknown(cp, path, reason) {
    const entry = cp.entries.get(path);
    if (entry) { entry.touched = true; return; }
    cp.entries.set(path, { before: { kind: 'unknown', reason }, after: null, touched: true });
  }

  // ── Reading a checkpoint ────────────────────────────────────────────────

  /**
   * What the request changed, measured against the files as they are now.
   * @returns {Promise<Array<{path: string, status: 'added'|'modified'|'deleted'|'unknown',
   *   added: number, removed: number, binary: boolean}>>} sorted by path.
   */
  async changes(cp = this.current) {
    if (!cp) return [];
    const out = [];
    await Promise.all([...cp.entries].map(async ([path, entry]) => {
      if (!entry.touched) return;
      const now = await readState(path, this.maxFileBytes);
      if (entry.before.kind === 'unknown') {
        out.push({ path, status: 'unknown', added: 0, removed: 0, binary: false });
        return;
      }
      if (sameState(entry.before, now)) return;
      const beforeBytes = entry.before.kind === 'file' ? entry.before.content : Buffer.alloc(0);
      const nowBytes = now.kind === 'file' ? now.content : Buffer.alloc(0);
      const binary = isBinary(beforeBytes) || isBinary(nowBytes) || now.kind === 'unknown';
      const counts = binary ? { added: 0, removed: 0 } : countLineChanges(splitLines(beforeBytes), splitLines(nowBytes));
      out.push({
        path,
        status: entry.before.kind === 'absent' ? 'added' : now.kind === 'absent' ? 'deleted' : 'modified',
        ...counts,
        binary,
      });
    }));
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The newest checkpoint `/undo` would act on, or null. */
  undoTarget() {
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      const cp = this.checkpoints[i];
      if (!cp.undone && [...cp.entries.values()].some(entry => entry.touched)) return cp;
    }
    return null;
  }

  /**
   * Puts back the files of the most recent request that changed any.
   *
   * @param {{force?: boolean}} options `force` also restores files that have
   *   changed again since the request finished.
   * @returns {Promise<null | {label: string, restored: Array<{path: string, action: string}>,
   *   conflicts: string[], unknown: Array<{path: string, reason: string}>, historyMoved: boolean}>}
   *   null when there is nothing to undo. `historyMoved` says a shell command
   *   committed, pulled or switched branch: the files are back, HEAD is not.
   */
  async undo({ force = false } = {}) {
    const cp = this.undoTarget();
    if (!cp) return null;
    const result = { label: cp.label, restored: [], conflicts: [], unknown: [], historyMoved: cp.historyMoved };
    const redo = new Map();

    for (const [path, entry] of [...cp.entries].sort(([a], [b]) => a.localeCompare(b))) {
      if (!entry.touched) continue;
      if (entry.before.kind === 'unknown') {
        result.unknown.push({ path, reason: entry.before.reason });
        continue;
      }
      const now = await readState(path, this.maxFileBytes);
      if (sameState(entry.before, now)) continue;
      if (now.kind === 'unknown') {
        result.unknown.push({ path, reason: now.reason });
        continue;
      }
      if (!force && entry.after && signatureOf(now) !== entry.after) {
        result.conflicts.push(path);
        continue;
      }
      try {
        await writeState(path, entry.before);
      } catch (error) {
        result.unknown.push({ path, reason: `could not be restored (${error?.code || error?.message || error})` });
        continue;
      }
      redo.set(path, { state: now, expect: signatureOf(entry.before) });
      result.restored.push({
        path,
        action: entry.before.kind === 'absent' ? 'removed' : now.kind === 'absent' ? 'recreated' : 'restored',
      });
    }

    // With conflicts left behind the checkpoint stays open, so `/undo force`
    // can still reach them.
    if (!result.conflicts.length) cp.undone = true;
    if (redo.size) this.redoStack.push({ cp, files: redo });
    if (cp === this.current && cp.undone) this.current = null;
    return result;
  }

  /**
   * Reverses the last `/undo`.
   * @returns {Promise<null | {label: string, restored: Array<{path: string, action: string}>, conflicts: string[]}>}
   */
  async redo() {
    const record = this.redoStack.pop();
    if (!record) return null;
    const result = { label: record.cp.label, restored: [], conflicts: [] };
    for (const [path, { state, expect }] of record.files) {
      const now = await readState(path, this.maxFileBytes);
      // Only over the state the undo left: anything else is newer work.
      if (signatureOf(now) !== expect) {
        result.conflicts.push(path);
        continue;
      }
      try {
        await writeState(path, state);
        result.restored.push({ path, action: state.kind === 'absent' ? 'removed' : 'restored' });
      } catch {
        result.conflicts.push(path);
      }
    }
    record.cp.undone = false;
    return result;
  }

  /** Requests that can still be undone, newest first. */
  list() {
    return this.checkpoints
      .filter(cp => !cp.undone)
      .map(cp => ({
        id: cp.id,
        label: cp.label,
        startedAt: cp.startedAt,
        files: [...cp.entries.values()].filter(entry => entry.touched).length,
      }))
      .filter(cp => cp.files > 0)
      .reverse();
  }

  clear() {
    this.checkpoints = [];
    this.redoStack = [];
    this.current = null;
  }
}

/** A path as the user would write it: relative when it is inside `cwd`. */
export function displayPath(path, cwd = process.cwd()) {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

// One store for the session. The main agent and the worker sub-agents it
// starts all change the same working tree for the same request.
export const checkpoints = new CheckpointStore();
