// Windows behaviour, exercised from Linux. Every function under test takes
// `platform` and `env` as arguments precisely so this file can run anywhere —
// the CI matrix checks the real thing, this checks the decisions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findOnPath,
  resolveBinary,
  resolvePython,
  resolveShell,
  shellInvocation,
  describeShell,
  detachOptions,
  killProcessTree,
  shortenPath,
  baseNameOf,
  hasPathSeparator,
} from '../src/utils/platform.js';

// A fake Windows PATH on the real filesystem: findOnPath stats files, so the
// candidates have to exist.
async function fakeWindowsPath(names) {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-winpath-'));
  await mkdir(dir, { recursive: true });
  for (const name of names) await writeFile(join(dir, name), '');
  return {
    dir,
    env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  };
}

test('findOnPath resolves a bare name through PATHEXT on Windows', async () => {
  const { dir, env } = await fakeWindowsPath(['npm.cmd', 'node.exe']);
  assert.equal(findOnPath('npm', { env, platform: 'win32' }), join(dir, 'npm.cmd'));
  assert.equal(findOnPath('node', { env, platform: 'win32' }), join(dir, 'node.exe'));
  assert.equal(findOnPath('nothing-here', { env, platform: 'win32' }), null);
});

test('a .cmd shim is spawned with a shell, an .exe without', async () => {
  const { dir, env } = await fakeWindowsPath(['npm.cmd', 'node.exe']);

  const npm = resolveBinary('npm', { env, platform: 'win32' });
  assert.equal(npm.file, join(dir, 'npm.cmd'));
  assert.equal(npm.shell, true, 'Node refuses to spawn a .cmd without a shell (CVE-2024-27980)');

  const node = resolveBinary('node', { env, platform: 'win32' });
  assert.equal(node.file, join(dir, 'node.exe'));
  assert.equal(node.shell, false, 'an .exe needs no shell');
});

test('a known shim missing from PATH still gets the shell it needs', () => {
  const env = { PATH: '', PATHEXT: '.EXE;.CMD' };
  const npm = resolveBinary('npm', { env, platform: 'win32' });
  assert.equal(npm.file, 'npm');
  assert.equal(npm.shell, true);

  const unknown = resolveBinary('some-random-tool', { env, platform: 'win32' });
  assert.equal(unknown.shell, false, 'do not route arbitrary tools through cmd.exe');
});

test('POSIX never asks for a shell and never rewrites the name', () => {
  for (const name of ['npm', 'python3', 'go']) {
    const out = resolveBinary(name, { env: { PATH: '/usr/bin' }, platform: 'linux' });
    assert.deepEqual(out, { file: name, shell: false });
  }
});

test('python resolves to what the platform actually installs', async () => {
  const { dir, env } = await fakeWindowsPath(['python.exe']);
  const win = resolvePython({ env, platform: 'win32' });
  assert.equal(win.file, join(dir, 'python.exe'), 'python3.exe usually does not exist on Windows');

  const posix = resolvePython({ env: { PATH: '/usr/bin' }, platform: 'linux' });
  assert.equal(posix.file, 'python3');
});

test('the Windows shell is PowerShell when it is available', async () => {
  const { dir, env } = await fakeWindowsPath(['powershell.exe']);
  const shell = resolveShell({ env, platform: 'win32' });
  assert.equal(shell.name, 'powershell');
  assert.equal(shell.file, join(dir, 'powershell.exe'));
  assert.deepEqual(shell.args, ['-NoProfile', '-NonInteractive', '-Command']);
});

test('pwsh wins over Windows PowerShell when both are installed', async () => {
  const { dir, env } = await fakeWindowsPath(['pwsh.exe', 'powershell.exe']);
  assert.equal(resolveShell({ env, platform: 'win32' }).file, join(dir, 'pwsh.exe'));
});

