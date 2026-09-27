import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join, win32 } from 'path';
import { findOnPath } from '../utils/platform.js';

// Bridge to the locally installed Claude Code CLI. Unlike every other entry in
// the registry this provider holds no API key: the `claude` binary is already
// authenticated against the user's Anthropic account (subscription OAuth, or a
// token from `claude setup-token`), and we simply drive it in headless mode.
//
// Anthropic's Messages API only accepts `x-api-key` credentials — subscription
// OAuth tokens are not valid there. Reusing the local CLI is the supported way
// to reach the account without provisioning a key.

// `claude --model` takes either an alias, which always resolves to the current
// model of that tier, or a pinned id. Aliases come first because they never go
// stale; the pinned ids are for reproducibility. The CLI forwards any string it
// does not recognise straight to the API, so `/use claude-code <id>` also works
// with a model that is not listed here.
export const CLAUDE_CODE_MODELS = [
  { id: 'sonnet',      description: 'Claude Sonnet — latest, balanced (recommended)' },
  { id: 'opus',        description: 'Claude Opus — latest, most capable' },
  { id: 'haiku',       description: 'Claude Haiku — latest, fastest' },
  { id: 'opusplan',    description: 'Opus to plan, Sonnet to execute' },
  { id: 'default',     description: "The CLI's own recommended default" },
  { id: 'claude-opus-5-5',            description: 'Opus 5.5 (pinned) — needs Claude Code 2.1.280 or newer' },
  { id: 'claude-opus-5',              description: 'Opus 5 (pinned)' },
  { id: 'claude-sonnet-5',            description: 'Sonnet 5 (pinned)' },
  { id: 'claude-opus-4-7',            description: 'Opus 4.7 (pinned)' },
  { id: 'claude-opus-4-6',            description: 'Opus 4.6 (pinned)' },
  { id: 'claude-opus-4-5',            description: 'Opus 4.5 (pinned)' },
  { id: 'claude-sonnet-4-6',          description: 'Sonnet 4.6 (pinned)' },
  { id: 'claude-sonnet-4-5',          description: 'Sonnet 4.5 (pinned)' },
  { id: 'claude-haiku-4-5',           description: 'Haiku 4.5 (pinned)' },
  // Refused on a plain Pro/Max subscription — they bill against usage credits.
  { id: 'claude-fable-5', description: 'Fable 5', note: 'needs usage credits' },
  { id: 'sonnet[1m]',     description: 'Sonnet, 1M context', note: 'needs usage credits' },
];

export function resolveClaudeBinary(env = process.env) {
  return env.ETTORE_CLAUDE_BIN || 'claude';
}

// npm's Windows shim runs its target through one of these lines; the path is
// relative to the shim's own folder (`%dp0%` / `%~dp0`).
const SHIM_TARGET_RE = /"%~?dp0%?\\([^"]+?\.(?:exe|cjs|mjs|js))"/i;

/**
 * How to start the Claude Code CLI: `{ file, args }` to spawn directly, with
 * `args` going before the real arguments.
 *
 * On Linux and macOS that is just `claude`. On Windows it is not: npm installs
 * the CLI as `claude.cmd`, a batch shim around the real executable, and Node
 * will not spawn a .cmd without a shell (CVE-2024-27980). `execFile('claude')`
 * therefore failed with ENOENT on every Windows machine and the provider said
 * "Claude Code CLI not found" next to a working install. Going through a shell
 * instead is no answer either: cmd.exe mangles the quoting of the arguments
 * the bridge passes and caps the command line at 8191 characters. So the shim
 * is read and the program it would have run is started directly — the native
 * `claude.exe` that current releases ship, or `node cli.js` for older ones.
 */
export function resolveClaudeCommand({
  env = process.env,
  os = process.platform,
  exists = existsSync,
  readFile = file => readFileSync(file, 'utf8'),
  nodePath = process.execPath,
} = {}) {
  const explicit = env.ETTORE_CLAUDE_BIN;
  if (os !== 'win32') return { file: explicit || 'claude', args: [] };

  const found = explicit || findOnPath('claude', { env, platform: 'win32' });
  if (!found) {
    // The native installer puts it here without necessarily touching PATH
    // for an already running terminal.
    const home = env.USERPROFILE || homedir();
    const native = win32.join(home, '.local', 'bin', 'claude.exe');
    return exists(native) ? { file: native, args: [] } : { file: 'claude', args: [] };
  }
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args: [] };

  const dir = win32.dirname(found);
  const packaged = win32.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (exists(packaged)) return { file: packaged, args: [] };
  try {
    const target = SHIM_TARGET_RE.exec(readFile(found))?.[1];
    if (target) {
      const full = win32.join(dir, target);
      if (exists(full)) {
        return /\.exe$/i.test(full) ? { file: full, args: [] } : { file: nodePath, args: [full] };
      }
    }
  } catch { /* unreadable shim — fall through */ }
  // Last resort: through the shell. Short commands (`--version`, `auth
  // status`) survive it; say so rather than fail with a bare ENOENT.
  return { file: found, args: [], shell: true };
}

