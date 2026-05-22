# ETTORE - Advanced AI CLI Assistant

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/node-18+-green" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="License">
</p>

ETTORE is an advanced AI CLI assistant that helps with software engineering tasks. It's like having a smart assistant in your terminal.

## Features

- 🤖 **AI-Powered** - Uses OpenAI GPT and Anthropic Claude models
- 💻 **Tool Execution** - bash, read, write, edit, grep, glob, web search
- 🎨 **Beautiful TUI** - Rich terminal interface with themes
- 🔌 **Easy Setup** - Connect to providers with simple commands
- 💾 **Persistent Config** - API keys saved securely

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
```

## Commands

| Command | Description |
|---------|-------------|
| `/connect <provider> <key>` | Connect to OpenAI/Anthropic |
| `/keys add <provider> <key>` | Save API key |
| `/keys list` | List saved keys |
| `/use <provider> <model>` | Select model |
| `/providers` | List providers |
| `/models` | List models |
| `/help` | Show help |
| `/exit` | Exit |

## Examples

```bash
# Connect to OpenAI
ettore /keys add openai sk-...

# Connect to Anthropic
ettore /keys add anthropic sk-ant-...

# Select model
ettore /use openai gpt-4o

# Interactive mode
ettore
```

## Configuration

API keys are saved in `~/.config/ettore/keys.json`. Use `/keys` to manage them.
For env-only usage, set the provider key before starting ETTORE:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
ettore
```

Prefer environment variables or `/connect` over `--api-key`; command-line
arguments can be exposed in shell history and process lists.

## Requirements

- Node.js 18+
- OpenAI or Anthropic API key

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
