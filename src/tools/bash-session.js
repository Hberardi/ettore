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
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { killProcessTree, resolveShell } from '../utils/platform.js';

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
// How long stderr may stay SILENT, after stdout's sentinel has arrived, before
// we stop waiting for its counterpart.
//
// It is the last resort, not the mechanism. A command that makes stderr
// unreachable — `exec 2>&-` closes it, `exec 2>/dev/null` redirects it —
// normally closes the pipe, and that close is what tells us no sentinel is
// coming: a fact from the data rather than a bet on the clock. This window
// only covers the case where the pipe somehow stays open with nothing on it.
//
// It resets on every byte of stderr, because a pipe preserves order: data
// still arriving proves the sentinel is queued behind it. The window used to
// be a flat 250ms from the stdout sentinel, and under load — a full test suite,
// a busy machine — it expired while `boom` was still in flight, and the
// command's entire error output was reported as empty next to a correct exit
// code. That is precisely the failure the stderr sentinel exists to prevent.
const STDERR_SILENCE_GRACE_MS = 2000;
// How long a piped PowerShell has to dial back before we give up on it.
const PIPE_CONNECT_TIMEOUT_MS = 15_000;

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
    // so a failing command does not tear the session down. UTF-8 output so an
    // accented file name or git message does not arrive in the OEM codepage.
    init: "function prompt { '' }\n$ErrorActionPreference = 'Continue'\n$ProgressPreference = 'SilentlyContinue'\n"
      + 'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding } catch { }\n',
    // The command never reaches stdin as text. `-Command -` reads stdin the
    // way the interactive console does: a multi-line statement — a `foreach`
    // block, an `if` over three lines, a here-string — is only run once a
    // BLANK line follows it. The frame had none, so every framing line after
    // such a command was swallowed into the same pending statement, the
    // sentinel never printed, and the call sat there for the full timeout.
    // An unbalanced brace or quote did the same, forever. Models write
    // multi-line PowerShell all the time, so this was the common case.
    //
    // Instead the command travels base64-encoded on one line and is parsed by
    // [ScriptBlock]::Create: a syntax error becomes an exception with a
    // message, not a hang, and non-ASCII text survives stdin's codepage.
    //
    // It is dot-sourced, not `& { }`: `&` would give the command its own
    // scope and a `Set-Location` would not stick, which is the whole point of
    // a session. `$?` is read inside the same script, right after the
    // command's last statement, so it still describes the command.
    //
    // Exit codes come from two places in PowerShell — $LASTEXITCODE for native
    // executables, $? for cmdlets — so both are consulted. A cmdlet that fails
    // leaves $LASTEXITCODE untouched from an earlier command, hence the reset.
    //
    // With `cwd` the command runs isolated instead — see isolatedPowerShell.
    frame: (command, sentinel, { cwd = null } = {}) => [
      '$LASTEXITCODE = 0',
      '$__ettore_ok = $false',
      "try { . ([ScriptBlock]::Create([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"
        + Buffer.from(cwd == null ? `${command}\n$__ettore_ok = $?` : isolatedPowerShell(command, cwd), 'utf8').toString('base64')
        + "')))) } catch { [Console]::Error.WriteLine(($_ | Out-String).TrimEnd()) }",
      '$__ettore_ec = if ($__ettore_ok) { if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE } }'
        + ' else { if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 } }',
      `[Console]::Error.Write("\`n" + '${sentinel}' + "\`n")`,
      `[Console]::Out.Write("\`n" + '${sentinel}' + "EXIT:" + $__ettore_ec + "\`n")`,
      '',
    ].join('\n'),
  },
};

