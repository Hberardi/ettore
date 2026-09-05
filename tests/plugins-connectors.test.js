// Contract tests every bundled plugin must pass — a well-formed manifest and
// an entry point that imports — plus behavioural tests for git-helpers, which
// has no test file of its own.
//
// The excel and database connectors used to be tested here as `excel-xlsx` and
// `db-query`. They were replaced by `excel-full` and `pgadmin`, which carry
// their own test files; what remained here asserted against directories that
// no longer existed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// Read from disk rather than hard-coded. The previous list named two plugins
// that had since been renamed, so the contract tests below were asserting
// against directories that no longer existed — and every bundled plugin added
// after the list was written went untested. Deriving it means a new plugin is
// covered the moment it lands, and a renamed one cannot leave a stale entry.
const PLUGINS = readdirSync(join(REPO_ROOT, 'examples', 'plugins'), { withFileTypes: true })
  .filter(e => e.isDirectory() && existsSync(join(REPO_ROOT, 'examples', 'plugins', e.name, 'plugin.json')))
  .map(e => e.name)
  .sort();

for (const name of PLUGINS) {
  test(`plugin "${name}": manifest is well-formed`, () => {
    const p = join(REPO_ROOT, 'examples', 'plugins', name, 'plugin.json');
    const json = JSON.parse(readFileSync(p, 'utf-8'));
    assert.equal(json.name, name);
    assert.match(json.version, /^\d+\.\d+\.\d+/);
    assert.equal(json.apiVersion, '1');
    assert.equal(json.main, 'index.js');
    assert.ok(Array.isArray(json.permissions) && json.permissions.length > 0);
  });

  test(`plugin "${name}": entry point imports without throwing`, async () => {
    const entry = join(REPO_ROOT, 'examples', 'plugins', name, 'index.js');
    const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}-${name}`);
    const bag = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
    assert.ok(bag.tools || bag.commands || bag.hooks, 'plugin must export at least one surface');
  });
}

// ── git-helpers: contract + structural ─────────────────────────────────────
test('git-helpers: declares the four documented tools', async () => {
  const entry = join(REPO_ROOT, 'examples', 'plugins', 'git-helpers', 'index.js');
  const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}-gh`);
  const bag = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
  for (const name of ['git_blame', 'git_log', 'git_diff_stat', 'git_branch_audit']) {
    assert.ok(bag.tools[name], `missing tool: ${name}`);
    assert.equal(typeof bag.tools[name].handler, 'function');
    assert.equal(typeof bag.tools[name].parameters, 'object');
  }
});

test('git-helpers: git_log returns an empty-but-valid result for a brand-new repo', async () => {
  // Make a tmp git repo with no commits. git_log on it should not throw.
  const tmp = mkdtempSync(join(tmpdir(), 'git-helpers-test-'));
  try {
    execSync('git init -q', { cwd: tmp });
    const entry = join(REPO_ROOT, 'examples', 'plugins', 'git-helpers', 'index.js');
    const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}-gh2`);
    const bag = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
    const out = await bag.tools.git_log.handler({ n: 5, cwd: tmp });
    assert.equal(typeof out, 'string');
    // git log on a brand-new repo either errors with "ambiguous argument HEAD"
    // or returns "(no commits)". The plugin must surface a string either way.
    assert.ok(out.length > 0, 'should return a non-empty string');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('git-helpers: git_diff_stat returns "(no diff)" for a clean tree', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'git-helpers-test-'));
  try {
    execSync('git init -q && git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init', { cwd: tmp });
    const entry = join(REPO_ROOT, 'examples', 'plugins', 'git-helpers', 'index.js');
    const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}-gh3`);
    const bag = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
    const out = await bag.tools.git_diff_stat.handler({ cwd: tmp });
    assert.equal(out, '(no diff)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── package.json: optionalDependencies declared ──────────────────────────
test('package.json declares the connector dependencies as optional', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
  assert.ok(pkg.optionalDependencies, 'optionalDependencies must be present');
  // `xlsx` was replaced by `exceljs`: the community SheetJS build writes
  // neither cell styles nor embedded images, and carries two high-severity
  // advisories with no fix available since it left npm.
  assert.ok(pkg.optionalDependencies.exceljs, 'exceljs must be in optionalDependencies');
  assert.ok(!pkg.optionalDependencies.xlsx, 'xlsx should no longer be a dependency');
  assert.ok(pkg.optionalDependencies['better-sqlite3'], 'better-sqlite3 must be in optionalDependencies');
  assert.ok(pkg.optionalDependencies.pg, 'pg must be in optionalDependencies');
});

// ── Optional dependencies must be loadable at all ────────────────────────────

test('no bundled plugin calls a bare require() in an ES module', async () => {
  // `require` does not exist in an ES module, so `try { require('xlsx') }` threw
  // ReferenceError every time and the catch reported it as a missing optional
  // dependency. The plugin then claimed the package was not installed whether
  // or not it was, and no tool that needed it could ever work.
  const { readdirSync } = await import('node:fs');
  const dir = join(REPO_ROOT, 'examples', 'plugins');
  for (const name of PLUGINS) {
    const entry = join(dir, name, 'index.js');
    if (!existsSync(entry)) continue;
    // Comments stripped first: a comment explaining why bare `require(` is
    // wrong would otherwise fail the test that enforces it.
    const src = readFileSync(entry, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');
    // `createRequire(...)` and a require it produced are fine; a bare one is not.
    const bare = [...src.matchAll(/(^|[^.\w])require\(/g)]
      .filter(m => !src.slice(Math.max(0, m.index - 40), m.index).includes('createRequire'));
    assert.equal(bare.length, 0, `${name} uses a bare require(): ESM has none`);
  }
  assert.ok(readdirSync(dir).length > 0);
});

test('a plugin can resolve a package that is actually installed', async () => {
  // The point of the fix: not just a better failure, but a load that succeeds
  // when the dependency is present. `pg` and `xlsx` are optional and absent
  // here, so this proves the path from the plugin's own location works.
  const { createRequire } = await import('node:module');
  for (const name of ['pgadmin', 'excel-full']) {
    const entry = join(REPO_ROOT, 'examples', 'plugins', name, 'index.js');
    if (!existsSync(entry)) continue;
    const requirePeer = createRequire(pathToFileURL(entry).href);
    assert.ok(requirePeer.resolve('chalk'), `${name} cannot resolve an installed package`);
    // And an absent one fails as a missing module, not as a broken language.
    try {
      requirePeer('definitely-not-a-real-package');
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.code, 'MODULE_NOT_FOUND', `got ${err.name}: ${err.message}`);
    }
  }
});
