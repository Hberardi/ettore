// The `bash` tool on Windows, without starting PowerShell every time.
//
// A one-shot `powershell -Command` costs half a second to a second and a half
// before the command even begins — Windows PowerShell's startup, plus the
// antivirus looking at a fresh process. An agent turn runs a dozen commands,
// so that was the bulk of the time it spent "in bash".
//
// This keeps a few PowerShells warm and runs each command in one of them, with
// the one-shot contract kept intact (see isolatedPowerShell in
// bash-session.js): its own working directory, its own variables, `$env:`
// changes undone, and stdin closed. It is used only where it helps — Windows,
// with PowerShell as the shell — and anything that goes wrong with it hands
// the command back to the one-shot path rather than failing the call.
//
// ETTORE_WARM_SHELL=0 turns it off.

import { BashSession, sessionDialect } from './bash-session.js';
import { resolveShell } from '../utils/platform.js';

// Parallel tool calls each get a shell; beyond this they queue.
const POOL_SIZE = 3;

const pool = [];
// Set once the pipe transport has failed here: the next call should not pay
// for finding that out again.
let broken = false;

export function warmShellEnabled({ env = process.env, platform = process.platform } = {}) {
  if (broken || platform !== 'win32') return false;
  if (String(env.ETTORE_WARM_SHELL ?? '').trim() === '0') return false;
  return resolveShell({ env, platform }).name === 'powershell';
}

function pickSession() {
  const idle = pool.find(entry => entry.busy === 0);
  if (idle) return idle;
  if (pool.length < POOL_SIZE) {
    const entry = {
      busy: 0,
      session: new BashSession(process.cwd(), {
        transport: 'pipe',
        isolate: true,
        dialect: sessionDialect(),
      }),
    };
    pool.push(entry);
    return entry;
  }
  return pool.reduce((a, b) => (b.busy < a.busy ? b : a));
}

/**
 * Runs `command` in a warm PowerShell.
 *
 * @returns {Promise<object|null>} the same shape runShellCommand resolves to,
 *   or null when the warm shell is unavailable and the caller should run the
 *   command the one-shot way instead.
 */
export async function runWarmShellCommand(command, { cwd = process.cwd(), timeoutMs = 120_000, signal = null } = {}) {
  if (!warmShellEnabled()) return null;
  const entry = pickSession();
  const { session } = entry;
  entry.busy += 1;
  session.setRef(true);
  try {
    try {
      await session.ready();
    } catch {
      // Named pipes blocked, PowerShell refusing -EncodedCommand, a policy we
      // cannot see: whatever it is, the one-shot path still works.
      broken = true;
      killWarmShells();
      return null;
    }
    const r = await session.run(command, { timeoutMs, signal, cwd });
    if (r.writeError) return null;
    return {
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      // `exit 3` ends the warm shell itself; its exit code is the command's.
      code: r.timedOut || r.aborted ? null : r.exitCode,
      signal: r.signal ?? null,
      timedOut: Boolean(r.timedOut),
      aborted: Boolean(r.aborted),
      truncated: Boolean(r.bufferOverflow),
    };
  } finally {
    entry.busy -= 1;
    if (entry.busy === 0) session.setRef(false);
  }
}

export function killWarmShells() {
  for (const entry of pool.splice(0)) {
    try { entry.session.kill(); } catch { /* already gone */ }
  }
}

process.on('exit', () => { try { killWarmShells(); } catch { /* exiting */ } });
