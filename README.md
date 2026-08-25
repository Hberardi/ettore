# ETTORE - Advanced AI CLI Assistant

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/node-18+-green" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="License">
</p>

ETTORE is an advanced AI CLI assistant that helps with software engineering tasks. It's like having a smart assistant in your terminal.

## Features

- 🤖 **AI-Powered** - OpenAI, Anthropic, Ollama (local), OpenAI-compatible endpoints, and MiniMax
- 💻 **Tool Execution** - bash, read, write, edit, grep, glob, web search, web fetch, image inspection
- 🖱️ **Runs your apps** - opens web apps in a real browser (reads the browser console: errors, exceptions, failed requests) and launches desktop apps (captures stdout/stderr, screenshots, clicks and types) to reproduce bugs before fixing them
- 🎨 **Native TUI** - Custom ANSI renderer (no React/Ink) with themes and a sidebar
- 🖼️ **Vision** - Reads local images; agent can discover, download, and inspect public web images
- 📄 **Super OCR for PDF** - Extracts native text first, then automatically handles scanned and low-quality PDFs with preprocessing, deskew, denoise, adaptive thresholding, and multi-pass Tesseract OCR
- 🔌 **Easy Setup** - `/connect <provider> <key>` or environment variables
- 💾 **Persistent Config** - API keys saved with `0600` permissions in `~/.config/ettore/`
- 🧠 **Context Tools** - compression, project memory, working memory, sessions, auto-approve
- 📋 **Explicit Planning** - non-trivial tasks get a structured `<plan>...</plan>` block on the first turn
- 🧩 **Plugin System** - extend ETTORE with local plugins (`~/.config/ettore/plugins/<name>/`)

## Installation

### Option 1: npm (recommended)

```bash
# Install globally
npm install -g ettore

# Verify installation
ettore --version
```

### Option 2: From source

```bash
# Clone or download
cd ettore-cli

# Make executable
chmod +x install.sh
./install.sh
```

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
| `/theme <name>` | Switch theme (`default`, `midnight`, `matrix`, `forest`) |
| `/auto-approve [edits\|installs] on\|off` | Skip approval prompts (sensitive commands still prompt) |
| `/config [key] [value] [--local]` | Show/set configuration; `--local` writes `.ettore/config.json` |
| `/config max-iterations <1-200> [--local]` | Set the agent loop budget (default: 50) |
| `/memory show\|add\|clear\|edit\|export\|path` | Persistent project memory |
| `/skills list\|show\|create\|reload` | Global skills with automatic prompt activation |
| `/mission [status\|history\|clear]` | Live execution graph: plan, waves, tools, files, tokens |
| `/compress [preview\|apply\|auto\|stats\|history\|undo]` | Manage context compression |
| `/agent [stats\|memory\|clear]` | Inspect agent runtime memory |
| `/caveman [level\|off]` | Toggle compressed reply style (saves tokens) |
| `/approvals [list\|clear] [project\|system\|download]` | Inspect or reset session approvals |
| `/sessions` / `/resume` / `/new` | Session management |
| `/history [n]` | Show recent commands |
| `/team` | Multi-agent team orchestration |
| `/plugins [list\|available\|enable\|disable\|reload\|info] [name]` | Manage plugins |
| `/select [provider]` | Pick a model interactively |
| `/system` | Platform and runtime info |
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

ETTORE activates at most two matching skills per turn and keeps the base
safety rules and tool permissions higher priority than skill instructions.

## Mission Control

Mission Control tracks the current task directly in the TUI sidebar: plan
progress, parallel tool waves, changed files, decisions, and token usage.

```bash
/mission
/mission history
/mission clear
```

## Plugins

ETTORE is extensible via local plugins. A plugin is a directory under
`~/.config/ettore/plugins/<name>/` (override the location with the
`ETTORE_PLUGINS_DIR` environment variable) containing two files:

1. **`plugin.json`** — the manifest: `name`, `version`, `apiVersion`,
   `main`, optional `description` / `author` / `license` /
   `permissions`.
2. **`<main>`** (default `index.js`) — the ESM module. It exports
   `tools`, `commands`, and `hooks` (with `onLoad` and `onUnload`).

```bash
# install the bundled example
cp -r examples/plugins/hello-world ~/.config/ettore/plugins/

# in the TUI
/plugins list                  # show enabled plugins
/plugins available             # show what is on disk
/plugins enable hello-world
/plugins info hello-world
/plugins reload hello-world    # re-import after editing the plugin
/plugins disable hello-world
```

Plugin tool handlers receive a controlled `ctx` object (`{ plugin, tool,
signal, workspace, agentMode, safetyProfile }`) — they never see the
agent's internals. See `examples/plugins/README.md` for the full
authoring guide and the list of reserved tool names that plugins
cannot override.

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

API keys are saved in `~/.config/ettore/keys.json` with `0600` file
permissions. Use `/keys` to manage them. Override the config dir for tests
or CI with `ETTORE_CONFIG_DIR=/path/to/dir`.

For env-only usage, set the provider key before starting ETTORE:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export OPENROUTER_API_KEY=sk-or-...
export MINIMAX_API_KEY=...
ettore
```

Prefer environment variables or `/connect` over `--api-key`; command-line
arguments can be exposed in shell history and process lists.

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

Limitations of this transport, compared with an API key: no prompt caching
(each turn re-sends the transcript to a fresh headless session), no
`temperature`/`max_tokens` control, and image attachments are dropped.

## Requirements

- Node.js 18+ (Node 22+ for `browser_app`, which uses the built-in WebSocket client)
- An API key for OpenAI, Anthropic, or another supported provider (Ollama runs locally and `claude-code` reuses your Claude login — both without a key)

Optional, only for driving applications:

| Capability | Needs | Install (Debian/Ubuntu/Mint) |
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
