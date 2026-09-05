// Running a shell command without waiting on things that are not the command.
//
// `child_process.exec` settles when the child's stdout and stderr reach EOF,
// not when the child exits. Anything the command leaves running in the
// background inherits those pipes and holds them open, so a command that
// finished instantly keeps the caller waiting for the full timeout:
//
//   sleep 20 & echo started      → 120s, the default timeout
//   sleep 20 >/dev/null & echo   → 10ms, same command, stdout redirected
//
// Starting a dev server, a watcher, or anything else with `&` takes the first
// shape, which is why "the CLI hangs on bash" and "bash works fine" are both
// true depending on the command.
//
// This waits for the process instead, and treats the streams as a best effort
// after that.

import { spawn } from 'node:child_process';

// After the process exits, its own output may still be sitting in the pipe.
// A short grace period lets that land before we stop listening; a background
// grandchild holding the pipe open costs exactly this much and no more.
const FLUSH_GRACE_MS = 150;
// Between asking a runaway process group to stop and insisting.
const KILL_GRACE_MS = 2000;

/**
 * Runs `command` through bash and resolves once the command itself is done.
 *
 * @returns {Promise<{stdout, stderr, code, signal, timedOut, aborted, truncated}>}
 *   Never rejects for a command that ran: a non-zero exit, a timeout and a
 *   kill are all outcomes with output worth reading, and the caller decides
 *   what to make of them. It rejects only when the shell could not be started.
 */
export function runShellCommand(command, {
  cwd = process.cwd(),
  timeoutMs = 120_000,
  signal = null,
  maxBytes = 10 * 1024 * 1024,
  spawnFn = spawn,
  env = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn('bash', ['-lc', String(command)], {
        cwd,
        env,
        // stdin closed outright rather than redirected inside the command
        // string: anything that reads it — a prompt, a REPL, `git commit` with
        // no -m — gets EOF instead of waiting on a pipe nobody will write to.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a timeout can take down what the command
        // started as well as the command. Without this a runaway build leaves
        // its children behind.
        detached: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let flushTimer = null;
    let killTimer = null;

    const timeoutTimer = setTimeout(() => { timedOut = true; stop('SIGTERM'); }, timeoutMs);
    timeoutTimer.unref?.();

    const collect = (chunk, into) => {
      if (truncated) return;
      const text = String(chunk);
      bytes += Buffer.byteLength(text);
      if (bytes > maxBytes) {
        truncated = true;
        return;
      }
      if (into === 'out') stdout += text; else stderr += text;
    };

    // Signals go to the negated pid, which is the whole group. A command that
    // spawned a build, a server or a test runner takes them with it.
    const signalGroup = (sig) => {
      try { process.kill(-child.pid, sig); } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };

    function stop(sig) {
      signalGroup(sig);
      if (killTimer) return;
      killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    }

    function onAbort() { aborted = true; stop('SIGTERM'); }
    if (signal) {
      if (signal.aborted) { aborted = true; }
      else signal.addEventListener?.('abort', onAbort, { once: true });
    }

    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (flushTimer) clearTimeout(flushTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', onAbort);
      // Stop reading; a grandchild may still own the far end of these.
      try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* already closed */ }
      // The parent must not be kept alive by a process it is no longer
      // waiting for.
      try { child.unref(); } catch { /* not detached */ }
      resolve({ stdout, stderr, code, signal: sig, timedOut, aborted, truncated });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', c => collect(c, 'out'));
    child.stderr?.on('data', c => collect(c, 'err'));
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    // `close` is the clean end — process gone *and* pipes drained — so it is
    // preferred when it comes. `exit` is the one that always comes.
    child.on('close', (code, sig) => finish(code, sig));
    child.on('exit', (code, sig) => {
      if (settled || flushTimer) return;
      flushTimer = setTimeout(() => finish(code, sig), FLUSH_GRACE_MS);
      flushTimer.unref?.();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    if (aborted) stop('SIGTERM');
  });
}
