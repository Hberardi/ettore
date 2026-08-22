import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

// Bridge to the locally installed Claude Code CLI. Unlike every other entry in
// the registry this provider holds no API key: the `claude` binary is already
// authenticated against the user's Anthropic account (subscription OAuth, or a
// token from `claude setup-token`), and we simply drive it in headless mode.
//
// Anthropic's Messages API only accepts `x-api-key` credentials — subscription
// OAuth tokens are not valid there. Reusing the local CLI is the supported way
// to reach the account without provisioning a key.

// `claude --model` takes an alias for the latest model of each tier, so the ids
// here stay valid across model releases without touching this list.
export const CLAUDE_CODE_MODELS = [
  { id: 'sonnet', description: 'Claude Sonnet (latest) — Claude subscription' },
  { id: 'opus',   description: 'Claude Opus (latest) — Claude subscription' },
  { id: 'haiku',  description: 'Claude Haiku (latest) — Claude subscription' },
];

export function resolveClaudeBinary(env = process.env) {
  return env.ETTORE_CLAUDE_BIN || 'claude';
}

/**
 * Best-effort check that `claude` has credentials to work with. The CLI has no
 * non-interactive "am I logged in?" command that avoids spending tokens, so we
 * probe the same sources it does, cheapest first.
 */
export function detectClaudeAuth(env = process.env, home = homedir(), os = platform()) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { ok: true, source: 'CLAUDE_CODE_OAUTH_TOKEN' };
  if (env.ANTHROPIC_API_KEY)       return { ok: true, source: 'ANTHROPIC_API_KEY' };
  if (existsSync(join(home, '.claude', '.credentials.json'))) return { ok: true, source: 'claude login' };
  // macOS keeps the OAuth tokens in the Keychain, so there is no file to stat.
  // Assume they exist — a missing login surfaces as a clear error on first turn.
  if (os === 'darwin') return { ok: true, source: 'keychain (unverified)' };
  return { ok: false, source: null };
}

function runVersion(bin) {
  return new Promise(resolve => {
    execFile(bin, ['--version'], { timeout: 15_000 }, (error, stdout) => {
      if (error) resolve({ ok: false, error: error.message });
      else resolve({ ok: true, version: String(stdout || '').trim() });
    });
  });
}

export class ClaudeCodeProvider {
  constructor() {
    this.name = 'claude-code';
    this.bin = resolveClaudeBinary();
    this.version = null;
    this.authSource = null;
  }

  async listModels() {
    return { success: true, models: CLAUDE_CODE_MODELS };
  }

  // Named validateKey for parity with the other providers even though there is
  // no key: the connection manager calls this before saving the connection.
  async validateKey() {
    const probe = await runVersion(this.bin);
    if (!probe.ok) {
      return {
        valid: false,
        error: `Claude Code CLI not found (tried "${this.bin}"). Install it with `
          + '`npm i -g @anthropic-ai/claude-code`, or point ETTORE_CLAUDE_BIN at the binary.',
      };
    }
    this.version = probe.version;

    const auth = detectClaudeAuth();
    if (!auth.ok) {
      return {
        valid: false,
        error: 'Claude Code is installed but not logged in. Run `claude` once and sign in '
          + 'with your Anthropic account (or run `claude setup-token`).',
      };
    }
    this.authSource = auth.source;
    return { valid: true };
  }

  static getInfo() {
    return {
      name: 'Claude (subscription)',
      description: 'Claude through the local Claude Code login — no API key',
      models: CLAUDE_CODE_MODELS,
    };
  }
}
