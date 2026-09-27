# github

GitHub from the agent: CI runs and why they failed, pull requests, issues — and,
with your confirmation each time, opening a pull request, filing an issue or
commenting.

## Setup

It drives the [GitHub CLI](https://cli.github.com), so it needs `gh` installed
and signed in:

```bash
gh auth login          # or: export GH_TOKEN=...
```

Then, in ETTORE:

```
/plugins install github
```

It works in whatever repository ETTORE is running in; `gh` finds it from the git
remote.

## Tools

| Tool | What it does | Asks first |
|---|---|---|
| `gh_ci_status` | Recent runs of a branch (the current one by default) and the jobs of the latest, with the steps that failed | — |
| `gh_ci_failure` | Why a run failed: for each failed job, the failing tests and their errors, pulled out of the job log | — |
| `gh_pr_view` | A pull request: description, changed files, reviews, conversation, checks | — |
| `gh_pr_list` / `gh_issue_list` | Open (or closed, or all) pull requests and issues | — |
| `gh_issue_view` | An issue with its whole discussion | — |
| `gh_pr_create` | Open a pull request for the current branch (already pushed) | every time |
| `gh_issue_create` | File an issue | every time |
| `gh_comment` | Comment on an issue or a pull request | every time |

`gh_ci_failure` reads the formats the common test runners print — Node's TAP,
pytest, Jest, Go — and GitHub's own `##[error]` annotations; from a log in none
of them it returns the last lines, so there is always something to go on. It
keeps the report small: a few thousand characters instead of a log of thousands
of lines.

## Commands

- `/ci [branch]` — the latest run on the branch, job by job.
- `/pr [number]` — the pull request of the current branch, or the one given.

Both also work from the shell: `ettore /ci`.

## Safety

The reading tools are `risk: 'low'`: they change nothing and are available in
plan mode. The three that publish act outside the project and in your name, so
each one asks for your confirmation — whatever `/auto-approve` is set to — and
is refused when there is no interactive session to ask in. `gh` is always run
with an argument array, never through a shell, so a title or a branch name
cannot turn into a command.
