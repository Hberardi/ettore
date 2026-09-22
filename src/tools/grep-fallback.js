// Code search without ripgrep or grep.
//
// `grep` and `repo_find_symbol` shell out to `rg`, then to `grep`. Neither
// ships with Windows, so on that platform the agent's main way of finding code
// simply failed — and code search is not an optional tool, it is how a turn
// starts. This is the last fallback: slower than ripgrep, present everywhere.
//
// Output is `path:line:text`, byte-identical in shape to
// `rg --line-number --with-filename --no-heading` and `grep -rn`, so callers
// parse one format regardless of which backend answered.

import { readFile } from 'node:fs/promises';
import { glob as globby } from 'glob';
import { resolve as resolvePath } from 'node:path';

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/target/**',
];

// Files larger than this are almost never source, and reading them would cost
// more than the match is worth.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// How many file reads the searcher keeps in flight at once.
const READ_AHEAD = 16;

function looksBinary(buffer) {
  // A NUL in the first block is what `grep` itself uses to decide.
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true;
  return false;
}

function buildMatcher({ pattern, fixed = false, wholeWord = false, ignoreCase = false }) {
  const source = fixed ? String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : String(pattern);
  const body = wholeWord ? `\\b(?:${source})\\b` : source;
  try {
    return new RegExp(body, ignoreCase ? 'i' : '');
  } catch (err) {
    // An invalid regex is a user error worth reporting, not a crash.
    const error = new Error(`invalid search pattern: ${err.message}`);
    error.code = 'ERR_BAD_PATTERN';
    throw error;
  }
}

/**
 * Search `path` recursively for `pattern`.
 *
 * @param {object} opts
 * @param {string} opts.pattern    regex source, or a literal when `fixed`
 * @param {string} opts.path       directory (or single file) to search
 * @param {string} [opts.include]  glob limiting which files are read, e.g. "*.js"
 * @param {boolean} [opts.fixed]   treat `pattern` as a literal string
 * @param {boolean} [opts.wholeWord] wrap the pattern in word boundaries
 * @param {boolean} [opts.ignoreCase] match regardless of case
 * @param {boolean} [opts.filesOnly] report each matching file once, as a bare path
 * @param {number} [opts.maxMatches]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} `path:line:text` lines, newline separated
 */
export async function searchFiles({
  pattern,
  path,
  include,
  fixed = false,
  wholeWord = false,
  ignoreCase = false,
  filesOnly = false,
  maxMatches = 200,
  signal = null,
  globFn = globby,
  readFileFn = readFile,
} = {}) {
  const matcher = buildMatcher({ pattern, fixed, wholeWord, ignoreCase });
  const root = path || process.cwd();

  // `include` is a bare filename glob ("*.js") in both grep's --include and
  // rg's -g, so it has to match at any depth here too.
  const filePattern = include
    ? (include.includes('/') ? include : `**/${include}`)
    : '**/*';

  let files = await globFn(filePattern, {
    cwd: root,
    absolute: true,
    nodir: true,
    dot: false,
    follow: false,
    ignore: DEFAULT_IGNORE,
  });
  // glob joins the cwd and the match with '/', so on Windows an absolute
  // result came back mixed — `C:\dir\sub/file.txt`. These paths are handed to
  // the model and passed back to read/edit, so they have to be the platform's.
  files = files.map(file => resolvePath(file)).sort((a, b) => a.localeCompare(b));

  // Reading one file at a time left the disk idle between reads, and on
  // Windows — the platform this fallback exists for — each open is slow and
  // passes through the antivirus. A small window of reads in flight hides
  // that latency; matches are still reported in file order.
  const read = file => readFileFn(file).catch(() => null);
  const pending = files.slice(0, READ_AHEAD).map(read);
  let next = pending.length;

  const lines = [];
  for (let f = 0; f < files.length; f++) {
    if (signal?.aborted) break;
    if (lines.length >= maxMatches) break;

    const file = files[f];
    const buffer = await pending[f];
    pending[f] = null;
    if (next < files.length) pending[next] = read(files[next++]);
    // unreadable (permissions, a race with a delete) — skip it
    if (!buffer) continue;
    if (buffer.length > MAX_FILE_BYTES || looksBinary(buffer)) continue;

    // Split on \n and trim a trailing \r so a CRLF file reports the same text
    // a POSIX checkout would.
    const text = buffer.toString('utf8');
    const fileLines = text.split('\n');
    for (let i = 0; i < fileLines.length; i++) {
      if (lines.length >= maxMatches) break;
      const line = fileLines[i].endsWith('\r') ? fileLines[i].slice(0, -1) : fileLines[i];
      if (!matcher.test(line)) continue;
      if (filesOnly) {
        lines.push(file);
        break;
      }
      lines.push(`${file}:${i + 1}:${line}`);
    }
  }

  return lines.join('\n');
}

export const _internal = { buildMatcher, looksBinary, DEFAULT_IGNORE };
