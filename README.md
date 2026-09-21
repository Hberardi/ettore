# ETTORE - Advanced AI CLI Assistant

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/node-18+-green" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="License">
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey" alt="Platform">
</p>

ETTORE is an advanced AI CLI assistant that helps with software engineering tasks. It's like having a smart assistant in your terminal.

## Features

- 🤖 **32 providers** - OpenAI, Anthropic, your Claude subscription, Gemini, Ollama (local), NVIDIA, Groq, DeepSeek, MiniMax, Kimi, OpenRouter — and any OpenAI-compatible endpoint
- 💻 **Tool Execution** - bash, read, write, edit, grep, glob, web search, web fetch, image inspection, delegated codebase search
- ✅ **Done means the tests pass** - when the agent changes code it runs your project's full test suite before handing the work back; a red suite goes back to the agent to fix, and it never reports "done" over failing tests ([details](#done-means-the-tests-pass))
- 🖱️ **Runs your apps** - opens web apps in a real browser (reads the browser console: errors, exceptions, failed requests) and launches desktop apps (captures stdout/stderr, screenshots, clicks and types) to reproduce bugs before fixing them
- 🎨 **Native TUI** - Custom ANSI renderer (no React/Ink) with themes and a sidebar
- 🖼️ **Vision** - Reads local images; agent can discover, download, and inspect public web images
- 📄 **Super OCR for PDF** - Extracts native text first, then automatically handles scanned and low-quality PDFs with preprocessing, deskew, denoise, adaptive thresholding, and multi-pass Tesseract OCR
- 🪟 **Linux, macOS and Windows** - shell commands, code search and file edits work natively on each; see [Platform support](#platform-support)
- 🔌 **Easy Setup** - `/connect <provider> <key>` or environment variables
- 💾 **Persistent Config** - API keys saved in a per-user config directory, `0600` on Linux/macOS ([details](#configuration))
- 🧠 **Context Tools** - compression, project memory, working memory, sessions, auto-approve
- ⚡ **Fast on every provider** - requests are shaped so the provider can reuse its prompt cache, context summaries are written by a fast model of the same provider, and `--verbose-tokens` reports time-to-first-token and cached tokens per call
- 🔍 **Delegated search** - `explore` answers one question about the codebase in a separate read-only context and returns a short report with `file:line` references; the greps and full-file reads behind it never enter the main conversation
- 📋 **Explicit Planning** - non-trivial tasks get a structured `<plan>...</plan>` block on the first turn, and its steps drive the progress panel and the auto-continue, so a plan left half-done is resumed instead of dropped
- 🧩 **Eight plugins included** - PostgreSQL, Excel, EDI over FTP, extended git, shell history, palette shortcuts — installed with `/plugins install`, and you can write your own

## Installation

### Option 1: npm (recommended)

```bash
# Install globally
npm install -g ettore-ai-assistant

# Verify installation
ettore --version
```

The package is published as `ettore-ai-assistant`; the command it installs is
`ettore`. (`npm install -g ettore` fetches an unrelated package by another
author.)

### Option 2: From source

```bash
# Clone or download
cd ettore-cli

# Linux / macOS
chmod +x install.sh
./install.sh
```

On Windows, install from the checkout with npm instead — `install.sh` needs a
POSIX shell:

```powershell
npm install -g .
```

> Paths written as `~/.config/ettore/…` below are the Linux and macOS form. On
> Windows the same directory is `C:\Users\<you>\.config\ettore\…`.

## Platform support

ETTORE runs on Linux, macOS and Windows. The differences are handled for you,
but two of them are worth knowing about.

### The shell the agent uses

The `bash` and `bash_session` tools run commands through the platform's shell:
**bash** on Linux and macOS, **PowerShell** on Windows. The model is told which
one it has, so it writes `Select-String` rather than `grep` and `;` rather than
`&&` when it is on Windows.

PowerShell is preferred over Git Bash even when Git Bash is installed: a `bash`
found on a Windows `PATH` is often WSL's, and that one cannot see `C:\…` the
way the caller means. To override:

```bash
# Use Git Bash instead (must be on PATH)
set ETTORE_SHELL=bash        # cmd
$env:ETTORE_SHELL = 'bash'   # PowerShell
```

Accepted values: `bash`, `pwsh`, `powershell`, `cmd`, or a path to a shell.

### Running it from a terminal that works

Git Bash and other MSYS terminals (mintty) do not give Node a real console
handle, so the TUI cannot start there and says so. Use **Windows Terminal**,
**PowerShell** or **cmd** — or stay in Git Bash and prefix the command:

```bash
winpty ettore
```

### What is not needed

Code search works without `ripgrep` or `grep` installed — there is a built-in
searcher underneath both, so `grep` and `repo_find_symbol` work on a bare
Windows box. Line endings are handled on both sides: editing a file checked out
with CRLF keeps it CRLF, so a two-line change stays a two-line diff.

Desktop automation is platform-aware too: on Windows it drives the GUI through
PowerShell (nothing to install), on Linux it needs `xdotool` or `ydotool` — see
[Requirements](#requirements).

## Tuning how hard the model thinks

Two settings decide how much room a turn gets. Both are optional, and both do
nothing on a model that does not support them. Set `effort` from the CLI with
`/config effort <level>` (add `--local` for this project only), or write either
of them into `.ettore/config.json` by hand:

```jsonc
{
  "effort": "xhigh",   // low | medium | high | xhigh | max
  "maxTokens": 32768   // ceiling on one turn's output
}
```

`effort` is unset by default, which means the API's own default. Raising it
buys depth on hard coding and agentic work and is paid in tokens — on a
subscription, in quota — so it is worth measuring on your own workload before
making it permanent. Lowering it to `low` is the cheaper direction and often
costs nothing on routine turns. Plan mode already runs a step lower than build
mode: it reads and reasons but writes nothing, so it is the one place a lower
setting is a saving rather than a trade. Context compression always runs at
`low` — it is summarisation, and an extra call on top of the turn that
triggered it.

`effort` reaches more than Claude: it is sent as `reasoning_effort` to OpenAI
o-series and GPT-5, to gpt-oss wherever it is hosted, and to Gemini 2.5+, and
as OpenRouter's `reasoning` field for the same models routed through it. It is
deliberately not sent to hybrid models, where any effort at all switches
thinking *on* and would make a `low` request slower than no setting at all. An
endpoint that refuses the field gets the request again without it.

`maxTokens` is a stop, not a target: you are billed for what the model writes,
not for the room it was given. It matters because on a model with adaptive
thinking the budget covers reasoning *and* the answer, so a ceiling tuned for
answers alone cuts the thinking off first. ETTORE now resolves it per model —
room to think where the model allows it, and a clamp where it does not, since
asking Claude 3 for 8192 is a rejected request rather than a longer answer.

## Staying up to date

At startup ETTORE asks npm whether a newer release exists and tells you when
there is one:

```
↻ A new version of ETTORE is available: 1.3.0 → 1.3.1. Run `ettore update` to upgrade.
```

The answer is cached in `~/.config/ettore/version-cache.json`. A known newer
version is kept for six hours, since re-asking about it changes nothing; "there
is nothing newer" is kept for thirty, because that is the answer a release
makes wrong the moment it is published. `ettore update` never reads the cache
at all, so it takes a release as soon as it lands.

ETTORE then installs it and restarts into the new build before running your
command, so an install stays current without being told to:

```
ettore 1.2.3
↻ ETTORE 1.2.3 → 1.2.4: installing…
✓ 1.2.4 installed — restarting
ettore 1.2.4
```

`ettore update` does the same thing on demand, and `--no-update-check` skips
the npm call altogether.

The install is skipped — and ETTORE tells you about the new version instead —
when:

- the new release is a **new major version**. A major bump is a declared breaking change, so it is taken deliberately with `ettore update`, never on a launch.
- stdout is not a terminal: a pipe, a script, a CI job. Nothing is installed behind your back.
- you passed `--no-auto-update`, or set `ETTORE_AUTO_UPDATE=0`. The flag outranks the environment, so a scripted run can refuse what a shell profile enabled.
- you are running a git checkout **with uncommitted work, or on a branch that tracks no remote**. A checkout is never updated through npm — that would replace your link with a registry copy — so it is fast-forwarded with git instead (below).

### A git checkout updates itself too

A development checkout used to have no automatic path at all: npm was refused,
correctly, and nothing took its place, so a linked install quietly stayed on
whatever commit it was on. It now takes the update that actually fits it —
`git pull --ff-only` — before anything else loads, then restarts into it:

```
ettore 1.3.6
↻ checkout fast-forwarded — restarting
ettore 1.3.7
```

Only when it is safe: a **clean** tree, on a branch that **tracks a remote**,
and **fast-forward only**, so no local commit can be lost and nothing is ever
pulled over work in progress. Untracked files don't count — a working
directory always has some. The pull is bounded (6s at startup, 12s on Windows),
so an unreachable remote costs a pause, not a hang, and `--no-auto-update` /
`ETTORE_AUTO_UPDATE=0` turn it off like everything else.

If the release you are running has been **deprecated** on npm, ETTORE says so
at startup, quoting the publisher's own message:

```
⚠ ETTORE 1.2.3 is deprecated: <the message the publisher set>
```

npm itself only shows that during an install, so a copy that was installed
once and never reinstalled would otherwise never hear about it.

## Quick Start

```bash
# Start interactive mode
ettore

# Or run a single prompt
ettore "Hello, create a hello world in Python"

# Analyze an image (repeat --image to attach up to four images)
ettore --image ./screenshot.png "Find the UI problem in this screenshot"

# Let the agent fetch and inspect a public image URL
ettore "Analyze the image at https://example.com/screenshot.png"
```

In the interactive TUI, attach a local image with `@path/to/image.png`. Quote paths
that contain spaces, for example `@"screenshots/home page.png"`. JPEG, PNG, GIF,
and WebP files up to 5 MiB are supported; the selected model must support vision.
For web pages, the agent can discover image URLs with `webfetch` and inspect them
through its protected `web_image` tool. Redirects and resolved addresses are
validated to block private-network access.

## Commands

Run `/help` inside the TUI for the full list. Most-used commands:

In the interactive CLI, press `Ctrl+O` or use the visible `📎 attach` control to
add local files and images to the next message. Images are sent multimodally;
documents, audio, video, and other files are passed to the agent with their
local path so it can choose the appropriate reader tool.

For Super OCR, install `tesseract-ocr` with the language packs you need (ETTORE
automatically uses `ita+eng` when both are available), plus Poppler's
`pdftotext`, `pdftoppm`, and `pdfinfo` commands. If OCR dependencies are not
installed, ETTORE keeps its native PDF and binary-text fallbacks.

| Command | Description |
|---------|-------------|
| `/connect <provider> [key]` | Connect a provider (`openai`, `anthropic`, `claude-code`, `ollama`, `openai-compat`, `minimax`, ...) |
| `/use [provider] [model]` | List connections, then set the active provider/model |
| `/disconnect [provider]` | Drop a saved connection |
| `/providers` | List supported providers and their default models |
| `/models [provider] [refresh\|stale]` | List models (with cache control) |
| `/status` | Show active provider, model, and config |
| `/doctor` | Diagnose setup, config, providers, and permissions |
| `/keys list\|add\|remove` | Manage saved API keys |
| `/reconnect [provider]` | Re-validate saved keys and reconnect |
| `/theme <name>` | Switch theme (`default`, `midnight`, `matrix`, `forest`) |
| `/auto-approve [edits\|installs] on\|off` | Skip approval prompts (sensitive commands still prompt) |
| `/config [key] [value] [--local]` | Show/set configuration; `--local` writes `.ettore/config.json` |
| `/config max-iterations <1-200> [--local]` | Set the agent loop budget (default: 50) |
| `/config max-tools <4-28> [--local]` | How many tool schemas reach the model per turn (default: 20) |
| `/config tool-routing on\|off [--local]` | Route a relevant subset per turn, or hand over every tool |
| `/config effort <low\|medium\|high\|xhigh\|max\|default>` | How hard the model thinks, on models that accept it |
| `/memory show\|add\|clear\|edit\|export\|path` | Persistent project memory |
| `/ecosystem show\|prune\|export\|path` | Learned playbook memory, reused across turns |
| `/skills list\|show\|create\|reload` | Global skills with automatic prompt activation |
| `/mission [status\|history\|clear]` | Live execution graph: plan, waves, tools, files, tokens |
| `/compress [preview\|apply\|auto\|stats\|threshold\|history\|undo]` | Manage context compression |
| `/compress model <id\|default\|main>` | Which model writes context summaries (default: a fast one from the same provider) |
| `/agent [stats\|memory\|clear]` | Inspect agent runtime memory |
| `/caveman [level\|off]` | Toggle compressed reply style (saves tokens) |
| `/approvals [list\|clear] [project\|system\|download]` | Inspect or reset session approvals |
| `/sessions` / `/resume` / `/new` | Session management |
| `/history [n]` | Show recent commands |
| `/alias list` | Show command aliases |
| `/team [create\|list\|show\|delete] [name]` | Multi-agent team orchestration |
| `/loop [start <goal>\|stop\|status\|list\|run\|clear]` | Run a goal repeatedly until it is done |
| `/video_music` | Open the music-video web studio (mp3 + photo → video) |
| `/plugins [list\|available\|install\|enable\|disable\|reload\|info] [name]` | Manage plugins; `install` with no name offers a picker |
| `/select [provider]` | Pick a model interactively |
| `/system` | Platform and runtime info |
| `/init` | Reload project memory and reset the conversation |
| `/version` | Show ETTORE version |
| `/help [command]` | Show help for a specific command |
| `/clear` | Clear the screen |
| `/exit` | Exit interactive mode |

## Global Skills

Skills are Markdown playbooks. They add focused instructions to the agent when
a prompt matches their description or triggers; they do not load or execute
JavaScript. Skills created through the web wizard are global and live in
`~/.config/ettore/skills/<name>/SKILL.md`, so they can be used in every project.

```bash
# in the TUI
/skills list
/skills create
/skills show api-review
/skills reload
```

`/skills create` opens ETTORE Skill Studio in the browser. The form asks for
the skill name, the workflow it should follow, and the final output format.

Each `SKILL.md` can use this frontmatter:

```markdown
---
name: api-review
description: Review REST API endpoints and contracts
triggers: endpoint, openapi, contract
enabled: true
---

Check validation, compatibility, and focused regression tests.
```

`triggers` are worth writing, and worth writing in the language you type your
prompts in. They are matched as substrings and weigh more than anything
inferred from the description, so they are what makes a skill fire reliably; a
skill with none depends on your prompt happening to reuse the words of its
description. A skill named in English will not match an Italian prompt on its
name alone.

ETTORE activates at most three matching skills per turn and keeps the base
safety rules and tool permissions higher priority than skill instructions. The
sidebar names the skills a prompt activated, or says `none of N` — a turn that
ran without the guidance you expected otherwise looks exactly like one that ran
with it.

## Mission Control

Mission Control tracks the current task directly in the TUI sidebar: plan
progress, parallel tool waves, changed files, decisions, and token usage.

```bash
/mission
/mission history
/mission clear
```

## Delegating a search

Finding an answer in a large codebase is cheap; what it leaves behind is not.
Twenty grep hits and six full file reads stay in the transcript for the rest of
the session, are re-sent on every turn, and are the first thing the context
compressor discards — so by the time the edit gets written, the context is full
of the search and short of the code.

`explore` moves that somewhere else. The agent hands it one question; it
investigates in a throwaway read-only context of its own and returns a short
report with `file:line` references. None of the searching reaches the main
conversation — only the answer does, and the report says so, so the agent opens
the files it cites before editing them rather than trusting evidence it never
saw.

It is for questions like *where is X implemented and who calls it*, *how does
the Y flow work end to end*, *which files would a Z change touch* — not for
something a single read of a path you already know would settle. It runs in plan
mode, so it cannot write, run commands or install anything; it cannot delegate
again; and it is bounded at twelve iterations and eight minutes.

You still see it working: the sub-agent's own `repo_map`, `grep` and `read`
calls scroll past in the running-tool display like any others, while the
`explore` call that started them stays open.

## Done means the tests pass

An agent that says "done" over a failing test suite is worse than one that does
nothing: you find out later, somewhere else. So when a turn in build mode
changes code, ETTORE does not let it end until the project's **full test suite
passes on the final code**.

1. The agent changes the code and is told to run the suite before finishing.
2. If it tries to finish without a green run on its latest edit, ETTORE runs the
   suite itself — you see `run_tests` in the running-tool display.
3. If any test fails, the failures go back to the agent as work still to do:
   find the cause, fix the code (not the test, unless the task changed that
   behaviour on purpose), run the suite again.
4. Only a green suite releases the answer: `✓ Test verdi`.

It counts only what really verifies the current code:

- **The whole suite.** A narrowed run — `pytest tests/test_x.py`, `-k`,
  `--grep` — is useful while working but does not release the code, because it
  cannot catch a regression somewhere else.
- **After the last edit.** Any change after a green run needs a new run.
- **The real result.** A failing run is a failure even when the exit code is
  hidden by a pipe (`npm test | tail`): the output is read too.

After five fix-and-rerun rounds the turn ends anyway, but the answer says so
plainly — *⚠️ Codice NON verificato: la suite di test è ancora rossa* — instead of
claiming success. Change the number of rounds in `.ettore/config.json`:

```json
{ "maxReleaseGateRetries": 8 }
```

| Project | What has to pass |
|---|---|
| `package.json` with a `test` script | `npm test` |
| `pytest.ini`, `conftest.py`, or pytest in `pyproject.toml` | `pytest` |
| `go.mod` | `go test ./...` |
| `Cargo.toml` | `cargo test` |
| No test suite | at least one check since the last edit — `node --check`, `py_compile`, running the program |
| Only docs or images changed | nothing |

If your suite is already red before the agent starts, every turn that changes
code will end with the warning: fix or skip those tests first.

### The agent sees the code it is fixing

A fix is only as good as what the model can see. Three things make sure it
sees it:

- **Reads arrive whole.** A `read` of a normal-sized range reaches the model
  complete. A very large one is cut only at the end, with the exact `offset` to
  continue from — never with a silent hole in the middle.
- **The working set is not forgotten.** In a long session, old tool output is
  shortened to save tokens, but the latest read of each file being worked on and
  the latest failing test output stay whole.
- **Test failures keep their tail**, where runners print the failing test and
  the summary.

And `edit` helps when it misses: a block copied with the wrong indentation still
applies, "not found" quotes the closest region of the file with line numbers,
and a successful edit shows the changed lines.

## Jev: a second opinion on when a turn is done

Every turn in build mode ends with a judgment: did the model *announce* work
without doing it, hand it back to you, show code instead of writing it — or is
the request genuinely finished? ETTORE answers that with regex over Italian and
English phrasing. It works, but wording is a proxy for meaning: a false yes
re-prompts a model that was already done, a false no ends a turn with the job
half finished.

[Jev](https://docs.typesafe.ai/introduction), TypeSafe's System One model, can
answer the same questions from meaning instead of wording. It does not generate
text — it evaluates typed questions against a state and returns structured
answers with calibrated probabilities. ETTORE asks all four questions in a
single request, evaluated in parallel.

```bash
/jev active <api key>      # turn it on (key from https://console.typesafe.ai/keys)
/jev status                # what is on, and which model
/jev test                  # check the key and the connection
/jev out                   # turn it off; add "forget" to delete the key
```

If you cannot reach the command — a script, a sandbox, or a CLI session that
was already running when Jev was installed — exporting the key is enough on its
own:

```bash
export TYPESAFE_API_KEY=sk-...
```

An explicit `/jev out` still wins over the variable, so turning the feature off
never means hunting down where the export lives.

With Jev on, one thing behaves differently rather than just more accurately:
**a turn can continue on its own without a declared plan.** Auto-continue
normally needs a `<todo>` list, and a model that writes "task completo"
suppresses it — so the work of restarting fell to you. Measured on real
sessions, 56% of the prompts sent were restarts rather than requests, the same
sentence typed 28 times. When Jev is sure the request has not been carried out,
and the turn actually ran tools, ETTORE continues by itself: at most three
rounds, and it stops the moment a round changes nothing.

Without Jev that branch does not exist. It is reached only through a decisive
verdict, and there is no verdict when Jev is off, unreachable or unsure, so
every user who never turns it on keeps exactly today's behaviour.

Three properties make it safe to leave on:

- **Jev decides, it never writes.** No text of its own ever reaches you or the
  transcript. It only answers yes/no questions about a turn that already
  happened.
- **It only overrides when it is sure.** A Noul answer near the middle — the
  model's way of saying "could go either way" — is discarded and the existing
  check stands. Jev can only change an outcome it is confident about.
- **Failure changes nothing.** No key, no network, a rate limit, a timeout:
  the turn proceeds on exactly the checks it used before, and you see one line
  saying Jev was unreachable.

To check it is really calling the API rather than showing a label, `/jev status`
reports the traffic: how many calls succeeded and failed this session, the
round-trip time, the tokens billed, and **which model answered** — that id
(`jev-1.13.0`) and the token counts come back from the server, so ETTORE cannot
print them without having made the call. `/jev test` does one call on demand
and reports the same.

When Jev does decide something, you see it: `◆ Jev (240ms) — lavoro annunciato
ma non fatto: sì`. An invisible decision layer would be worse than none.

The key is stored with the same encrypted store used for provider keys, and is
never written to disk in plaintext or echoed back in full. `/jev out` keeps the
key so you can switch it back on without retyping; `/jev out forget` deletes it.

## Plugins

ETTORE ships eight plugins and can load your own. A plugin adds **tools** the
agent can call and **slash commands** you can type — they merge with the
built-in set rather than replacing it.

```bash
# in the TUI
/plugins available             # what is installed, and what ships with ETTORE
/plugins install               # pick one from a list; installed and enabled
/plugins install pgadmin       # or name it outright
/plugins list                  # what is enabled right now
/plugins info pgadmin          # what it adds
/plugins disable pgadmin
```

### What ships

| Plugin | Adds | Needs |
|---|---|---|
| **pgadmin** | PostgreSQL from the terminal: list and describe databases, schemas, tables, views, indexes, constraints and functions; run queries; `EXPLAIN`/`ANALYZE`; `pg_dump` and `pg_restore`, the latter through a local web wizard | `pg` |
| **excel-full** | Read, create and edit `.xlsx`: formulas, cell styles, number formats, sheet management, charts, one-page reports | `exceljs`, `pureimage` |
| **edi-ftp** | EDI files over FTP, FTPS or SFTP: list a remote directory, fetch or peek a file, inspect an undocumented tracciato, and parse fixed-width, delimited or EDIFACT/X12 into records — with a saved layout or with the structure inferred. Connection profiles are stored locally, password encrypted at rest | — for FTP/FTPS; `ssh2`, installed separately, for SFTP |
| **git-helpers** | Beyond the built-in `git_status` / `git_diff`: blame, log, diff stat, branch audit | — |
| **git-history** | Read-only history: commit log, line-range blame grouped by change, single-commit inspection | — |
| **bash-monitor** | Times every shell command, warns on slow ones, keeps a queryable history | — |
| **command-palette-shortcuts** | `/last-bash`, `/kill-bash`, `/replay-last`, `/where` | — |
| **hello-world** | The minimal shape of a plugin, to copy from | — |

The dependencies are declared as `optionalDependencies`, so a normal
`npm install` brings them and a plugin whose dependency is missing says which
one rather than failing obscurely.

### You can see when a plugin is running

A tool from a plugin is marked wherever tools are shown — the running-tool
line, the sidebar, the one-shot output, and the `/mission` summary:

```
○ pg_query ⧉pgadmin [2s]
✔ git_log ⧉git-helpers
✔ read
```

A built-in gets no badge. Running code you installed yourself is worth seeing,
and it is what tells you which tool to blame when something misbehaves.

### Which tools reach the model

The agent is offered a bounded set of tools each turn — 20 by default, out of
nearly forty. What the prompt asks for decides the **order**; it does not decide
what exists. Whatever the prompt looks like, the agent always has the tools to
find code, change it, and run something; whatever slots are left over are filled
with the tools whose absence hurts most, and only the priced or narrowly
specialised ones (music-video generation, desktop automation) wait to be asked
for by name.

That distinction matters more than it sounds. Asked "controlla se il progetto
compila", an agent routed purely by keyword gets no shell, no `run_checks` and
no `run_tests` — and answers by reading the source and guessing, confidently.

Plugin tools take a guaranteed share of the set and are ranked by how well their
name and description match the request, so asking about a database restore
surfaces `pg_restore_wizard` rather than whichever plugin happened to load first
— and the core toolset is never crowded out.

Plan mode is read-only, and that is enforced by the router, not by the prompt:
nothing that writes, runs a command or launches a process is offered there. Since
ETTORE cannot inspect what a plugin's handler does, a plugin tool is offered in
plan mode only if it declares `risk: 'low'`, which is the author stating that it
does not write.

Raise or lower the budget with `/config max-tools <4-28>` (add `--local` to
keep it to this project), or set `"maxToolsPerRequest"` in
`.ettore/config.json` directly. `/config tool-routing off` hands the model
every tool instead.

### Writing one

A plugin is a directory under `~/.config/ettore/plugins/<name>/` (override with
`ETTORE_PLUGINS_DIR`) containing:

1. **`plugin.json`** — the manifest: `name`, `version`, `apiVersion`, `main`,
   optional `description` / `author` / `license` / `permissions`.
2. **`<main>`** (default `index.js`) — an ES module exporting `tools`,
   `commands`, and `hooks` (`onLoad`, `onUnload`).

```js
export const tools = {
  say_hello: {
    description: 'Greet someone by name.',
    risk: 'low',                       // admits it to plan mode
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async ({ name }, ctx) => `Hello, ${name} — from ${ctx.plugin}.`,
  },
};
```

It is an ES module: use `import`, and `createRequire(import.meta.url)` if you
need to reach an optional dependency. Handlers receive a controlled `ctx`
(`{ plugin, tool, signal, workspace, agentMode, safetyProfile }`) and never see
the agent's internals. `examples/plugins/README.md` has the full guide and the
reserved tool names a plugin cannot override.

**A plugin runs with your privileges.** The `permissions` in the manifest state
intent; they are not a sandbox. Enabling a plugin is the moment you decide to
run its code, so read one you did not write, as you would any script.

An installed plugin is a copy: the one under `~/.config/ettore/plugins/` is what
runs, and it does not change when a new ETTORE ships a newer version of it.
`/plugins available` says which copies have fallen behind, and
`/plugins install <name> --force` updates one.

## Examples

```bash
# Start interactive mode
ettore

# Run a single prompt
ettore "Hello, create a hello world in Python"

# Connect a provider (API key optional for Ollama)
ettore /connect openai sk-...
ettore /connect anthropic sk-ant-...
ettore /connect ollama                # local, no key
ettore /connect claude-code           # Claude subscription, no key

# Select active model
ettore /use openai gpt-4o
ettore /use openai gpt-5.6-luna       # fast, cost-efficient OpenAI model

# One-shot with image and provider
ettore --provider openai --image ./screenshot.png "Find the UI problem in this screenshot"
```

## Debugging a running application

ETTORE does not have to guess from the source why an app misbehaves — it can
open the app and watch it break.

**Web apps** — `browser_app` drives a real Chrome/Chromium over the DevTools
Protocol and keeps every console message, uncaught exception, failed request
and HTTP 4xx/5xx in a buffer:

```
open a browser on http://localhost:3000, click "Salva" and tell me what the console says
```

The agent runs `browser_app` `open` → `snapshot` → `click`/`type` →
`console`/`errors`/`network`, fixes the code, then `reload`s and re-reads the
console. Every click and keystroke already reports the console errors it just
caused. `localhost` is allowed (unlike `browser_check`, which only fetches
public pages). `action="attach"` with `port=` connects to an app that is
already running with `--remote-debugging-port` — that is how the renderer
console of an Electron desktop app is read.

**Desktop apps** — `desktop_app` starts a GUI program while capturing its
stdout/stderr (tracebacks, crashes, Qt/GTK criticals), lists and screenshots
its windows, and clicks/types into it:

```
start "python3 app.py", click Save and show me the error it prints
```

Screenshots are written to `.ettore/screenshots/` (gitignored). Both tools
clean up their processes when the CLI exits.

## Configuration

API keys live in a per-user config directory. Use `/keys` to manage them, and
`ETTORE_CONFIG_DIR` to point somewhere else for tests or CI.

| Platform | Location | Protection |
|---|---|---|
| Linux, macOS | `~/.config/ettore/keys.json` | directory `0700`, file `0600` |
| Windows | `C:\Users\<you>\.config\ettore\keys.json` | the ACL your user profile already carries — NTFS has no POSIX mode bits, so the `chmod` is skipped there |

For env-only usage, set the provider key before starting ETTORE. The variable
names are the same everywhere; only the syntax differs:

```bash
# Linux / macOS
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export OPENROUTER_API_KEY=sk-or-...
export MINIMAX_API_KEY=...
ettore
```

```powershell
# Windows PowerShell
$env:OPENAI_API_KEY = 'sk-...'
ettore
```

```bat
:: Windows cmd
set OPENAI_API_KEY=sk-...
ettore
```

Prefer environment variables or `/connect` over `--api-key`; command-line
arguments can be exposed in shell history and process lists.

Other variables ETTORE reads: `ETTORE_SHELL` (which shell the agent's commands
run in — see [Platform support](#platform-support)), `ETTORE_CHROME_BIN`,
`ETTORE_AUTO_UPDATE`.

### Claude without an API key

The `claude-code` provider reaches your Anthropic account through the Claude
Code CLI that is already logged in on this machine, so no key is stored and
usage draws on your Claude subscription instead of API credit.

```bash
npm i -g @anthropic-ai/claude-code   # if not installed yet
ettore /connect claude-code          # signs you in if you are not already
ettore /use claude-code sonnet       # or opus, opusplan, claude-opus-5, ...
```

If no Anthropic account is signed in yet, `/connect claude-code` hands the
terminal to `claude auth login` and reconnects when the browser flow finishes.
Once connected it prints which account and plan the session will draw on.

Models: the aliases `sonnet`, `opus`, `haiku`, `opusplan` and `default` always
resolve to the current model of that tier; pinned ids (`claude-opus-5`,
`claude-sonnet-4-6`, …) are listed too, and `/use claude-code <id>` accepts any
id the CLI knows, listed or not. Models billed against usage credits rather
than the subscription (`claude-fable-5`, `sonnet[1m]`) are flagged in the
picker.

ETTORE drives `claude --print` as a bare model: its own tools, MCP servers,
settings and slash commands are disabled, and ETTORE's system prompt and tools
replace them. On a headless machine, `claude setup-token` or
`CLAUDE_CODE_OAUTH_TOKEN` work too; point `ETTORE_CLAUDE_BIN` at the binary if
it is not on `PATH`.

Compared with an API key, this transport drops image attachments and offers no
`temperature` control. Prompt caching does apply despite each turn being a
fresh headless session: measured on a warm turn, 12,300 of ~12,306 prompt
tokens came back as a cache read. The output ceiling is set for you and can be
overridden with `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, and `effort` is passed through
to the CLI on models that accept it.

## Requirements

- Node.js 18+ (Node 22+ for `browser_app`, which uses the built-in WebSocket client)
- Linux, macOS or Windows — tested on CI against Node 20 and 22 on Linux and Windows
- An API key for OpenAI, Anthropic, or another supported provider (Ollama runs locally and `claude-code` reuses your Claude login — both without a key)

Bundled plugins declare their own dependencies as `optionalDependencies`, so
`npm install` brings them. `pgadmin` also needs `psql`, `pg_dump` and
`pg_restore` on `PATH` for the dump and restore tools; everything else in it
works without them.

Optional, only for driving applications. On **Windows** none of this needs
installing: the desktop backend drives the GUI through PowerShell, which ships
with the OS, and Chrome or Edge is found wherever the installer put it —
including a non-admin install under `%LOCALAPPDATA%`.

| Capability | Needs (Linux/macOS) | Install (Debian/Ubuntu/Mint) |
|---|---|---|
| Web apps + browser console (`browser_app`) | Chrome or Chromium | `sudo apt install chromium` (or set `ETTORE_CHROME_BIN`) |
| Desktop windows: list/focus (`desktop_app`) | wmctrl or xdotool | `sudo apt install wmctrl` |
| Desktop screenshots | ImageMagick, gnome-screenshot, scrot… | `sudo apt install imagemagick` |
| Desktop clicks and typing | xdotool (X11) / ydotool (Wayland) | `sudo apt install xdotool` |
| Headless desktop apps (no display) | Xvfb | `sudo apt install xvfb` |

`desktop_app` with `action="capabilities"` reports which of these are present on
the current machine.

## Development

```bash
npm test
npm run lint
python3 test_display.py
```

Run `python3 test_display.py` after TUI rendering changes. It should finish with
`Total issues: 0`.

Before publishing a release, run the complete release gate:

```bash
npm run release:check
```

This command runs the full test suite, ESLint, and the TUI layout validator.
`npm publish` runs the same gate automatically through `prepublishOnly`; a
regression blocks publication. Releases tagged as `v*` also execute the gate in
GitHub Actions and validate the package contents with `npm pack --dry-run`.

## License

MIT