/**
 * An explicit credential in the environment wins over the stored login — it is
 * what the CLI itself picks up first, and `claude auth status` does not report
 * it. Falls back to the on-disk login so an unreachable CLI still gives a
 * meaningful answer.
 */
export function detectClaudeAuth(env = process.env, home = homedir(), os = platform()) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { ok: true, source: 'CLAUDE_CODE_OAUTH_TOKEN' };
  if (env.ANTHROPIC_API_KEY)       return { ok: true, source: 'ANTHROPIC_API_KEY' };
  if (existsSync(join(home, '.claude', '.credentials.json'))) return { ok: true, source: 'claude login' };
  // macOS keeps the OAuth tokens in the Keychain, so there is no file to stat.
  if (os === 'darwin') return { ok: true, source: 'keychain (unverified)' };
  return { ok: false, source: null };
}

function run(command, args, timeout = 20_000) {
  return new Promise(resolve => {
    execFile(command.file, [...command.args, ...args], {
      timeout,
      windowsHide: true,
      shell: Boolean(command.shell),
    }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, error: error.message, stderr: String(stderr || '') });
      else resolve({ ok: true, stdout: String(stdout || '').trim() });
    });
  });
}

/**
 * `claude auth status` prints JSON: which account is signed in and on what
 * plan. This is the authoritative check — the credentials file can exist while
 * the session behind it is gone.
 */
export function parseAuthStatus(stdout) {
  try {
    const data = JSON.parse(stdout);
    if (!data || typeof data !== 'object') return null;
    return {
      loggedIn: data.loggedIn === true,
      email: data.email || null,
      plan: data.subscriptionType || null,
      method: data.authMethod || null,
    };
  } catch {
    return null;
  }
}

export function describeAccount(account) {
  if (!account) return null;
  if (account.source && !account.email) {
    return `Anthropic account via ${account.source} — no API key stored`;
  }
  const plan = account.plan ? ` · ${account.plan} plan` : '';
  return `Anthropic account: ${account.email || 'signed in'}${plan} — via the Claude Code login, no API key stored`;
}

export class ClaudeCodeProvider {
  constructor() {
    this.name = 'claude-code';
    this.command = resolveClaudeCommand();
    this.bin = this.command.file;
    this.version = null;
    this.account = null;
  }

  async listModels() {
    return { success: true, models: CLAUDE_CODE_MODELS };
  }

  // Named validateKey for parity with the other providers even though there is
  // no key: the connection manager calls this before saving the connection.
  async validateKey() {
    const probe = await run(this.command, ['--version'], 15_000);
    if (!probe.ok) {
      return {
        valid: false,
        error: `Claude Code CLI not found (tried "${this.bin}"). Install it with `
          + '`npm i -g @anthropic-ai/claude-code`, or point ETTORE_CLAUDE_BIN at the binary.',
      };
    }
    this.version = probe.stdout;

    const env = detectClaudeAuth();
    if (env.ok && env.source !== 'claude login' && env.source !== 'keychain (unverified)') {
      this.account = { source: env.source };
      return { valid: true };
    }

    const status = await run(this.command, ['auth', 'status', '--json']);
    const account = status.ok ? parseAuthStatus(status.stdout) : null;
    if (account?.loggedIn) {
      this.account = account;
      return { valid: true };
    }

    // Nothing to fall back on: this is a login prompt, not a broken install.
    return {
      valid: false,
      needsLogin: true,
      error: 'Not signed in to your Anthropic account. Sign in with `claude auth login` '
        + '(or `claude setup-token` on a headless machine), then connect again.',
    };
  }

  /** Shown after a successful connect so it is clear which account is in use. */
  connectionNote() {
    return describeAccount(this.account);
  }

  /** The interactive sign-in to hand the terminal over to. */
  loginCommand() {
    return { bin: this.command.file, args: [...this.command.args, 'auth', 'login'] };
  }

  static getInfo() {
    return {
      name: 'Claude (subscription)',
      description: 'Claude through the local Claude Code login — no API key',
      models: CLAUDE_CODE_MODELS,
    };
  }
}
