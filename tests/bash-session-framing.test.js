// The stdout/stderr framing race, driven deterministically.
//
// stdout and stderr are separate pipes with independent delivery, so the
// stdout sentinel arriving says nothing about whether the command's stderr has
// been read. The session used to give stderr a flat 250ms after that point and
// then give up, which under load reported a command's entire error output as
// empty next to a correct exit code. These tests reproduce that timing with a
// fake shell instead of waiting for a busy machine to produce it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import { BashSession } from '../src/tools/bash-session.js';

// A shell that never runs anything: the test decides byte for byte what comes
// back on each pipe, and when.
function fakeShell() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.kill = () => {};
  proc.pid = 4242;
  const written = [];
  proc.stdin.on('data', chunk => written.push(chunk.toString()));
  proc.written = written;
  return proc;
}

// The sentinel is minted per command and embedded in what the session writes
// to stdin; read it back out so the fake shell can echo the real protocol.
function sentinelFrom(written) {
  const match = written.join('').match(/__ETTORE_SESSION_END_[0-9a-f]+__/);
  return match ? match[0] : null;
}

function sessionWith(proc) {
  return new BashSession(process.cwd(), { platform: 'linux', spawnFn: () => proc });
}

const tick = ms => new Promise(r => { setTimeout(r, ms); });

test('stderr that arrives long after the stdout sentinel is still reported', async () => {
  const proc = fakeShell();
  const session = sessionWith(proc);
  const run = session.run('echo boom >&2; exit 3');

  await tick(30);
  const sentinel = sentinelFrom(proc.written);
  assert.ok(sentinel, 'the session must frame the command with a sentinel');

  // stdout finishes first, carrying the exit code. Nothing on stderr yet.
  proc.stdout.write(`\n${sentinel}EXIT:3\n`);

  // Far past the old 250ms window: this is the delivery delay a loaded
  // machine produces, and the whole point is that it must not lose data.
  await tick(700);
  proc.stderr.write(`boom\n${sentinel}\n`);

  const result = await run;
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /boom/, 'the error output must survive a slow pipe');
  assert.ok(!result.stderrTruncated, 'nothing was given up on');
});

test('a closed stderr settles at once instead of waiting out a window', async () => {
  const proc = fakeShell();
  const session = sessionWith(proc);
  const startedAt = Date.now();
  const run = session.run('exec 2>&-; echo still_here');

  await tick(30);
  const sentinel = sentinelFrom(proc.written);
  // The command closed stderr: its sentinel can never arrive, and the pipe
  // ends. That end is the proof, so there is nothing to wait for.
  proc.stderr.end();
  proc.stdout.write(`still_here\n${sentinel}EXIT:0\n`);

  const result = await run;
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /still_here/);
  assert.ok(Date.now() - startedAt < 500, `took ${Date.now() - startedAt}ms — it waited on a dead pipe`);
});

test('giving up on stderr is reported, never passed off as complete output', async () => {
  const proc = fakeShell();
  const session = sessionWith(proc);
  const run = session.run('weird');

  await tick(30);
  const sentinel = sentinelFrom(proc.written);
  // stdout completes; stderr stays open and utterly silent, so the window is
  // the only way out. The result has to say the error output may be partial.
  proc.stdout.write(`out\n${sentinel}EXIT:1\n`);

  // The window's timer is unref'd — production must not keep the process
  // alive for it — so the test holds the event loop open itself.
  const keepAlive = setInterval(() => {}, 20);
  const result = await run;
  clearInterval(keepAlive);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderrTruncated, true);
});

test('a shell that dies mid-command still reports what it wrote', async () => {
  const proc = fakeShell();
  const session = sessionWith(proc);
  const run = session.run('echo boom >&2; exit 3');

  await tick(30);
  // The shell ends: `exit 3` exits the session shell itself. The process is
  // gone, but its output has not been read yet — which is the whole point.
  proc.emit('exit', 3, null);
  await tick(50);
  proc.stderr.write('boom\n');
  proc.stderr.end();
  proc.stdout.end();
  await tick(10);
  proc.emit('close', 3, null);

  const result = await run;
  assert.equal(result.exitCode, 3);
  assert.equal(result.sessionDied, true);
  assert.match(result.stderr, /boom/, 'output written before the shell died must not be lost');
});
