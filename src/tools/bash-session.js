// Persistent bash session.
//
// One long-lived `bash` subprocess shared across the whole agent run.
// `cd`, exported variables, defined functions, and shell options persist
// between calls — unlike the one-shot `bash` tool that spawns a fresh
// process each time.
//
// Commands are framed with a random sentinel so we can detect their end
// without relying on a real PTY. Calls are serialized through a Promise
// chain so parallel tool batches don't interleave on shared stdin/stdout.
//
// On timeout or abort the shell is killed and respawned on the next call —
// a stuck command may have left stdin or job-control state in an unknown
// position, and a clean restart is cheaper than guessing.

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { resolve } from 'path';

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

let _sharedSession = null;

function makeSentinel() {
  return `__ETTORE_SESSION_END_${randomBytes(8).toString('hex')}__`;
}

class BashSession {
  constructor(workdir = process.cwd()) {
    this.workdir = resolve(workdir);
    this.process = null;
    this.alive = false;
    // Promise chain used to serialize concurrent run() calls — the shell
    // can only execute one command at a time, since stdin/stdout are shared.
    this._chain = Promise.resolve();
  }

  ensureStarted() {
    if (this.alive && this.process) return;
    const proc = spawn('bash', ['--noprofile', '--norc'], {
      cwd: this.workdir,
      env: {
        ...process.env,
        PS1: '',
        PS2: '',
        TERM: 'dumb',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
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
      let sentinelSeen = false;

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
        this.process?.stdout?.off('data', onStdout);
        this.process?.stderr?.off('data', onStderr);
        this.process?.off('exit', onExit);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };

      const onStdout = (data) => {
        stdoutBuf += data.toString();
        if (stdoutBuf.length > MAX_BUFFER_BYTES) {
          bufferOverflow = true;
          stdoutBuf = stdoutBuf.slice(-MAX_BUFFER_BYTES);
        }
        const idx = stdoutBuf.indexOf(sentinel);
        if (idx !== -1 && !sentinelSeen) {
          sentinelSeen = true;
          const before = stdoutBuf.slice(0, idx);
          const after = stdoutBuf.slice(idx + sentinel.length);
          const codeMatch = after.match(/EXIT:(-?\d+)/);
          const exitCode = codeMatch ? parseInt(codeMatch[1], 10) : 0;
          // Defer settle so any pending stderr `data` events already queued by
          // the kernel get a chance to fire on the current event-loop turn —
          // otherwise stderr written before the sentinel can be lost when we
          // detach listeners.
          setImmediate(() => {
            settle({
              stdout: before.replace(/\r?\n+$/, ''),
              stderr: stderrBuf.replace(/\r?\n+$/, ''),
              exitCode,
              bufferOverflow,
            });
          });
        }
      };

      const onStderr = (data) => {
        stderrBuf += data.toString();
        if (stderrBuf.length > MAX_BUFFER_BYTES) {
          bufferOverflow = true;
          stderrBuf = stderrBuf.slice(-MAX_BUFFER_BYTES);
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
      const wrapped = `{ ${command}\n} < /dev/null\nprintf '\\n%sEXIT:%d\\n' '${sentinel}' $?\n`;
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
    try { proc.kill('SIGTERM'); } catch {}
    const forceTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
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
