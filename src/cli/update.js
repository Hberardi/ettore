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

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
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
    return raw;
  } catch {
    return null;
  }
}

function writeCache(entry) {
  try {
    mkdirSync(getCacheDir(), { recursive: true });
    writeFileSync(getCachePath(), JSON.stringify({ ...entry, cachedAt: Date.now() }, null, 2));
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

export async function checkForUpdate({ force = false } = {}) {
  const { version: current } = readLocalPackage();
  if (!force) {
    const cached = readCache();
    if (cached && Date.now() - Number(cached.cachedAt || 0) < CACHE_TTL_MS) {
      return {
        current,
        latest: cached.latest || current,
        outdated: isOutdated(current, cached.latest),
        fromCache: true,
        error: null,
      };
    }
  }
  const latest = await fetchLatestVersion();
  if (!latest) {
    return { current, latest: null, outdated: false, fromCache: false, error: 'npm view failed' };
  }
  writeCache({ latest });
  return { current, latest, outdated: isOutdated(current, latest), fromCache: false, error: null };
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
    return { current, latest: null, outdated: false, fromCache: false, error: null };
  }
  if (Date.now() - Number(cached.cachedAt || 0) >= CACHE_TTL_MS) {
    return { current, latest: null, outdated: false, fromCache: false, error: null };
  }
  return {
    current,
    latest: cached.latest,
    outdated: isOutdated(current, cached.latest),
    fromCache: true,
    error: null,
  };
}

// Build a short, single-line banner that the CLI can show under the
// version line. ANSI colors are used so the outdated notification is
// visible at a glance; the function returns plain text when stdout is
// not a TTY.
export function formatBanner(status, { color = true } = {}) {
  if (!status?.outdated) return null;
  const useColor = color && process.stdout?.isTTY;
  const YELLOW = useColor ? '\x1b[33m' : '';
  const BOLD = useColor ? '\x1b[1m' : '';
  const RESET = useColor ? '\x1b[0m' : '';
  return `${YELLOW}↻ A new version of ETTORE is available: ${status.current} → ${status.latest}. Run \`${BOLD}ettore update${RESET}${YELLOW}\` to upgrade.${RESET}`;
}

// Run `npm install -g <pkg>@<version>` (or `@latest`). The output is
// streamed to the parent's stdout so the user sees npm's progress
// bars; we only return metadata about the outcome.
// A dist-tag ("latest", "next") or a version ("1.2.0", "1.3.0-beta.1").
// Anything else is refused: on Windows these arguments reach cmd.exe.
const SAFE_TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function runUpdate({ target = 'latest', stream = true } = {}) {
  const { name } = readLocalPackage();
  return new Promise((resolveUpdate, reject) => {
    const wanted = String(target || 'latest').trim();
    if (!SAFE_TARGET_RE.test(wanted)) {
      reject(new Error(`invalid target "${wanted}" — expected a version like 1.2.0 or a tag like latest`));
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
        // Drop the cache so the next check pulls a fresh comparison.
        try {
          const p = getCachePath();
          if (existsSync(p)) unlinkSync(p);
        } catch {}
        resolveUpdate({ ok: true, code, package: name, target });
      } else {
        reject(new Error(`npm install exited with code ${code}`));
      }
    });
  });
}

// Convenience: kick off the async check and return a promise. Used by
// the startup banner so the CLI can update its first impression once
// the real latest version is known.
export function startBackgroundCheck() {
  return checkForUpdate().catch(() => null);
}
