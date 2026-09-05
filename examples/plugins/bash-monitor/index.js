// bash-monitor plugin
//
// What this does:
//   - Tracks every bash / bash_session invocation: command, exit code,
//     duration in ms, and the turn in which it ran.
//   - Emits a warning when a single command exceeds 30 seconds, when
//     the same command is run three or more times, and when sudo /
//     apt / passwd is detected (because those open /dev/tty and the
//     < /dev/null redirect in the core tool cannot reach them).
//   - Exposes a tool `command_history({ last, slow_only, only_failed })
//     that the agent can call to inspect what was just run — useful
//     when a tool result mentions an error but the model cannot tell
//     whether the same command failed before.
//   - Persists a rolling buffer of the last 20 entries to
//     ~/.config/ettore/bash-monitor.json so the command-palette-shortcuts
//     plugin (and you, with `cat`) can read the recent history.
//
// Permissions declared in plugin.json: agent:emit, fs:read, fs:write.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_PATH = join(homedir(), '.config', 'ettore', 'bash-monitor.json');
const MAX_ENTRIES = 20;
const SLOW_THRESHOLD_MS = 30_000;
const REPEAT_THRESHOLD = 3;
const SUDO_RE = /(^|\s|;|&&|\|\|)(\bsudo\b|\bapt\b|\bpasswd\b|\bsu\b)(\s|$)/;

// In-flight timestamps: command name → startedAt. We use the command
// string as the key, but since two parallel calls would race on the
// same key, we key by `${toolName}:${sequence}` instead, where sequence
// is a process-local counter incremented at every onBeforeTool call.
const sequence = { value: 0 };
const inFlight = new Map();

function normalize(cmd = '') {
  return String(cmd).replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return { entries: [] };
    const raw = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    if (!raw || !Array.isArray(raw.entries)) return { entries: [] };
    return { entries: raw.entries.slice(-MAX_ENTRIES) };
  } catch {
    // Corrupt state should never break the agent — start fresh.
    return { entries: [] };
  }
}

async function saveState(state) {
  try {
    await mkdir(join(homedir(), '.config', 'ettore'), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort: in-memory state is still useful for the current session.
  }
}

function pickWarning(entry, recent) {
  const lines = [];
  if (entry.durationMs >= SLOW_THRESHOLD_MS) {
    lines.push(`Slow: this command took ${Math.round(entry.durationMs / 1000)}s (threshold ${SLOW_THRESHOLD_MS / 1000}s).`);
  }
  if (SUDO_RE.test(entry.command)) {
    lines.push('Heads-up: sudo / apt / passwd opens /dev/tty for the password. The < /dev/null redirect cannot reach it, so the command may hang. Prefer `sudo -n` (non-interactive) or run installs through a non-sudo flow.');
  }
  if (recent.length >= REPEAT_THRESHOLD) {
    const sameCount = recent.filter((e) => e.normalized === entry.normalized).length;
    if (sameCount >= REPEAT_THRESHOLD) {
      lines.push(`Repeated: this exact command has been run ${sameCount} times in this session. Consider a different approach if it keeps failing.`);
    }
  }
  return lines;
}

export const tools = {
  command_history: {
    description: 'Return the recent bash / bash_session history for this ETTORE session. Useful when a tool result is ambiguous and the model needs context.',
    parameters: {
      type: 'object',
      properties: {
        last: { type: 'integer', description: 'How many recent entries to return (default 10, max 20).', default: 10, minimum: 1, maximum: 20 },
        slow_only: { type: 'boolean', description: 'If true, return only commands that exceeded 30s.', default: false },
        only_failed: { type: 'boolean', description: 'If true, return only entries with exit code != 0.', default: false },
      },
      additionalProperties: false,
    },
    handler: async ({ last = 10, slow_only = false, only_failed = false } = {}) => {
      const state = await loadState();
      let entries = state.entries.slice(-Math.max(1, Math.min(Number(last) || 10, MAX_ENTRIES)));
      if (slow_only) entries = entries.filter((e) => e.durationMs >= SLOW_THRESHOLD_MS);
      if (only_failed) entries = entries.filter((e) => e.exitCode !== 0);
      return {
        total_tracked: state.entries.length,
        returned: entries.length,
        entries: entries.map((e) => ({
          turn: e.turn,
          tool: e.tool,
          command: e.command,
          duration_s: Math.round(e.durationMs / 1000),
          exit_code: e.exitCode,
          timed_out: !!e.timedOut,
          when: e.at,
        })),
      };
    },
  },
};

export const hooks = {
  onLoad: async (api) => {
    api.log('info', 'bash-monitor loaded — watching bash and bash_session for slow / repeated / sudo commands');
  },
  onUnload: async () => {
    // Persist the latest in-memory state on unload so a /plugins reload
    // does not lose history. The state file is small (<2KB) and the
    // operation is best-effort.
    try {
      const state = await loadState();
      await saveState(state);
    } catch {}
  },
  onBeforeTool: async (name, args) => {
    if (name !== 'bash' && name !== 'bash_session') return;
    const cmd = String(args?.command || '').trim();
    if (!cmd) return;
    sequence.value += 1;
    inFlight.set(`${name}:${sequence.value}`, { name, cmd, startedAt: Date.now() });
  },
  onAfterTool: async (name, args, result) => {
    if (name !== 'bash' && name !== 'bash_session') return;
    const cmd = String(args?.command || '').trim();
    if (!cmd) return;
    // Match the in-flight entry by command string (sequence is best-effort:
    // if the onAfterTool runs out of order, we just take the latest in-flight
    // for this tool name with a matching command).
    let startedAt = null;
    let keyUsed = null;
    for (const [key, info] of inFlight.entries()) {
      if (info.name === name && info.cmd === cmd) {
        startedAt = info.startedAt;
        keyUsed = key;
        break;
      }
    }
    if (keyUsed) inFlight.delete(keyUsed);
    const durationMs = startedAt ? Date.now() - startedAt : 0;

    // The tool result is a string like "real output\n[exit code: 1]\n[timeout ...]".
    // Pull the exit code out of the structured markers; default to 0 when
    // the tool succeeded and nothing was reported.
    const exitMatch = typeof result === 'string'
      ? result.match(/\[exit code:\s*(-?\d+)\]/) || result.match(/\[timeout after \d+s/)
      : null;
    let exitCode = 0;
    let timedOut = false;
    if (exitMatch) {
      if (exitMatch[1] != null) exitCode = Number(exitMatch[1]);
      else timedOut = true;
    }

    const entry = {
      turn: sequence.value,
      tool: name,
      command: cmd,
      normalized: normalize(cmd),
      durationMs,
      exitCode,
      timedOut,
      at: new Date().toISOString(),
    };

    const state = await loadState();
    state.entries.push(entry);
    if (state.entries.length > MAX_ENTRIES) {
      state.entries.splice(0, state.entries.length - MAX_ENTRIES);
    }
    await saveState(state);

    // Build warnings against the now-updated state.
    const warnings = pickWarning(entry, state.entries);
    if (warnings.length) {
      const banner = warnings.map((w) => `[bash-monitor] ${w}`).join('\n');
      // The hook receives the result string and the runtime prepends
      // plugin-emitted messages into the tool transcript. Emitting the
      // banner via the `emit` API is a no-op for non-interactive sessions,
      // so we also append it to the result string itself.
      return banner;
    }
  },
};