const psQuote = text => String(text).replace(/'/g, "''");

/**
 * A command run in a warm PowerShell as if it had a process of its own: the
 * `bash` tool's contract, which is one fresh shell per call.
 *
 * - It starts in `cwd`, whatever the previous command did with the location.
 * - Its variables and functions live in a child scope (`& { }`) and go with it.
 * - `$env:` changes are undone afterwards, since a process of its own would
 *   have taken them to its grave.
 * - Its output is formatted inside the statement (`Out-String -Stream`). The
 *   warm shell is one long-running pipeline, and left to Out-Default a table
 *   is held back to size its columns — long enough for the end-of-command
 *   sentinel, written straight to the console, to overtake it — and the
 *   next command's objects would join the same table without a header.
 *
 * `$?` is taken inside the child scope, right after the command's last
 * statement, and handed to the frame one scope up.
 */
export function isolatedPowerShell(command, cwd) {
  return [
    `Set-Location -LiteralPath '${psQuote(cwd)}'`,
    '$__ettore_snap = [Environment]::GetEnvironmentVariables()',
    'try {',
    '& {',
    command,
    'Set-Variable -Scope 1 -Name __ettore_ok -Value $?',
    // A bare `process` block, not ForEach-Object, which is several times
    // slower per line in Windows PowerShell — noticeable on a big listing.
    '} | Out-String -Stream -Width 200 | & { process { [Console]::Out.WriteLine($_) } }',
    '} finally {',
    '$__ettore_now = [Environment]::GetEnvironmentVariables()',
    'foreach ($k in @($__ettore_now.Keys)) { if (-not $__ettore_snap.ContainsKey($k)) { [Environment]::SetEnvironmentVariable($k, $null) } }',
    'foreach ($k in @($__ettore_snap.Keys)) { if ($__ettore_now[$k] -cne $__ettore_snap[$k]) { [Environment]::SetEnvironmentVariable($k, $__ettore_snap[$k]) } }',
    '}',
  ].join('\n');
}

/**
 * The script a piped PowerShell runs: dial the named pipe, prove it is the
 * child we started, then execute each line it receives — a base64-encoded
 * frame — in its own scope.
 *
 * Commands arrive over a named pipe rather than stdin because stdin is
 * inherited. A native program run from a `-Command -` shell reads the very
 * pipe the commands are written into: `python` with no arguments, `git
 * commit` with no -m, anything with a prompt, sat waiting on it until the
 * timeout. This shell's stdin is closed, so they get EOF straight away — the
 * same as a one-shot `powershell -Command`.
 */
export function powershellPipeBootstrap() {
  return [
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$__ettore_utf8 = New-Object System.Text.UTF8Encoding $false',
    'try { [Console]::OutputEncoding = $__ettore_utf8; $OutputEncoding = $__ettore_utf8 } catch { }',
    "$__ettore_pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $env:ETTORE_SH_PIPE, [System.IO.Pipes.PipeDirection]::InOut)",
    `$__ettore_pipe.Connect(${PIPE_CONNECT_TIMEOUT_MS})`,
    '$__ettore_w = New-Object System.IO.StreamWriter($__ettore_pipe, $__ettore_utf8)',
    '$__ettore_w.AutoFlush = $true',
    '$__ettore_w.WriteLine($env:ETTORE_SH_TOKEN)',
    // Nothing the commands start should inherit the handshake.
    'Remove-Item Env:ETTORE_SH_TOKEN, Env:ETTORE_SH_PIPE -ErrorAction SilentlyContinue',
    '$__ettore_r = New-Object System.IO.StreamReader($__ettore_pipe, $__ettore_utf8)',
    'while ($null -ne ($__ettore_line = $__ettore_r.ReadLine())) {',
    '  . ([ScriptBlock]::Create($__ettore_utf8.GetString([Convert]::FromBase64String($__ettore_line))))',
    '}',
  ].join('\n');
}

/** Where a piped shell's named pipe lives: the pipe namespace on Windows. */
export function pipePath(name, platform = process.platform) {
  return platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

/** The dialect for this platform's session shell. */
export function sessionDialect(options = {}) {
  const shell = resolveShell(options);
  // cmd.exe has no usable stdin REPL for this protocol; PowerShell is present
  // on every supported Windows, so that is the Windows session shell.
  const name = shell.name === 'bash' ? 'bash' : 'powershell';
  const file = shell.name === 'cmd' ? 'powershell' : shell.file;
  return { name, file, ...SHELL_DIALECTS[name] };
}

// Exported for tests: the stdout/stderr framing has a race that only appears
// under load, and a fake process is the only way to drive it deterministically.
export class BashSession {
  constructor(workdir = process.cwd(), options = {}) {
    this.workdir = resolve(workdir);
    this.process = null;
    this.alive = false;
    this.platform = options.platform || process.platform;
    this.dialect = options.dialect || sessionDialect({ platform: this.platform, env: options.env || process.env });
    this._spawn = options.spawnFn || spawn;
    // 'stdin' writes commands into the shell's stdin; 'pipe' (PowerShell
    // only) sends them over a named pipe and leaves stdin closed.
    this.transport = options.transport || 'stdin';
    // Each command gets a fresh-process contract instead of a shared scope.
    this.isolate = Boolean(options.isolate);
    this._socket = null;
    this._outbox = [];
    this._ready = Promise.resolve();
    // Promise chain used to serialize concurrent run() calls — the shell
    // can only execute one command at a time, since stdin/stdout are shared.
    this._chain = Promise.resolve();
  }

  ensureStarted() {
    if (this.alive && this.process) return;
    const proc = this.transport === 'pipe'
      ? this._startPiped()
      : this._spawn(this.dialect.file, this.dialect.args, {
        cwd: this.workdir,
        env: { ...process.env, ...this.dialect.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    this.process = proc;
    this.alive = true;
    // The flag describes THIS process's stderr pipe. A respawn gets a new one,
    // and carrying the old value over would declare it dead from the start.
    this._stderrEnded = false;
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
    proc.stdin?.on('error', () => {});
    // Prompt and error-preference setup, written before any user command so
    // its output can never land inside a framed result. The piped bootstrap
    // does its own.
    if (this.dialect.init && this.transport !== 'pipe') {
      try { proc.stdin.write(this.dialect.init); } catch { /* handled above */ }
    }
  }

  // A PowerShell whose commands arrive over a named pipe it dials back to.
  // Resolves `ready()` once the handshake proves the caller is our child.
  _startPiped() {
    const name = `ettore-sh-${randomBytes(12).toString('hex')}`;
    const token = randomBytes(16).toString('hex');
    this._socket = null;
    this._outbox = [];
    let settle = null;
    this._ready = new Promise((resolveReady, rejectReady) => { settle = { resolveReady, rejectReady }; });
    this._ready.catch(() => {});

    const server = createServer((sock) => {
      sock.on('error', () => {});
      sock.setEncoding('utf8');
      let hello = '';
      const onHello = (data) => {
        hello += data;
        const nl = hello.indexOf('\n');
        if (nl === -1) {
          if (hello.length > 256) sock.destroy();
          return;
        }
        sock.off('data', onHello);
        // Anyone on the machine can dial a named pipe. Only the process that
        // was handed the token in its environment gets the commands.
        if (hello.slice(0, nl).trim() !== token) { sock.destroy(); return; }
        done(null, sock);
      };
      sock.on('data', onHello);
    });
    const connectTimer = setTimeout(() => done(new Error('the shell did not connect')), PIPE_CONNECT_TIMEOUT_MS + 2000);
    connectTimer.unref?.();
    const done = (err, sock = null) => {
      if (!settle) return;
      const { resolveReady, rejectReady } = settle;
      settle = null;
      clearTimeout(connectTimer);
      server.close(() => {});
      if (err) { rejectReady(err); return; }
      this._socket = sock;
      if (!this._refed) sock.unref?.();
      for (const line of this._outbox) sock.write(line);
      this._outbox = [];
      resolveReady();
    };
    server.on('error', err => done(err));
    server.listen(pipePath(name, this.platform));
    server.unref?.();

    const encoded = Buffer.from(powershellPipeBootstrap(), 'utf16le').toString('base64');
    const proc = this._spawn(this.dialect.file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      cwd: this.workdir,
      env: { ...process.env, ETTORE_SH_PIPE: name, ETTORE_SH_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc.on('exit', () => done(new Error('the shell exited before it connected')));
    proc.on('error', err => done(err));
    return proc;
  }

  /** Resolves once the shell can take commands; rejects if it never will. */
  ready() {
    this.ensureStarted();
    return this._ready;
  }

  // Whether this shell may hold the event loop open. A warm shell sitting
  // idle must not keep the CLI from exiting; one running a command must.
  setRef(on) {
    this._refed = on;
    const method = on ? 'ref' : 'unref';
    for (const handle of [this.process, this.process?.stdout, this.process?.stderr, this._socket]) {
      try { handle?.[method]?.(); } catch { /* already closed */ }
    }
  }

  _send(text) {
    if (this.transport !== 'pipe') {
      this.process.stdin.write(text);
      return;
    }
    const line = `${Buffer.from(text, 'utf8').toString('base64')}\n`;
    if (this._socket) this._socket.write(line);
    else this._outbox.push(line);
  }

  run(command, opts = {}) {
    const next = this._chain.then(() => this._runOne(command, opts));
    // Keep the chain alive even if a call rejects — otherwise later commands
    // would inherit the rejection.
    this._chain = next.catch(() => {});
    return next;
  }

  _runOne(command, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, onProgress, cwd = null } = {}) {
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
      // Set when we stop waiting for a sentinel that never came: the error
      // output may be incomplete, and a caller must not present it as whole.
      let stderrTruncated = false;

      // Restart the silence window. Called whenever stderr proves it is alive.
      const armGrace = () => {
        if (stdoutSentinelSeen && !stderrSentinelSeen && !settled) {
          if (graceTimer) clearTimeout(graceTimer);
          graceTimer = setTimeout(() => {
            stderrTruncated = true;
            stderrSentinelSeen = true;
            settleIfFramed();
          }, STDERR_SILENCE_GRACE_MS);
          graceTimer.unref?.();
        }
      };

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
        this.process?.stderr?.off('end', onStderrEnd);
        this.process?.off('close', onClose);
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
          stderrTruncated,
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
            // Its counterpart was written first, so it is on its way. If the
            // pipe has already closed, nothing is coming and there is nothing
            // to wait for; otherwise wait for as long as stderr stays silent.
            if (this._stderrEnded) {
              stderrSentinelSeen = true;
            } else {
              armGrace();
            }
          }
          settleIfFramed();
        }
      };

      // The pipe closed: the command redirected or closed stderr, so its
      // sentinel can never arrive. Whatever is buffered is all there is.
      const onStderrEnd = () => {
        this._stderrEnded = true;
        if (!stderrSentinelSeen) {
          stderrSentinelSeen = true;
          settleIfFramed();
        }
      };

      const onStderr = (data) => {
        stderrBuf += data.toString();
        // Proof the pipe is alive and ordered: the sentinel is behind this.
        armGrace();
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

      // The shell died under the command — `exit 3` ends the session shell
      // itself, and so does a crash. Settling on the process's `exit` event
      // read the buffers at the instant the process ended, which says nothing
      // about whether its output had been read yet: on a loaded machine the
      // stderr bytes were still in the pipe, and a command's error output came
      // back empty beside a correct exit code. `close` is the event that means
      // the process ended AND its stdio is drained, so the buffers are whole.
      const onClose = (code, sig) => {
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
      this.process.stderr.on('end', onStderrEnd);
      this.process.on('close', onClose);
      // A pipe that closed during an earlier command stays closed: nothing
      // will ever arrive on it again, so do not wait on it at all.
      if (this._stderrEnded) stderrSentinelSeen = true;
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener?.('abort', onAbort, { once: true });
      }

      // See SHELL_DIALECTS for why each shell frames the way it does.
      const wrapped = this.dialect.frame(command, sentinel, this.isolate ? { cwd: cwd || this.workdir } : undefined);
      try {
        this._send(wrapped);
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
    try { this._socket?.destroy(); } catch { /* already gone */ }
    this._socket = null;
    this._outbox = [];
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
