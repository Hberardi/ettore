// Tests for src/cli/update.js — version check, cache, banner formatting.
// The npm-registry call is exercised with a fake `npm` binary on PATH
// so these tests run in CI without network access.
//
// The module is imported ONCE at the top; per-test isolation comes from
// ETTORE_CONFIG_DIR being read fresh on every call (getCacheDir()
// re-evaluates process.env), and from the cache file being written
// inside a per-test mkdtemp directory. CACHE_PATH and the in-memory
// cachedName/cachedVersion are deliberately module-scope because
// that's how the production code behaves — the production cache TTL
// and the readLocalPackage memo are observable behaviour the LLM
// relies on, and we test them as such.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const update = await import(`${REPO_ROOT}/src/cli/update.js`);

test('readLocalPackage returns the version from package.json', () => {
  const pkg = update.readLocalPackage();
  assert.equal(typeof pkg.name, 'string');
  assert.equal(typeof pkg.version, 'string');
  assert.match(pkg.version, /^\d+\.\d+\.\d+/);
});

test('compareVersions handles dotted integers and v-prefix', () => {
  assert.equal(update.compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(update.compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(update.compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(update.compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(update.compareVersions('1.2', '1.2.0'), 0);
  assert.equal(update.compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(update.isOutdated('1.0.0', '1.0.1'), true);
  assert.equal(update.isOutdated('1.0.1', '1.0.1'), false);
  assert.equal(update.isOutdated('1.0.1', '1.0.0'), false);
});

test('formatBanner returns null when not outdated', () => {
  const text = update.formatBanner({ current: '1.2.3', latest: '1.2.3', outdated: false }, { color: false });
  assert.equal(text, null);
  const text2 = update.formatBanner({ current: '1.2.3', latest: '1.2.3', outdated: false });
  assert.equal(text2, null);
});

test('formatBanner includes the version bump and the update hint', () => {
  // The advised command depends on where the CLI is installed, so the test
  // states it rather than inheriting whatever the repo happens to be.
  const text = update.formatBanner(
    { current: '1.2.3', latest: '1.2.4', outdated: true },
    { color: false, install: { updatable: true } },
  );
  assert.ok(text.includes('1.2.3'));
  assert.ok(text.includes('1.2.4'));
  assert.ok(text.includes('ettore update'));
});

// Helper: install a fake `npm` shim in a tmp bin dir. The shim is a
// Node script (portable, no shell quirks) that prints the given JSON
// version and exits 0. Returns the bin dir so the caller can prepend
// it to PATH.
function installFakeNpm(tmp, version = '9.9.9', { deprecated = null } = {}) {
  const binDir = join(tmp, 'bin');
  mkdirSync(binDir, { recursive: true });
  // On Windows the file extension matters: npm.cmd is matched by
  // execFile, plain `npm` is not. On POSIX systems a plain `npm`
  // file with a Node shebang works.
  const shimName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const shim = join(binDir, shimName);
  // `npm view <pkg> version --json` prints a JSON string literal, e.g.
  // `"1.0.0"`. `npm view <pkg>@<v> deprecated --json` prints the message
  // the same way — or NOTHING AT ALL when the version is not deprecated.
  // Both shapes matter here, so the shim branches on the field asked for.
  const logic = 'const args = process.argv.slice(2);\n'
    + "if (args.includes('deprecated')) {\n"
    + `  ${deprecated === null ? '' : `console.log(${JSON.stringify(JSON.stringify(deprecated))});`}\n`
    + '  process.exit(0);\n'
    + '}\n'
    + `console.log('"${version}"');\n`
    + 'process.exit(0);\n';
  // Windows cmd cannot express that branching without quoting pain, so the
  // .cmd is a one-liner handing its arguments to the same Node script.
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'npm-shim.js'), logic);
    writeFileSync(shim, '@echo off\r\nnode "%~dp0npm-shim.js" %*\r\n');
  } else {
    writeFileSync(shim, `#!/usr/bin/env node\n${logic}`);
  }
  // Use fs.chmodSync (a syscall) instead of shelling out to chmod —
  // the latter fails when the test runner runs in a stripped-down
  // PATH, and the empty catch hides the real error.
  if (process.platform !== 'win32') {
    chmodSync(shim, 0o755);
  }
  return binDir;
}

test('fetchLatestVersion returns null when npm is not on PATH', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ettore-version-'));
  const savedPath = process.env.PATH;
  const savedConfig = process.env.ETTORE_CONFIG_DIR;
  try {
    process.env.ETTORE_CONFIG_DIR = tmp;
    process.env.PATH = ''; // nothing on PATH — npm cannot be found
    const latest = await update.fetchLatestVersion({ timeoutMs: 1000 });
    assert.equal(latest, null);
  } finally {
    process.env.PATH = savedPath;
    process.env.ETTORE_CONFIG_DIR = savedConfig;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchLatestVersion parses npm view JSON output', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ettore-version-'));
  const binDir = installFakeNpm(tmp, '9.9.9');
  const savedPath = process.env.PATH;
  const savedConfig = process.env.ETTORE_CONFIG_DIR;
  try {
    process.env.ETTORE_CONFIG_DIR = join(tmp, 'config');
    process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${savedPath || ''}`;
    const latest = await update.fetchLatestVersion({ timeoutMs: 5000 });
    assert.equal(latest, '9.9.9');
  } finally {
    process.env.PATH = savedPath;
    process.env.ETTORE_CONFIG_DIR = savedConfig;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkForUpdateSync respects the cache and skips npm', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ettore-version-'));
  const savedConfig = process.env.ETTORE_CONFIG_DIR;
  try {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'version-cache.json'), JSON.stringify({
      // The cache names the package it describes; an entry without it, or
      // for another package, is discarded rather than believed.
      name: update.readLocalPackage().name,
      cachedAt: Date.now(),
      latest: '999.0.0',
    }));
    process.env.ETTORE_CONFIG_DIR = tmp;
    const status = update.checkForUpdateSync();
    assert.equal(status.fromCache, true);
    assert.equal(status.latest, '999.0.0');
    assert.equal(status.outdated, true);
  } finally {
    if (savedConfig === undefined) delete process.env.ETTORE_CONFIG_DIR;
    else process.env.ETTORE_CONFIG_DIR = savedConfig;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkForUpdateSync returns no cache when the file is absent', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ettore-version-'));
  const savedConfig = process.env.ETTORE_CONFIG_DIR;
  try {
    process.env.ETTORE_CONFIG_DIR = tmp;
    const status = update.checkForUpdateSync();
    assert.equal(status.fromCache, false);
    assert.equal(status.latest, null);
  } finally {
    if (savedConfig === undefined) delete process.env.ETTORE_CONFIG_DIR;
    else process.env.ETTORE_CONFIG_DIR = savedConfig;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkForUpdateSync treats a stale cache as a miss', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ettore-version-'));
  const savedConfig = process.env.ETTORE_CONFIG_DIR;
  try {
    process.env.ETTORE_CONFIG_DIR = tmp;
    writeFileSync(join(tmp, 'version-cache.json'), JSON.stringify({
      cachedAt: Date.now() - 7 * 60 * 60 * 1000, // 7 hours ago
      latest: '999.0.0',
    }));
    const status = update.checkForUpdateSync();
    assert.equal(status.fromCache, false);
    assert.equal(status.latest, null);
  } finally {
    if (savedConfig === undefined) delete process.env.ETTORE_CONFIG_DIR;
    else process.env.ETTORE_CONFIG_DIR = savedConfig;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkForUpdate ignores a cache older than 6h and re-fetches', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ettore-version-'));
  const binDir = installFakeNpm(tmp, '1.0.0');
  const savedPath = process.env.PATH;
  const savedConfig = process.env.ETTORE_CONFIG_DIR;
  try {
    const cacheDir = join(tmp, 'config');
    mkdirSync(cacheDir, { recursive: true });
    // Seed with a STALE entry whose `latest` would otherwise be
    // returned by the cache. The 6h TTL must force a fresh fetch.
    writeFileSync(join(cacheDir, 'version-cache.json'), JSON.stringify({
      cachedAt: Date.now() - 7 * 60 * 60 * 1000,
      latest: '999.0.0',
    }));
    process.env.ETTORE_CONFIG_DIR = cacheDir;
    process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${savedPath || ''}`;
    const status = await update.checkForUpdate();
    // The fake npm returns 1.0.0, which is older than the local
    // 1.2.0, so this run is NOT outdated — but it MUST have hit the
    // fake npm and ignored the stale cache.
    assert.equal(status.fromCache, false);
    assert.equal(status.latest, '1.0.0');
    assert.equal(status.outdated, false);
  } finally {
    process.env.PATH = savedPath;
    if (savedConfig === undefined) delete process.env.ETTORE_CONFIG_DIR;
    else process.env.ETTORE_CONFIG_DIR = savedConfig;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bin/cli.js registers version, update, and the version-check banner', () => {
  // Importing the CLI entry point must succeed and expose the new
  // commands. Commander stores them on `program.commands`; we just
  // assert their names are present.
  const cliPath = join(REPO_ROOT, 'bin', 'cli.js');
  const text = readFileSync(cliPath, 'utf8');
  assert.match(text, /command\('version'\)/);
  assert.match(text, /command\('update'\)/);
  assert.match(text, /--no-update-check/);
  assert.match(text, /formatBanner/);
  assert.match(text, /checkForUpdateSync/);
});

// Local import of node:fs.readFileSync to avoid a name shadow with
// the `readFileSync` already imported at the top of the file. We use
// it only for the contract test on bin/cli.js.
import { readFileSync } from 'node:fs';
void execFileSync; // silence unused-import lint if the suite is run isolated

test('compareVersions orders prereleases before their release', () => {
  // The old split-on-'.' compare turned Number('0-beta') into NaN → 0, so
  // a beta build looked identical to the stable release and never saw the
  // upgrade.
  assert.equal(update.compareVersions('1.3.0-beta', '1.3.0'), -1);
  assert.equal(update.compareVersions('1.3.0', '1.3.0-beta'), 1);
  assert.equal(update.compareVersions('1.3.0-beta.1', '1.3.0-beta.2'), -1);
  assert.equal(update.compareVersions('1.3.0-beta.1', '1.3.0-beta.1'), 0);
  // Build metadata never affects ordering.
  assert.equal(update.compareVersions('1.3.0+build.9', '1.3.0'), 0);
  assert.equal(update.isOutdated('1.3.0-beta.1', '1.3.0'), true);
  assert.equal(update.isOutdated('1.3.0', '1.3.0-beta.1'), false);
});

test('runUpdate refuses a target that is not a version or a tag', async () => {
  // On Windows these arguments are handed to cmd.exe via `shell: true`.
  await assert.rejects(
    () => update.runUpdate({ target: 'latest & calc.exe', stream: false }),
    /invalid target/,
  );
  await assert.rejects(() => update.runUpdate({ target: '$(whoami)', stream: false }), /invalid target/);
});

test('npm is spawned in a way that works on Windows', () => {
  // Contract test: `npm` on Windows is npm.cmd, and since the fix for
  // CVE-2024-27980 child_process refuses to spawn a .cmd without a shell.
  // Getting this wrong fails silently — no banner, ever — so pin it.
  const text = readFileSync(resolve(REPO_ROOT, 'src/cli/update.js'), 'utf8');
  assert.match(text, /npm\.cmd/);
  assert.match(text, /shell:\s*true/);
  assert.ok(
    !/execFileA?s?y?n?c?\(\s*'npm'/.test(text),
    'npm must be spawned through the platform-resolved binary, not the literal "npm"',
  );
});

test('describeInstall refuses to npm-install over a git checkout', () => {
  // This repo IS a checkout, which is precisely the case that must not be
  // "updated": `npm install -g` would drop a registry copy next to it and,
  // on a linked install, replace the link that makes `ettore` run the repo.
  const install = update.describeInstall();
  assert.equal(install.isCheckout, true);
  assert.equal(install.updatable, false);
  assert.match(install.reason, /git pull/);
});

test('runUpdate refuses a checkout unless forced', async () => {
  await assert.rejects(() => update.runUpdate({ target: 'latest', stream: false }), /git checkout/);
});

test('globalPackageDir points at the prefix npm installs into', () => {
  const dir = update.globalPackageDir();
  if (!dir) return; // no npm on PATH in this environment
  const expected = process.platform === 'win32' ? /node_modules[\\/]ettore-ai-assistant$/ : /lib[\\/]node_modules[\\/]ettore-ai-assistant$/;
  assert.match(dir, expected);
});

test('planAutoUpdate only runs when it is safe and useful', () => {
  const status = { current: '1.2.0', latest: '1.3.0', outdated: true };
  // `enabled` is no longer the default: installing is opt-in, so the fixture
  // that expects a run has to ask for one.
  const ok = { status, enabled: true, isTTY: true, alreadyRan: false, install: { updatable: true } };

  assert.equal(update.planAutoUpdate(ok).run, true);
  assert.equal(update.planAutoUpdate({ ...ok, enabled: false }).run, false);
  // A pipe or a CI job must never have software installed under it.
  assert.equal(update.planAutoUpdate({ ...ok, isTTY: false }).run, false);
  // The re-exec guard: without it a build that keeps reporting the old
  // version would relaunch itself forever.
  assert.equal(update.planAutoUpdate({ ...ok, alreadyRan: true }).run, false);
  assert.match(update.planAutoUpdate({ ...ok, alreadyRan: true }).reason, /already updated/);
  assert.equal(update.planAutoUpdate({ ...ok, status: { current: '1.2.0', latest: '1.2.0', outdated: false } }).run, false);
  // A checkout is reported with the same reason the update command prints.
  const onCheckout = update.planAutoUpdate({ ...ok, install: undefined });
  assert.equal(onCheckout.run, false);
  assert.match(onCheckout.reason, /git pull/);
});

test('bin/cli.js installs before loading anything and guards the re-exec', () => {
  const text = readFileSync(resolve(REPO_ROOT, 'bin/cli.js'), 'utf8');
  assert.match(text, /--no-auto-update/);
  assert.match(text, /planAutoUpdate\(/);
  assert.match(text, /ETTORE_AUTO_UPDATE_DONE:\s*'1'/, 'the relaunch must mark itself to avoid a restart loop');
  assert.match(text, /spawnSync\(process\.execPath/);
  // The relaunch is only worth doing when npm wrote the copy we execute.
  assert.match(text, /result\.isRunningCopy/);
});

test('checkForUpdate forwards a timeout to the registry call', async () => {
  // The startup path pays a bounded blocking call when the cache is cold;
  // the budget has to actually reach `npm view`, or a slow registry stalls
  // the launch it was meant to keep snappy.
  const text = readFileSync(resolve(REPO_ROOT, 'src/cli/update.js'), 'utf8');
  assert.match(text, /const options = timeoutMs \? \{ timeoutMs \} : undefined/);
  assert.match(text, /fetchLatestVersion\(options\)/);
  assert.match(text, /fetchDeprecation\(current, options\)/);
  assert.equal(typeof update.COLD_CHECK_TIMEOUT_MS, 'number');
  assert.ok(update.COLD_CHECK_TIMEOUT_MS <= 5000, 'startup must never block for long');
});

test('bin/cli.js refreshes a cold cache before deciding to auto-update', () => {
  const text = readFileSync(resolve(REPO_ROOT, 'bin/cli.js'), 'utf8');
  // Without this the first run after an install does nothing and the update
  // only happens on the second launch.
  assert.match(text, /!updateStatus\?\.latest && install\.updatable/);
  assert.match(text, /await checkForUpdate\(\{ timeoutMs: COLD_CHECK_TIMEOUT_MS \}\)/);
  // A checkout must not pay for a network call whose answer it would refuse.
  // `describeInstall()` is read once into `install` and both branches share it.
  assert.match(text, /const install = describeInstall\(\);/);
  assert.ok(
    text.indexOf('const install = describeInstall();') < text.indexOf('await checkForUpdate({ timeoutMs'),
    'the checkout guard must be evaluated before the blocking call',
  );
  // The checkout's own update — a fast-forward — is decided before the npm
  // check, and it is the branch that runs when the npm one cannot.
  assert.ok(
    text.indexOf('planCheckoutUpdate({') < text.indexOf('await checkForUpdate({ timeoutMs'),
    'the checkout is offered its update before the registry is consulted',
  );
});

// ---------------------------------------------------------------------------
// Deprecation notices.
//
// `npm deprecate` is the publisher's only way to reach an install that is
// already on disk, but npm only prints the message during an install. These
// cover reading it at startup instead, so a user who never reinstalls still
// hears about it.
// ---------------------------------------------------------------------------

test('fetchDeprecation returns null when the version is not deprecated', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ettore-version-'));
  const binDir = installFakeNpm(tmp, '9.9.9'); // no deprecation: npm prints nothing
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${savedPath || ''}`;
    assert.equal(await update.fetchDeprecation('1.0.0', { timeoutMs: 5000 }), null);
  } finally {
    process.env.PATH = savedPath;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchDeprecation returns the message npm has on file', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ettore-version-'));
  const message = 'Old release: run npm i -g ettore-ai-assistant@latest';
  const binDir = installFakeNpm(tmp, '9.9.9', { deprecated: message });
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${savedPath || ''}`;
    assert.equal(await update.fetchDeprecation('1.0.0', { timeoutMs: 5000 }), message);
  } finally {
    process.env.PATH = savedPath;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchDeprecation ignores an empty message from an un-deprecated version', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ettore-version-'));
  // `npm deprecate <pkg>@<range> ""` leaves the field present but empty.
  const binDir = installFakeNpm(tmp, '9.9.9', { deprecated: '' });
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${savedPath || ''}`;
    assert.equal(await update.fetchDeprecation('1.0.0', { timeoutMs: 5000 }), null);
  } finally {
    process.env.PATH = savedPath;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('formatBanner warns about a deprecated version above the upgrade line', () => {
  const text = update.formatBanner({
    current: '1.0.0',
    latest: '1.2.3',
    outdated: true,
    deprecated: 'Old release: upgrade',
  }, { color: false, install: { updatable: true } });
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('deprecated'), 'the deprecation comes first');
  assert.ok(lines[0].includes('Old release: upgrade'));
  assert.ok(lines[0].includes('1.0.0'));
  assert.ok(lines[1].includes('ettore update'));
});

test('formatBanner still warns when a deprecated version is the newest one', () => {
  // Nothing newer to install: pointing at `ettore update` would be a lie.
  const text = update.formatBanner({
    current: '1.2.3',
    latest: '1.2.3',
    outdated: false,
    deprecated: 'Unsupported build',
  }, { color: false });
  assert.ok(text.includes('Unsupported build'));
  assert.ok(!text.includes('ettore update'));
});

test('checkForUpdateSync surfaces a cached deprecation for the running version', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ettore-version-'));
  const savedConfig = process.env.ETTORE_CONFIG_DIR;
  try {
    process.env.ETTORE_CONFIG_DIR = tmp;
    writeFileSync(join(tmp, 'version-cache.json'), JSON.stringify({
      name: update.readLocalPackage().name,
      cachedAt: Date.now(),
      latest: '999.0.0',
      deprecated: 'Old release: upgrade',
      deprecatedFor: update.readLocalPackage().version,
    }));
    const status = update.checkForUpdateSync();
    assert.equal(status.deprecated, 'Old release: upgrade');
  } finally {
    if (savedConfig === undefined) delete process.env.ETTORE_CONFIG_DIR;
    else process.env.ETTORE_CONFIG_DIR = savedConfig;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a deprecation cached for another version is not repeated after an update', () => {
  // The cache file survives the upgrade that fixes the problem; without the
  // version guard the new build would keep shouting the old build's warning.
  const tmp = mkdtempSync(join(tmpdir(), 'ettore-version-'));
  const savedConfig = process.env.ETTORE_CONFIG_DIR;
  try {
    process.env.ETTORE_CONFIG_DIR = tmp;
    writeFileSync(join(tmp, 'version-cache.json'), JSON.stringify({
      cachedAt: Date.now(),
      latest: '999.0.0',
      deprecated: 'Old release: upgrade',
      deprecatedFor: '0.0.1-something-else',
    }));
    assert.equal(update.checkForUpdateSync().deprecated, null);
  } finally {
    if (savedConfig === undefined) delete process.env.ETTORE_CONFIG_DIR;
    else process.env.ETTORE_CONFIG_DIR = savedConfig;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bin/cli.js shows the banner for a deprecated version, not only an outdated one', () => {
  const text = readFileSync(resolve(REPO_ROOT, 'bin/cli.js'), 'utf8');
  assert.match(text, /updateStatus\?\.outdated \|\| updateStatus\?\.deprecated/);
});
