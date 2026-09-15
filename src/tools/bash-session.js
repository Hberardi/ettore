// Persistent shell session.
//
// One long-lived shell subprocess shared across the whole agent run — bash on
// POSIX, PowerShell on Windows. `cd`, exported variables, defined functions
// and shell options persist between calls, unlike the one-shot `bash` tool
// that spawns a fresh process each time.
//
// Commands are framed with a random sentinel on BOTH stdout and stderr so we
// can detect their end without relying on a real PTY. Calls are serialized
// through a Promise chain so parallel tool batches don't interleave on shared
// stdin/stdout.
//
// On timeout or abort the shell is killed and respawned on the next call —
// a stuck command may have left stdin or job-control state in an unknown
// position, and a clean restart is cheaper than guessing.

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { resolve } from 'path';
import { killProcessTree, resolveShell } from '../utils/platform.js';

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
// How long to keep waiting for the stderr sentinel once stdout's has arrived.
// It is a fallback, not the mechanism: normally both are already in hand. It
// exists for the command that makes its counterpart unreachable — `exec 2>&-`
// closes the session's stderr, `exec 2>/dev/null` redirects it — where waiting
// for a sentinel that can never come would otherwise hold the call for the
// full command timeout.
const STDERR_SENTINEL_GRACE_MS = 250;

let _sharedSession = null;

function makeSentinel() {
  return `__ETTORE_SESSION_END_${randomBytes(8).toString('hex')}__`;
}

// Per-shell framing. Both dialects must satisfy the same contract: run the
// command in the session's own scope (so `cd` sticks), keep the shell alive
// after an error, print the bare `<sentinel>` on stderr, and then print
// `<sentinel>EXIT:<code>` on stdout — both once the command is done and not
// before.
//
// stderr is framed for the same reason stdout is. It is a separate pipe,
// delivered independently of stdout, so "the stdout sentinel arrived" says
// nothing about whether the command's stderr has been read yet. This used to
// be papered over with a single `setImmediate` before detaching the listeners,
// which is a guess about the event loop rather than a fact about the data:
// under load the stderr read slipped past it and a command's entire error
// output was reported as empty, with a correct exit code and correct stdout
// beside it. A sentinel on stderr turns the question into one the data answers
// — a pipe preserves order, so the sentinel arriving proves every earlier byte
// of stderr is already in the buffer.
//
// The stderr sentinel is emitted BEFORE the stdout one, so by the time the
// stdout sentinel is seen its counterpart is already in flight.
export const SHELL_DIALECTS = {
  bash: {
    args: ['--noprofile', '--norc'],
    env: { PS1: '', PS2: '', TERM: 'dumb' },
    init: '',
    // Brace group preserves shell builtins like `cd` (a subshell would lose
    // the cwd change). The sentinel + exit code prints AFTER user output so
    // we can frame it cleanly.
    //
    // `< /dev/null` on the group is what keeps this tool from freezing. The
    // shell's stdin is the same pipe we write commands into, so a command
    // that reads stdin — `read`, a REPL, `git commit` with no -m, an npm or
    // sudo prompt — swallows the sentinel line below and the framing never
    // arrives: the call then sits there for the full timeout. Worse, a
    // command that *echoes* stdin (`cat`) hands the sentinel straight back
    // and we frame a bogus success. Redirecting the group's default stdin
    // fixes both; a command with its own redirect (heredoc, `< file`, an
    // explicit pipe) still wins, because that redirect is applied closer in.
    //
    // `$?` is captured into a variable first: the stderr printf below would
    // otherwise overwrite it before the exit code is read. Both printfs sit
    // outside the brace group, so a `2>&1` inside the user's command
    // redirects the command's own output without capturing the framing.
    frame: (command, sentinel) =>
      `{ ${command}\n} < /dev/null\n__ettore_ec=$?\n`
      + `printf '\\n%s\\n' '${sentinel}' >&2\n`
      + `printf '\\n%sEXIT:%d\\n' '${sentinel}' $__ettore_ec\n`,
  },
  powershell: {
    // `-Command -` reads statements from stdin, which is what makes the
    // session persistent. -NonInteractive is what stops Read-Host and every
    // other prompt from eating the sentinel: it errors instead of blocking,
    // which is the closest equivalent to bash's `< /dev/null`.
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
    env: {},
    // An empty prompt so no `PS C:\>` lands in captured stdout, and Continue
    // so a failing command does not tear the session down.
    init: "function prompt { '' }\n$ErrorActionPreference = 'Continue'\n",
    // No `& { }` wrapper: it would give the command its own scope and a
    // `Set-Location` would not stick, which is the whole point of a session.
    //
    // Exit codes come from two places in PowerShell — $LASTEXITCODE for native
    // executables, $? for cmdlets — so both are consulted. A cmdlet that fails
    // leaves $LASTEXITCODE untouched from an earlier command, hence the reset.
    frame: (command, sentinel) => [
      '$LASTEXITCODE = 0',
      command,
      '$__ettore_ok = $?',
      '$__ettore_ec = if ($__ettore_ok) { if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE } }'
        + ' else { if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 } }',
      `[Console]::Error.Write("\`n" + '${sentinel}' + "\`n")`,
      `[Console]::Out.Write("\`n" + '${sentinel}' + "EXIT:" + $__ettore_ec + "\`n")`,
      '',
    ].join('\n'),
  },
};

