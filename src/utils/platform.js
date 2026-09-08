// Platform differences the rest of the CLI should not have to think about.
//
// Everything here takes `platform` and `env` as arguments rather than reading
// process state directly, so Windows behaviour is testable from Linux — which
// matters, because until now nothing about Windows was covered by a test and
// the breakages piled up unnoticed.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const isWindows = process.platform === 'win32';

// ─── Executable lookup ───────────────────────────────────────────────────────

// Windows resolves a bare name through PATHEXT: `npm` on disk is `npm.cmd`,
// and child_process will not find it under the bare name.
function pathExtensions(platform, env) {
  if (platform !== 'win32') return [''];
  const raw = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const out = [];
  for (const entry of String(raw).split(';')) {
    const ext = entry.trim();
    if (!ext) continue;
    // PATHEXT is conventionally upper case (".CMD") while the file on disk is
    // lower case ("npm.cmd"). Windows does not care, but a case-sensitive
    // filesystem does — and so does anything resolving a Windows PATH from
    // elsewhere. Try both rather than depend on the volume's casing rules.
    //
    // Lower case goes first on purpose. Windows would match either way, but it
    // is the candidate string we return, so trying ".CMD" first handed back
    // `npm.CMD` for a file actually named `npm.cmd` — runnable, but not the
    // path that exists.
    for (const variant of [ext.toLowerCase(), ext, ext.toUpperCase()]) {
      if (!out.includes(variant)) out.push(variant);
    }
  }
  return out;
}

/**
 * Absolute path of `name` on PATH, or null. Mirrors what the OS loader does,
 * including PATHEXT on Windows.
 */
export function findOnPath(name, { env = process.env, platform = process.platform } = {}) {
  const raw = env.PATH || env.Path || '';
  const dirs = String(raw).split(delimiter).filter(Boolean);
  const exts = pathExtensions(platform, env);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        if (existsSync(candidate)) return candidate;
      } catch { /* unreadable PATH entry — keep looking */ }
    }
  }
  return null;
}

// Node ≥18.20 refuses to spawn a .cmd/.bat without a shell (CVE-2024-27980),
// so anything that resolves to one has to be run through cmd.exe. Callers get
// told rather than having to know which tools ship as shims.
const WINDOWS_SHIMMED = new Set(['npm', 'npx', 'yarn', 'pnpm', 'bun', 'tsc', 'eslint', 'prettier', 'ng', 'vue', 'code']);

/**
 * How to invoke `name` on this platform.
 * @returns {{file: string, shell: boolean}} `file` to spawn, and whether the
 *   spawn needs `shell: true`. When shell is true every argument goes through
 *   cmd.exe, so callers must not pass unvalidated user input.
 */
export function resolveBinary(name, { env = process.env, platform = process.platform } = {}) {
  const bare = String(name || '').trim();
  if (!bare || platform !== 'win32') return { file: bare, shell: false };

  const found = findOnPath(bare, { env, platform });
  if (found) {
    const isShim = /\.(cmd|bat)$/i.test(found);
    // The resolved name keeps its extension so the loader does not have to
    // guess a second time; a .exe needs no shell.
    return { file: found, shell: isShim };
  }
  // Not on PATH (or PATH is not readable): fall back to the bare name and take
  // the shell if this is a tool that ships as a shim, so the common case still
  // runs instead of failing with a bare ENOENT.
  return { file: bare, shell: WINDOWS_SHIMMED.has(bare.toLowerCase()) };
}

/**
 * The Python launcher that actually exists here. Windows installs `python.exe`
 * and the `py` launcher; `python3` is usually absent, which is what every
 * hardcoded `python3` in the tools was tripping over.
 */
export function resolvePython({ env = process.env, platform = process.platform } = {}) {
  const order = platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python'];
  for (const candidate of order) {
    if (findOnPath(candidate, { env, platform })) return resolveBinary(candidate, { env, platform });
  }
  return resolveBinary(order[0], { env, platform });
}

// ─── Shell selection ─────────────────────────────────────────────────────────

const SHELLS = {
  bash: file => ({ name: 'bash', file, args: ['-lc'] }),
  // -NoProfile keeps a user's profile from printing banners into captured
  // output; -NonInteractive makes a prompt fail instead of hanging forever on
  // a stdin we deliberately closed.
  powershell: file => ({ name: 'powershell', file, args: ['-NoProfile', '-NonInteractive', '-Command'] }),
  cmd: file => ({ name: 'cmd', file, args: ['/d', '/s', '/c'] }),
};

/**
 * The shell used to run a free-form command string.
 *
 * On Windows this is PowerShell, not bash: it is always present, it works on
 * native paths (a `bash` found on PATH is often WSL's, which cannot see
 * `C:\…` the way the caller means), and its aliases mean plain `ls`/`cat`/`rm`
 * still do what a model expects. `ETTORE_SHELL` overrides it for anyone who
 * would rather have Git Bash.
 */
