// Version check + self-update helpers.
//
// ETTORE has a global install layout (`npm install -g ettore-ai-assistant`).
// At startup the CLI should notice when a newer version is on npm and
// suggest `ettore update`. The check is intentionally cheap and offline-
// friendly:
//
//   - one `npm view <pkg> version` call (small, ~1 KB response)
//   - cached to ~/.config/ettore/version-cache.json for 6 hours
//   - skipped entirely on first-run or when offline (fails silent)
//
// `runUpdate()` shells out to `npm install -g` and surfaces the same
// output the user would have seen if they had run npm themselves.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

// On Windows the npm entry point is `npm.cmd`, and since the Node fix for
// CVE-2024-27980 child_process refuses to spawn a .cmd without a shell.
// Without this the check dies with EINVAL, the fail-silent path swallows
// it (no banner, ever) and `ettore update` rejects — on the one platform
// where the user has no other upgrade path in the CLI.
const IS_WINDOWS = process.platform === 'win32';
const NPM_BIN = IS_WINDOWS ? 'npm.cmd' : 'npm';
// `shell: true` is what makes the .cmd runnable, but it also routes the
// arguments through cmd.exe, so anything user-supplied must be validated
// before it gets there (see SAFE_TARGET_RE in runUpdate).
const SHELL_OPTS = IS_WINDOWS ? { shell: true } : {};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// The package.json is two levels up: src/cli/update.js → src/cli → src → root.
const ROOT = resolve(__dirname, '..', '..');
const PACKAGE_JSON = join(ROOT, 'package.json');

let cachedName = null;
let cachedVersion = null;

export function readLocalPackage() {
  if (cachedName && cachedVersion) return { name: cachedName, version: cachedVersion };
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    cachedName = pkg.name;
    cachedVersion = pkg.version;
    return pkg;
  } catch {
    return { name: 'ettore-ai-assistant', version: '0.0.0' };
  }
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// "There is nothing newer" is the one answer that goes stale the instant it
// stops being true — a release published a minute after the check is invisible
// for the rest of the window. "1.3.0 exists" only becomes more true with age.
// The two answers decay differently, so they expire differently: this is why a
// machine that checked shortly before a publish kept reporting itself current.
const NEGATIVE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** How long this particular cached answer is worth trusting. */
function cacheTtlFor(cached, current) {
  const latest = cached?.latest;
  if (!latest) return NEGATIVE_CACHE_TTL_MS;
  return isOutdated(current, latest) ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
}

function cacheIsFresh(cached, current, now = Date.now()) {
  if (!cached) return false;
  return now - Number(cached.cachedAt || 0) < cacheTtlFor(cached, current);
}

// How long startup may block on the registry when the cache has nothing
// usable. Short enough that a slow or unreachable registry costs a beat
// rather than a stall, and paid at most once every CACHE_TTL_MS.
// Windows gets longer. `npm` there is `npm.cmd` run through a shell, so the
// cost is process startup rather than the network, and it routinely exceeds a
// budget that is generous on Linux — where the same call takes about half a
// second. A budget too small to ever succeed does not save time, it just makes
// the check useless.
export const COLD_CHECK_TIMEOUT_MS = IS_WINDOWS ? 8000 : 2500;

// The cache directory is read fresh on every call so tests that set
// ETTORE_CONFIG_DIR after the module is first loaded (e.g. a suite
// that flips the env between cases) are still isolated. Caching it
// at module scope used to leak state across tests.
function getCacheDir() {
  return process.env.ETTORE_CONFIG_DIR || join(homedir(), '.config', 'ettore');
}
function getCachePath() {
  return join(getCacheDir(), 'version-cache.json');
}

