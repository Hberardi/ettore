# Changelog

All notable changes to ETTORE are documented in this file. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/) and the
project is in pre-1.0 territory, so breaking changes are routine and
documented under the `Changed` heading rather than the Semantic Versioning
`BREAKING` tag.

## [Unreleased]

### Added — a `git-history` plugin, and a real example of what one is for

`git_status` and `git_diff` describe the working tree as it is. Nothing
answered "why is this code like this", which is the question that decides
whether a change is safe to make.

The plugin adds `git_log`, `git_blame` and `git_show`, all read-only. The agent
could already reach git through `bash`, and that is what it replaces: shell git
is a moving target for a model — porcelain that differs per subcommand, `-L`
syntax nothing else uses, a forgotten `--no-pager` that hangs on a terminal — 
where a typed schema is chosen deliberately and validated first. `git_blame`
groups consecutive lines from one commit, so its answer is a handful of changes
rather than one row per line.

Every call goes through `execFile` with an argument array rather than a shell
string, and paths are refused before git sees them if they leave the workspace.

It also serves as the example `hello-world` could not be: a plugin worth
installing, rather than a demonstration of the file layout.

### Added — bundled plugins can actually be installed

A bundled plugin used to reach nobody. `files` in package.json listed `bin`,
`src` and the README, so `examples/` was never published: an npm install
carried no plugins at all. And installing one meant copying a directory by
hand, from a path inside the global npm prefix that a user has no reason to
know.

`examples/plugins` is now published, `/plugins available` lists what ships
with ETTORE alongside what is on disk, and `/plugins install <name>` copies
one into place and enables it in a single step. Installing over an existing
copy is refused unless forced, since a plugin on disk may have been edited.

`/plugins install` with no name opens a picker — the same selection overlay
the loop planner uses — rather than asking you to retype a name you just read
in a listing. Where nothing can answer a prompt, such as a pipe or a one-shot
run, it prints the usage line and the available names instead: a picker nobody
can answer is a hang rather than a question.

## [1.3.2] — 2026-09-05

### Changed — updates install themselves again

1.3.0 made automatic installation opt-in. That was the wrong call and this
reverses it.

The reasoning was a poisoned version cache that had claimed the latest release
was `2.88.2` — another package's metadata entirely — and under the old default
that was one plausible digit from being installed. But two other guards shipped
in the same release, and **either one alone stops it**: the cache now records
which package it describes, so that entry is discarded unread, and a new major
version is never installed unattended, so 1.2.4 → 2.88.2 is refused even with
the feature fully on.

The opt-in was a third net over a hazard already caught twice, and it cost the
thing the feature exists for. An install that has to be told to update is one
that stays behind: every machine running 1.3.0 or 1.3.1 stopped following
releases and needs one manual `ettore update` to rejoin.

Installs on 1.2.x were never affected — they still carry the old default and
will pick this up on their own, and keep following from here.

`--no-auto-update` and `ETTORE_AUTO_UPDATE=0` still turn it off, and the flag
outranks the environment. The major-version guard stays: a 2.0.0 will still
wait for a deliberate `ettore update`.

### Fixed — the update banner named a command that refuses where it was printed

On a git checkout the banner said "Run `ettore update` to upgrade", and
`ettore update` refuses on a checkout: installing the published build would
put a separate copy over the link and disconnect the CLI from the repo. The
advice sent the reader to a command that exits 1 to explain why it will not
run. It now names `git pull` there, and `ettore update` everywhere it works.

## [1.3.1] — 2026-09-05

### Fixed — the README described behaviour the code no longer had

npm renders this file as the package page, so a stale claim there is the first
thing a prospective user reads. Three had gone out of date: the skill cap (two,
now three), and two of the three stated limitations of the Claude Code
transport — prompt caching does apply to it (12,300 of ~12,306 prompt tokens
came back as a cache read on a warm turn) and the output ceiling is now set,
and overridable. The skills section also now says the thing that decides
whether a skill fires at all: write `triggers`, in the language you prompt in.

### Fixed — a machine that checked just before a release kept reporting itself current

The version cache held one answer for six hours, but the two answers it can
hold do not decay alike. "1.3.0 exists" only becomes more true with age.
"There is nothing newer" stops being true the instant something is published,
and then stays wrong for the rest of the window.

Which is exactly what happened to 1.3.0: machines that had checked in the six
hours before it went out went on saying they were up to date, with the release
already on npm.