export function resolveShell({ env = process.env, platform = process.platform } = {}) {
  const requested = String(env.ETTORE_SHELL || '').trim().toLowerCase();
  if (requested) {
    if (requested === 'bash' || requested === 'sh') {
      const found = findOnPath(requested, { env, platform });
      return SHELLS.bash(found || requested);
    }
    if (requested === 'pwsh' || requested === 'powershell') {
      const found = findOnPath(requested, { env, platform });
      return SHELLS.powershell(found || requested);
    }
    if (requested === 'cmd' || requested === 'cmd.exe') {
      return SHELLS.cmd(env.ComSpec || 'cmd.exe');
    }
    // An explicit path to something else: run it like a POSIX shell.
    return SHELLS.bash(requested);
  }

  if (platform !== 'win32') return SHELLS.bash('bash');

  const pwsh = findOnPath('pwsh', { env, platform });
  if (pwsh) return SHELLS.powershell(pwsh);
  const windowsPowerShell = findOnPath('powershell', { env, platform });
  if (windowsPowerShell) return SHELLS.powershell(windowsPowerShell);
  return SHELLS.cmd(env.ComSpec || 'cmd.exe');
}

/** Spawn arguments for running `command` in the platform shell. */
export function shellInvocation(command, options = {}) {
  const shell = resolveShell(options);
  return { file: shell.file, args: [...shell.args, String(command)], shell: shell.name };
}

/**
 * One line naming the shell and its conventions, for the system prompt. A
 * model told nothing writes `grep foo *.js | head` on PowerShell and gets a
 * parse error it cannot diagnose.
 */
export function describeShell({ env = process.env, platform = process.platform } = {}) {
  const shell = resolveShell({ env, platform });
  if (shell.name === 'powershell') {
    return 'The `bash` tool runs commands through **PowerShell on Windows**, not bash. Use PowerShell syntax: `Select-String` not grep, `Get-ChildItem`/`ls` not `ls -la`, `;` not `&&` to sequence, `$env:VAR` not `$VAR`, and backslash paths. Aliases exist for ls/cat/cp/mv/rm/pwd/echo. There is no `|head` — use `-First N` or `Select-Object -First N`.';
  }
  if (shell.name === 'cmd') {
    return 'The `bash` tool runs commands through **cmd.exe on Windows**, not bash. Use cmd syntax: `dir` not `ls`, `findstr` not `grep`, `%VAR%` not `$VAR`, and backslash paths.';
  }
  return '';
}

// ─── Paths for display ───────────────────────────────────────────────────────

// Both separators, always: a Windows path can legitimately mix them
// (`C:\projects/zp`), and a POSIX path never contains a backslash separator.
const PATH_SEPARATORS = /[\\/]+/;

/**
 * The trailing `segments` of a path, for headers and tool lines.
 *
 * The TUI used to do `cwd.split('/').slice(-2).join('/')`, which on Windows
 * found no separator at all: `C:\Users\re77\zp` came back whole and overflowed
 * the header it was meant to fit inside.
 */
export function shortenPath(fullPath, segments = 2) {
  const text = String(fullPath ?? '').trim();
  if (!text) return '';
  const parts = text.split(PATH_SEPARATORS).filter(Boolean);
  if (parts.length <= segments) return parts.join('/');
  return parts.slice(-segments).join('/');
}

/** The final component of a path, on either platform's separator. */
export function baseNameOf(fullPath) {
  return shortenPath(fullPath, 1);
}

/** True when `text` looks like it carries a path separator worth shortening. */
export function hasPathSeparator(text) {
  return PATH_SEPARATORS.test(String(text ?? ''));
}

// ─── Process trees ───────────────────────────────────────────────────────────

/**
 * Spawn options that give a command its own killable process tree.
 *
 * `detached` means opposite things per platform: a new process group on POSIX
 * (what we want, so a timeout can take down a build and everything it started)
 * but a new console window on Windows (a visible flash on every command).
 */
export function detachOptions({ platform = process.platform } = {}) {
  if (platform === 'win32') return { detached: false, windowsHide: true };
  return { detached: true };
}

/**
 * Signal a command and everything it started.
 *
 * POSIX signals the negated pid, which is the group. Windows has no process
 * groups to signal — a negative pid throws, and killing the parent orphans the
 * build it spawned — so the tree goes through taskkill.
 */
export function killProcessTree(child, signal, {
  platform = process.platform,
  spawnSyncFn = spawnSync,
  killFn = null,
} = {}) {
  const pid = child?.pid;
  if (!pid) return false;

  if (platform === 'win32') {
    const force = signal === 'SIGKILL';
    const args = ['/pid', String(pid), '/T'];
    if (force) args.push('/F');
    try {
      spawnSyncFn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); return true; } catch { return false; }
    }
  }

  const kill = killFn || process.kill.bind(process);
  try {
    kill(-pid, signal);
    return true;
  } catch {
    try { child.kill(signal); return true; } catch { return false; }
  }
}
