// Guards on the automatic update path: when it is allowed to run at all, and
// what it refuses to install even when it is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as update from '../src/cli/update.js';

const updatable = { updatable: true, reason: null };
const status = (current, latest) => ({ current, latest, outdated: true });

function withConfigDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ettore-autoupdate-'));
  const saved = process.env.ETTORE_CONFIG_DIR;
  process.env.ETTORE_CONFIG_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (saved === undefined) delete process.env.ETTORE_CONFIG_DIR;
    else process.env.ETTORE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Opt-in ───────────────────────────────────────────────────────────────────

test('a routine upgrade installs itself, which is the point of the feature', () => {
  // An install that has to be told to update is one that stays behind. 1.3.0
  // made this opt-in and broke the chain; the guards below are what make the
  // default safe, not the asking.
  const plan = update.planAutoUpdate({
    status: status('1.2.4', '1.3.2'),
    isTTY: true,
    alreadyRan: false,
    install: updatable,
  });
  assert.deepEqual(plan, { run: true, from: '1.2.4', to: '1.3.2', reason: null });
});

test('turning it off is still honoured, and says what to run instead', () => {
  const plan = update.planAutoUpdate({
    status: status('1.2.4', '1.3.2'),
    enabled: false,
    isTTY: true,
    alreadyRan: false,
    install: updatable,
  });
  assert.equal(plan.run, false);
  assert.match(plan.reason, /ettore update/);
});

// ── Major-version guard ──────────────────────────────────────────────────────

test('a major version is never installed behind the user', () => {
  const plan = update.planAutoUpdate({
    status: status('1.2.4', '2.0.0'),
    enabled: true,
    isTTY: true,
    alreadyRan: false,
    install: updatable,
  });
  assert.equal(plan.run, false);
  assert.match(plan.reason, /major version/);
  // The versions are still reported so the caller can say what it skipped.
  assert.equal(plan.to, '2.0.0');
});

test('the guard covers the bogus jump that started this, on the default path', () => {
  // A cache holding another package's metadata proposed 1.2.4 → 2.88.2. With
  // auto-update on by default again, this guard is one of the two things
  // standing between that entry and an install, so it is tested without an
  // explicit opt-in.
  const plan = update.planAutoUpdate({
    status: status('1.2.4', '2.88.2'),
    isTTY: true,
    alreadyRan: false,
    install: updatable,
  });
  assert.equal(plan.run, false);
  assert.match(plan.reason, /major version/);
});

test('autoUpdateCrossesMajor answers only what it can', () => {
  assert.equal(update.autoUpdateCrossesMajor('1.2.4', '2.0.0'), true);
  assert.equal(update.autoUpdateCrossesMajor('1.2.4', '1.99.0'), false);
  assert.equal(update.autoUpdateCrossesMajor('2.0.0', '1.9.0'), false);
  assert.equal(update.autoUpdateCrossesMajor('1.2.4', '1.3.0-beta.1'), false);
  // A version it cannot read is not a major jump it can claim to have found.
  assert.equal(update.autoUpdateCrossesMajor('1.2.4', ''), false);
  assert.equal(update.autoUpdateCrossesMajor('', '2.0.0'), false);
});

test('majorOf reads a leading integer, or admits it cannot', () => {
  assert.equal(update.majorOf('1.2.4'), 1);
  assert.equal(update.majorOf('v2.0.0'), 2);
  assert.equal(update.majorOf('10.0.0-rc.1'), 10);
  assert.equal(update.majorOf(''), null);
  assert.equal(update.majorOf(null), null);
});

// ── The pre-existing gates still hold ────────────────────────────────────────

test('an opted-in run still refuses outside a terminal or in a checkout', () => {
  const base = { status: status('1.2.4', '1.3.0'), enabled: true, alreadyRan: false, install: updatable };
  assert.equal(update.planAutoUpdate({ ...base, isTTY: false }).run, false);
  assert.equal(update.planAutoUpdate({ ...base, isTTY: true, alreadyRan: true }).run, false);
  const checkout = { updatable: false, reason: 'is a git checkout' };
  assert.equal(update.planAutoUpdate({ ...base, isTTY: true, install: checkout }).run, false);
});

// ── Cache identity ───────────────────────────────────────────────────────────