function readCache() {
  try {
    const p = getCachePath();
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof raw !== 'object' || !raw) return null;
    // An entry that does not name the package it describes, or names a
    // different one, is not evidence about this package. This is not
    // hypothetical: a cache in the wild held npm's `request` metadata —
    // `latest: "2.88.2"` and that package's deprecation notice — which the
    // banner then reported as ETTORE's own. Discarding costs one registry
    // call, once, and the entry heals itself.
    if (raw.name !== readLocalPackage().name) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(entry) {
  try {
    mkdirSync(getCacheDir(), { recursive: true });
    const stamped = { name: readLocalPackage().name, ...entry, cachedAt: Date.now() };
    writeFileSync(getCachePath(), JSON.stringify(stamped, null, 2));
  } catch {
    // Best-effort: a write failure should not block the user's session.
  }
}

// Split "v1.2.3-beta.1+build" into its numeric core and its prerelease
// tag. Build metadata is dropped: semver says it never affects ordering.
function splitVersion(value) {
  const clean = String(value || '').trim().replace(/^v/, '').split('+')[0];
  const dash = clean.indexOf('-');
  const core = dash === -1 ? clean : clean.slice(0, dash);
  const pre = dash === -1 ? '' : clean.slice(dash + 1);
  return { core: core.split('.').map(part => Number(part) || 0), pre };
}

export function compareVersions(a, b) {
  // Dotted-integer compare plus the one Semver 2.0 rule that matters for
  // a local-vs-npm check: a prerelease sorts BEFORE its release, so
  // 1.3.0-beta < 1.3.0. Splitting on '.' alone turned `Number('0-beta')`
  // into NaN → 0, which made a beta install look identical to the stable
  // release and hid the upgrade forever. Prerelease tags themselves are
  // compared as plain strings — enough to order beta.1 before beta.2.
  const va = splitVersion(a);
  const vb = splitVersion(b);
  const len = Math.max(va.core.length, vb.core.length);
  for (let i = 0; i < len; i++) {
    const x = va.core[i] ?? 0;
    const y = vb.core[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  if (va.pre && !vb.pre) return -1;
  if (!va.pre && vb.pre) return 1;
  if (va.pre !== vb.pre) return va.pre < vb.pre ? -1 : 1;
  return 0;
}

export function isOutdated(current, latest) {
  return compareVersions(current, latest) < 0;
}

// Fetch the latest version published on npm. Uses `npm view` because it
// is the lowest-common-denominator that respects the user's npm
// configuration (registry, auth, offline cache). Fails silent on any
// error: this is a courtesy check, not a hard requirement.
export async function fetchLatestVersion({ timeoutMs = 8000 } = {}) {
  const { name } = readLocalPackage();
  try {
    const { stdout } = await execFileAsync(NPM_BIN, ['view', name, 'version', '--json'], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      ...SHELL_OPTS,
    });
    const trimmed = String(stdout || '').trim();
    // `npm view ... --json` returns `"1.2.3"` (a JSON string).
    const parsed = JSON.parse(trimmed);
    return String(parsed).replace(/^v/, '');
  } catch {
    return null;
  }
}

// Has the version we are RUNNING been deprecated on npm? `npm deprecate` is
// the only channel a publisher has towards an install that is already on
// disk, but npm itself only surfaces the message during an install — a user
// who never reinstalls never sees it. Reading it here is what turns it into
// something the running CLI can say out loud.
//
// Note the version-pinned spec: `npm view <pkg> deprecated` would answer for
// the LATEST version, which is never the one we need.
export async function fetchDeprecation(version, { timeoutMs = 8000 } = {}) {
  const { name } = readLocalPackage();
  if (!version) return null;
  try {
    const { stdout } = await execFileAsync(NPM_BIN, ['view', `${name}@${version}`, 'deprecated', '--json'], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      ...SHELL_OPTS,
    });
    const trimmed = String(stdout || '').trim();
    // Not deprecated: npm exits 0 and prints nothing at all.
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    // A version that was deprecated and then un-deprecated reports ''.
    return typeof parsed === 'string' && parsed.trim() ? parsed : null;
  } catch {
    return null;
  }
}

// The cached notice belongs to the version that was running when it was
// written. After an update the same cache file is still on disk, so without
// this guard the new version would keep repeating the old one's warning.
function cachedDeprecation(cached, current) {
  if (!cached?.deprecated) return null;
  return cached.deprecatedFor === current ? cached.deprecated : null;
}

export async function checkForUpdate({ force = false, timeoutMs } = {}) {
  const { version: current } = readLocalPackage();
  if (!force) {
    const cached = readCache();
    if (cacheIsFresh(cached, current)) {
      return {
        current,
        latest: cached.latest || current,
        outdated: isOutdated(current, cached.latest),
        deprecated: cachedDeprecation(cached, current),
        fromCache: true,
        error: null,
      };
    }
  }
  const options = timeoutMs ? { timeoutMs } : undefined;
  // Two calls, but issued together and at most once per CACHE_TTL_MS, so the
  // cold path still costs one round trip rather than two.
  const [latest, deprecated] = await Promise.all([
    fetchLatestVersion(options),
    fetchDeprecation(current, options),
  ]);
  if (!latest) {
    return { current, latest: null, outdated: false, deprecated, fromCache: false, error: 'npm view failed' };
  }
  writeCache({ latest, deprecated, deprecatedFor: current });
  return {
    current,
    latest,
    outdated: isOutdated(current, latest),
    deprecated,
    fromCache: false,
    error: null,
  };
}

// Synchronous variant used by the CLI banner. Uses cached data only
// and never blocks the user's first prompt. A stale cache entry is
// treated the same as a missing one — we do not want the banner to
// propose an update based on a number that was fetched 7 hours ago.
// The async check runs in the background and replaces the banner with
// fresh data as soon as npm responds.
export function checkForUpdateSync() {
  const { version: current } = readLocalPackage();
  const cached = readCache();
  if (!cached || !cached.latest) {
    return { current, latest: null, outdated: false, deprecated: null, fromCache: false, error: null };
  }
  if (!cacheIsFresh(cached, current)) {
    return { current, latest: null, outdated: false, deprecated: null, fromCache: false, error: null };
  }
  return {
    current,
    latest: cached.latest,
    outdated: isOutdated(current, cached.latest),
    deprecated: cachedDeprecation(cached, current),
    fromCache: true,
    error: null,
  };
}

// Build the short banner the CLI shows under the version line. ANSI colors
// make the notice visible at a glance; the function returns plain text when
// stdout is not a TTY.
//
// A deprecated version gets its own line, in red and above the upgrade line:
// "there is something newer" and "the thing you are running is no longer
// supported" are different messages, and the second one is the one that
// should make a user stop and read.
export function formatBanner(status, { color = true, install = null } = {}) {
  if (!status?.outdated && !status?.deprecated) return null;
  // `ettore update` refuses on a git checkout — it would install a separate
  // copy over the link — so telling a checkout to run it sends the reader to a
  // command that exits 1 and explains why. Name the command that works here.
  const where = install || describeInstall();
  const upgradeCmd = where.updatable ? 'ettore update' : 'git pull';
  const useColor = color && process.stdout?.isTTY;
  const YELLOW = useColor ? '\x1b[33m' : '';
  const RED = useColor ? '\x1b[31m' : '';
  const BOLD = useColor ? '\x1b[1m' : '';
  const RESET = useColor ? '\x1b[0m' : '';

  const lines = [];
  if (status.deprecated) {
    lines.push(`${RED}⚠ ETTORE ${status.current} is deprecated: ${status.deprecated}${RESET}`);
  }
  if (status.outdated) {
    lines.push(`${YELLOW}↻ A new version of ETTORE is available: ${status.current} → ${status.latest}. Run \`${BOLD}${upgradeCmd}${RESET}${YELLOW}\` to upgrade.${RESET}`);
  } else if (status.deprecated) {
    // Deprecated but already on the newest release: `ettore update` would be
    // a no-op, so point at the message instead of a command that does nothing.
    lines.push(`${YELLOW}↻ No newer version is published yet.${RESET}`);
  }
  return lines.join('\n');
}

// Run `npm install -g <pkg>@<version>` (or `@latest`). The output is
// streamed to the parent's stdout so the user sees npm's progress
// bars; we only return metadata about the outcome.
// ---------------------------------------------------------------------------
// Where are we actually installed?
//
// `npm install -g` writes into npm's global prefix. That is not necessarily
// the copy the user executes: a machine can carry two prefixes, a prefix
// whose bin/ is not on PATH, or a `npm link`ed checkout. In all three cases
// the old command kept running while the update reported success, which is
// exactly the "update does nothing" report that started this.
// ---------------------------------------------------------------------------

let cachedPrefix;

export function npmGlobalPrefix() {
  if (cachedPrefix !== undefined) return cachedPrefix;
  try {
    const out = execFileSync(NPM_BIN, ['prefix', '-g'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...SHELL_OPTS,
    });
    cachedPrefix = String(out || '').trim() || null;
  } catch {
    cachedPrefix = null;
  }
  return cachedPrefix;
}

// <prefix>/lib/node_modules/<name> on POSIX, <prefix>/node_modules/<name>
// on Windows.
export function globalPackageDir(name = readLocalPackage().name) {
  const prefix = npmGlobalPrefix();
  if (!prefix) return null;
  return IS_WINDOWS ? join(prefix, 'node_modules', name) : join(prefix, 'lib', 'node_modules', name);
}

// The version npm has on disk after an install — NOT the one this process
// booted with. Re-reading our own package.json is what let `ettore update`
// print "✓ updated" while nothing the user runs had changed.
export function installedVersion() {
  const dir = globalPackageDir();
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

// Is the copy we are executing the one npm would overwrite?
export function runningIsGlobalInstall() {
  const dir = globalPackageDir();
  if (!dir) return false;
  try {
    return realpathSync(dir) === realpathSync(ROOT);
  } catch {
    return false;
  }
}

// A published install is a plain directory under the global node_modules. A
// development copy has a .git alongside it and is usually symlinked there by
// `npm link`, so `npm install -g <pkg>@latest` would replace the link with a
// registry copy and silently disconnect the command from the repo. Refuse
// that instead of performing it.
export function describeInstall({ root = ROOT } = {}) {
  const { name, version } = readLocalPackage();
  const isCheckout = existsSync(join(root, '.git'));
  return {
    name,
    version,
    root,
    isCheckout,
    updatable: !isCheckout,
    reason: isCheckout
      ? `${root} is a git checkout, so \`npm install -g ${name}@latest\` would install a separate copy and, if this one is linked, replace the link. Update it with \`git pull\` instead.`
      : null,
  };
}

// A dist-tag ("latest", "next") or a version ("1.2.0", "1.3.0-beta.1").
// Anything else is refused: on Windows these arguments reach cmd.exe.
const SAFE_TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether a git checkout can update itself, and how.
 *
 * A checkout is refused an npm install for good reason — it would replace the
 * link with a registry copy — but that left it with no automatic path at all,
 * so a development machine silently never moved while everything reported
 * itself fine. `git pull --ff-only` is the update for a checkout, and it is
 * safe exactly when the tree is clean and the branch tracks something.
 */
export function describeCheckout({ root = ROOT } = {}) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return null; }
  };
  if (!existsSync(join(root, '.git'))) return { isCheckout: false };
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstream = run(['rev-parse', '--abbrev-ref', '@{upstream}']);
  // Untracked files do not block a fast-forward, and a working directory
  // always has some — scratch files, local notes. Only tracked modifications
  // count as a reason to hold back.
  const dirty = run(['status', '--porcelain', '--untracked-files=no']);
  const reasons = [];
  if (!upstream) reasons.push(`branch "${branch || '?'}" tracks no remote, so there is nothing to pull from`);
  if (dirty) reasons.push('the working tree has uncommitted changes');
  return {
    isCheckout: true,
    branch,
    upstream,
    clean: !dirty,
    pullable: Boolean(upstream) && !dirty,
    reason: reasons.join('; ') || null,
  };
}

