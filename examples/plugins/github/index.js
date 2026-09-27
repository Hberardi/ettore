// github — the part of the work that happens on GitHub, as tools the agent can
// choose.
//
// ETTORE sees the repository on disk and nothing of what happens after a push.
// "CI is red" used to mean the user copying a log into the chat, or the agent
// shelling out to `gh` and wading through thousands of lines of runner output
// for the one assertion that failed. `gh_ci_failure` does that wading: it
// fetches the failed jobs' logs and returns the failing tests with their
// errors, in the formats the common runners print (Node's TAP, pytest, Jest,
// Go) and GitHub's own `##[error]` annotations, falling back to the log's
// tail when none match.
//
// Everything goes through the GitHub CLI, invoked with execFile and an
// argument array — never a shell string — so a branch name or a PR title
// cannot become a command however it is spelled. gh brings the login
// (`gh auth login`, or GH_TOKEN), the repository detection from the git
// remote, and pagination.
//
// Reading is `risk: 'low'` and works in plan mode. Publishing — a pull
// request, an issue, a comment — acts outside the project and in the user's
// name, so each one asks through ctx.confirm first, whatever /auto-approve
// says, and is refused when there is no one to ask.

import { execFile } from 'node:child_process';

const GH_TIMEOUT_MS = 30_000;
const LOG_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
// What one failure may cost the context: enough for the assertion, the
// expected/actual pair and the location; not the whole stack.
const MAX_LINES_PER_FAILURE = 24;
const MAX_FAILURES_PER_JOB = 12;
const MAX_REPORT_CHARS = 12_000;

// ── running gh ──────────────────────────────────────────────────────────────

