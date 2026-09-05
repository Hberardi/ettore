// Contract tests for the bundled example plugins. These do NOT load the
// plugins through the runtime (that would require plugin dir wiring and
// the full agent bootstrap); they verify the static shape that
// `validateManifest` and `validatePluginModule` require, so a typo in
// the manifest or a missing `export const tools` blocks a release.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const PLUGINS = ['bash-monitor', 'command-palette-shortcuts'];

function loadManifest(name) {
  const p = join(REPO_ROOT, 'examples', 'plugins', name, 'plugin.json');
  return { path: p, json: JSON.parse(readFileSync(p, 'utf-8')) };
}

for (const name of PLUGINS) {
  test(`plugin "${name}": manifest is well-formed`, () => {
    const { path, json } = loadManifest(name);
    assert.ok(existsSync(path), `manifest must exist at ${path}`);
    assert.equal(json.name, name, 'manifest.name must match the directory name');
    assert.match(json.version, /^\d+\.\d+\.\d+/, 'version must be semver');
    assert.equal(json.apiVersion, '1');
    assert.equal(json.main, 'index.js');
    assert.ok(Array.isArray(json.permissions), 'permissions must be an array');
    assert.ok(json.permissions.length > 0, 'permissions must not be empty');
  });

  test(`plugin "${name}": entry-point is importable and exports the expected shape`, async () => {
    const entry = join(REPO_ROOT, 'examples', 'plugins', name, 'index.js');
    assert.ok(existsSync(entry), `entry point must exist at ${entry}`);
    // We import with a cache-busting query so each test sees a fresh
    // module (state stored on module-level Maps would otherwise leak).
    const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}`);
    const bag = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
    // At least one of tools / commands / hooks must be exported so the
    // plugin does something observable.
    const hasTools = bag.tools && typeof bag.tools === 'object' && Object.keys(bag.tools).length > 0;
    const hasCommands = bag.commands && typeof bag.commands === 'object' && Object.keys(bag.commands).length > 0;
    const hasHooks = bag.hooks && typeof bag.hooks === 'object' && Object.keys(bag.hooks).length > 0;
    assert.ok(hasTools || hasCommands || hasHooks, 'plugin must export at least one of tools/commands/hooks');
  });
}

// bash-monitor: command_history tool returns the right shape with no state.
test('bash-monitor: command_history returns empty state when no file exists', async () => {
  // Point HOME at a temp dir so the plugin reads from there.
  const tmp = mkdtempSync(join(tmpdir(), 'bash-monitor-test-'));
  const savedHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const entry = join(REPO_ROOT, 'examples', 'plugins', 'bash-monitor', 'index.js');
    const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}-2`);
    const bag = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
    const handler = bag.tools.command_history.handler;
    const out = await handler({ last: 5 });
    assert.equal(out.total_tracked, 0);
    assert.equal(out.returned, 0);
    assert.deepEqual(out.entries, []);
  } finally {
    process.env.HOME = savedHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// bash-monitor: write a synthetic history file, then read it back.
test('bash-monitor: command_history reads the file the plugin writes', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bash-monitor-test-'));
  const savedHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const cfgDir = join(tmp, '.config', 'ettore');
    mkdirSync(cfgDir, { recursive: true });
    const statePath = join(cfgDir, 'bash-monitor.json');
    const fake = {
      entries: [
        { turn: 1, tool: 'bash', command: 'npm test', normalized: 'npm test', durationMs: 12000, exitCode: 0, timedOut: false, at: new Date().toISOString() },
        { turn: 2, tool: 'bash_session', command: 'npm install', normalized: 'npm install', durationMs: 45000, exitCode: 0, timedOut: false, at: new Date().toISOString() },
      ],
    };
    writeFileSync(statePath, JSON.stringify(fake));
    const entry = join(REPO_ROOT, 'examples', 'plugins', 'bash-monitor', 'index.js');
    const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}-3`);
    const bag = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
    const handler = bag.tools.command_history.handler;
    const all = await handler({ last: 10 });
    assert.equal(all.total_tracked, 2);
    assert.equal(all.returned, 2);
    assert.equal(all.entries[0].command, 'npm test');
    assert.equal(all.entries[1].command, 'npm install');
    const slow = await handler({ last: 10, slow_only: true });
    assert.equal(slow.returned, 1);
    assert.equal(slow.entries[0].command, 'npm install');
  } finally {
    process.env.HOME = savedHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// command-palette-shortcuts: /last-bash shows recent entries.
test('command-palette-shortcuts: /last-bash reads from the same file', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-test-'));
  const savedHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const cfgDir = join(tmp, '.config', 'ettore');
    mkdirSync(cfgDir, { recursive: true });
    const fake = {
      entries: [
        { turn: 1, tool: 'bash', command: 'pwd', normalized: 'pwd', durationMs: 50, exitCode: 0, timedOut: false, at: '2026-09-05T10:00:00.000Z' },
        { turn: 2, tool: 'bash', command: 'ls -la', normalized: 'ls -la', durationMs: 200, exitCode: 0, timedOut: false, at: '2026-09-05T10:00:05.000Z' },
      ],
    };
    writeFileSync(join(cfgDir, 'bash-monitor.json'), JSON.stringify(fake));
    const entry = join(REPO_ROOT, 'examples', 'plugins', 'command-palette-shortcuts', 'index.js');
    const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}-4`);
    const bag = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
    const out = await bag.commands.last_bash.handler('2', {});
    assert.match(out, /Last 2 bash command/);
    assert.match(out, /pwd/);
    assert.match(out, /ls -la/);
  } finally {
    process.env.HOME = savedHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// command-palette-shortcuts: /where returns a snapshot.
test('command-palette-shortcuts: /where returns session info', async () => {
  const entry = join(REPO_ROOT, 'examples', 'plugins', 'command-palette-shortcuts', 'index.js');
  const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}-5`);
  const bag = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
  const out = await bag.commands.where.handler('', {});
  assert.match(out, /Session snapshot/);
  assert.match(out, /workdir/);
  assert.match(out, /platform/);
});

// bash-monitor: slow command triggers a warning in the onAfterTool return.
test('bash-monitor: slow command produces a warning', async () => {
  const entry = join(REPO_ROOT, 'examples', 'plugins', 'bash-monitor', 'index.js');
  const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}-6`);
  const bag = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
  // Fire onBeforeTool then onAfterTool with a 31s gap. We need to
  // monkey-patch Date.now to avoid a real sleep.
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    await bag.hooks.onBeforeTool('bash', { command: 'npm test' });
    clock += 31_000;
    const result = await bag.hooks.onAfterTool('bash', { command: 'npm test' }, 'all tests passed');
    assert.match(String(result || ''), /bash-monitor.*Slow/);
  } finally {
    Date.now = realNow;
  }
});