test('a cache describing another package is discarded, not believed', () => {
  withConfigDir((dir) => {
    mkdirSync(dir, { recursive: true });
    // The exact entry found in the wild: npm's `request` metadata, which the
    // banner reported as ETTORE's own newer version.
    writeFileSync(join(dir, 'version-cache.json'), JSON.stringify({
      name: 'request',
      latest: '2.88.2',
      deprecated: 'request has been deprecated',
      deprecatedFor: '2.88.2',
      cachedAt: Date.now(),
    }));

    const result = update.checkForUpdateSync();
    assert.equal(result.latest, null, 'believed a cache written for another package');
    assert.equal(result.outdated, false);
    assert.equal(result.deprecated, null);
  });
});

test('a cache with no package name is treated as unusable', () => {
  withConfigDir((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'version-cache.json'), JSON.stringify({
      latest: '9.9.9', cachedAt: Date.now(),
    }));
    assert.equal(update.checkForUpdateSync().latest, null);
  });
});

test('a cache for this package is still used', () => {
  withConfigDir((dir) => {
    mkdirSync(dir, { recursive: true });
    const { name, version } = update.readLocalPackage();
    writeFileSync(join(dir, 'version-cache.json'), JSON.stringify({
      name, latest: '99.0.0', cachedAt: Date.now(),
    }));
    const result = update.checkForUpdateSync();
    assert.equal(result.latest, '99.0.0');
    assert.equal(result.current, version);
    assert.equal(result.outdated, true);
  });
});

test('what the checker writes is what it will accept back', () => {
  withConfigDir((dir) => {
    mkdirSync(dir, { recursive: true });
    const { name } = update.readLocalPackage();
    writeFileSync(join(dir, 'version-cache.json'), JSON.stringify({
      name, latest: '99.0.0', cachedAt: Date.now(),
    }));
    const written = JSON.parse(readFileSync(join(dir, 'version-cache.json'), 'utf8'));
    assert.equal(written.name, name);
    assert.equal(update.checkForUpdateSync().latest, '99.0.0');
  });
});

// ── Cache freshness is asymmetric ────────────────────────────────────────────

test('"nothing newer" expires quickly, because publishing makes it wrong', () => {
  // The case that hid a real release: a machine that checked shortly before
  // 1.3.0 was published kept reporting itself current for the whole window.
  withConfigDir((dir) => {
    mkdirSync(dir, { recursive: true });
    const { name, version } = update.readLocalPackage();
    writeFileSync(join(dir, 'version-cache.json'), JSON.stringify({
      name, latest: version, cachedAt: Date.now() - 50 * 60 * 1000,
    }));
    // Discarded, so the next check asks npm again.
    assert.equal(update.checkForUpdateSync().latest, null);
  });
});

test('a known newer version is trusted for the full window', () => {
  // This answer only becomes more true with age, so re-asking is wasted work.
  withConfigDir((dir) => {
    mkdirSync(dir, { recursive: true });
    const { name } = update.readLocalPackage();
    writeFileSync(join(dir, 'version-cache.json'), JSON.stringify({
      name, latest: '99.0.0', cachedAt: Date.now() - 50 * 60 * 1000,
    }));
    const result = update.checkForUpdateSync();
    assert.equal(result.latest, '99.0.0');
    assert.equal(result.fromCache, true);
  });
});

test('a "nothing newer" answer is still trusted while it is fresh', () => {
  withConfigDir((dir) => {
    mkdirSync(dir, { recursive: true });
    const { name, version } = update.readLocalPackage();
    writeFileSync(join(dir, 'version-cache.json'), JSON.stringify({
      name, latest: version, cachedAt: Date.now() - 60 * 1000,
    }));
    const result = update.checkForUpdateSync();
    assert.equal(result.latest, version);
    assert.equal(result.outdated, false);
  });
});

test('even a fresh positive answer goes stale eventually', () => {
  withConfigDir((dir) => {
    mkdirSync(dir, { recursive: true });
    const { name } = update.readLocalPackage();
    writeFileSync(join(dir, 'version-cache.json'), JSON.stringify({
      name, latest: '99.0.0', cachedAt: Date.now() - 7 * 60 * 60 * 1000,
    }));
    assert.equal(update.checkForUpdateSync().latest, null);
  });
});

// ── The banner has to name a command that works where it is printed ──────────

