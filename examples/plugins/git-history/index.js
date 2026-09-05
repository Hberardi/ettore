// git-history — the repository's past, as tools the model can choose.
//
// ETTORE ships `git_status` and `git_diff`: both describe the working tree as
// it is right now. Nothing answers "why is this code like this", which is the
// question that decides whether a change is safe to make — the line looks
// wrong until you find the commit that says it is load-bearing.
//
// The agent can already reach git through `bash`, and that is exactly the
// problem this solves. Shell git is a moving target for a model: the porcelain
// differs between subcommands, quoting a path with a space is easy to get
// wrong, `-L` takes a syntax nothing else uses, and a missing `--no-pager` on
// an interactive terminal hangs. A named tool with a typed schema is chosen
// deliberately and validated before it runs.
//
// Every command here is read-only, and every one is invoked through execFile
// with an argument array — never a shell string — so a ref or a path cannot
// become a command however it is spelled.

import { execFile } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';

const GIT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
// Field separator. Written into the --format string as git's own `%x1f`
// placeholder rather than as the byte: Node's execFile refuses any argument
// containing a NUL, and would refuse a raw 0x1f in the argument too. git
// expands the placeholder itself, so only the *output* carries the separator —
// which is the point, since a commit subject can contain any printable
// character but not a control one.
const SEP_FORMAT = '%x1f';
const SEP = '\u001f';

/**
 * Runs git and resolves with its output.
 *
 * Rejects with git's own stderr rather than a wrapper message: "unknown
 * revision or path not in the working tree" tells the model what to do next,
 * and "git failed" does not.
 */
function git(args, { cwd, signal }) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      // --no-pager first: on a terminal, `log`, `blame` and `show` all page by
      // default and a pager waiting for input is indistinguishable from a hang.
      ['--no-pager', ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, signal: signal || undefined },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || '').trim();
          reject(new Error(detail || `git ${args[0]} failed`));
          return;
        }
        resolvePromise(String(stdout || ''));
      },
    );
  });
}

/**
 * Keeps a path argument inside the workspace.
 *
 * git would refuse most escapes on its own — an untracked path outside the
 * repository is not in any commit — but relying on that puts the boundary in
 * git's hands rather than ours, and the failure would read as a git error
 * instead of a refusal.
 */