/** `git pull --ff-only` on a checkout that can take one. */
export function pullCheckout({ root = ROOT } = {}) {
  return new Promise((resolvePull) => {
    execFile('git', ['pull', '--ff-only'], { cwd: root }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (error) { resolvePull({ ok: false, output: output || error.message }); return; }
      resolvePull({ ok: true, output, changed: !/Already up to date/i.test(output) });
    });
  });
}

export function runUpdate({ target = 'latest', stream = true, force = false } = {}) {
  const { name, version: before } = readLocalPackage();
  return new Promise((resolveUpdate, reject) => {
    const wanted = String(target || 'latest').trim();
    if (!SAFE_TARGET_RE.test(wanted)) {
      reject(new Error(`invalid target "${wanted}" — expected a version like 1.2.0 or a tag like latest`));
      return;
    }
    const install = describeInstall();
    if (!install.updatable && !force) {
      reject(new Error(install.reason));
      return;
    }
    const args = ['install', '-g', `${name}@${wanted}`];
    const child = execFile(NPM_BIN, args, { windowsHide: true, ...SHELL_OPTS });
    if (stream) {
      child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
      child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        // Re-read the package.json so the user sees the new version on
        // the next start. The npm install -g replaced the same files
        // we read from, so a re-read gives us the freshly installed
        // version.
        cachedName = null;
        cachedVersion = null;
        cachedPrefix = undefined;
        // Drop the cache so the next check pulls a fresh comparison.
        try {
          const p = getCachePath();
          if (existsSync(p)) unlinkSync(p);
        } catch {}
        // Report what npm actually left on disk, and whether that is the
        // copy this machine executes. Both can disagree with `before`, and
        // saying "updated" regardless is how the command came to look like
        // it did nothing.
        resolveUpdate({
          ok: true,
          code,
          package: name,
          target: wanted,
          before,
          installed: installedVersion(),
          installedAt: globalPackageDir(),
          isRunningCopy: runningIsGlobalInstall(),
        });
      } else {
        reject(new Error(`npm install exited with code ${code}`));
      }
    });
  });
}

