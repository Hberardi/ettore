# ETTORE CLI — Agent Guide

## Entry Points
- `bin/cli.js` — main CLI entry (Commander). Two modes:
  - **Interactive**: `node bin/cli.js` → `src/app/native-ui.js` → `src/app/tui-native.js`
  - **One-shot**: `node bin/cli.js "prompt"` → `src/cli/index.js`
- `npm start` aliases `node bin/cli.js`

## Tech Stack
- Node.js 18+, ESM (`"type": "module"` in package.json)
- Pure JavaScript — no TypeScript in source (despite `@types/react` dep for Ink)
- ESLint 9 flat config in `eslint.config.js`
- Node's built-in test runner via `npm test`
- No formatter configured

## TUI Architecture (important)
- **Active TUI**: custom ANSI renderer in `src/app/tui-native.js` + `src/app/native-ui.js`
- ANSI cursor positioning: `ANSI.move(col, row)` = `\x1b[${col};${row}H` (column first, row second)
- Sidebar uses absolute cursor positioning per row (not concatenated to message lines)
- Use `_visualLen(s)` to compute visual width (strips ANSI codes)
- Layout: `availableHeight = rows - 4`, `sidebarWidth = 32`

## When modifying TUI rendering
Run after changes:
```bash
python3 test_display.py
```
Must end with "Total issues: 0". Manual smoke test in a real terminal also recommended.

## Quality Checks
Run before finishing code changes:
```bash
npm test
npm run lint
python3 test_display.py
```
`npm run lint` may report pre-existing warnings, but it should not report errors.

## Tools Available
`bash`, `read`, `write`, `edit`, `glob`, `grep`, `webfetch`, `ask_user`, `memory_write`

## Driving applications
- `browser_app` (`src/tools/browser-driver.js`) — drives Chrome/Chromium over the
  DevTools Protocol (raw CDP over Node's built-in WebSocket, no extra dependency):
  open/goto/click/type/press/eval/snapshot/screenshot plus `console`, `errors` and
  `network` reads. Needs a Chrome/Chromium binary (`ETTORE_CHROME_BIN` overrides
  the lookup) and Node 22+.
- `desktop_app` (`src/tools/desktop-app.js`) — launches a GUI app keeping its
  stdout/stderr, lists/focuses/screenshots its windows and injects clicks and
  keystrokes. Uses wmctrl or xdotool for windows, ImageMagick/gnome-screenshot/
  scrot for screenshots, xdotool (X11) or ydotool (Wayland) for input, and Xvfb
  when no display is available. `action="capabilities"` reports what is installed.
- Both keep per-id sessions in module state and kill their processes on
  `process.on('exit')` / SIGINT, like `bash-session.js`.
- Adding a tool means touching: `src/tools/index.js` (handler + definition),
  `src/agents/tool-router.js` (routing), `src/agents/prompts.js` (capabilities),
  `src/agents/index.js` (`getToolTimeoutMs`), `src/tools/workspace-policy.js`
  (path rules), `src/plugins/manifest.js` (reserved names), and the TUI colour
  map / intent labels in `src/app/`.

## ask_user constraint
Only works in interactive mode. In one-shot/non-interactive contexts it returns an error telling the user to start interactive mode.

## Config & API Keys
- Stored in `~/.config/ettore/keys.json` with `0600` file permissions
- Override config dir for tests/CI with `ETTORE_CONFIG_DIR=/tmp/some-dir`
- Env-only keys are supported for common providers, e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `MINIMAX_API_KEY`
- Avoid `--api-key` in examples; CLI args can expose secrets in shell history and process listings
- Connect a provider: `/connect <provider> <api-key>` from the TUI

## Run commands
```bash
node bin/cli.js                     # interactive TUI
node bin/cli.js "prompt"           # one-shot mode
npm start                          # same as above
npm test                           # Node test suite
npm run lint                       # ESLint checks
python3 test_display.py            # TUI layout validation
```

## Key source files
- `src/agents/index.js` — Agent class, tool-calling loop, system prompts
- `src/tools/index.js` — tool implementations and definitions
- `src/providers/index.js` — ConnectionManager
