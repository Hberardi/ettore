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

function looksBinary(buffer) {
  // A NUL in the first block is what `grep` itself uses to decide.
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true;
  return false;
}

function buildMatcher({ pattern, fixed = false, wholeWord = false }) {
  const source = fixed ? String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : String(pattern);
  const body = wholeWord ? `\\b(?:${source})\\b` : source;
  try {
    return new RegExp(body);
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
  maxMatches = 200,
  signal = null,
  globFn = globby,
  readFileFn = readFile,
} = {}) {
  const matcher = buildMatcher({ pattern, fixed, wholeWord });
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
  files = files.sort((a, b) => a.localeCompare(b));

  const lines = [];
  for (const file of files) {
    if (signal?.aborted) break;
    if (lines.length >= maxMatches) break;

    let buffer;
    try {
      buffer = await readFileFn(file);
    } catch {
      continue; // unreadable (permissions, a race with a delete) — skip it
    }
    if (buffer.length > MAX_FILE_BYTES || looksBinary(buffer)) continue;

    // Split on \n and trim a trailing \r so a CRLF file reports the same text
    // a POSIX checkout would.
    const text = buffer.toString('utf8');
    const fileLines = text.split('\n');
    for (let i = 0; i < fileLines.length; i++) {
      if (lines.length >= maxMatches) break;
      const line = fileLines[i].endsWith('\r') ? fileLines[i].slice(0, -1) : fileLines[i];
      if (matcher.test(line)) lines.push(`${file}:${i + 1}:${line}`);
    }
  }

  return lines.join('\n');
}

export const _internal = { buildMatcher, looksBinary, DEFAULT_IGNORE };
