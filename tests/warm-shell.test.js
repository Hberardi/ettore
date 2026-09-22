import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import {
  BashSession,
  SHELL_DIALECTS,
  isolatedPowerShell,
  pipePath,
  powershellPipeBootstrap,
} from '../src/tools/bash-session.js';
import { runWarmShellCommand, warmShellEnabled, killWarmShells } from '../src/tools/warm-shell.js';

const windowsOnly = { skip: process.platform === 'win32' ? false : 'Windows shell' };

// ─── The PowerShell side, as text ────────────────────────────────────────────
// It cannot run here; what it must say can still be pinned down.

test('the piped bootstrap dials the pipe, proves itself, then hides the handshake', () => {
  const boot = powershellPipeBootstrap();
  assert.match(boot, /NamedPipeClientStream\('\.', \$env:ETTORE_SH_PIPE/);
  assert.ok(boot.indexOf('WriteLine($env:ETTORE_SH_TOKEN)') < boot.indexOf('Remove-Item Env:ETTORE_SH_TOKEN'),
    'the token is sent first and only then removed from what commands inherit');
  assert.match(boot, /FromBase64String\(\$__ettore_line\)/, 'each line is a base64 frame');
  assert.match(boot, /ProgressPreference = 'SilentlyContinue'/, 'progress bars make Invoke-WebRequest crawl');
});

test('an isolated command starts in its cwd, keeps its variables and gives back $env', () => {
  const script = isolatedPowerShell('$x = 1', "C:\\it's here");
  assert.match(script, /^Set-Location -LiteralPath 'C:\\it''s here'/, 'quotes are doubled, not left to break the line');
  assert.match(script, /& \{\n\$x = 1\nSet-Variable -Scope 1 -Name __ettore_ok -Value \$\?\n\}/,
    'a child scope, with $? read right after the command');
  assert.match(script, /\} finally \{[\s\S]*SetEnvironmentVariable/, 'env is restored even when the command throws');
  assert.match(script, /Out-String -Stream/, 'output is formatted inside the statement, before the sentinel');
});

test('the frame only isolates when given a cwd', () => {
  const decode = framed => Buffer.from(framed.match(/FromBase64String\('([^']*)'\)/)[1], 'base64').toString('utf8');
  assert.ok(!decode(SHELL_DIALECTS.powershell.frame('dir', 'S')).includes('Set-Location'));
  assert.ok(decode(SHELL_DIALECTS.powershell.frame('dir', 'S', { cwd: 'C:\\w' })).startsWith("Set-Location -LiteralPath 'C:\\w'"));
});

test('the warm shell is for Windows PowerShell only, and can be switched off', () => {
  assert.equal(warmShellEnabled({ platform: 'linux', env: {} }), false);
  assert.equal(warmShellEnabled({ platform: 'win32', env: { ETTORE_SHELL: 'cmd', ComSpec: 'cmd.exe' } }), false);
  assert.equal(warmShellEnabled({ platform: 'win32', env: { ETTORE_SHELL: 'powershell', ETTORE_WARM_SHELL: '0' } }), false);
  assert.equal(warmShellEnabled({ platform: 'win32', env: { ETTORE_SHELL: 'powershell' } }), true);
});

test('off Windows the bash tool is not routed through it', async () => {
  if (process.platform === 'win32') return;
  assert.equal(await runWarmShellCommand('echo hi'), null);
});

// ─── The Node side, for real ─────────────────────────────────────────────────
// A stand-in for PowerShell that speaks the same protocol: dial the pipe, send
// the token, and answer each frame with its sentinels. Everything on the Node
// side — handshake, queueing before connect, framing — runs as it does on
// Windows.

const FAKE_SHELL = `
const net = require('net');
const stdinClosed = (() => { try { return require('fs').readFileSync(0).length === 0; } catch { return true; } })();
const sock = net.connect(process.env.FAKE_PIPE_PATH);
sock.write((process.env.FAKE_TOKEN_OVERRIDE || process.env.ETTORE_SH_TOKEN) + '\\n');
let buf = '';
sock.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const frame = Buffer.from(buf.slice(0, i), 'base64').toString();
    buf = buf.slice(i + 1);
    const sentinel = frame.match(/__ETTORE_SESSION_END_[0-9a-f]+__/)[0];
    const script = Buffer.from(frame.match(/FromBase64String\\('([^']*)'\\)/)[1], 'base64').toString();
    const command = script.split('\\n')[4];
    process.stdout.write(JSON.stringify({ command, stdinClosed, inherited: 'ETTORE_SH_TOKEN' in process.env }) + '\\n');
    process.stderr.write('warn:' + command + '\\n');
    process.stderr.write('\\n' + sentinel + '\\n');
    process.stdout.write('\\n' + sentinel + 'EXIT:' + (command === 'fail' ? 7 : 0) + '\\n');
  }
});
`;

function fakeSpawn(extraEnv = {}) {
  return (file, args, opts) => {
    assert.ok(args.includes('-EncodedCommand'), 'PowerShell gets the bootstrap encoded, not quoted');
    assert.equal(opts.stdio[0], 'ignore', 'stdin must be closed, so native commands read EOF');
    return spawn(process.execPath, ['-e', FAKE_SHELL], {
      ...opts,
      env: { ...opts.env, FAKE_PIPE_PATH: pipePath(opts.env.ETTORE_SH_PIPE), ...extraEnv },
    });
  };
}

function pipedSession(spawnFn) {
  return new BashSession(process.cwd(), {
    transport: 'pipe',
    isolate: true,
    dialect: SHELL_DIALECTS.powershell,
    spawnFn,
  });
}

test('piped session: commands queued before the shell connects still run, in order', async () => {
  const session = pipedSession(fakeSpawn());
  try {
    const [a, b] = await Promise.all([session.run('first'), session.run('fail')]);
    assert.equal(JSON.parse(a.stdout).command, 'first');
    assert.equal(a.exitCode, 0);
    assert.match(a.stderr, /warn:first/, 'stderr is framed too');
    assert.equal(JSON.parse(b.stdout).command, 'fail');
    assert.equal(b.exitCode, 7);
    assert.equal(JSON.parse(a.stdout).stdinClosed, true);
  } finally {
    session.kill();
  }
});

test('piped session: a caller without the token gets nothing', async () => {
  const session = pipedSession(fakeSpawn({ FAKE_TOKEN_OVERRIDE: 'not-the-token' }));
  try {
    // Rejected, the stand-in has nothing left to do and exits; either way the
    // call must end without the command having reached it.
    const result = await session.run('secret', { timeoutMs: 1500 });
    assert.ok(result.sessionDied || result.timedOut, JSON.stringify(result));
    assert.ok(!result.stdout.includes('secret'), 'the command must not be sent to an unproven caller');
  } finally {
    session.kill();
  }
});

test('piped session: ready() rejects when the shell dies before connecting', async () => {
  const session = pipedSession((file, args, opts) => spawn(process.execPath, ['-e', 'process.exit(0)'], opts));
  await assert.rejects(session.ready(), /exited before it connected/);
  session.kill();
});

test('piped session: an idle shell does not hold the process open', async () => {
  const session = pipedSession(fakeSpawn());
  try {
    session.setRef(true);
    await session.run('x');
    session.setRef(false);
    assert.equal(session.process.stdout.hasRef?.() ?? false, false);
  } finally {
    session.kill();
  }
});

// ─── On Windows, the real thing ──────────────────────────────────────────────

test('warm shell: output, exit codes and a multi-line block', windowsOnly, async () => {
  try {
    const hello = await runWarmShellCommand('Write-Output hello');
    assert.ok(hello, 'the warm shell should be available on Windows');
    assert.equal(hello.stdout.trim(), 'hello');
    assert.equal(hello.code, 0);

    const native = await runWarmShellCommand('cmd /c exit 3');
    assert.equal(native.code, 3);

    const block = await runWarmShellCommand('foreach ($i in 1..3) {\n  "n$i"\n}');
    assert.deepEqual(block.stdout.trim().split(/\r?\n/), ['n1', 'n2', 'n3']);

    const broken = await runWarmShellCommand('if ($true) {', { timeoutMs: 10_000 });
    assert.equal(broken.timedOut, false, 'a syntax error must fail fast, not hang');
    assert.notEqual(broken.code, 0);
  } finally {
    killWarmShells();
  }
});

test('warm shell: each call behaves like a fresh process', windowsOnly, async () => {
  try {
    await runWarmShellCommand('$leak = "x"; $env:ETTORE_LEAK = "y"; Set-Location ..');
    const after = await runWarmShellCommand('"[$leak][$env:ETTORE_LEAK]"; (Get-Location).Path', { cwd: process.cwd() });
    const [vars, where] = after.stdout.trim().split(/\r?\n/);
    assert.equal(vars, '[][]', 'variables and env changes must not carry over');
    assert.equal(where, process.cwd());
  } finally {
    killWarmShells();
  }
});

test('warm shell: a native command reading stdin gets EOF, not a hang', windowsOnly, async () => {
  try {
    const r = await runWarmShellCommand(`& "${process.execPath}" -e "process.stdin.resume(); process.stdin.on('end', () => console.log('eof'))"`, { timeoutMs: 15_000 });
    assert.equal(r.timedOut, false);
    assert.match(r.stdout, /eof/);
  } finally {
    killWarmShells();
  }
});