test('with no PowerShell at all it falls back to ComSpec', () => {
  const env = { PATH: '', PATHEXT: '.EXE', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const shell = resolveShell({ env, platform: 'win32' });
  assert.equal(shell.name, 'cmd');
  assert.equal(shell.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(shell.args, ['/d', '/s', '/c']);
});

test('ETTORE_SHELL overrides the default on either platform', async () => {
  const { dir, env } = await fakeWindowsPath(['bash.exe', 'powershell.exe']);
  const forced = resolveShell({ env: { ...env, ETTORE_SHELL: 'bash' }, platform: 'win32' });
  assert.equal(forced.name, 'bash');
  assert.equal(forced.file, join(dir, 'bash.exe'));

  const forcedCmd = resolveShell({ env: { ...env, ETTORE_SHELL: 'cmd' }, platform: 'win32' });
  assert.equal(forcedCmd.name, 'cmd');
});

test('POSIX keeps bash -lc exactly as before', () => {
  const shell = resolveShell({ env: {}, platform: 'linux' });
  assert.deepEqual(shell, { name: 'bash', file: 'bash', args: ['-lc'] });

  const invocation = shellInvocation('echo hi', { env: {}, platform: 'linux' });
  assert.equal(invocation.file, 'bash');
  assert.deepEqual(invocation.args, ['-lc', 'echo hi']);
});

test('shellInvocation puts the command last, after the shell flags', async () => {
  const { env } = await fakeWindowsPath(['powershell.exe']);
  const invocation = shellInvocation('Get-ChildItem', { env, platform: 'win32' });
  assert.deepEqual(invocation.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(invocation.args.at(-1), 'Get-ChildItem');
  assert.equal(invocation.shell, 'powershell');
});

test('the shell description is empty on POSIX and explicit on Windows', async () => {
  assert.equal(describeShell({ env: {}, platform: 'linux' }), '');

  const { env } = await fakeWindowsPath(['powershell.exe']);
  const note = describeShell({ env, platform: 'win32' });
  assert.match(note, /PowerShell/);
  assert.match(note, /Select-String/, 'the model has to be told grep is not there');
});

test('detach means a process group on POSIX and no console window on Windows', () => {
  assert.deepEqual(detachOptions({ platform: 'linux' }), { detached: true });
  // `detached` on Windows opens a console window on every command instead.
  assert.deepEqual(detachOptions({ platform: 'win32' }), { detached: false, windowsHide: true });
});

test('killing a tree uses the process group on POSIX', () => {
  const seen = [];
  const ok = killProcessTree({ pid: 4321 }, 'SIGTERM', {
    platform: 'linux',
    killFn: (pid, sig) => seen.push([pid, sig]),
  });
  assert.equal(ok, true);
  assert.deepEqual(seen, [[-4321, 'SIGTERM']], 'the negated pid is the group');
});

test('killing a tree uses taskkill on Windows', () => {
  const calls = [];
  killProcessTree({ pid: 4321 }, 'SIGTERM', {
    platform: 'win32',
    spawnSyncFn: (file, args) => calls.push([file, args]),
  });
  killProcessTree({ pid: 4321 }, 'SIGKILL', {
    platform: 'win32',
    spawnSyncFn: (file, args) => calls.push([file, args]),
  });

  assert.deepEqual(calls[0], ['taskkill', ['/pid', '4321', '/T']]);
  assert.deepEqual(calls[1], ['taskkill', ['/pid', '4321', '/T', '/F']], 'SIGKILL forces');
});

test('killing a tree falls back to the child when the group call fails', () => {
  let killed = null;
  const child = { pid: 99, kill: (sig) => { killed = sig; return true; } };
  const ok = killProcessTree(child, 'SIGTERM', {
    platform: 'linux',
    killFn: () => { throw new Error('ESRCH'); },
  });
  assert.equal(ok, true);
  assert.equal(killed, 'SIGTERM');
});

test('killing a tree with no pid is a no-op, not a crash', () => {
  assert.equal(killProcessTree(null, 'SIGTERM', { platform: 'linux' }), false);
  assert.equal(killProcessTree({}, 'SIGTERM', { platform: 'win32' }), false);
});

// ─── Paths for display ───────────────────────────────────────────────────────
// The TUI header did `cwd.split('/').slice(-2).join('/')`, which finds no
// separator in `C:\Users\re77\zp` and printed the whole path into a field
// sized for two segments.

test('shortenPath keeps the last segments on both separators', () => {
  assert.equal(shortenPath('/home/re77/Scrivania/zp'), 'Scrivania/zp');
  assert.equal(shortenPath('C:\\Users\\re77\\Scrivania\\zp'), 'Scrivania/zp');
  assert.equal(shortenPath('C:\\projects/mixed\\sep'), 'mixed/sep');
});

test('shortenPath leaves a short path alone and survives odd input', () => {
  assert.equal(shortenPath('zp'), 'zp');
  assert.equal(shortenPath('/zp'), 'zp');
  assert.equal(shortenPath('C:\\'), 'C:');
  assert.equal(shortenPath(''), '');
  assert.equal(shortenPath(null), '');
  assert.equal(shortenPath('/a/b/c/d', 3), 'b/c/d');
});

test('baseNameOf takes the final component on either platform', () => {
  assert.equal(baseNameOf('/home/re77/app.py'), 'app.py');
  assert.equal(baseNameOf('C:\\Users\\re77\\app.py'), 'app.py');
  assert.equal(baseNameOf('app.py'), 'app.py');
});

test('hasPathSeparator sees a Windows separator too', () => {
  assert.equal(hasPathSeparator('a/b'), true);
  assert.equal(hasPathSeparator('a\\b'), true);
  assert.equal(hasPathSeparator('plain'), false);
});

// ─── Runner resolution through the tools layer ───────────────────────────────

test('every test suite the user can name resolves its binary for the platform', async () => {
  const { platformRunner } = await import('../src/tools/index.js');
  for (const [kind, name] of [['npm', 'npm'], ['node', 'node'], ['pytest', 'python3'], ['go', 'go'], ['cargo', 'cargo']]) {
    const runner = platformRunner(kind, name, ['x']);
    assert.equal(runner.kind, kind);
    assert.equal(typeof runner.cmd, 'string');
    assert.ok(runner.cmd.length > 0, `${kind}: empty command`);
    assert.equal(typeof runner.shell, 'boolean', `${kind}: the shell flag drives execFile on Windows`);
  }
});