// Decide whether the CLI should install a new release before the agent
// starts. Every condition that makes this unsafe or pointless is a "skip",
// never a failure: the user asked to run ETTORE, not to install software.
/** Leading integer of a version, or null when it does not have one. */
export function majorOf(value) {
  const { core } = splitVersion(value);
  return Number.isFinite(core[0]) && String(value || '').trim() ? core[0] : null;
}

/**
 * Whether the gap between two versions is one to cross unattended.
 *
 * A major bump is a declared breaking change, so installing one because the
 * user happened to launch the CLI is the wrong default however trustworthy
 * the number looks — and the number is not always trustworthy: a cache
 * holding another package's metadata proposed a jump from 1.2.4 to 2.88.2,
 * which this refuses on the same rule that refuses a genuine 2.0.0.
 */
export function autoUpdateCrossesMajor(current, latest) {
  const from = majorOf(current);
  const to = majorOf(latest);
  if (from === null || to === null) return false;
  return to > from;
}

export function planAutoUpdate({
  status = null,
  enabled = true,
  isTTY = Boolean(process.stdout?.isTTY),
  alreadyRan = Boolean(process.env.ETTORE_AUTO_UPDATE_DONE),
  install = null,
} = {}) {
  if (!enabled) return { run: false, reason: 'auto-update is disabled — run `ettore update` to upgrade' };
  // The caller re-executes into the new build; without this guard a build
  // that keeps reporting the old version would relaunch itself forever.
  if (alreadyRan) return { run: false, reason: 'already updated during this launch' };
  // Never install software in a pipe, a CI job or a one-shot script run.
  if (!isTTY) return { run: false, reason: 'not an interactive terminal' };
  if (!status?.outdated || !status.latest) return { run: false, reason: 'no newer version is known yet' };
  const info = install || describeInstall();
  if (!info.updatable) return { run: false, reason: info.reason };
  if (autoUpdateCrossesMajor(status.current, status.latest)) {
    return {
      run: false,
      from: status.current,
      to: status.latest,
      reason: `${status.latest} is a new major version — run \`ettore update\` to take it deliberately`,
    };
  }
  return { run: true, from: status.current, to: status.latest, reason: null };
}

// Convenience: kick off the async check and return a promise. Used by
// the startup banner so the CLI can update its first impression once
// the real latest version is known.
export function startBackgroundCheck() {
  return checkForUpdate().catch(() => null);
}