function repoPath(input, workspace) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const absolute = isAbsolute(raw) ? raw : resolve(workspace, raw);
  const rel = relative(workspace, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path "${raw}" is outside the workspace`);
  }
  return rel;
}

function workspaceOf(ctx) {
  const ws = ctx?.workspace || process.cwd();
  return ws;
}

/** A positive integer within bounds, or the fallback. */
function boundedInt(value, fallback, { min = 1, max = 1000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export const tools = {
  git_log: {
    description:
      'Commit history, newest first, optionally scoped to a file or directory. Use it to find out when and why something changed, who has been working on an area, or what a recent change set contains. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Limit to commits touching this file or directory, relative to the workspace root' },
        limit: { type: 'number', description: 'How many commits to return, 1-200. Default 20' },
        author: { type: 'string', description: 'Only commits whose author matches this substring' },
        since: { type: 'string', description: 'Only commits after this date, e.g. "2 weeks ago" or "2026-01-01"' },
        grep: { type: 'string', description: 'Only commits whose message contains this text' },
      },
      additionalProperties: false,
    },
    handler: async ({ path, limit, author, since, grep }, ctx) => {
      const cwd = workspaceOf(ctx);
      const target = repoPath(path, cwd);
      const args = [
        'log',
        `-n${boundedInt(limit, 20, { max: 200 })}`,
        '--date=short',
        `--format=%h${SEP_FORMAT}%an${SEP_FORMAT}%ad${SEP_FORMAT}%s${SEP_FORMAT}%d`,
      ];
      if (author) args.push(`--author=${String(author)}`);
      if (since) args.push(`--since=${String(since)}`);
      if (grep) args.push(`--grep=${String(grep)}`, '--regexp-ignore-case');
      // --follow tracks a file across renames, which is most of the value of
      // asking about one file's history. It only accepts a single path.
      if (target) args.push('--follow', '--', target);

      const out = await git(args, { cwd, signal: ctx?.signal });
      const commits = out.split('\n').filter(Boolean).map(line => {
        const [sha, authorName, date, subject, refs] = line.split(SEP);
        const commit = { sha, author: authorName, date, subject };
        if (refs && refs.trim()) commit.refs = refs.trim().replace(/^\(|\)$/g, '');
        return commit;
      });

      if (!commits.length) {
        return target
          ? `No commits touch ${target}${since ? ` since ${since}` : ''}. It may be untracked, or newer than the filter.`
          : 'No commits match.';
      }
      return { path: target || '(whole repository)', count: commits.length, commits };
    },
  },

  git_blame: {
    description:
      'Who last changed each line of a file, and in which commit. Consecutive lines from the same commit are grouped, so the answer reads as a handful of changes rather than one row per line. Use it before editing code whose reason is unclear. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File to blame, relative to the workspace root' },
        start_line: { type: 'number', description: 'First line of the range. Default 1' },
        end_line: { type: 'number', description: 'Last line of the range. Default: 200 lines after start' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    handler: async ({ file, start_line, end_line }, ctx) => {
      const cwd = workspaceOf(ctx);
      const target = repoPath(file, cwd);
      if (!target) return 'Error: `file` is required.';

      const start = boundedInt(start_line, 1, { max: 1_000_000 });
      // A whole large file blamed line by line is a wall of text that buries
      // the answer. A window, extendable on request, is the useful default.
      const end = boundedInt(end_line, start + 199, { min: start, max: 1_000_000 });

      const out = await git(
        ['blame', '--line-porcelain', `-L${start},${end}`, '--', target],
        { cwd, signal: ctx?.signal },
      );

      // --line-porcelain repeats a full header per line: a header line with
      // the sha, then key/value lines, then the source line prefixed by a tab.
      const groups = [];
      let current = null;
      let sha = null;
      let lineNo = start;
      let meta = {};
      for (const line of out.split('\n')) {
        // Header: "<sha> <line in original> <line in final file> [<count>]".
        // The third field is the line number this record describes — reading it
        // is both simpler and correct, where counting records drifts.
        const header = /^([0-9a-f]{7,40}) \d+ (\d+)/.exec(line);
        if (header) {
          sha = header[1];
          lineNo = Number(header[2]);
          meta = {};
          continue;
        }
        if (line.startsWith('author ')) meta.author = line.slice(7);
        else if (line.startsWith('author-time ')) meta.time = Number(line.slice(12));
        else if (line.startsWith('summary ')) meta.summary = line.slice(8);
        else if (line.startsWith('\t') && sha) {
          // The source line closes this record. Consecutive lines from the same
          // commit extend the current group rather than starting a new one:
          // "lines 40-58, one commit" is the answer, one row per line is not.
          if (current && current.fullSha === sha && lineNo === current.end + 1) {
            current.end = lineNo;
          } else {
            current = {
              fullSha: sha,
              sha: sha.slice(0, 8),
              author: meta.author,
              date: meta.time ? new Date(meta.time * 1000).toISOString().slice(0, 10) : null,
              summary: meta.summary,
              start: lineNo,
              end: lineNo,
            };
            groups.push(current);
          }
        }
      }

      if (!groups.length) {
        return `No blame output for ${target} lines ${start}-${end}. The file may be untracked, or the range past its end.`;
      }
      return {
        file: target,
        range: `${start}-${groups[groups.length - 1].end}`,
        changes: groups.map(g => ({
          lines: g.start === g.end ? `${g.start}` : `${g.start}-${g.end}`,
          sha: g.sha,
          author: g.author,
          date: g.date,
          summary: g.summary,
        })),
      };
    },
  },

  git_show: {
    description:
      'One commit in full: its message, the files it touched, and optionally its diff. Use it after git_log or git_blame has named a commit worth reading. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Commit to show: a sha, a tag, HEAD~3, a branch name' },
        diff: { type: 'boolean', description: 'Include the patch as well as the file list. Default false' },
        path: { type: 'string', description: 'Restrict the diff to this file, relative to the workspace root' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    handler: async ({ ref, diff = false, path }, ctx) => {
      const cwd = workspaceOf(ctx);
      const target = repoPath(path, cwd);
      const wanted = String(ref || '').trim();
      if (!wanted) return 'Error: `ref` is required.';

      const header = await git(
        ['show', '--no-patch', `--format=%H${SEP_FORMAT}%an${SEP_FORMAT}%ae${SEP_FORMAT}%ad${SEP_FORMAT}%s${SEP_FORMAT}%b`, '--date=short', wanted],
        { cwd, signal: ctx?.signal },
      );
      const [sha, author, email, date, subject, body] = header.split(SEP);

      const statArgs = ['show', '--stat', '--format=', wanted];
      if (target) statArgs.push('--', target);
      const stat = await git(statArgs, { cwd, signal: ctx?.signal });

      const result = {
        sha: String(sha || '').trim(),
        author: `${author} <${email}>`,
        date,
        subject,
        files: stat.trim().split('\n').filter(Boolean),
      };
      if (body && body.trim()) result.body = body.trim();

      if (diff) {
        const diffArgs = ['show', '--format=', wanted];
        if (target) diffArgs.push('--', target);
        const patch = await git(diffArgs, { cwd, signal: ctx?.signal });
        // A merge or a generated-file commit can be enormous; the model gets
        // the shape of it and can ask for one path if it needs more.
        const capped = patch.length > 60_000
          ? `${patch.slice(0, 60_000)}\n… diff truncated at 60KB — call again with \`path\` to narrow it`
          : patch;
        result.diff = capped;
      }
      return result;
    },
  },
};

export const commands = {
  history: {
    description: 'Recent commits for a file, or for the repository: /history [path]',
    handler: async (arg, ctx) => {
      const out = await tools.git_log.handler({ path: arg?.trim() || undefined, limit: 10 }, ctx);
      if (typeof out === 'string') return out;
      return out.commits
        .map(c => `${c.sha}  ${c.date}  ${String(c.author).padEnd(18).slice(0, 18)}  ${c.subject}`)
        .join('\n');
    },
  },
};

export const hooks = {
  async onLoad(api) {
    api.log('info', 'git-history ready: git_log, git_blame, git_show');
  },
};