/** The dialect for this platform's session shell. */
export function sessionDialect(options = {}) {
  const shell = resolveShell(options);
  // cmd.exe has no usable stdin REPL for this protocol; PowerShell is present
  // on every supported Windows, so that is the Windows session shell.
  const name = shell.name === 'bash' ? 'bash' : 'powershell';
  const file = shell.name === 'cmd' ? 'powershell' : shell.file;
  return { name, file, ...SHELL_DIALECTS[name] };
}

class BashSession {
  constructor(workdir = process.cwd(), options = {}) {
    this.workdir = resolve(workdir);
    this.process = null;
    this.alive = false;
    this.platform = options.platform || process.platform;
    this.dialect = options.dialect || sessionDialect({ platform: this.platform, env: options.env || process.env });
    this._spawn = options.spawnFn || spawn;
    // Promise chain used to serialize concurrent run() calls — the shell
    // can only execute one command at a time, since stdin/stdout are shared.
    this._chain = Promise.resolve();
  }

  ensureStarted() {
    if (this.alive && this.process) return;
    const proc = this._spawn(this.dialect.file, this.dialect.args, {
      cwd: this.workdir,
      env: { ...process.env, ...this.dialect.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process = proc;
    this.alive = true;
    // Guard against a SIGTERM'd previous process exiting AFTER we've already
    // spawned its replacement: only clear state if `proc` is still the active
    // one. Without this guard, the late `exit` event from the old shell would
    // wipe out the new process reference.
    proc.on('exit', () => {
      if (this.process === proc) { this.alive = false; this.process = null; }
    });
    proc.on('error', () => {
      if (this.process === proc) { this.alive = false; this.process = null; }
    });
    // A dead shell surfaces the failed write as an async EPIPE on the stdin
    // stream, not as a throw from write(). Without a listener that becomes an
    // unhandled 'error' event and takes the CLI down; the pending call is
    // settled by the `exit` handler above.
    proc.stdin.on('error', () => {});
    // Prompt and error-preference setup, written before any user command so
    // its output can never land inside a framed result.
    if (this.dialect.init) {
      try { proc.stdin.write(this.dialect.init); } catch { /* handled above */ }
    }
  }

  run(command, opts = {}) {
    const next = this._chain.then(() => this._runOne(command, opts));
    // Keep the chain alive even if a call rejects — otherwise later commands
    // would inherit the rejection.
    this._chain = next.catch(() => {});
    return next;
  }

  _runOne(command, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, onProgress } = {}) {
    if (typeof command !== 'string' || !command.trim()) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    }
    this.ensureStarted();
    const sentinel = makeSentinel();
    const startedAt = Date.now();

    return new Promise((resolve) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let bufferOverflow = false;
      let settled = false;
      let stdoutSentinelSeen = false;
      let stderrSentinelSeen = false;
      // Filled in by the stdout branch, consumed once both streams are framed.
      let framedStdout = '';
      let framedExitCode = 0;
      let graceTimer = null;

      const heartbeat = onProgress ? setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        onProgress(`Running… ${elapsed}s elapsed`);
      }, 5000) : null;
      heartbeat?.unref?.();

      const settle = (value) => {
        if (settled) return;
        settled = true;
        if (heartbeat) clearInterval(heartbeat);
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        this.process?.stdout?.off('data', onStdout);
        this.process?.stderr?.off('data', onStderr);
        this.process?.off('exit', onExit);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };

      // Completion is the conjunction of the two streams, not a bet on timing.
      const settleIfFramed = () => {
        if (!stdoutSentinelSeen || !stderrSentinelSeen) return;
        settle({
          stdout: framedStdout.replace(/\r?\n+$/, ''),
          stderr: stderrBuf.replace(/\r?\n+$/, ''),
          exitCode: framedExitCode,
          bufferOverflow,
        });
      };

      const onStdout = (data) => {
        stdoutBuf += data.toString();
        if (stdoutBuf.length > MAX_BUFFER_BYTES) {
          bufferOverflow = true;
          stdoutBuf = stdoutBuf.slice(-MAX_BUFFER_BYTES);
        }
        const idx = stdoutBuf.indexOf(sentinel);
        if (idx !== -1 && !stdoutSentinelSeen) {
          stdoutSentinelSeen = true;
          framedStdout = stdoutBuf.slice(0, idx);
          const after = stdoutBuf.slice(idx + sentinel.length);
          const codeMatch = after.match(/EXIT:(-?\d+)/);
          framedExitCode = codeMatch ? parseInt(codeMatch[1], 10) : 0;
          if (!stderrSentinelSeen) {
            // Its counterpart was written first, so it is on its way; give the
            // pipe the time it needs rather than a single event-loop turn. The
            // timer only fires for a command that made it unreachable.
            graceTimer = setTimeout(() => {
              stderrSentinelSeen = true;
              settleIfFramed();
            }, STDERR_SENTINEL_GRACE_MS);
            graceTimer.unref?.();
          }
          settleIfFramed();
        }
      };

      const onStderr = (data) => {
        stderrBuf += data.toString();
        if (stderrBuf.length > MAX_BUFFER_BYTES) {
          bufferOverflow = true;
          stderrBuf = stderrBuf.slice(-MAX_BUFFER_BYTES);
        }
        const idx = stderrBuf.indexOf(sentinel);
        if (idx !== -1 && !stderrSentinelSeen) {
          stderrSentinelSeen = true;
          // Cut the framing back out: it is our protocol, not the command's
          // error output. Anything after it belongs to a later command and is
          // dropped with it.
          stderrBuf = stderrBuf.slice(0, idx);
          settleIfFramed();
        }
      };

      const onExit = (code, sig) => {
        settle({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode: code ?? -1,
          sessionDied: true,
          signal: sig,
        });
      };

      const onAbort = () => {
        this.kill();
        settle({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode: 130,
          aborted: true,
        });
      };

      const timer = setTimeout(() => {
        this.kill();
        settle({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode: 124,
          timedOut: true,
        });
      }, timeoutMs);
      timer.unref?.();

      this.process.stdout.on('data', onStdout);
      this.process.stderr.on('data', onStderr);
      this.process.on('exit', onExit);
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener?.('abort', onAbort, { once: true });
      }

