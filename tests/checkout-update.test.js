// The startup update path for a git checkout, and the guarantee that adding
// it left the npm path — the one Windows takes — exactly as it was.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planCheckoutUpdate,
  planAutoUpdate,
  describeCheckout,
  pullCheckout,
} from '../src/cli/update.js';

const npmInstall = { name: 'ettore-ai-assistant', version: '1.3.6', root: '/usr/lib/node_modules/ettore', isCheckout: false, updatable: true, reason: null };
const checkoutInstall = { name: 'ettore-ai-assistant', version: '1.3.6', root: '/home/u/ettore', isCheckout: true, updatable: false, reason: 'is a git checkout' };
const ready = { isCheckout: true, branch: 'main', upstream: 'origin/main', clean: true, pullable: true, reason: null };
const base = { isTTY: true, alreadyRan: false };

// ── The npm path must not notice any of this ─────────────────────────────────

test('an npm install is never touched by the checkout path', () => {
  // The whole safety argument in one line: `updatable` is true exactly when
  // this branch must not fire, so the two can never both run.
  const plan = planCheckoutUpdate({ install: npmInstall, checkout: ready, ...base });
  assert.equal(plan.run, false);
  assert.match(plan.reason, /npm owns this install/);
});

test('the npm plan still fires for an outdated npm install', () => {
  // Windows: no .git, so this is the only branch that can run, and it still does.
  const plan = planAutoUpdate({
    status: { current: '1.3.5', latest: '1.3.6', outdated: true },
    install: npmInstall, enabled: true, isTTY: true, alreadyRan: false,
  });
  assert.equal(plan.run, true);
  assert.equal(plan.to, '1.3.6');
});

test('the npm plan still refuses a checkout, as it always did', () => {
  const plan = planAutoUpdate({
    status: { current: '1.3.5', latest: '1.3.6', outdated: true },
    install: checkoutInstall, enabled: true, isTTY: true, alreadyRan: false,
  });
  assert.equal(plan.run, false);
});

// ── When the checkout path fires ─────────────────────────────────────────────

test('a clean checkout tracking a remote is pulled', () => {
  const plan = planCheckoutUpdate({ install: checkoutInstall, checkout: ready, ...base });
  assert.equal(plan.run, true);
  assert.equal(plan.branch, 'main');
  assert.equal(plan.upstream, 'origin/main');
});

test('uncommitted work is never pulled over', () => {
  const dirty = { ...ready, clean: false, pullable: false, reason: 'the working tree has uncommitted changes' };
  const plan = planCheckoutUpdate({ install: checkoutInstall, checkout: dirty, ...base });
  assert.equal(plan.run, false);
  assert.match(plan.reason, /uncommitted/);
});

test('a branch tracking nothing has nowhere to pull from', () => {
  const untracked = { isCheckout: true, branch: 'wip', upstream: null, clean: true, pullable: false, reason: 'branch "wip" tracks no remote' };
  const plan = planCheckoutUpdate({ install: checkoutInstall, checkout: untracked, ...base });
  assert.equal(plan.run, false);
});

test('the off switches still switch it off', () => {
  const off = planCheckoutUpdate({ install: checkoutInstall, checkout: ready, ...base, enabled: false });
  assert.equal(off.run, false);
  // Re-executing into the pulled build must not pull again.
  const again = planCheckoutUpdate({ install: checkoutInstall, checkout: ready, isTTY: true, alreadyRan: true });
  assert.equal(again.run, false);
  assert.match(again.reason, /already updated/);
  // Nothing installs itself in a pipe or a CI job.
  const piped = planCheckoutUpdate({ install: checkoutInstall, checkout: ready, isTTY: false, alreadyRan: false });
  assert.equal(piped.run, false);
});

// ── `changed`, against a git that does not speak English ─────────────────────

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

async function repoPair() {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-ck-'));
  const origin = join(dir, 'origin');
  const clone = join(dir, 'clone');
  execFileSync('git', ['init', '-q', '-b', 'main', origin]);
  git(origin, 'config', 'user.email', 't@t');
  git(origin, 'config', 'user.name', 'T');
  await writeFile(join(origin, 'f.txt'), 'one\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'one');
  execFileSync('git', ['clone', '-q', origin, clone]);
  git(clone, 'config', 'user.email', 't@t');
  git(clone, 'config', 'user.name', 'T');
  return { dir, origin, clone };
}

test('a no-op pull reports no change even when git answers in Italian', async () => {
  // The bug this replaced: `changed` was `!/Already up to date/`, so on an
  // it_IT machine ("Già aggiornato") every pull looked like a change — which
  // on the startup path means re-executing on every single launch.
  const { dir, clone } = await repoPair();
  try {
    const before = git(clone, 'rev-parse', 'HEAD').trim();
    const result = await pullCheckout({ root: clone, timeoutMs: 30_000 });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false, `output was: ${result.output}`);
    assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a pull that moves HEAD reports a change', async () => {
  const { dir, origin, clone } = await repoPair();
  try {
    await writeFile(join(origin, 'f.txt'), 'two\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'two');
    const before = git(clone, 'rev-parse', 'HEAD').trim();
    const result = await pullCheckout({ root: clone, timeoutMs: 30_000 });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.notEqual(git(clone, 'rev-parse', 'HEAD').trim(), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a checkout ahead of its remote pulls without moving', async () => {
  // This machine's own case: a local commit not yet pushed.
  const { dir, clone } = await repoPair();
  try {
    await writeFile(join(clone, 'local.txt'), 'mine\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-qm', 'local');
    const before = git(clone, 'rev-parse', 'HEAD').trim();
    const result = await pullCheckout({ root: clone, timeoutMs: 30_000 });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a diverged branch is refused rather than merged', async () => {
  // --ff-only earning its keep: local and remote both moved.
  const { dir, origin, clone } = await repoPair();
  try {
    await writeFile(join(origin, 'f.txt'), 'remote\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'remote side');
    await writeFile(join(clone, 'f.txt'), 'local\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-qm', 'local side');
    const before = git(clone, 'rev-parse', 'HEAD').trim();
    const result = await pullCheckout({ root: clone, timeoutMs: 30_000 });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, false);
    // The working copy is exactly where it was.
    assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a pull that cannot answer is bounded, not hung', async () => {
  const { dir, clone } = await repoPair();
  try {
    // A remote that does not exist: git retries and waits.
    git(clone, 'remote', 'set-url', 'origin', 'https://10.255.255.1/nope.git');
    const t0 = Date.now();
    const result = await pullCheckout({ root: clone, timeoutMs: 1500 });
    const elapsed = Date.now() - t0;
    assert.equal(result.ok, false);
    assert.ok(elapsed < 12_000, `took ${elapsed}ms — the timeout did not bite`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── The real checkout ────────────────────────────────────────────────────────

test('this working copy reports itself as a pullable checkout', () => {
  const here = describeCheckout();
  assert.equal(here.isCheckout, true);
  assert.equal(typeof here.pullable, 'boolean');
});
