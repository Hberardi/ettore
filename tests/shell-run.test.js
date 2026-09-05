// The behaviours that decide whether `bash` returns or appears to hang.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShellCommand } from '../src/tools/shell-run.js';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('a command that finishes returns when it finishes, not when its pipes close', async () => {
  // The reported hang. `exec` settled at stdout EOF, so the background `sleep`
  // held the pipe and this cost the full timeout — 120s by default — even
  // though `echo` had already run.
  const t0 = Date.now();
  const result = await runShellCommand('sleep 20 & echo started', { timeoutMs: 10_000 });
  const elapsed = Date.now() - t0;

  assert.match(result.stdout, /started/);
  assert.equal(result.timedOut, false);
  assert.ok(elapsed < 2000, `took ${elapsed}ms — it is waiting on the pipe again`);
});

test('output still arrives in full for an ordinary command', async () => {
  // The grace period after exit must not clip a command's own output.
  const result = await runShellCommand('for i in $(seq 1 200); do echo "line $i"; done', { timeoutMs: 10_000 });
  assert.equal(result.stdout.trim().split('\n').length, 200);
  assert.equal(result.code, 0);
});

test('stdin is closed, so a command that reads it gets EOF instead of waiting', async () => {
  const t0 = Date.now();
  const result = await runShellCommand('read -r line; echo "got:[$line]"', { timeoutMs: 5000 });
  assert.match(result.stdout, /got:\[\]/);
  assert.ok(Date.now() - t0 < 2000, 'blocked on stdin');
});

test('a non-zero exit is an outcome, not an exception', async () => {
  const result = await runShellCommand('echo out; echo err >&2; exit 3', { timeoutMs: 5000 });
  assert.equal(result.code, 3);
  assert.match(result.stdout, /out/);
  assert.match(result.stderr, /err/);
  assert.equal(result.timedOut, false);
});

test('a command that will not finish is timed out and reported as such', async () => {
  const t0 = Date.now();
  const result = await runShellCommand('echo before; sleep 30', { timeoutMs: 800 });
  const elapsed = Date.now() - t0;

  assert.equal(result.timedOut, true);
  // Whatever it managed to print before the timeout is still worth reading.
  assert.match(result.stdout, /before/);
  assert.ok(elapsed < 4000, `timeout did not fire promptly: ${elapsed}ms`);
});

test('a timeout takes down what the command started, not just the command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-shell-'));
  const pidFile = join(dir, 'pid');
  try {
    // The grandchild records itself, then outlives its parent unless the whole
    // process group is signalled.
    await runShellCommand(`bash -c 'echo $$ > ${pidFile}; sleep 30' & sleep 30`, { timeoutMs: 800 });
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.ok(Number.isFinite(pid) && pid > 0, 'the grandchild never started');

    // Give the signal a moment to land.
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise(r => { setTimeout(r, 50); });
    assert.equal(alive(pid), false, `pid ${pid} survived the timeout`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an abort stops the command and says so', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const result = await runShellCommand('sleep 30', { timeoutMs: 10_000, signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});

test('a signal already aborted stops the command immediately', async () => {
  const controller = new AbortController();
  controller.abort();
  const t0 = Date.now();
  const result = await runShellCommand('sleep 30', { timeoutMs: 10_000, signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.ok(Date.now() - t0 < 3000);
});

test('runaway output is capped rather than buffered without limit', async () => {
  const result = await runShellCommand('yes ettore | head -c 200000', { timeoutMs: 10_000, maxBytes: 4096 });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 8192, `kept ${result.stdout.length} chars`);
});

test('a shell that cannot be started rejects, since nothing ran', async () => {
  await assert.rejects(
    () => runShellCommand('echo hi', { timeoutMs: 1000, spawnFn: () => { throw new Error('ENOENT'); } }),
    /ENOENT/,
  );
});

test('the working directory is honoured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-shell-cwd-'));
  try {
    const result = await runShellCommand('pwd', { cwd: dir, timeoutMs: 5000 });
    // macOS reports /private/var for /var, so compare the tail.
    assert.ok(result.stdout.trim().endsWith(dir.split('/').pop()), result.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