// bash-monitor: sudo command triggers a /dev/tty warning.
test('bash-monitor: sudo command produces a /dev/tty warning', async () => {
  const entry = join(REPO_ROOT, 'examples', 'plugins', 'bash-monitor', 'index.js');
  const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}-7`);
  const bag = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    await bag.hooks.onBeforeTool('bash', { command: 'sudo apt install curl' });
    clock += 100;
    const result = await bag.hooks.onAfterTool('bash', { command: 'sudo apt install curl' }, '');
    assert.match(String(result || ''), /bash-monitor.*\/dev\/tty/);
  } finally {
    Date.now = realNow;
  }
});

// bash-monitor: onBeforeTool records the timestamp, onAfterTool uses it.
test('bash-monitor: onBeforeTool + onAfterTool round-trip produces a valid entry', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bash-monitor-rt-'));
  const savedHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const entry = join(REPO_ROOT, 'examples', 'plugins', 'bash-monitor', 'index.js');
    const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}-8`);
    const bag = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      await bag.hooks.onBeforeTool('bash', { command: 'echo hello' });
      clock += 1500;
      await bag.hooks.onAfterTool('bash', { command: 'echo hello' }, 'hello\n[exit code: 0]');
      const out = await bag.tools.command_history.handler({ last: 5 });
      assert.equal(out.total_tracked, 1);
      assert.equal(out.entries[0].command, 'echo hello');
      assert.equal(out.entries[0].exit_code, 0);
      assert.equal(out.entries[0].duration_s, 2);
    } finally {
      Date.now = realNow;
    }
  } finally {
    process.env.HOME = savedHome;
    rmSync(tmp, { recursive: true, force: true });
  }
});
