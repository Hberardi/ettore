// git-helpers plugin
//
// Four read-only tools that complement the built-in `git_status` and
// `git_diff` with the everyday operations a code reviewer / maintainer
// actually uses: blame, log, diff stat, and a quick branch audit that
// surfaces stale branches and remote drift.
//
// All four tools use the system `git` CLI via execFileSync. There is
// NO remote write, NO push, NO branch deletion — the plugin is strictly
// inspect-only. A future major version could add interactive rebase
// helpers, but that is out of scope for the read-only contract.

import { execFileSync } from 'node:child_process';

function run(args, { cwd = process.cwd(), timeoutMs = 8000 } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function safeRun(args, fallback, opts) {
  try { return { ok: true, output: run(args, opts) }; }
  catch (err) {
    return { ok: false, error: String(err?.stderr || err?.message || err).trim() || 'git failed' };
  }
}

function shortSha(sha) {
  return String(sha || '').trim().slice(0, 7);
}

function trim(s, n = 80) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export const tools = {
  git_blame: {
    description: 'Annotate each line of a file with the last commit that touched it. Read-only. Output format: <sha> <author> <date> <line>.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the file, relative to the repo root or absolute.' },
        start_line: { type: 'integer', description: 'Start line (1-based). Optional — defaults to 1.', minimum: 1 },
        end_line: { type: 'integer', description: 'End line (inclusive). Optional — defaults to last line.', minimum: 1 },
        cwd: { type: 'string', description: 'Override the working directory. Defaults to the agent CWD.' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    handler: async ({ file, start_line, end_line, cwd }) => {
      const args = ['blame', '--line-porcelain'];
      if (Number.isInteger(start_line) && Number.isInteger(end_line)) {
        args.push('-L', `${start_line},${end_line}`);
      }
      args.push('--', file);
      const r = safeRun(args, '', { cwd });
      if (!r.ok) return `Error: ${r.error}`;
      // The --line-porcelain format is <sha> <orig-line> <final-line>\n then a
      // header block; we collapse it to one line per source line for readability.
      const lines = r.output.split('\n');
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^([0-9a-f]{40}) (\d+) (\d+)$/);
        if (!m) continue;
        const sha = shortSha(m[1]);
        // header block follows: 'author <name>', 'author-mail <...>', 'author-time <ts>',
        // 'author-tz', 'committer', 'committer-tz', 'summary <subject>'.
        let author = '?';
        let when = '?';
        let summary = '';
        let j = i + 1;
        for (; j < lines.length; j++) {
          const line = lines[j];
          if (line.startsWith('author ')) author = trim(line.slice(7), 24);
          else if (line.startsWith('author-time ')) {
            const ts = Number(line.slice(12));
            if (Number.isFinite(ts)) when = new Date(ts * 1000).toISOString().slice(0, 10);
          }
          else if (line.startsWith('summary ')) summary = trim(line.slice(8), 50);
          else if (line === '') break;
        }
        out.push(`${sha} ${author.padEnd(20)} ${when} L${m[3].padStart(4)}  ${summary}`);
        i = j;
      }
      return out.length ? out.join('\n') : '(no output)';
    },
  },

  git_log: {
    description: 'Recent commits with hash, author, date, subject. Default 20, max 200. Use this to see what changed recently, who to ask, or which commit introduced a bug.',
    parameters: {
      type: 'object',
      properties: {
        n: { type: 'integer', description: 'How many commits to return. Default 20, max 200.', default: 20, minimum: 1, maximum: 200 },
        since: { type: 'string', description: 'Only commits after this date. Accepts anything `git log --since` accepts, e.g. "2 weeks ago", "2026-01-01".' },
        author: { type: 'string', description: 'Only commits by this author (substring match).' },
        path: { type: 'string', description: 'Only commits touching this path.' },
        cwd: { type: 'string', description: 'Override the working directory.' },
      },
      additionalProperties: false,
    },
    handler: async ({ n = 20, since, author, path, cwd } = {}) => {
      const safeN = Math.max(1, Math.min(Number(n) || 20, 200));
      const args = ['log', `--max-count=${safeN}`, '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=short'];
      if (since) args.push(`--since=${since}`);
      if (author) args.push(`--author=${author}`);
      if (path) args.push('--', path);
      const r = safeRun(args, '', { cwd });
      if (!r.ok) return `Error: ${r.error}`;
      const rows = r.output.split('\n').filter(Boolean);
      if (!rows.length) return '(no commits)';
      const lines = [`Last ${rows.length} commit(s):`];
      for (const row of rows) {
        const [sha, author, date, ...rest] = row.split('\t');
        lines.push(`  ${sha}  ${date}  ${author.padEnd(20)}  ${rest.join('\t')}`);
      }
      return lines.join('\n');
    },
  },

  git_diff_stat: {
    description: 'Show the per-file insertion / deletion summary of a diff. Useful for "what did this PR change" without dumping the full patch.',
    parameters: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Base ref to diff against. Default: HEAD (i.e. unstaged changes).' },
        path: { type: 'string', description: 'Limit the diff to this path.' },
        cwd: { type: 'string', description: 'Override the working directory.' },
      },
      additionalProperties: false,
    },
    handler: async ({ base, path, cwd } = {}) => {
      const args = ['diff', '--stat', '--numstat'];
      if (base) args.push(base);
      if (path) args.push('--', path);
      const r = safeRun(args, '', { cwd });
      if (!r.ok) return `Error: ${r.error}`;
      if (!r.output.trim()) return '(no diff)';
      return r.output.trim();
    },
  },

  git_branch_audit: {
    description: 'List local branches with their last-commit date, age, and whether they are merged into main. Surfaces stale branches that should be deleted.',
    parameters: {
      type: 'object',
      properties: {
        main: { type: 'string', description: 'The branch considered "main" for the merged check. Default: main (or master if main is missing).' },
        cwd: { type: 'string', description: 'Override the working directory.' },
      },
      additionalProperties: false,
    },
    handler: async ({ main = 'main', cwd } = {}) => {
      // Resolve which branch is the integration target. If neither main nor
      // master exists locally (e.g. the repo uses a different default), the
      // user can pass an explicit name.
      let mainRef = main;
      try { run(['show-ref', '--verify', '--quiet', `refs/heads/${main}`], { cwd }); }
      catch {
        try { run(['show-ref', '--verify', '--quiet', 'refs/heads/master'], { cwd }); mainRef = 'master'; }
        catch {
          return `Error: cannot find integration branch "${main}" (or master). Pass an explicit name.`;
        }
      }
      const refOut = safeRun(['for-each-ref', '--format=%(refname:short)|%(committerdate:iso8601)|%(authorname)|%(subject)', 'refs/heads/'], '', { cwd });
      if (!refOut.ok) return `Error: ${refOut.error}`;
      const mergedOut = safeRun(['branch', '--merged', mainRef, '--format=%(refname:short)'], '', { cwd });
      const mergedSet = new Set(mergedOut.ok ? mergedOut.output.split('\n').map(s => s.trim()).filter(Boolean) : []);
      const rows = refOut.output.split('\n').filter(Boolean).map((line) => {
        const [name, date, author, ...rest] = line.split('|');
        return { name, date, author, subject: rest.join('|'), merged: mergedSet.has(name) };
      });
      rows.sort((a, b) => (a.date < b.date ? 1 : -1));
      const lines = [`${rows.length} local branch(es). Main = ${mainRef}.`];
      const now = Date.now();
      for (const r of rows) {
        const ageDays = r.date ? Math.round((now - new Date(r.date).getTime()) / 86_400_000) : '?';
        const flag = r.merged ? 'merged' : (ageDays > 90 ? 'stale' : 'active');
        lines.push(`  ${flag.padEnd(7)} ${r.name.padEnd(30)} ${r.date || '?'.padEnd(10)} (${ageDays}d)  ${trim(r.author, 16)}  ${trim(r.subject, 40)}`);
      }
      return lines.join('\n');
    },
  },
};

export const hooks = {
  onLoad: async (api) => {
    api.log('info', 'git-helpers loaded — read-only git helpers (blame, log, diff_stat, branch_audit)');
  },
};
