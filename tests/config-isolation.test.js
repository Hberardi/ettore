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
  assert.match(out, /ettore-cli-nodejs[/\\]config\.json$/);
});