A cached "nothing newer" now expires after 30 minutes; a cached newer version
still holds for six hours, since re-asking about it is wasted work. `ettore
update` was never affected — it calls npm directly and ignores the cache
entirely, which is the way to take a release the moment it lands.

## [1.3.0] — 2026-09-05

### Upgrading from 1.2.x — read this one first

Automatic installation of updates is now opt-in, which has a consequence
worth stating plainly: if you are on 1.2.x with the old default, **this is
the last release that will install itself**. From here on a new version is
reported and you run `ettore update` to take it, or you pass `--auto-update`
/ set `ETTORE_AUTO_UPDATE=1` to keep the old behaviour.

The reason is below under "installing an update is opt-in": a version cache
found in the wild claimed this package's latest release was `2.88.2`, which
was another package's metadata entirely, and the old default was one
plausible digit away from installing it.

### Fixed — `bash` appeared to hang on commands that had already finished

`child_process.exec` settles when the child's stdout and stderr reach EOF,
not when the child exits. Anything a command leaves running in the background
inherits those pipes and holds them open, so the tool waited out its entire
timeout on a command that was already done:

```
sleep 20 & echo started        →  5023ms with a 5s timeout (120s by default)
sleep 20 >/dev/null & echo     →    10ms, same command, stdout redirected
```

The difference is only who holds stdout, which is why "the CLI hangs on
bash" and "bash works fine" were both true depending on the command —
starting a dev server, a watcher, or anything with `&` took the first shape.

`bash` now waits for the process rather than for its pipes (`exit`, with a
short grace period for output still in flight, falling back to `close` when
it comes first). The same case now returns in 192ms.

Three things came with it:

- stdin is closed on the child instead of redirected inside the command string, so a command that reads it gets EOF whatever quoting or heredoc it uses.
- A timeout signals the whole process group, so a runaway build no longer leaves its children behind.
- A non-zero exit is reported with its output and `[exit code N]` rather than raised as an error, since what the command printed is usually the answer.

### Fixed — skills matched the wrong prompts, in both directions at once

Skills are activated automatically on every prompt, and the scoring was a
count of shared words against the skill's name, description and triggers,
with a fixed threshold of 2. Measured against a real five-skill set, it was
wrong both ways.

It woke skills on nothing: `che ore sono` scored 2.3 against a security
skill, because `che` and `sono` were not in the stop-word list and a long
description has more chances to contain any given word. Counting words meant
verbosity bought relevance.

And it stayed asleep when it mattered: `controlla i colori` did not activate
`audit-color`, a skill named for colours whose description is about colours.
It earned exactly 1 point — the prompt is Italian and the skill is named in
English, so `colori` and `color` shared nothing — and the gate was 2.

Four changes:

- Terms are weighted by how few skills use them, so a word common to every skill counts for almost nothing and a distinctive one carries the match. Length stops being an advantage.
- Words that share a stem count at half weight, which is what lets `colori` reach `audit-color`; a stem match alone is a guess and cannot fire a skill on its own, so "questo non funziona" no longer wakes a web design skill.
- Each word of the prompt contributes once, at its best match. `funziona` used to collect a weight for `funzionante`, `funzionanti` and `funzionano` separately — one word, scored three times.
- The stop-word list now covers the language the prompts are actually written in. It held 47 words, of which few were Italian; short prompts are mostly function words, so the shortest prompts were the noisiest.

The cap rose from 2 to 3: with two slots, a generic skill with common triggers
took one on nearly every prompt.

### Added — the sidebar says which skills a prompt woke

`workingMemory.activeSkills` was written and displayed nowhere. A turn that
ran without the guidance you thought was active looked exactly like one that
ran with it, which is how the matching stayed broken without being noticed.
The panel now shows the active skills, or `none of N` when a prompt matched
nothing.

### Changed — a turn gets room to think, sized to the model

`max_tokens` was one number, 8192, standing in for every model at once. On a
model with adaptive thinking that number is a ceiling over reasoning *and*
answer together, so a hard turn ran out of room to think before it reached an
answer — while the model in use reports a limit of 64,000.

It is now resolved per model: room to think where the model allows it, the
conservative default where we know nothing about it, and a clamp where the
model would reject the request outright (Claude 3 answers 8192 with a 400
rather than a longer answer). A ceiling set in config is honoured and then
clamped the same way. The ceiling is a stop, not a target — output is billed
as written, not as allowed.

