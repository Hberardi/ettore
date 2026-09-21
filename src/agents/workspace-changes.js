// What a shell command changed in the workspace.
//
// write/edit/apply_patch_structured name the file they touch, so the agent
// can record the mutation directly. A shell command does not: `sed -i`,
// `cat > file`, `git apply` or a code generator all write files the agent
// never hears about, and the release gate used to treat such a turn as if no
// code had been touched. Diffing a snapshot taken before and after the command
// sees the result whatever the command was.
//
// Inside a git work tree the snapshot is `git status` plus the mtime and size
// of every dirty path, so a second edit to an already-modified file still
// shows up. Outside git there is nothing cheap to diff, and the fallback reads
// the files a command visibly writes to out of the command itself.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const GIT_TIMEOUT_MS = 3000;
// Past this many dirty paths the snapshot keeps only their status lines:
// stat-ing thousands of files around every shell call would cost more than
// the rare missed re-edit of an already-dirty file.
const MAX_STAT_PATHS = 2000;

function git(args, cwd) {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolvePromise(error ? null : String(stdout));
    });
  });
}

/**
 * Parse `git status --porcelain=v1 -z` output into repo-relative paths with
 * their two-letter status. A rename carries its source as a second NUL
 * separated field; both ends count as changed.
 */
export function parsePorcelainZ(output) {
  const entries = new Map();
  const fields = String(output || '').split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    entries.set(field.slice(3), status);
    if (status[0] === 'R' || status[0] === 'C') {
      const source = fields[++i];
      if (source) entries.set(source, 'D ');
    }
  }
  return entries;
}

/**
 * @returns {Promise<null | {root: string, entries: Map<string, string>}>}
 *   null when `cwd` is not inside a git work tree (or git is unavailable).
 */
export async function snapshotWorkspace(cwd) {
  const root = (await git(['rev-parse', '--show-toplevel'], cwd))?.trim();
  if (!root) return null;
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root);
  if (status === null) return null;
  const parsed = parsePorcelainZ(status);
  const entries = new Map();
  const statThem = parsed.size <= MAX_STAT_PATHS;
  await Promise.all([...parsed].map(async ([path, code]) => {
    let signature = code;
    if (statThem) {
      try {
        const info = await stat(join(root, path));
        signature += `|${info.mtimeMs}|${info.size}`;
      } catch {
        signature += '|missing';
      }
    }
    entries.set(path, signature);
  }));
  return { root, entries };
}

/** Absolute paths whose snapshot entry appeared, vanished or changed. */
export function diffSnapshots(before, after) {
  if (!before || !after || before.root !== after.root) return [];
  const changed = new Set();
  for (const [path, signature] of after.entries) {
    if (before.entries.get(path) !== signature) changed.add(path);
  }
  for (const path of before.entries.keys()) {
    if (!after.entries.has(path)) changed.add(path);
  }
  return [...changed].sort().map(path => join(after.root, path));
}

const IN_PLACE_RE = /\b(?:sed|perl)\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*i\S*\s+(.+)/;
const REDIRECT_RE = /(?:^|[^0-9&<>])>{1,2}\s*([^\s|&;<>()]+)/g;
const TEE_RE = /\btee\s+(?:-a\s+)?([^\s|&;<>()]+)/g;

function unquote(token) {
  return token.replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * Files a shell command visibly writes to, resolved against `cwd`. Used only
 * outside git; deliberately narrow, since a false positive sends a turn to the
 * release gate. /dev/* targets (`> /dev/null`, `2>&1`) are ignored.
 */
export function commandWriteTargets(command, cwd) {
  const text = String(command || '');
  const targets = new Set();
  for (const re of [REDIRECT_RE, TEE_RE]) {
    for (const match of text.matchAll(re)) targets.add(unquote(match[1]));
  }
  const inPlace = text.match(IN_PLACE_RE);
  if (inPlace) {
    // The last word before any pipe or command separator is the file.
    const words = inPlace[1].split(/[|;&]/)[0].trim().split(/\s+/);
    const last = words[words.length - 1];
    if (last && words.length > 1) targets.add(unquote(last));
  }
  return [...targets]
    .filter(target => target && !target.startsWith('/dev/') && !target.startsWith('&'))
    .map(target => (isAbsolute(target) ? target : resolve(cwd, target)));
}
