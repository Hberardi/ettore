# Ettore Plugin Examples

This directory contains example plugins for the ETTORE plugin system.

## hello-world

A minimal plugin demonstrating:

- One tool with a JSON-schema parameter block (`say_hello`)
- A second tool returning structured data (`count_letters`)
- One slash command (`/hello [name]`)
- An `onLoad` lifecycle hook that logs a message at enable time

### How to install

Copy the `hello-world/` directory to your plugins root:

```bash
# Linux / macOS
cp -r examples/plugins/hello-world ~/.config/ettore/plugins/

# Windows (PowerShell)
Copy-Item -Recurse examples\plugins\hello-world $env:USERPROFILE\.config\ettore\plugins\
```

Then enable it. From the TUI:

```
/plugins enable hello-world
```

…or from a one-shot run, set `ETTORE_PLUGINS_DIR` and start the agent — it
will auto-load every enabled plugin on boot.

### Anatomy of a plugin

Every plugin needs two files in its directory:

1. **`plugin.json`** — the manifest. Required fields: `name`, `version`,
   `apiVersion`, `main`. Optional: `description`, `author`, `license`,
   `permissions`.

2. **`<main>` (default `index.js`)** — the module. It can export:
   - `tools` — object: `{ [toolName]: { description, parameters, handler } }`
   - `commands` — object: `{ [cmdName]: { description, usage?, handler } }`
   - `hooks` — object: `{ onLoad?, onUnload?, onBeforeTool?, onAfterTool? }`

The plugin's directory name MUST equal the `name` field in the manifest.

### Permissions

Declare the permissions your plugin needs in `plugin.json`. The user is
shown the list at enable time and can grant them as a single action.

Known permissions:

- `fs:read` — read files inside the workspace
- `fs:write` — write files inside the workspace
- `network:http` / `network:https` — outbound HTTP
- `shell:exec` — run a shell command
- `memory:read` / `memory:write` — read/write project memory
- `agent:tools` — call other tools from within a tool handler
- `agent:emit` — emit events on the agent event bus

Request only what you need. The runtime enforces them at the call site
once the support is wired through (in progress — see the `agent:` group).

### Reserved tool names

Plugins MAY NOT register tools with these names — they are owned by the
core runtime for safety or because they drive core UI:

`bash`, `bash_session`, `write`, `edit`, `read`, `read_pdf`, `read_doc`,
`todo_write`, `ask_user`, `memory_write`, `apply_patch_structured`, `glob`,
`grep`, `list_dir`, `file_info`, `git_status`, `git_diff`, `websearch`,
`webfetch`, `dev_server`, `browser_check`, `browser_app`, `desktop_app`,
`repo_map`, `repo_find_symbol`,
`dep_inspect`, `run_tests`, `run_checks`, `web_image`, `video_describe`,
`video_transcript`, `audio_read`, `music_video`.

A plugin trying to register one of these will be rejected at load time.