### Added — `effort`

`output_config.effort` was never sent, so every turn ran at the API's default.
It is now a setting (`low` | `medium` | `high` | `xhigh` | `max`), unset by
default so the default still stands, and it reaches both transports: the
parameter on the API path, `--effort` on the Claude Code bridge.

It is gated on the model, because Sonnet 4.5 and Haiku 4.5 reject the
parameter and sending it there turns a working request into a 400; a model
with a shorter ladder is clamped rather than refused. Plan mode runs a step
lower than build mode, and context compression always runs at `low`.

Measured on Opus through the bridge, same question: `low` returned 581 output
tokens in 14.0s against the default's 788 in 17.9s — 21% less spend for the
turns that do not need the depth.

### Changed — installing an update is opt-in

Launching the CLI used to be enough to have it replace itself: on a terminal
it made a blocking registry call, ran `npm install -g` before loading
anything else, and re-executed into the new build. That is a lot of authority
for the act of typing `ettore`, and it is only safe while the version it
reads is trustworthy.

It is not always trustworthy. A version cache found in the wild held npm's
`request` metadata — `latest: "2.88.2"` and that package's deprecation notice
— which the banner reported as ETTORE's own. Under the old default that
number was one plausible digit away from triggering an install.

Three changes, each of which alone would have stopped it:

- The default now reports the new version and leaves the decision. `--auto-update` or `ETTORE_AUTO_UPDATE=1` restores the old behaviour; `--no-auto-update` and `ETTORE_AUTO_UPDATE=0` still turn it off, and outrank the environment.
- A **new major version** is never installed automatically, even with the opt-in. A major bump is a declared breaking change, so it is taken deliberately with `ettore update` — the same rule that refuses a bogus 2.88.2 refuses a genuine 2.0.0.
- The version cache now records which package it describes, and an entry naming a different package, or naming none, is discarded rather than believed. It costs one registry call, once, and heals itself.

An opt-in that then refuses now says why without needing `--debug`.

### Removed

- `scripts/` — the loose dev scripts (`check-env`, `run-tests`, `verify-modules`, `git-status`, `desktop-live-preview`, `demo-desktop-windows`, `verify-patches`). Nothing in the package referenced them any more; `npm test`, `npm run check` and `npm run lint` cover what they did.

## [1.2.4] — 2026-09-05

### Fixed — the README told people to install the wrong package

`npm install -g ettore` installs an unrelated dependency-injection container
by another author. The package is `ettore-ai-assistant`, and since the npm
page renders this README, that line was the first thing a prospective user
read. The version badge was also frozen at 1.0.0.

The README now documents the update behaviour as well: what the CLI does on
its own, the three cases where it steps back and only tells you, and what a
deprecation notice looks like.

### Added — the CLI says when the version you are running is deprecated

`npm deprecate` is the only channel a publisher has towards a copy that is
already installed, but npm prints the message during an `npm install` and
nowhere else. Someone who installed once and never reinstalled — exactly the
person the message is aimed at — never saw it.

Startup now reads the deprecation flag for the running version alongside the
latest-version check (`npm view <pkg>@<version> deprecated`), caches it under
the same six-hour TTL, and prints it above the upgrade line:

```
⚠ ETTORE 1.0.0 is deprecated: <the publisher's message>
↻ A new version of ETTORE is available: 1.0.0 → 1.2.4. Run `ettore update` to upgrade.
```

The two calls are issued together, so the cold path still costs one round
trip. The notice is cached against the version it describes, so the build
that fixes the problem does not inherit the warning from the one it
replaced. A deprecated release that is still the newest one published says
so, instead of pointing at an `ettore update` that would do nothing.

Note the limit: this reaches versions that ship this code, and no earlier
ones. 1.0.0 and 1.1.x carry no version check at all, so nothing published
today can make those installs speak up.

## [1.2.2] — 2026-09-05

### Fixed — the first launch after an install now updates itself

The startup check read only the cache, so a freshly installed copy — whose
cache is necessarily empty — found nothing, skipped the auto-update and
left the work to the *second* launch. That is not what "update when I run
`ettore`" means.

When the cache holds nothing usable, startup now pays one blocking
registry call bounded by `COLD_CHECK_TIMEOUT_MS` (2.5s), passed down to
`npm view` as its own timeout so a slow or unreachable registry costs a
beat instead of a stall. It is paid once per cache lifetime (6h), never
per launch. `describeInstall().updatable` is consulted *first*, so a
development checkout — which would refuse the update anyway — never pays
for the call at all.

