// Loaded before every test file (see the `test` script in package.json).
//
// Tests must never reach a real provider. A developer machine usually has
// live credentials exported, and code that prefers the environment over its
// own configuration will pick them up: TYPESAFE_API_KEY switches Jev on by
// itself, so an exported key made the whole suite consult the real API — it
// changed what the agent's recovery gates decided, spent the owner's credits
// on test prompts, sent those prompts to a third party, and printed the key
// into the output of any test that failed while reading it.
//
// Stripping them here makes every run hermetic regardless of the shell it
// started from. A test that wants a credential sets it itself, on the value
// it chose.
const CREDENTIAL_VARS = [
  'TYPESAFE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'MINIMAX_API_KEY',
  'OPENROUTER_API_KEY',
  'NVIDIA_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'FAL_KEY',
  'REPLICATE_API_TOKEN',
  'RUNWAY_API_KEY',
];

for (const name of CREDENTIAL_VARS) delete process.env[name];

// Credentials do not only arrive through the environment. A developer who ran
// `/jev active` has the key in the real encrypted store and the switch in the
// real settings, so a test that builds an Agent would consult the live API
// from there instead. Point both stores at a scratch directory for the whole
// run — unless the caller already chose one — so no test can read, or write,
// the settings, secrets and session history of whoever is running it.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

if (!process.env.ETTORE_CONFIG_DIR) {
  const scratch = mkdtempSync(join(tmpdir(), 'ettore-test-home-'));
  process.env.ETTORE_CONFIG_DIR = scratch;
  process.env.ETTORE_SESSIONS_DIR ||= join(scratch, 'sessions');
  process.on('exit', () => {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}
