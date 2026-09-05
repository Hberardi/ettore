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
