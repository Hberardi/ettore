import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBashSession, killBashSession } from '../src/tools/bash-session.js';

after(() => { killBashSession(); });

test('bash_session: cwd persists across calls (cd then pwd)', async () => {
  killBashSession();
  const dir = await mkdtemp(join(tmpdir(), 'ettore-bashsess-'));
  try {
    const session = getBashSession(process.cwd());
    const r1 = await session.run(`cd ${dir}`);
    assert.equal(r1.exitCode, 0);
    const r2 = await session.run('pwd');
    assert.equal(r2.exitCode, 0);
    assert.equal(r2.stdout.trim(), dir);
  } finally {
    killBashSession();
    await rm(dir, { recursive: true, force: true });
  }
});

test('bash_session: exported variables persist', async () => {
  killBashSession();
  try {
    const session = getBashSession(process.cwd());
    const r1 = await session.run('export ETTORE_TEST_VAR=hello_world');
    assert.equal(r1.exitCode, 0);
    const r2 = await session.run('echo "value=$ETTORE_TEST_VAR"');
    assert.equal(r2.exitCode, 0);
    assert.match(r2.stdout, /value=hello_world/);
  } finally {
    killBashSession();
  }
});

test('bash_session: defined shell functions persist', async () => {
  killBashSession();
  try {
    const session = getBashSession(process.cwd());
    const r1 = await session.run('greet() { echo "ciao $1"; }');
    assert.equal(r1.exitCode, 0);
    const r2 = await session.run('greet ettore');
    assert.equal(r2.exitCode, 0);
    assert.match(r2.stdout, /ciao ettore/);
  } finally {
    killBashSession();
  }
});

test('bash_session: non-zero exit code is reported, session stays alive', async () => {
  killBashSession();
  try {
    const session = getBashSession(process.cwd());
    const r1 = await session.run('false');
    assert.equal(r1.exitCode, 1);
    // Session should still respond after a failing command
    const r2 = await session.run('echo still_here');
    assert.equal(r2.exitCode, 0);
    assert.match(r2.stdout, /still_here/);
  } finally {
    killBashSession();
  }
});

test('bash_session: concurrent run() calls are serialized in submission order', async () => {
  killBashSession();
  try {
    const session = getBashSession(process.cwd());
    const [a, b, c] = await Promise.all([
      session.run('echo one'),
      session.run('echo two'),
      session.run('echo three'),
    ]);
    assert.match(a.stdout, /^one$/);
    assert.match(b.stdout, /^two$/);
    assert.match(c.stdout, /^three$/);
  } finally {
    killBashSession();
  }
});

test('bash_session: timeout kills the session and reports it', async () => {
  killBashSession();
  try {
    const session = getBashSession(process.cwd());
    const r = await session.run('sleep 5', { timeoutMs: 250 });
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, 124);
    // Next call should respawn a fresh session
    const r2 = await session.run('echo respawned');
    assert.equal(r2.exitCode, 0);
    assert.match(r2.stdout, /respawned/);
  } finally {
    killBashSession();
  }
});

test('bash_session: stdout and stderr are separated', async () => {
  killBashSession();
  try {
    const session = getBashSession(process.cwd());
    const r = await session.run('echo out_msg; echo err_msg >&2');
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /out_msg/);
    assert.match(r.stderr, /err_msg/);
  } finally {
    killBashSession();
  }
});

test('bash_session: file written in one call is visible to next call', async () => {
  killBashSession();
  const dir = await mkdtemp(join(tmpdir(), 'ettore-bashsess-fs-'));
  try {
    const session = getBashSession(process.cwd());
    await session.run(`cd ${dir}`);
    const r1 = await session.run('echo "persistent state" > out.txt');
    assert.equal(r1.exitCode, 0);
    const r2 = await session.run('cat out.txt');
    assert.equal(r2.exitCode, 0);
    assert.match(r2.stdout, /persistent state/);
  } finally {
    killBashSession();
    await rm(dir, { recursive: true, force: true });
  }
});

test('bash_session: changing the requested workdir recreates the shared shell', async () => {
  killBashSession();
  const first = await mkdtemp(join(tmpdir(), 'ettore-bashsess-first-'));
  const second = await mkdtemp(join(tmpdir(), 'ettore-bashsess-second-'));
  try {
    const sessionA = getBashSession(first);
    const pwdA = await sessionA.run('pwd');
    assert.equal(pwdA.stdout.trim(), first);

    const sessionB = getBashSession(second);
    const pwdB = await sessionB.run('pwd');
    assert.notEqual(sessionB, sessionA);
    assert.equal(pwdB.stdout.trim(), second);
  } finally {
    killBashSession();
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});
