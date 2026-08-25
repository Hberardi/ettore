# Changelog

All notable changes to ETTORE are documented in this file. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/) and the
project is in pre-1.0 territory, so breaking changes are routine and
documented under the `Changed` heading rather than the Semantic Versioning
`BREAKING` tag.

## [Unreleased]

## [1.1.1] — 2026-08-24

### Fixed — a `read` loop no longer burns the whole turn

Two defects turned a model stuck on one file into a lost turn: a real
session ended with `Tool-call limit reached for this turn (80)` after 81
consecutive `read` calls, discarding everything the turn had already done.

- **`read` had no loop brake.** It is deliberately outside
  `LOOP_GUARDED_TOOLS` — re-reading a *different* range is legitimate work,
  so it cannot be deduplicated on the second call like a `grep`. But the
  same range over an unchanged file can never return anything new. `read`
  now has a repeat budget (`REPEAT_BUDGET_TOOLS`): two identical calls pass,
  the third is refused with an instruction to use the content already in
  context, read a different range, or act on it. The check compares the
  file's size+mtime fingerprint — the same one the read cache keys on — so a
  file changed by a shell command or an external editor (neither of which
  moves `workspaceRevision`) is still re-readable.
- **Hitting the tool-call ceiling was fatal instead of graceful.** Every
  other loop brake in the turn loop (duplicate batches, read-only streaks,
  invalid tool-call streaks, the iteration ceiling) grants one text-only turn
  so the model can report what it found; the tool-call budget alone emitted
  an error and returned, throwing away up to `maxToolCallsPerTurn` tool calls
  of real work. The first breach now rejects the offending batch without
  persisting its assistant `tool_calls` (a dangling tool_call makes strict
  providers such as MiniMax fail the next request with error 2013), queues
  the `tool_loop_finalize` overlay and lets the model close the turn. The
  hard error survives only for a second breach, i.e. a model that keeps
  calling tools after being sent an empty tool list.

Tests: `tests/agent-tool-call-limit.test.js` (soft landing completes the turn;
second breach still fails loudly) and `tests/agent-tool-loop-recovery.test.js`
(read budget, fingerprint change, and a non-regression on the strict guard).


## [1.1.0] — 2026-08-24

### Added — the agent can open and drive real applications

Two new tools let the agent reproduce a bug in the running product instead of
inferring it from the source.

`browser_app` (`src/tools/browser-driver.js`) drives Chrome/Chromium over the
DevTools Protocol — raw CDP over Node 22's built-in WebSocket, no new
dependency. It launches (or attaches to) a browser, navigates, lists the
clickable elements, clicks, types, presses keys, evaluates JavaScript, and
takes screenshots. Throughout, it buffers **the browser console**: console
API calls, uncaught exceptions, browser log entries, failed requests and HTTP
4xx/5xx responses, each with source URL, line and stack. Every interaction
reports the console errors it just produced, and `console`/`errors`/`network`
read the buffer on demand (`since_last` for just the new ones). `localhost`
is allowed, unlike `browser_check`. `action="attach"` connects to any app
already running with `--remote-debugging-port`, which is how an Electron
app's renderer console is read.

`desktop_app` (`src/tools/desktop-app.js`) launches a GUI application while
capturing its stdout/stderr — where tracebacks, crashes and GTK/Qt criticals
appear — and extracts the suspicious lines with their stack context. It
lists, focuses and screenshots the app's windows (matched through the whole
process subtree, since GUI processes are usually grandchildren of the spawned
command) and injects clicks, text and key combinations. Backends are probed
at runtime: wmctrl/xdotool for windows, ImageMagick/gnome-screenshot/scrot/
spectacle/grim for screenshots, xdotool (X11) or ydotool (Wayland) for input,
Xvfb when there is no display. Whatever is missing produces an explicit
"install this" message instead of a silent failure; `action="capabilities"`
reports the whole picture up front.

Both tools keep per-id sessions, so several apps can be driven at once, and
kill their processes on exit/SIGINT like `bash-session.js`.

Integration: handlers and schemas in `src/tools/index.js`, routing through
`RUNTIME_TOOLS` and a widened runtime intent regex in
`src/agents/tool-router.js`, debugging playbooks in
`src/agents/prompts.js`, 180s timeouts in `src/agents/index.js`, screenshot
path rules plus a safe-profile block on `desktop_app open` in
`src/tools/workspace-policy.js`, reserved plugin names in
`src/plugins/manifest.js`, colours and Italian intent labels in `src/app/`.
Tests in `tests/app-driver.test.js`.


### Added — explicit pre-execution planning

For non-trivial tasks (multi-sentence prompts, long descriptions, or
prompts matching trigger words like "refactor" / "implement" / "migra"),
the agent now nudges the model to emit a structured `<plan>...</plan>`
block on its first turn. The plan rides on the existing first-turn
response — no extra LLM call, no extra latency — and is surfaced via a
new `plan` event the TUI can render in a dedicated panel.

Components:

- `src/agents/planner.js` — heuristic (`shouldPlanExplicitly`),
  `PLANNING_REMINDER` prompt, and `extractPlan` parser (strict JSON,
  loose JSON with trailing-comma / single-quote tolerance, markdown-list
  fallback).
- `src/agents/stream-parser.js` — `PLAN_BLOCK_RE` / `PLAN_CAPTURE_RE`
  regexes, `stripPlanBlock` helper, and partial-tag holdback extended to
  backslash-escaped closing tags (e.g. `<\/plan>` emitted by some models).