function execRunner(file, args, { cwd, signal, timeout = GH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd,
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      signal: signal || undefined,
      windowsHide: true,
      env: {
        ...process.env,
        // Never a prompt: a question nobody can see would hang the tool.
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
        CLICOLOR: '0',
      },
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') {
          reject(new Error(`${file} is not installed. Install the GitHub CLI from https://cli.github.com and sign in with \`gh auth login\` (or set GH_TOKEN).`));
          return;
        }
        // gh's own words — "not a git repository", "no pull requests found
        // for branch", "gh auth login" — say what to do next.
        reject(new Error(String(stderr || error.message || '').trim() || `${file} ${args[0]} failed`));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

// Replaceable in tests, so no test ever talks to GitHub.
let runner = execRunner;
export function _setRunner(fn) {
  runner = fn || execRunner;
}

const gh = (args, ctx, options = {}) => runner('gh', args, { cwd: workspaceOf(ctx), signal: ctx?.signal, ...options });
const git = (args, ctx) => runner('git', args, { cwd: workspaceOf(ctx), signal: ctx?.signal });

async function ghJson(args, ctx, options) {
  const out = await gh(args, ctx, options);
  try {
    return JSON.parse(out || 'null');
  } catch {
    throw new Error(`gh returned something that is not JSON: ${out.slice(0, 200)}`);
  }
}

function workspaceOf(ctx) {
  return ctx?.workspace || process.cwd();
}

async function currentBranch(ctx) {
  const out = await git(['rev-parse', '--abbrev-ref', 'HEAD'], ctx);
  const branch = out.trim();
  if (!branch || branch === 'HEAD') throw new Error('Not on a branch (detached HEAD) — pass `branch` explicitly.');
  return branch;
}

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}… [${value.length - max} more characters]` : value;
}

function toInt(value, fallback, { min = 1, max = 100 } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ── reading a CI log ────────────────────────────────────────────────────────

const TIMESTAMP_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** A job log as plain lines: no timestamps, no colour codes. */
export function cleanLog(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map(line => line.replace(TIMESTAMP_RE, '').replace(ANSI_RE, ''));
}

function tapFailures(lines) {
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*not ok \d+ - (.+)$/.exec(lines[i]);
    if (!match) continue;
    const block = [];
    let parentOnly = false;
    for (let j = i + 1; j < lines.length && j < i + 200; j++) {
      const line = lines[j];
      if (/^\s*\.\.\.\s*$/.test(line)) break;
      if (/failureType: 'subtestsFailed'/.test(line)) parentOnly = true;
      if (/^\s*(---|duration_ms:|type:|stack:|\s*async |\s*at |\s*TestContext\.|\s*Test\.|\s*process\.)/.test(line)) continue;
      if (/^\s{4,}(async |at |TestContext|Test\.|process\.|node:)/.test(line)) continue;
      if (line.trim()) block.push(line.replace(/^\s{2}/, ''));
    }
    // A file whose subtests failed repeats them; the subtests are the story.
    if (parentOnly) continue;
    failures.push({ test: match[1].trim(), details: block.slice(0, MAX_LINES_PER_FAILURE).join('\n') });
  }
  return failures;
}

function pytestFailures(lines) {
  const failures = [];
  const summary = lines.findIndex(line => /=+ short test summary info =+/.test(line));
  if (summary !== -1) {
    for (const line of lines.slice(summary + 1)) {
      const match = /^(FAILED|ERROR) (\S+)(?: - (.*))?$/.exec(line.trim());
      if (match) failures.push({ test: match[2], details: `${match[1]}${match[3] ? `: ${match[3]}` : ''}` });
      if (/^=+ .* in [\d.]+s/.test(line.trim())) break;
    }
  }
  if (failures.length) {
    // The `E   ` lines under each test's section are the assertion itself.
    for (const failure of failures) {
      const name = failure.test.split('::').pop();
      const header = lines.findIndex(line => new RegExp(`_{3,} .*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.* _{3,}`).test(line));
      if (header === -1) continue;
      const errors = [];
      for (const line of lines.slice(header + 1, header + 300)) {
        if (/^_{3,} /.test(line) || /^=+ /.test(line)) break;
        if (/^E\s/.test(line) || /^\S+\.py:\d+:/.test(line)) errors.push(line);
      }
      if (errors.length) failure.details = errors.slice(0, MAX_LINES_PER_FAILURE).join('\n');
    }
  }
  return failures;
}

function jestFailures(lines) {
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*● (.+ › .+)$/.exec(lines[i]);
    if (!match) continue;
    const block = [];
    for (let j = i + 1; j < lines.length && block.length < MAX_LINES_PER_FAILURE; j++) {
      if (/^\s*● /.test(lines[j])) break;
      if (/^\s+at /.test(lines[j])) break;
      if (lines[j].trim()) block.push(lines[j].trim());
    }
    failures.push({ test: match[1].trim(), details: block.join('\n') });
  }
  return failures;
}

function goFailures(lines) {
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*--- FAIL: (\S+)/.exec(lines[i]);
    if (!match) continue;
    const block = [];
    for (let j = i + 1; j < lines.length && block.length < MAX_LINES_PER_FAILURE; j++) {
      if (/^\s*(--- (FAIL|PASS|SKIP)|=== RUN|FAIL|ok)\b/.test(lines[j])) break;
      if (lines[j].trim()) block.push(lines[j].trim());
    }
    failures.push({ test: match[1], details: block.join('\n') });
  }
  return failures;
}

/**
 * The failing tests in a CI job log, and what they said.
 *
 * @returns {{ failures: Array<{test: string, details: string}>, summary: string|null, annotations: string[], tail: string|null }}
 *   `tail` is filled only when no runner format matched, so something useful
 *   comes back from a log this does not understand.
 */
export function extractFailures(raw) {
  const lines = cleanLog(raw);
  const failures = [
    ...tapFailures(lines),
    ...pytestFailures(lines),
    ...jestFailures(lines),
    ...goFailures(lines),
  ];
  const seen = new Set();
  const unique = failures.filter(f => (seen.has(f.test) ? false : seen.add(f.test)));

  const counts = [];
  for (const line of lines) {
    const tap = /^# (pass|fail|tests|skipped|cancelled) (\d+)$/.exec(line.trim());
    if (tap && (tap[1] === 'pass' || tap[1] === 'fail')) counts.push(`${tap[1]} ${tap[2]}`);
    const py = /^=+ (.*(?:failed|passed|error).*) in [\d.]+s/.exec(line.trim());
    if (py) counts.push(py[1]);
    const jest = /^Tests:\s+(.+)$/.exec(line.trim());
    if (jest) counts.push(jest[1]);
  }
  const annotations = [...new Set(lines
    .map(line => /##\[error\](.*)$/.exec(line)?.[1]?.trim())
    .filter(Boolean))].slice(0, 10);

  let tail = null;
  if (!unique.length) {
    const meaningful = lines.filter(line => line.trim() && !/^##\[(group|endgroup)\]/.test(line));
    tail = meaningful.slice(-40).join('\n');
  }
  return {
    failures: unique.slice(0, MAX_FAILURES_PER_JOB),
    more: Math.max(0, unique.length - MAX_FAILURES_PER_JOB),
    summary: counts.length ? counts.slice(-2).join(', ') : null,
    annotations,
    tail,
  };
}

// ── runs ────────────────────────────────────────────────────────────────────

const RUN_FIELDS = 'databaseId,displayTitle,workflowName,status,conclusion,headBranch,headSha,event,createdAt,url';

function describeRun(run) {
  return {
    id: run.databaseId,
    workflow: run.workflowName,
    title: run.displayTitle,
    status: run.status,
    conclusion: run.conclusion || null,
    branch: run.headBranch,
    sha: String(run.headSha || '').slice(0, 7),
    event: run.event,
    created: run.createdAt,
    url: run.url,
  };
}

async function runJobs(runId, ctx) {
  const view = await ghJson(['run', 'view', String(runId), '--json', 'jobs,status,conclusion,url,headSha,displayTitle'], ctx);
  return {
    view,
    jobs: (view?.jobs || []).map(job => ({
      id: job.databaseId,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion || null,
      failedSteps: (job.steps || []).filter(step => step.conclusion === 'failure').map(step => step.name),
      url: job.url,
    })),
  };
}

async function listRuns({ branch, limit }, ctx) {
  const target = branch || await currentBranch(ctx);
  const runs = await ghJson(['run', 'list', '--branch', target, '--limit', String(limit), '--json', RUN_FIELDS], ctx);
  return { branch: target, runs: (runs || []).map(describeRun) };
}

// ── tools ───────────────────────────────────────────────────────────────────

async function confirmOrRefuse(ctx, title, detail) {
  if (typeof ctx?.confirm !== 'function') {
    return 'Refused: this ETTORE cannot ask you for confirmation, and publishing to GitHub is never done without it. Update ETTORE, or do this with `gh` yourself.';
  }
  const answer = await ctx.confirm(title, detail);
  if (answer?.allowed) return null;
  if (answer?.reason === 'non_interactive') {
    return 'Blocked: publishing to GitHub needs your confirmation, and there is no interactive session to ask in. Run ETTORE interactively.';
  }
  return 'Cancelled by user: they chose not to publish this to GitHub. Ask them what to change, or leave it.';
}

export const tools = {
  gh_ci_status: {
    risk: 'low',
    description:
      'The GitHub Actions runs for a branch (the current one by default), newest first, and the jobs of the latest run with the steps that failed. Use it to answer "did CI pass?" after a push, or to find a run id for gh_ci_failure. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch to look at. Default: the current branch' },
        run_id: { type: 'number', description: 'A specific run to show jobs for, instead of the latest' },
        limit: { type: 'number', description: 'How many recent runs to list, 1-20. Default 5' },
      },
    },
    handler: async ({ branch, run_id, limit }, ctx) => {
      const { branch: target, runs } = await listRuns({ branch, limit: toInt(limit, 5, { max: 20 }) }, ctx);
      const focus = run_id ? Number(run_id) : runs[0]?.id;
      if (!focus) return { branch: target, runs: [], note: `No workflow runs found for ${target}.` };
      const { view, jobs } = await runJobs(focus, ctx);
      return {
        branch: target,
        runs,
        run: { id: focus, status: view?.status, conclusion: view?.conclusion || null, sha: String(view?.headSha || '').slice(0, 7), url: view?.url },
        jobs,
        next: view?.conclusion === 'failure' ? `Use gh_ci_failure with run_id ${focus} for the failing tests.` : undefined,
      };
    },
  },

  gh_ci_failure: {
    risk: 'low',
    description:
      'Why a GitHub Actions run failed: for each failed job, the failing tests and their errors pulled out of the job log (Node TAP, pytest, Jest, Go, ##[error] annotations; the log tail otherwise). Default: the latest failed run on the current branch. Use it before reproducing a CI failure locally. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'number', description: 'The run to explain. Default: the latest failed run on the branch' },
        branch: { type: 'string', description: 'Branch to search for the latest failed run. Default: the current branch' },
      },
    },
    handler: async ({ run_id, branch }, ctx) => {
      let runId = run_id ? Number(run_id) : null;
      if (!runId) {
        const { branch: target, runs } = await listRuns({ branch, limit: 15 }, ctx);
        const failed = runs.find(run => run.conclusion === 'failure');
        if (!failed) {
          const latest = runs[0];
          return latest
            ? `No failed run among the last ${runs.length} on ${target}; the latest (${latest.id}) is ${latest.conclusion || latest.status}.`
            : `No workflow runs found for ${target}.`;
        }
        runId = failed.id;
      }
      const { view, jobs } = await runJobs(runId, ctx);
      const failedJobs = jobs.filter(job => job.conclusion === 'failure');
      if (!failedJobs.length) {
        return `Run ${runId} has no failed job (${view?.conclusion || view?.status}).`;
      }
      const reports = [];
      for (const job of failedJobs) {
        let extracted;
        try {
          // The API returns the log even while other jobs of the run are still
          // going, which `gh run view --log-failed` does not.
          const raw = await gh(['api', `repos/{owner}/{repo}/actions/jobs/${job.id}/logs`], ctx, { timeout: LOG_TIMEOUT_MS });
          extracted = extractFailures(raw);
        } catch (error) {
          extracted = { failures: [], summary: null, annotations: [], tail: null, error: error.message };
        }
        reports.push({ job: job.name, failedSteps: job.failedSteps, url: job.url, ...extracted });
      }
      let report = { run: { id: runId, title: view?.displayTitle, sha: String(view?.headSha || '').slice(0, 7), url: view?.url }, jobs: reports };
      // Several jobs usually fail the same way (the same test on four
      // runners); the size cap keeps the first ones whole rather than all cut.
      while (JSON.stringify(report).length > MAX_REPORT_CHARS && report.jobs.length > 1) {
        report = { ...report, jobs: report.jobs.slice(0, -1), omittedJobs: (report.omittedJobs || 0) + 1 };
      }
      return report;
    },
  },

  gh_pr_view: {
    risk: 'low',
    description:
      'A pull request: title, state, description, changed files, review comments, conversation and checks. Default: the PR for the current branch. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        number: { type: 'number', description: 'PR number. Default: the PR of the current branch' },
      },
    },
    handler: async ({ number }, ctx) => {
      const fields = 'number,title,state,isDraft,author,baseRefName,headRefName,body,url,additions,deletions,files,reviews,comments,statusCheckRollup,mergeable,reviewDecision';
      const pr = await ghJson(['pr', 'view', ...(number ? [String(number)] : []), '--json', fields], ctx);
      return {
        number: pr.number,
        title: pr.title,
        state: pr.isDraft ? `${pr.state} (draft)` : pr.state,
        author: pr.author?.login,
        branch: `${pr.headRefName} → ${pr.baseRefName}`,
        url: pr.url,
        mergeable: pr.mergeable,
        review: pr.reviewDecision || null,
        size: `+${pr.additions} −${pr.deletions}`,
        body: clip(pr.body, 3000),
        files: (pr.files || []).slice(0, 80).map(f => `${f.path} (+${f.additions} −${f.deletions})`),
        checks: (pr.statusCheckRollup || []).map(c => `${c.name || c.context}: ${c.conclusion || c.state || c.status}`),
        reviews: (pr.reviews || []).slice(-10).map(r => ({ by: r.author?.login, state: r.state, body: clip(r.body, 800) })),
        comments: (pr.comments || []).slice(-10).map(c => ({ by: c.author?.login, body: clip(c.body, 800) })),
      };
    },
  },

  gh_pr_list: {
    risk: 'low',
    description: 'Pull requests of the repository, newest first. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'], description: 'Default open' },
        limit: { type: 'number', description: '1-100. Default 20' },
        author: { type: 'string', description: 'Only PRs by this login ("@me" for yourself)' },
        search: { type: 'string', description: 'GitHub search terms, e.g. "label:bug review:required"' },
      },
    },
    handler: async ({ state = 'open', limit, author, search }, ctx) => {
      const args = ['pr', 'list', '--state', String(state), '--limit', String(toInt(limit, 20)),
        '--json', 'number,title,author,headRefName,state,isDraft,updatedAt,url'];
      if (author) args.push('--author', String(author));
      if (search) args.push('--search', String(search));
      const prs = await ghJson(args, ctx);
      return (prs || []).map(pr => ({
        number: pr.number, title: pr.title, author: pr.author?.login, branch: pr.headRefName,
        state: pr.isDraft ? `${pr.state} (draft)` : pr.state, updated: pr.updatedAt, url: pr.url,
      }));
    },
  },

  gh_issue_list: {
    risk: 'low',
    description: 'Issues of the repository, newest first. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default open' },
        limit: { type: 'number', description: '1-100. Default 20' },
        label: { type: 'string', description: 'Only issues with this label' },
        assignee: { type: 'string', description: 'Only issues assigned to this login ("@me" for yourself)' },
        search: { type: 'string', description: 'GitHub search terms' },
      },
    },
    handler: async ({ state = 'open', limit, label, assignee, search }, ctx) => {
      const args = ['issue', 'list', '--state', String(state), '--limit', String(toInt(limit, 20)),
        '--json', 'number,title,author,labels,assignees,state,updatedAt,url'];
      if (label) args.push('--label', String(label));
      if (assignee) args.push('--assignee', String(assignee));
      if (search) args.push('--search', String(search));
      const issues = await ghJson(args, ctx);
      return (issues || []).map(issue => ({
        number: issue.number, title: issue.title, author: issue.author?.login, state: issue.state,
        labels: (issue.labels || []).map(l => l.name), assignees: (issue.assignees || []).map(a => a.login),
        updated: issue.updatedAt, url: issue.url,
      }));
    },
  },

  gh_issue_view: {
    risk: 'low',
    description: 'One issue with its whole discussion. Read-only.',
    parameters: {
      type: 'object',
      properties: { number: { type: 'number', description: 'Issue number' } },
      required: ['number'],
    },
    handler: async ({ number }, ctx) => {
      if (!number) throw new Error('gh_issue_view needs an issue `number`.');
      const issue = await ghJson(['issue', 'view', String(number), '--json',
        'number,title,state,author,body,labels,assignees,comments,url,createdAt'], ctx);
      return {
        number: issue.number, title: issue.title, state: issue.state, author: issue.author?.login,
        created: issue.createdAt, url: issue.url,
        labels: (issue.labels || []).map(l => l.name), assignees: (issue.assignees || []).map(a => a.login),
        body: clip(issue.body, 4000),
        comments: (issue.comments || []).slice(-20).map(c => ({ by: c.author?.login, body: clip(c.body, 1200) })),
      };
    },
  },

  gh_pr_create: {
    // Publishes in the user's name: always asked, never auto-approved.
    risk: 'high',
    description:
      'Open a pull request for the current branch. The branch must already be pushed. The user is asked to confirm first, every time. Write a real title and a description of what changed and why.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR description (Markdown)' },
        base: { type: 'string', description: 'Branch to merge into. Default: the repository default branch' },
        draft: { type: 'boolean', description: 'Open as a draft. Default false' },
      },
      required: ['title', 'body'],
    },
    handler: async ({ title, body, base, draft = false }, ctx) => {
      if (!String(title || '').trim()) throw new Error('gh_pr_create needs a `title`.');
      const head = await currentBranch(ctx);
      const refused = await confirmOrRefuse(
        ctx,
        `🐙 Open a pull request on GitHub${draft ? ' (draft)' : ''}?`,
        `${head}${base ? ` → ${base}` : ''}\n${title}\n\n${clip(body, 1500)}`,
      );
      if (refused) return refused;
      const args = ['pr', 'create', '--title', String(title), '--body', String(body || ''), '--head', head];
      if (base) args.push('--base', String(base));
      if (draft) args.push('--draft');
      const out = await gh(args, ctx);
      return `Opened: ${out.trim().split(/\s+/).pop()}`;
    },
  },

  gh_issue_create: {
    risk: 'high',
    description: 'File an issue. The user is asked to confirm first, every time.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue description (Markdown)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply (must exist in the repository)' },
      },
      required: ['title', 'body'],
    },
    handler: async ({ title, body, labels = [] }, ctx) => {
      if (!String(title || '').trim()) throw new Error('gh_issue_create needs a `title`.');
      const refused = await confirmOrRefuse(ctx, '🐙 Open an issue on GitHub?', `${title}\n\n${clip(body, 1500)}`);
      if (refused) return refused;
      const args = ['issue', 'create', '--title', String(title), '--body', String(body || '')];
      for (const label of Array.isArray(labels) ? labels : []) args.push('--label', String(label));
      const out = await gh(args, ctx);
      return `Opened: ${out.trim().split(/\s+/).pop()}`;
    },
  },

  gh_comment: {
    risk: 'high',
    description: 'Comment on an issue or a pull request. The user is asked to confirm first, every time.',
    parameters: {
      type: 'object',
      properties: {
        number: { type: 'number', description: 'Issue or PR number' },
        on: { type: 'string', enum: ['issue', 'pr'], description: 'Whether `number` is an issue or a PR. Default issue' },
        body: { type: 'string', description: 'The comment (Markdown)' },
      },
      required: ['number', 'body'],
    },
    handler: async ({ number, on = 'issue', body }, ctx) => {
      if (!number || !String(body || '').trim()) throw new Error('gh_comment needs a `number` and a `body`.');
      const kind = on === 'pr' ? 'pr' : 'issue';
      const refused = await confirmOrRefuse(ctx, `🐙 Comment on GitHub (${kind === 'pr' ? 'PR' : 'issue'} #${number})?`, clip(body, 1500));
      if (refused) return refused;
      const out = await gh([kind, 'comment', String(number), '--body', String(body)], ctx);
      return `Commented: ${out.trim().split(/\s+/).pop()}`;
    },
  },
};

