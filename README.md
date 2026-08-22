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
- 🎨 **Native TUI** - Custom ANSI renderer (no React/Ink) with themes and a sidebar
- 🖼️ **Vision** - Reads local images; agent can discover, download, and inspect public web images
- 🔌 **Easy Setup** - `/connect <provider> <key>` or environment variables
- 💾 **Persistent Config** - API keys saved with `0600` permissions in `~/.config/ettore/`
- 🧠 **Context Tools** - compression, project memory, working memory, sessions, auto-approve

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
| `/memory show\|add\|clear\|edit\|export\|path` | Persistent project memory |
| `/compress [preview\|apply\|auto\|stats\|history\|undo]` | Manage context compression |
| `/agent [stats\|memory\|clear]` | Inspect agent runtime memory |
| `/caveman [level\|off]` | Toggle compressed reply style (saves tokens) |
| `/approvals [list\|clear] [project\|system\|download]` | Inspect or reset session approvals |
| `/sessions` / `/resume` / `/new` | Session management |
| `/history [n]` | Show recent commands |
| `/team` | Multi-agent team orchestration |
| `/select [provider]` | Pick a model interactively |
| `/system` | Platform and runtime info |
| `/version` | Show ETTORE version |
| `/help [command]` | Show help for a specific command |
| `/clear` | Clear the screen |
| `/exit` | Exit interactive mode |

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

# One-shot with image and provider
ettore --provider openai --image ./screenshot.png "Find the UI problem in this screenshot"
```

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
claude                               # sign in once, then quit
ettore /connect claude-code
ettore /use claude-code sonnet        # or opus / haiku
```

ETTORE drives `claude --print` as a bare model: its own tools, MCP servers,
settings and slash commands are disabled, and ETTORE's system prompt and tools
replace them. On a headless machine, `claude setup-token` or
`CLAUDE_CODE_OAUTH_TOKEN` work too; point `ETTORE_CLAUDE_BIN` at the binary if
it is not on `PATH`.

Limitations of this transport, compared with an API key: no prompt caching
(each turn re-sends the transcript to a fresh headless session), no
`temperature`/`max_tokens` control, and image attachments are dropped.

## Requirements

- Node.js 18+
- An API key for OpenAI, Anthropic, or another supported provider (Ollama runs locally and `claude-code` reuses your Claude login — both without a key)

## Development

```bash
npm test
npm run lint
python3 test_display.py
```

Run `python3 test_display.py` after TUI rendering changes. It should finish with
`Total issues: 0`.

## License

MIT