- `src/agents/index.js` — `Agent.run()` pushes `PLANNING_REMINDER` when
  the heuristic fires; the streaming parser and the final-result path
  both extract the plan and emit `plan`; `workingMemory.plan` is
  populated for cross-turn context.

Config knobs:

- `requireExplicitPlan`: `true` / `false` (default: auto-detect)
- `explicitPlan`: `"off"` / `"never"` / `"always"`
- `mode === "plan"` always plans

### Added — local plugin system

A first-class plugin system transforms ETTORE from a single product into
a platform. Plugins live in `~/.config/ettore/plugins/<name>/` (override
with `ETTORE_PLUGINS_DIR`) and ship two files: a `plugin.json` manifest
and an ESM entry-point module. The system covers discovery, validation,
lifecycle, conflict detection, and runtime registration — and it is now
fully wired into the agent.

Components:

- `src/plugins/manifest.js` — strict schema validation for `plugin.json`
  (kebab-case names, semver, `apiVersion`, anti path-escape, known
  permissions) and the plugin module exports (tools, commands, hooks).
- `src/plugins/loader.js` — disk discovery, manifest reading, dynamic
  import, anti-symlink entry-point resolution.
- `src/plugins/registry.js` — tool/command/hook merging with conflict
  detection. Plugin handlers are wrapped in a controlled context so
  the plugin sees only what its declared permissions allow.
- `src/plugins/runtime.js` — `boot()`, `enable(name)`, `disable(name)`,
  `reload(name)`, plus the `api` object passed to `onLoad` hooks.
- `src/plugins/index.js` — public entry point.
- `examples/plugins/hello-world/` — minimal example plugin with two
  tools, one slash command, one lifecycle hook.
- `examples/plugins/README.md` — guide for plugin authors.

Agent integration:

- `src/agents/index.js` — `Agent` now accepts `config.pluginRegistry`.
  When present, the agent merges plugin tools and handlers with the
  built-in set; the merged view is cached for the agent's lifetime.
  Without a registry, behavior is byte-identical to the previous
  baseline (no regressions).
- `src/commands/index.js` — new `/plugins` command with six
  sub-commands: `list`, `available`, `enable <name>`, `disable <name>`,
  `reload <name>`, `info <name>`. Alias: `plugin`. After enable /
  disable / reload the command triggers a `rebuildAgent()` so the new
  tool set is in effect on the next turn.
- `src/app/native-ui.js` — bootstraps the `PluginRuntime` at session
  start, reports successful / failed plugin loads as system messages,
  and wires `pluginRuntime` + `rebuildAgent` into the command
  context.
- `src/cli/index.js` — same bootstrap for the one-shot CLI. A broken
  plugin is logged to stderr without aborting the run.

Test coverage:

- 24 new unit tests for the planner (`tests/planner.test.js`).
- 17 new unit tests for manifest validation
  (`tests/plugins-manifest.test.js`).
- 10 new unit tests for the plugin registry
  (`tests/plugins-registry.test.js`).
- 14 new integration tests for the loader and runtime
  (`tests/plugins-loader-runtime.test.js`).
- 14 new command-handler tests for `/plugins`
  (`tests/commands-plugins.test.js`).
- 6 new agent-integration tests verifying that plugin tools are
  exposed, routed, and that handler errors are surfaced correctly
  (`tests/agents-plugin-integration.test.js`).

### Added — automatic decision log

The agent now tracks important decisions in `workingMemory.decisions`
(capped at 32 entries, FIFO eviction) and emits a `decision` event for
the TUI. The model opts in by emitting `<decision>...</decision>`
blocks; the streaming parser strips the block from the visible reply
and feeds the body to working memory. Combined with the planning flow
above, this gives the user a complete trace of WHY the agent took each
step, not just WHICH steps it took.

Components:

- `src/agents/stream-parser.js` — `DECISION_BLOCK_RE` and
  `DECISION_CAPTURE_RE` regexes (case-insensitive, whitespace-tolerant,
  no leading-`g` on the block matcher to keep tests stateful-safe;
  the capture regex carries `g` because it is consumed by `matchAll`).
- `src/agents/index.js` — `Agent` populates
  `workingMemory.decisions` from both the streaming path
  (`onToken`) and the non-streaming fallback, and exposes the
  array via `getWorkingMemorySnapshot()`.

Test coverage: 10 unit + integration tests in
`tests/decision-log.test.js` covering the parser, the streaming path,
the cap, the truncation at 1000 chars, and the empty-block edge case.

### Added — post-mutation self-critique

After every mutation tool call (`write`, `edit`,
`apply_patch_structured`, `bash`, `bash_session`, `memory_write`) the
agent emits a `critiqueCheck` event with a one-line summary, the
sanitized args, the output excerpt, and a `passed` flag. The check is
intentionally cheap: no extra LLM call, no blocking, no automatic
retry — it is a hook for the TUI to display "I just edited X" or "the
last bash failed" without re-running anything, and a foundation for
future reflective loops.

Components:

- `src/agents/index.js` — `MUTATION_TOOL_NAMES` set; helpers
  `_isMutationTool`, `_safeArgsForCritique` (redacts
  `content` / `new_string` / `old_string` to size placeholders,
  truncates other long strings to 200 chars), and
  `_summarizeMutationOutput` (one-line "✓ wrote X" / "✗ edit failed: ..."
  for the TUI). The event is emitted right after
  `_recordToolExecution`, so it sees the final recorded output.

Test coverage: 10 unit tests in `tests/self-critique.test.js`
covering every mutation tool, the read-only skip list, the redaction
behavior, the long-bash-command truncation, and the multi-mutation
case.