This also closes a gap the cache-only check left behind: in 1.2.1 the
cache was filled by the TUI's background refresh, so a user who only ever
ran one-shot prompts (`ettore "…"`) never populated it and therefore never
auto-updated. The blocking check runs before the one-shot / TUI branch, so
both modes now update on the launch that finds something new.


## [1.2.1] — 2026-09-05

The 1.2.0 tarball on npm predates every entry in this section. The
feature descriptions under `[1.2.0]` describe those subsystems as they
stand *here*; the published 1.2.0 does not contain the fixes below.

### Fixed — the version check and `ettore update` were dead on Windows

`execFile('npm', ...)` cannot work on Windows: the entry point is
`npm.cmd`, and since the fix for CVE-2024-27980 child_process refuses
to spawn a `.cmd` without a shell. The check failed, the fail-silent
path swallowed the error (so no banner ever appeared) and
`ettore update` rejected — on the one platform 1.2.0 was built for and
where the CLI is the only upgrade route. npm is now spawned as
`npm.cmd` with `shell: true` there, and because that routes arguments
through cmd.exe, `runUpdate` validates its target against
`/^[A-Za-z0-9][A-Za-z0-9._-]*$/` before it gets there.

`compareVersions` also ignored prerelease tags: splitting on `.` turned
`Number('0-beta')` into `NaN` → 0, so `1.3.0-beta` compared equal to
`1.3.0` and a beta install could never see the stable release. It now
sorts a prerelease before its release and drops build metadata.

### Fixed — the live preview could not run where it was documented to run

The prompt told users to run `node scripts/desktop-live-preview.js <id>`
in a second terminal. That could not work twice over: `scripts/` is not
in package.json `files`, so an installed copy does not have the file,
and a relative `node scripts/...` would resolve against the user's own
project anyway. Worse, the script called `getApp(id)`, which reads a
Map living in the *agent's* process — a second process always found it
empty.

The preview is now `ettore preview [appId]` (`--interval`, `--width`,
`--height`, `--invert`, `--once`), implemented in `src/cli/preview.js`
and shipped with the package. It reads the frame *file* the agent
writes, so it works from anywhere, and the PNG→ASCII conversion runs on
a PowerShell host of its own — the conversion never needed an app
session. That host is torn down by the same exit hook that kills the
app hosts, so a Ctrl-C in the preview cannot leave one running.
`scripts/desktop-live-preview.js` is now a dev shim over the same code.

### Fixed — watch frames grew without bound inside the user's project

Every click/type/press saves a full-screen PNG, and `watch` can add one
every 50ms for up to ten minutes, all under `process.cwd()/.ettore/`.
`.ettore/` is gitignored in this repo, not in the user's. Frames are
now a bounded ring — the newest `ETTORE_WATCH_MAX_FRAMES` (default 200)
per app, ordered by the timestamp rather than the filename, since the
prefixes differ per action. `latest.png` is never a candidate, and
`watch` reports only the frames still on disk.

### Changed — the startup version check does less

The CLI called `checkForUpdateSync()` twice and then started a
background refresh in both branches of a condition whose comment
described the opposite of what it did. It now calls it once and shares
the result between the banner and the sidebar. The background refresh
lives only in the TUI, which is the only mode that stays alive long
enough for an npm call to land — in a one-shot run it kept the process
alive for the npm timeout after the answer had already been printed.
`--no-update-check` now also reaches the TUI, which was still hitting
the registry despite the flag.

### Added — the CLI updates itself, and stops lying when it cannot


`ettore update` used to run `npm install -g`, re-read its own
`package.json`, and report `✓ ETTORE updated to <version>` — the file
npm had just replaced was not the one it read back, so the command
announced success while nothing the user runs had changed. Three
things are fixed.

**It reports what npm actually left on disk.** `installedVersion()`
reads the package.json under npm's global prefix
(`<prefix>/lib/node_modules/<pkg>`, `<prefix>/node_modules/<pkg>` on
Windows), and `runningIsGlobalInstall()` says whether that is the copy
being executed. When the two disagree — a second prefix, or a prefix
whose `bin/` is not on `PATH` — the command prints both paths and says
you would keep launching the old build, instead of claiming an
upgrade.

