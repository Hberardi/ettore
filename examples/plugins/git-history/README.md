# git-history

Three read-only tools that let the agent ask what the repository *used to*
look like.

```bash
cp -r examples/plugins/git-history ~/.config/ettore/plugins/
# then, in the TUI
/plugins enable git-history
```

## Why it exists

ETTORE ships `git_status` and `git_diff`. Both describe the working tree as it
is now. Nothing answers **"why is this code like this"** — and that is the
question that decides whether a change is safe, because a line looks wrong right
up until you find the commit that says it is load-bearing.

The agent can already reach git through `bash`, which is exactly the problem.
Shell git is a moving target for a model: the porcelain differs between
subcommands, quoting a path with a space is easy to get wrong, `-L` takes a
syntax nothing else uses, and a forgotten `--no-pager` on a terminal hangs. A
named tool with a typed schema is chosen deliberately and validated before it
runs.

## Tools

| Tool | Answers |
|---|---|
| `git_log` | When did this change, who has been working here, what is in this change set. Filters: `path`, `limit`, `author`, `since`, `grep`. Follows renames. |
| `git_blame` | Who last touched these lines, and in which commit. |
| `git_show` | What one commit says and does. `diff: true` adds the patch. |

Plus `/history [path]` in the TUI, a ten-line summary for a human.

`git_blame` groups consecutive lines from the same commit, so the answer reads
as a handful of changes rather than one row per line:

```json
{ "file": "src/skills/index.js", "range": "13-22",
  "changes": [
    { "lines": "13-22", "sha": "e774cbcb", "author": "Ettore Berardi",
      "date": "2026-09-05", "summary": "Fix skill matching, which was wrong in both directions" }
  ] }
```

## What it will not do

**Nothing is written.** No `commit`, no `checkout`, no `reset` — the plugin has
no code path that changes a repository, which is why it is safe to enable and
forget about.

**Paths cannot leave the workspace.** `../../etc/passwd` and `/etc/passwd` are
refused before git sees them. git would refuse most escapes on its own, but
leaving the boundary to git puts it in git's hands, and the failure would read
as a git error rather than as a refusal.

**No shell.** Every call goes through `execFile` with an argument array, so a
ref or a path cannot become a command however it is spelled.

Output is bounded: `limit` is clamped, blame defaults to a 200-line window, and
a patch over 60KB is truncated with a note suggesting `path` to narrow it.

## Errors

git's own message is passed through rather than replaced. `fatal: ambiguous
argument 'zzz': unknown revision or path not in the working tree` tells the
model what to do next; "git failed" does not.
