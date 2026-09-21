// ETTORE_CONFIG_DIR has to mean the same thing everywhere.
//
// The encrypted secret store honoured it; the Conf-backed settings store did
// not, because Conf resolves its own directory. A test or a sandboxed run that
// redirected the config dir still wrote into the user's real settings — which
// is how `jevEnabled` ended up there during development.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Each case runs in its own process: the store resolves its path once, at
// module load, so the env var cannot be changed in-process.
function runWithConfigDir(dir, script) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    env: { ...process.env, ETTORE_CONFIG_DIR: dir },
    encoding: 'utf-8',
  }).trim();
}

test('a redirected config dir is empty, and writes stay inside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ettore-cfg-'));
  try {
    const out = runWithConfigDir(dir, `
      import { saveConfig, getConfig } from './src/config/index.js';
      const before = getConfig('jevEnabled');
      saveConfig('jevEnabled', true);
      console.log(JSON.stringify({ before, after: getConfig('jevEnabled') }));
    `);
    const { before, after } = JSON.parse(out);
    assert.equal(before, undefined, 'a redirected dir must not see the real settings');
    assert.equal(after, true);

    const written = join(dir, 'config.json');
    assert.ok(existsSync(written), 'the write lands in the redirected dir');
    assert.match(readFileSync(written, 'utf-8'), /jevEnabled/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without the variable the store keeps the path it has always used', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import Conf from 'conf';
    console.log(new Conf({ projectName: 'ettore-cli' }).path);
  `], { cwd: repoRoot, encoding: 'utf-8' }).trim();
  // Conf picks a per-platform directory: ~/.config/ettore-cli-nodejs on Linux,
  // %APPDATA%\ettore-cli-nodejs\Config on Windows. What matters is that it is
  // still Conf's own, not a redirected one.
  assert.match(out, /ettore-cli-nodejs[/\\].*config\.json$/i);
});

test('the redirect is honoured even when set after the module was imported', async () => {
  // The real shape of the hazard: a test suite imports everything while
  // collecting, then each test redirects the config dir in a hook. Resolving
  // the path at import time made that redirect arrive too late, and the write
  // landed in the user's settings.
  const { saveConfig, getConfig } = await import('../src/config/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'ettore-cfg-late-'));
  const previous = process.env.ETTORE_CONFIG_DIR;
  process.env.ETTORE_CONFIG_DIR = dir;
  try {
    saveConfig('__isolationProbe', 'written-after-import');
    assert.equal(getConfig('__isolationProbe'), 'written-after-import');
    assert.match(readFileSync(join(dir, 'config.json'), 'utf-8'), /__isolationProbe/);
  } finally {
    if (previous === undefined) delete process.env.ETTORE_CONFIG_DIR;
    else process.env.ETTORE_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }

  // And the probe must not exist in whatever store is active now.
  const { getConfig: getAgain } = await import('../src/config/index.js');
  assert.equal(getAgain('__isolationProbe'), undefined, 'the write must not have leaked out of the temp dir');
});

test('the suite runs with no live provider credentials in the environment', () => {
  // The guard in tests/helpers/test-setup.mjs. If this fails, the suite is
  // talking to somebody's real account: Jev turns itself on from
  // TYPESAFE_API_KEY, so an exported key silently changed what the agent's
  // recovery gates decided and billed the owner for the test run.
  for (const name of ['TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MINIMAX_API_KEY']) {
    assert.equal(process.env[name], undefined, `${name} must not be visible to tests`);
  }
});

test('the suite reads its own config and sessions, never the real ones', async () => {
  const { homedir } = await import('node:os');
  const realConfig = join(homedir(), '.config', 'ettore-cli-nodejs');
  assert.ok(process.env.ETTORE_CONFIG_DIR, 'the run must have a scratch config dir');
  assert.notEqual(process.env.ETTORE_CONFIG_DIR, realConfig);
  // The switch that would turn Jev on lives in settings, and the key beside
  // it in the encrypted store. Reading the developer's own would put the live
  // API in the middle of every agent test.
  const { isJevEnabled } = await import('../src/jev/index.js');
  assert.equal(isJevEnabled(), false, 'no test may run with Jev live');
});