test('on a checkout the banner points at git pull, not at a command that refuses', () => {
  // `ettore update` exits 1 on a checkout — it would install a separate copy
  // over the link — so advising it there sends the reader nowhere.
  const status = { current: '1.3.0', latest: '1.3.1', outdated: true };
  const banner = update.formatBanner(status, {
    color: false,
    install: { updatable: false, reason: 'is a git checkout' },
  });
  assert.match(banner, /git pull/);
  assert.doesNotMatch(banner, /ettore update/);
});

test('on an npm install the banner still points at ettore update', () => {
  const status = { current: '1.3.0', latest: '1.3.1', outdated: true };
  const banner = update.formatBanner(status, { color: false, install: { updatable: true } });
  assert.match(banner, /ettore update/);
  assert.doesNotMatch(banner, /git pull/);
});

test('a deprecation notice is printed whatever the install is', () => {
  const status = { current: '1.3.0', latest: '1.3.0', outdated: false, deprecated: 'do not use' };
  const banner = update.formatBanner(status, { color: false, install: { updatable: false } });
  assert.match(banner, /deprecated: do not use/);
});

// ── A check that cannot answer must not read as "up to date" ────────────────

test('the cold-check budget is large enough on Windows to ever succeed', async () => {
  // `npm` there is `npm.cmd` through a shell, so the cost is process startup
  // rather than the network and routinely exceeds a budget that is generous on
  // Linux. A budget too small to succeed does not save time; it makes the
  // check useless, and a check that never answers looks exactly like being up
  // to date.
  const src = readFileSync(new URL('../src/cli/update.js', import.meta.url), 'utf8');
  assert.match(src, /COLD_CHECK_TIMEOUT_MS = IS_WINDOWS \? \d{4,} : \d+/);
});

test('bin/cli.js says so when the check came back with nothing', async () => {
  // Both the update branch and the banner branch need a version to talk about,
  // so a failed check used to fall through to silence: no update, no banner,
  // no reason.
  const src = readFileSync(new URL('../bin/cli.js', import.meta.url), 'utf8');
  assert.match(src, /autoUpdateWanted && !updateStatus\?\.latest/);
  assert.match(src, /update check did not complete/);
});

test('a git checkout is not told a check failed that never ran', async () => {
  // The cold check is skipped on a checkout on purpose — installing over a
  // linked development copy would replace the link. Announcing a failure there
  // is doubly wrong: nothing failed, and `ettore update` refuses on a checkout
  // in favour of `git pull`.
  const src = readFileSync(new URL('../bin/cli.js', import.meta.url), 'utf8');
  assert.match(src, /coldCheckRan = true;/);
  assert.match(src, /else if \(coldCheckRan && !updateStatus\?\.latest\)/);
  // And it must not be reachable from the plain "wanted" flag any more.
  assert.doesNotMatch(src, /else if \(autoUpdateWanted && !updateStatus\?\.latest\)/);
});

// ── A checkout has an update path too ───────────────────────────────────────

test('describeCheckout reports whether a fast-forward is possible, and why not', async () => {
  const { mkdtempSync: mk } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const dir = mk(join(tmpdir(), 'ettore-checkout-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'x');
    git('add', '-A'); git('commit', '-q', '-m', 'first');

    const state = update.describeCheckout({ root: dir });
    assert.equal(state.isCheckout, true);
    assert.equal(state.branch, 'main');
    // No remote: a checkout that cannot pull has to say so rather than fail
    // with a generic refusal.
    assert.equal(state.pullable, false);
    assert.match(state.reason, /tracks no remote/);

    // Untracked files must not count as a reason to hold back — a working
    // directory always has some.
    writeFileSync(join(dir, 'scratch.log'), 'noise');
    assert.equal(update.describeCheckout({ root: dir }).clean, true);

    // A tracked modification does.
    writeFileSync(join(dir, 'a.txt'), 'changed');
    assert.equal(update.describeCheckout({ root: dir }).clean, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('describeCheckout says plainly when it is not a checkout at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ettore-notgit-'));
  try {
    assert.deepEqual(update.describeCheckout({ root: dir }), { isCheckout: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the update command pulls on a checkout instead of only refusing', () => {
  // Refusing used to be the whole answer, which left a development machine
  // with no update path at all.
  const src = readFileSync(new URL('../bin/cli.js', import.meta.url), 'utf8');
  assert.match(src, /if \(checkout\.pullable\)/);
  assert.match(src, /git pull --ff-only/);
  assert.match(src, /Cannot pull either/);
});
