// command-palette-shortcuts plugin
//
// Four slash commands that the user can type in the TUI to get fast
// answers about the current session. None of them require a permissions
// grant — they are read-only, except /kill-bash which only emits a
// guidance message because a plugin cannot directly call
// `killBashSession()` (the underlying export lives in src/tools and is
// not part of the plugin API).
//
// Reads bash history from the file written by the bash-monitor plugin
// (~/.config/ettore/bash-monitor.json). Falls back to a friendly
// "no history" message if the file is missing or the other plugin
// is not installed.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASH_HISTORY_PATH = join(homedir(), '.config', 'ettore', 'bash-monitor.json');

function readBashHistory() {
  try {
    if (!existsSync(BASH_HISTORY_PATH)) return [];
    const raw = JSON.parse(readFileSync(BASH_HISTORY_PATH, 'utf-8'));
    return Array.isArray(raw?.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

function detectGitBranch() {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    return String(out || '').trim() || null;
  } catch {
    return null;
  }
}

function detectGitDirty() {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    return String(out || '').trim().length > 0;
  } catch {
    return null;
  }
}

function pad(s, n) {
  s = String(s ?? '');
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}

export const commands = {
  // /last-bash [N] — show the last N bash commands (default 1).
  last_bash: {
    description: 'Show the last N bash commands run in this session. Reads the bash-monitor plugin history file. Default 1, max 20.',
    usage: '/last-bash [N]',
    handler: async (args) => {
      const n = Math.max(1, Math.min(Number(String(args).trim() || '1') || 1, 20));
      const entries = readBashHistory();
      if (!entries.length) {
        return [
          '(no bash history yet — either the bash-monitor plugin is not enabled or no bash command has been run)',
          'Enable it with: /plugins enable bash-monitor',
        ].join('\n');
      }
      const slice = entries.slice(-n).reverse();
      const lines = [`Last ${slice.length} bash command(s):`];
      for (const e of slice) {
        const dur = Math.round((e.durationMs || 0) / 1000);
        const code = e.timedOut ? 'TIMEOUT' : (e.exitCode === 0 ? 'OK' : `exit ${e.exitCode}`);
        const when = e.at ? new Date(e.at).toISOString().slice(11, 19) : '?';
        lines.push(`  ${pad(when, 8)} ${pad(code, 8)} ${pad(dur + 's', 5)} ${e.command}`);
      }
      return lines.join('\n');
    },
  },

  // /kill-bash — emit guidance: the plugin cannot kill the bash session
  // directly, so we tell the user the fastest way (Ctrl-C in the TUI)
  // and confirm what the result will be (next bash call spawns a fresh
  // shell because the persisted cwd / env state is lost).
  kill_bash: {
    description: 'Show how to cancel the running bash command. The plugin cannot kill the shell directly; press Ctrl-C in the TUI to interrupt the current turn, then the next bash call will respawn a fresh shell.',
    usage: '/kill-bash',
    handler: async () => {
      return [
        'To stop the bash command that is currently running:',
        '  1. Press Ctrl-C in the TUI to interrupt the current turn.',
        '  2. The next bash / bash_session call will start a fresh shell',
        '     (cwd and exported variables from the killed session are lost).',
        '',
        'If you are sure no command is currently running and the session',
        'is just stuck on a previous error, you can also exit and re-open',
        'ETTORE to force a full respawn.',
      ].join('\n');
    },
  },

  // /replay-last [N] — show the last N tool calls (read from the bash
  // history plus a small inline note for non-bash tools).
  replay_last: {
    description: 'Show the last N tool invocations in this session. Reads the bash-monitor history file. Default 5, max 20.',
    usage: '/replay-last [N]',
    handler: async (args) => {
      const n = Math.max(1, Math.min(Number(String(args).trim() || '5') || 5, 20));
      const entries = readBashHistory();
      if (!entries.length) {
        return '(no tool-call history — bash-monitor plugin is not enabled, or no tool has been called yet)';
      }
      const slice = entries.slice(-n).reverse();
      const lines = [`Last ${slice.length} tool invocation(s):`];
      for (const e of slice) {
        const when = e.at ? new Date(e.at).toISOString().slice(11, 19) : '?';
        const dur = Math.round((e.durationMs || 0) / 1000);
        const code = e.timedOut ? 'TIMEOUT' : (e.exitCode === 0 ? 'OK' : `exit ${e.exitCode}`);
        lines.push(`  ${pad(when, 8)} ${pad(e.tool || '?', 14)} ${pad(code, 8)} ${pad(dur + 's', 5)} turn #${e.turn}`);
      }
      return lines.join('\n');
    },
  },

  // /where — describe the current session: working directory, git
  // branch and dirty state, available commands, plugin count.
  where: {
    description: 'Show where the session is running: workdir, git branch / dirty state, enabled plugins count, available slash commands.',
    usage: '/where',
    handler: async () => {
      const workdir = process.cwd();
      const branch = detectGitBranch();
      const dirty = detectGitDirty();
      const history = readBashHistory();
      const lines = [
        'Session snapshot:',
        `  workdir   ${workdir}`,
        `  branch    ${branch || '(not a git repo, or git unavailable)'}`,
        `  dirty     ${dirty === null ? '?' : (dirty ? 'yes (uncommitted changes)' : 'no (clean)')}`,
        `  bash_hist ${history.length} tracked command(s) in ~/.config/ettore/bash-monitor.json`,
        `  node      ${process.version}`,
        `  platform  ${process.platform} ${process.arch}`,
      ];
      return lines.join('\n');
    },
  },
};

export const hooks = {
  onLoad: async (api) => {
    api.log('info', 'command-palette-shortcuts loaded — try /last-bash, /kill-bash, /replay-last, /where');
  },
};