**It refuses to overwrite a development checkout.** `describeInstall()`
treats a package root containing `.git` as not updatable: for a
`npm link`ed repo, `npm install -g <pkg>@latest` replaces the link with
a registry copy and silently disconnects the command from the repo.
`ettore update` now stops with "update it with `git pull` instead" and
a `--force` escape hatch.

**It installs automatically at startup.** When the cached check says a
newer version exists, the CLI installs it *before loading anything
else* and re-executes into the new build, passing the user's original
argv through. Doing it up front is what makes it safe: npm replaces
files under the running process, and this CLI imports modules lazily
for the whole session (TUI, tools, providers), so a mid-session swap
would mix old and new code in one process. That is also why the update
can never be applied to the session that discovers it.

`planAutoUpdate()` holds the conditions, and every one of them is a
skip rather than a failure — the user asked to run ETTORE, not to
install software:

- `--no-auto-update`, or `ETTORE_AUTO_UPDATE=0`
- not a TTY (never install under a pipe, a CI job or a one-shot run)
- `ETTORE_AUTO_UPDATE_DONE` is set — the re-exec guard, without which a
  build that keeps reporting the old version relaunches itself forever
- nothing newer is known (the 6h cache is cold or current)
- the running copy is a git checkout

A failed install (offline, or a prefix that needs sudo) prints one
dimmed line and the session continues on the working build. With
`--debug` the skip reason is printed too.

Tests: `tests/update.test.js` covers `describeInstall` on a checkout,
`runUpdate` refusing it, `globalPackageDir` per platform, all six
`planAutoUpdate` branches, and a contract test pinning the re-exec
guard in `bin/cli.js`.

### Fixed — `/skills list` is one line per skill

A description carrying newlines bled into the next skill, and a single
400-character description wrapped to 20-30 rows that buried every other
entry: the TUI renders one ◆ line per `\n`-separated chunk. Descriptions
are flattened and capped at 80 characters with an ellipsis; the full
text is still one `/skills show <name>` away.

## [1.2.0] — 2026-09-05

### Added — Windows desktop backend

`desktop_app` is now a platform dispatcher. On Linux the existing
xdotool/wmctrl/Xvfb backend is unchanged. On Windows a new
`src/tools/desktop-app-windows.js` module drives any native GUI app
through a long-running PowerShell host (`src/tools/desktop-host.ps1`)
that uses Win32 `SendInput` for mouse and keyboard, P/Invoke
`EnumWindows`/`GetWindowRect`/`SetForegroundWindow` for window
enumeration, and `System.Drawing` for screenshots. No install is
required: PowerShell ships with every Windows install. The original
Linux code is preserved untouched in `src/tools/desktop-app-linux.js`.

The host is started once per app session and stays alive on a
stdin/stdout JSON pipe; that avoids the 500-1000ms PowerShell cold
start on every click. A separate process kill is wired on exit/SIGINT
so a Ctrl-C in the CLI never leaves Notepad or the PowerShell host
running. For Electron/Chromium apps, the renderer console is still
read through `browser_app action=attach port=9222` as before — this
release just makes the surrounding native window driveable too.

Components:

- `src/tools/desktop-host.ps1` — 250-line PowerShell host. Reads JSON
  commands on stdin, writes JSON responses on stdout. Actions:
  `list-windows`, `get-window`, `screenshot`, `ascii-preview`, `focus`,
  `click`, `press`, `type`, `ping`, `quit`. Win32 P/Invoke and
  `[System.Windows.Forms.Keys]` key mapping cover the standard
  control/alt/shift/F-key/symbol set.
- `src/tools/desktop-app-windows.js` — Node module that spawns the
  host, exposes the same `openApp` / `stopApp` / `listWindows` /
  `clickAt` / `typeText` / `pressKeys` / `captureWindow` /
  `waitForWindow` / `focusWindow` surface as the Linux backend, plus
  `watch()` and `asciiPreview()` helpers.
- `src/tools/desktop-app-linux.js` — the original 511-line
  implementation, lifted verbatim into a sibling module.
- `src/tools/desktop-app.js` — thin dispatcher: `import * as linux`
  + `import * as windows`, picks on `process.platform === 'win32'`.
  Re-exports 25 symbols so the rest of the agent (tool router, TUI,
  system prompts) is unaware of the split.
- `src/agents/prompts.js` — the "RUN THE APP TO FIND THE BUG
  (desktop)" section now describes both backends and the Windows
  built-in-no-install path.