      // See SHELL_DIALECTS for why each shell frames the way it does.
      const wrapped = this.dialect.frame(command, sentinel);
      try {
        this.process.stdin.write(wrapped);
      } catch (err) {
        settle({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode: -1,
          writeError: String(err?.message || err),
        });
      }
    });
  }

  kill() {
    const proc = this.process;
    this.alive = false;
    this.process = null;
    if (!proc) return;
    // The session shell may have started a build or a server; killing only the
    // shell would orphan it. Windows has no process group to signal, so this
    // goes through taskkill /T.
    killProcessTree(proc, 'SIGTERM', { platform: this.platform });
    const forceTimer = setTimeout(() => {
      killProcessTree(proc, 'SIGKILL', { platform: this.platform });
    }, 2000);
    forceTimer.unref?.();
  }
}

export function getBashSession(workdir) {
  const requestedWorkdir = resolve(workdir || process.cwd());
  if (_sharedSession && _sharedSession.workdir !== requestedWorkdir) {
    _sharedSession.kill();
    _sharedSession = null;
  }
  if (!_sharedSession) _sharedSession = new BashSession(requestedWorkdir);
  return _sharedSession;
}

export function killBashSession() {
  if (_sharedSession) {
    _sharedSession.kill();
    _sharedSession = null;
  }
}

// Best-effort cleanup so a crashed/exiting CLI doesn't leak the shell child.
process.on('exit', () => { try { killBashSession(); } catch {} });
process.on('SIGINT', () => { try { killBashSession(); } catch {} });
process.on('SIGTERM', () => { try { killBashSession(); } catch {} });