// ── commands ────────────────────────────────────────────────────────────────

function formatStatus(result) {
  if (typeof result === 'string') return result;
  if (!result.runs?.length) return result.note || `No workflow runs for ${result.branch}.`;
  const icon = c => ({ success: '✓', failure: '✗', cancelled: '⊘', skipped: '·' }[c] || '…');
  const lines = [`CI on ${result.branch} — run ${result.run.id} (${result.run.sha}): ${result.run.conclusion || result.run.status}`];
  for (const job of result.jobs) {
    lines.push(`  ${icon(job.conclusion)} ${job.name}${job.failedSteps.length ? ` — failed at: ${job.failedSteps.join(', ')}` : ''}`);
  }
  lines.push(result.run.url);
  if (result.run.conclusion === 'failure') lines.push('Ask the agent "why did CI fail?" — gh_ci_failure pulls the failing tests out of the logs.');
  return lines.join('\n');
}

export const commands = {
  ci: {
    description: 'The latest CI run on the current branch, job by job: /ci [branch]',
    handler: async (arg, ctx) => formatStatus(await tools.gh_ci_status.handler({ branch: String(arg || '').trim() || undefined, limit: 1 }, ctx)),
  },
  pr: {
    description: 'The pull request of the current branch: /pr [number]',
    handler: async (arg, ctx) => {
      const number = Number.parseInt(String(arg || '').trim(), 10);
      const pr = await tools.gh_pr_view.handler(Number.isFinite(number) ? { number } : {}, ctx);
      return [
        `#${pr.number} ${pr.title} — ${pr.state}${pr.review ? `, ${pr.review}` : ''}`,
        `${pr.branch} · ${pr.size} · ${pr.files.length} file(s)`,
        ...(pr.checks.length ? ['Checks:', ...pr.checks.map(c => `  ${c}`)] : []),
        pr.url,
      ].join('\n');
    },
  },
};

export const hooks = {
  onLoad: (api) => {
    api?.log?.('info', 'github ready — /ci and /pr, plus gh_ci_failure for why CI failed (needs the gh CLI, signed in)');
  },
};