Tests:

- `tests/desktop-app-dispatch.test.js` — 9 unit tests on the
  dispatcher surface (right backend picked, identity preservation,
  Windows-only parsers are safe no-ops, `detectAppErrors` patterns,
  `looksLikeElectron`).
- `tests/desktop-app-windows.integration.test.js` — live test that
  opens notepad, waits for its window, takes a screenshot (verifies
  the PNG magic `89 50 4E 47`), types into the document, reads
  the captured logs, and closes the app. Skips on non-Windows.

### Added — live visual feedback for the desktop backend

Clicking too fast is a real bug: a person watching the screen
physically cannot follow a click that completes in 16ms. The new
behaviour makes the agent's actions visible in three complementary
ways.

1. **Slower inputs.** `Do-Focus` now waits 400ms after
   `SetForegroundWindow` (was 200ms — too short on DPI-mismatched
   monitors) and `Do-Click` waits 150ms after `SetCursorPos` (was
   50ms) before `SendInput`. The user sees the cursor land on the
   target.

2. **Auto-screenshot after every action.** `clickAt`, `typeText`
   and `pressKeys` now save a frame to
   `.ettore/watch/<id>/<prefix>-<ts>.png` and update
   `.ettore/watch/<id>/latest.png` by default. The tool response
   returns the path so the caller can read the frame. Set
   `record=false` to skip.

3. **ASCII preview, optionally inline.** A new
   `desktop-host.ps1` action resizes the captured PNG to 80×24 (or
   whatever the caller asks for) with `System.Drawing.Graphics`,
   samples luminance with the standard Rec. 601 weights, and maps it
   onto a 10-char ramp `' .:-=+*#%@'`. The agent can opt in with
   `ascii=true` on click/type/press/screenshot and receive the
   rendered text inline; the TUI can also poll the file
   independently.

A new `desktop_app action=watch interval_ms=400 duration_ms=10000
ascii=true` captures a stream of frames and prints them as ASCII.
For long debugging sessions the user can run `ettore preview <id>`
in a second terminal — it redraws the ASCII frame in place with
`ESC[2J ESC[H` so the cursor movement and UI changes are visible in
real time without leaving the CLI.

The preview reads the frame *file* rather than the desktop backend's
app registry, which lives in the agent's process memory: a second
process would always have found it empty. The PNG→ASCII conversion
therefore runs on a PowerShell host of its own, started lazily and
torn down by the same exit hook that kills the app hosts.

Frames are retained as a bounded ring — the newest
`ETTORE_WATCH_MAX_FRAMES` (default 200) per app, with `latest.png`
never a candidate. A full-screen PNG after every click plus a
`watch` at 50ms would otherwise leave gigabytes in the user's
working directory, and `.ettore/` is gitignored in this repo, not
in theirs.

Components:

- `src/tools/desktop-host.ps1` — new `Do-AsciiPreview` action,
  luminance ramp, `[System.Drawing.Drawing2D.InterpolationMode]
  ::HighQualityBicubic` downscale.
- `src/tools/desktop-app-windows.js` — `host.asciiPreview`,
  `recordFrame()`, `watch({app, intervalMs, durationMs, windowId,
  outDir})`, `asciiPreview(path, {width, height, invert})`,
  `pruneFrames(dir, max)` and a standalone host for app-less ASCII
  rendering. New `record` parameter on click/type/press.
- `src/tools/index.js` — `desktop_app` tool grew `record`, `ascii`,
  `ascii_width`, `ascii_height`, `invert`, `interval_ms`,
  `duration_ms`, `out_dir` parameters and `action=watch` and
  `action=preview` branches. On Linux the new helpers are
  `null` and the tool surfaces a clear "Windows-only" message.
- `src/agents/prompts.js` — instructs the LLM to use `ascii=true`
  on click/type/press/screenshot to see the screen and to recommend
  `ettore preview <id>` to the user.
- `src/cli/preview.js` — `framePath`, `renderFrame`, `drawFrame`,
  `livePreview`. Shipped code, not a script: `files` in
  package.json publishes `bin/` and `src/` only, so a helper under
  `scripts/` could never have been run from an installed copy — and
  a relative `node scripts/...` would have resolved against the
  user's own project anyway.
- `bin/cli.js` — `ettore preview [appId]` with `--interval`,
  `--width`, `--height`, `--invert`, `--once`.
- `scripts/desktop-live-preview.js` — reduced to a dev shim over
  `src/cli/preview.js`.
- `scripts/demo-desktop-windows.js` — updated demo: opens Notepad,
  prints ASCII previews around the type, runs a 2-second watch,
  prints the frame count.

Tests:

- `tests/desktop-app-preview.test.js` — verifies the dispatcher
  exposes `watch`/`asciiPreview` on Windows and `null` on Linux,
  and that the `action=watch` / `action=preview` branches in the
  tool surface return clear errors when the helpers are missing.

### Added — version check, sidebar banner, and `ettore update`

ETTORE now notices when a newer version is on npm and tells the
user how to upgrade. The check is intentionally cheap: one
`npm view <pkg> version --json` call, cached for 6 hours at
`~/.config/ettore/version-cache.json` (overridable through
`ETTORE_CONFIG_DIR` for CI), and never blocks the first prompt. A
failsilent return on registry/network errors means offline sessions
do not show a banner and do not show an error.

Three new CLI surfaces:

- `ettore` — prints `ettore <version>` in dim and, if a newer
  release is available, a yellow `↻ A new version of ETTORE is
  available: 1.1.1 → 1.2.0. Run \`ettore update\` to upgrade.` line.
  Skippable with `--no-update-check`.
- `ettore version` — same plus an explicit check (with `--no-fetch`
  to use the cache only) and a colour-coded status: green
  "✓ up to date" / yellow "↻ update available".
- `ettore update` — shells out to `npm install -g
  ettore-ai-assistant@latest` (or `@<version>` with
  `-t <version>`), streams the npm output to the user, and
  invalidates the version cache so the next start reflects the
  freshly installed build.

The same status is rendered in the right-hand sidebar of the
interactive TUI: a `v1.1.1` line directly under the `ETTORE SESSION`
header, with the `↻ 1.2.0` badge and a `→ \`ettore update\` to
upgrade` hint when an upgrade is available. The CLI runs the sync
check once and hands the result to both the banner and the sidebar;
the TUI refreshes a cold or stale cache in the background. A
one-shot `ettore "prompt"` run deliberately does not, so the npm
call cannot hold the process open after the answer is printed.

Components:

- `src/cli/update.js` — `readLocalPackage`, `compareVersions`,
  `isOutdated`, `fetchLatestVersion`, `checkForUpdate`,
  `checkForUpdateSync`, `formatBanner`, `runUpdate`,
  `startBackgroundCheck`. 6h TTL, ETTORE_CONFIG_DIR override, ANSI
  colours only when `process.stdout.isTTY`. npm is spawned as
  `npm.cmd` with `shell: true` on Windows — child_process refuses a
  bare `.cmd` since the fix for CVE-2024-27980, and the fail-silent
  path would have hidden it on the one platform where the CLI is
  the only upgrade route. `runUpdate` validates its target because
  that shell makes the argument reachable by cmd.exe.
  `compareVersions` sorts a prerelease before its release, so a
  beta build still sees the stable upgrade.
- `bin/cli.js` — registers the `version` and `update` subcommands,
  adds `--no-update-check`, prints the version line and the banner
  before the main action.
- `src/app/tui-native.js` — `TUI.version` and `TUI.updateStatus`
  fields; `_renderSidebar` prints the version immediately after the
  `ETTORE SESSION` header and appends the update hint when
  outdated.
- `src/app/native-ui.js` — reads `options.version` and
  `options.updateStatus` from the CLI, falls back to
  `readLocalPackage()` and a background `checkForUpdate()` call if
  the cache was cold.

Tests:

- `tests/update.test.js` — 11 tests using a fake `npm` shim to
  avoid network calls. Covers `compareVersions` (including
  `v`-prefix and length mismatches), `formatBanner` (null when
  not outdated, includes the bump + hint when outdated),
  `checkForUpdateSync` (cache hit, miss, stale), `fetchLatestVersion`
  (returns null on missing PATH, parses JSON of a fake `npm`),
  `checkForUpdate` ignoring a 7h-old cache, prerelease ordering,
  the rejected `runUpdate` target, and a contract test pinning the
  Windows npm spawn.
- `tests/tui-sidebar-version.test.js` — 6 tests asserting the
  sidebar contains the version, the upgrade hint when outdated, and
  the "version unknown" fallback when empty, plus contract tests
  that `bin/cli.js` and `native-ui.js` actually wire the new
  fields.



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
