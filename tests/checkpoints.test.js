import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointStore, countLineChanges } from '../src/agents/checkpoints.js';
import { diffSnapshots, snapshotWorkspace } from '../src/agents/workspace-changes.js';

const posixOnly = { skip: process.platform === 'win32' };

async function tempDir() {
  return realpath(await mkdtemp(join(tmpdir(), 'ettore-checkpoint-')));
}

async function tempRepo(files = {}) {
  const dir = await tempDir();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  if (Object.keys(files).length) {
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  }
  return { dir, git };
}

// What the agent does around a shell command.
async function shell(store, dir, command) {
  const before = await snapshotWorkspace(dir);
  const token = await store.shellBefore(before);
  execFileSync('bash', ['-c', command], { cwd: dir, stdio: 'pipe' });
  await store.shellAfter(token, diffSnapshots(before, await snapshotWorkspace(dir)));
}

// What the agent does around write/edit.
async function toolWrite(store, path, content) {
  await store.captureBefore([path]);
  await writeFile(path, content);
  await store.noteAfter([path]);
}

test('countLineChanges matches what a diff would count', () => {
  assert.deepEqual(countLineChanges(['a', 'b', 'c'], ['a', 'b', 'c']), { added: 0, removed: 0 });
  assert.deepEqual(countLineChanges([], ['a', 'b']), { added: 2, removed: 0 });
  assert.deepEqual(countLineChanges(['a', 'b'], []), { added: 0, removed: 2 });
  assert.deepEqual(countLineChanges(['a', 'b', 'c'], ['a', 'x', 'c']), { added: 1, removed: 1 });
  assert.deepEqual(countLineChanges(['a', 'b', 'c', 'd'], ['a', 'c', 'd', 'e', 'f']), { added: 2, removed: 1 });
  // A moved line is one removal and one addition, as git counts it.
  assert.deepEqual(countLineChanges(['a', 'b', 'c'], ['c', 'a', 'b']), { added: 1, removed: 1 });
});

test('undo puts an edited file back and removes a created one; redo reverses it', async () => {
  const dir = await tempDir();
  try {
    const edited = join(dir, 'a.txt');
    const created = join(dir, 'sub', 'new.txt');
    await writeFile(edited, 'one\ntwo\n');
    const store = new CheckpointStore();
    store.begin('change two files');
    await toolWrite(store, edited, 'one\nTWO\nthree\n');
    await mkdir(join(dir, 'sub'));
    await toolWrite(store, created, 'hello\n');

    assert.deepEqual(await store.changes(), [
      { path: edited, status: 'modified', added: 2, removed: 1, binary: false },
      { path: created, status: 'added', added: 1, removed: 0, binary: false },
    ]);

    const undone = await store.undo();
    assert.equal(undone.label, 'change two files');
    assert.deepEqual(undone.restored, [
      { path: edited, action: 'restored' },
      { path: created, action: 'removed' },
    ]);
    assert.equal(await readFile(edited, 'utf8'), 'one\ntwo\n');
    assert.equal(existsSync(created), false);
    assert.equal(await store.undo(), null, 'nothing is left to undo');

    const redone = await store.redo();
    assert.equal(redone.restored.length, 2);
    assert.equal(await readFile(edited, 'utf8'), 'one\nTWO\nthree\n');
    assert.equal(await readFile(created, 'utf8'), 'hello\n');
    assert.equal(await store.redo(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the state before the request wins over later edits to the same file', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'a.txt');
    await writeFile(file, 'original\n');
    const store = new CheckpointStore();
    store.begin('two edits');
    await toolWrite(store, file, 'first\n');
    await toolWrite(store, file, 'second\n');
    await store.undo();
    assert.equal(await readFile(file, 'utf8'), 'original\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('undo leaves alone a file that changed again after the request, unless forced', async () => {
  const dir = await tempDir();
  try {
    const mine = join(dir, 'mine.txt');
    const other = join(dir, 'other.txt');
    await writeFile(mine, 'before\n');
    await writeFile(other, 'before\n');
    const store = new CheckpointStore();
    store.begin('edit');
    await toolWrite(store, mine, 'agent\n');
    await toolWrite(store, other, 'agent\n');
    await writeFile(mine, 'agent\nplus my own work\n');

    const first = await store.undo();
    assert.deepEqual(first.conflicts, [mine]);
    assert.deepEqual(first.restored, [{ path: other, action: 'restored' }]);
    assert.equal(await readFile(mine, 'utf8'), 'agent\nplus my own work\n');

    const forced = await store.undo({ force: true });
    assert.deepEqual(forced.restored, [{ path: mine, action: 'restored' }]);
    assert.equal(await readFile(mine, 'utf8'), 'before\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('undo goes back one request at a time, newest first', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'a.txt');
    await writeFile(file, 'v0\n');
    const store = new CheckpointStore();
    store.begin('first');
    await toolWrite(store, file, 'v1\n');
    store.begin('a question that changed nothing');
    store.begin('second');
    await toolWrite(store, file, 'v2\n');
    assert.deepEqual(store.list().map(cp => cp.label), ['second', 'first']);

    assert.equal((await store.undo()).label, 'second');
    assert.equal(await readFile(file, 'utf8'), 'v1\n');
    assert.equal((await store.undo()).label, 'first');
    assert.equal(await readFile(file, 'utf8'), 'v0\n');
    assert.equal((await store.redo()).label, 'first');
    assert.equal((await store.redo()).label, 'second');
    assert.equal(await readFile(file, 'utf8'), 'v2\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a new request ends the chance to redo', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'a.txt');
    await writeFile(file, 'v0\n');
    const store = new CheckpointStore();
    store.begin('first');
    await toolWrite(store, file, 'v1\n');
    await store.undo();
    store.begin('second');
    assert.equal(await store.redo(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file too large to copy is reported, not restored', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'big.bin');
    await writeFile(file, 'x'.repeat(200));
    const store = new CheckpointStore({ maxFileBytes: 100 });
    store.begin('big');
    await toolWrite(store, file, 'small');
    assert.equal((await store.changes())[0].status, 'unknown');
    const undone = await store.undo();
    assert.deepEqual(undone.restored, []);
    assert.equal(undone.unknown[0].path, file);
    assert.equal(await readFile(file, 'utf8'), 'small');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell: a clean tracked file is restored from HEAD, mode included', posixOnly, async () => {
  const { dir, git } = await tempRepo({ 'a.txt': 'one\ntwo\n', 'run.sh': '#!/bin/sh\necho hi\n' });
  try {
    await chmod(join(dir, 'run.sh'), 0o755);
    git('add', '-A');
    git('commit', '-q', '-m', 'exec');
    const store = new CheckpointStore();
    store.begin('shell edits');
    await shell(store, dir, "sed -i 's/two/TWO/' a.txt && rm run.sh");

    const changes = await store.changes();
    assert.deepEqual(changes.map(c => [c.path, c.status]), [
      [join(dir, 'a.txt'), 'modified'],
      [join(dir, 'run.sh'), 'deleted'],
    ]);

    const undone = await store.undo();
    assert.deepEqual(undone.restored.map(r => r.action), ['restored', 'recreated']);
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\n');
    assert.equal((await stat(join(dir, 'run.sh'))).mode & 0o777, 0o755);
    assert.equal(git('status', '--porcelain'), '', 'the tree is clean again');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell: a file that already had uncommitted changes gets those back, not HEAD', posixOnly, async () => {
  const { dir } = await tempRepo({ 'a.txt': 'committed\n' });
  try {
    await writeFile(join(dir, 'a.txt'), 'my uncommitted work\n');
    await writeFile(join(dir, 'notes.txt'), 'untracked notes\n');
    const store = new CheckpointStore();
    store.begin('shell edits');
    await shell(store, dir, 'echo agent > a.txt; echo agent > notes.txt');
    await store.undo();
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'my uncommitted work\n');
    assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'untracked notes\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell: a command that only reads changes nothing and leaves nothing to undo', posixOnly, async () => {
  const { dir } = await tempRepo({ 'a.txt': 'committed\n' });
  try {
    await writeFile(join(dir, 'a.txt'), 'dirty\n');
    const store = new CheckpointStore();
    store.begin('just looking');
    await shell(store, dir, 'cat a.txt > /dev/null');
    assert.deepEqual(await store.changes(), []);
    assert.equal(await store.undo(), null);
    store.begin('next');
    assert.deepEqual(store.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell: files created in a new directory are removed', posixOnly, async () => {
  const { dir, git } = await tempRepo({ 'a.txt': 'x\n' });
  try {
    const store = new CheckpointStore();
    store.begin('generate');
    await shell(store, dir, 'mkdir -p gen/deep && echo 1 > gen/one.txt && echo 2 > gen/deep/two.txt && echo 3 > top.txt');
    assert.deepEqual((await store.changes()).map(c => c.status), ['added', 'added', 'added']);
    await store.undo();
    assert.equal(existsSync(join(dir, 'gen', 'one.txt')), false);
    assert.equal(existsSync(join(dir, 'gen', 'deep', 'two.txt')), false);
    assert.equal(existsSync(join(dir, 'top.txt')), false);
    assert.equal(git('status', '--porcelain'), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell: a change inside an untracked directory that was already there is not guessed at', posixOnly, async () => {
  const { dir } = await tempRepo({ 'a.txt': 'x\n' });
  try {
    await mkdir(join(dir, 'drafts'));
    await writeFile(join(dir, 'drafts', 'mine.txt'), 'mine\n');
    const store = new CheckpointStore();
    store.begin('touch drafts');
    await shell(store, dir, 'echo agent > drafts/extra.txt');
    const undone = await store.undo();
    assert.deepEqual(undone.restored, []);
    assert.equal(undone.unknown.length, 1);
    assert.equal(await readFile(join(dir, 'drafts', 'mine.txt'), 'utf8'), 'mine\n');
    assert.equal(existsSync(join(dir, 'drafts', 'extra.txt')), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell: a change the command committed is still found, and still undone', posixOnly, async () => {
  const { dir, git } = await tempRepo({ 'a.txt': 'one\n', 'b.txt': 'keep\n' });
  try {
    const store = new CheckpointStore();
    store.begin('edit and commit');
    await shell(store, dir, 'echo two >> a.txt && git commit -q -am change');
    assert.deepEqual((await store.changes()).map(c => [c.path, c.added]), [[join(dir, 'a.txt'), 1]]);
    const undone = await store.undo();
    assert.equal(undone.historyMoved, true);
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'one\n');
    assert.equal(await readFile(join(dir, 'b.txt'), 'utf8'), 'keep\n');
    assert.match(git('log', '--oneline'), /change/, 'the commit itself is left in place');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell: a file a .gitignore edit brought into view is not deleted as if it were new', posixOnly, async () => {
  const { dir } = await tempRepo({ '.gitignore': 'secret.env\n', 'a.txt': 'x\n' });
  try {
    await writeFile(join(dir, 'secret.env'), 'KEY=1\n');
    // Old enough that its birth time cannot be mistaken for the command's.
    await new Promise((done) => { setTimeout(done, 2100); });
    const store = new CheckpointStore();
    store.begin('edit gitignore');
    await shell(store, dir, ': > .gitignore');
    const undone = await store.undo();
    assert.equal(await readFile(join(dir, 'secret.env'), 'utf8'), 'KEY=1\n');
    assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), 'secret.env\n');
    assert.ok(undone.unknown.some(u => u.path === join(dir, 'secret.env')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell and tool edits to one file share one before-state', posixOnly, async () => {
  const { dir } = await tempRepo({ 'a.txt': 'original\n' });
  try {
    const file = join(dir, 'a.txt');
    const store = new CheckpointStore();
    store.begin('mixed');
    await toolWrite(store, file, 'tool\n');
    await shell(store, dir, 'echo shell > a.txt');
    assert.equal((await store.changes()).length, 1);
    await store.undo();
    assert.equal(await readFile(file, 'utf8'), 'original\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('outside git a shell change is reported as one that cannot be undone', posixOnly, async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'out.txt');
    await writeFile(file, 'before\n');
    const store = new CheckpointStore();
    store.begin('no git');
    const token = await store.shellBefore(null);
    await writeFile(file, 'after\n');
    await store.shellAfter(token, [file]);
    const undone = await store.undo();
    assert.deepEqual(undone.restored, []);
    assert.equal(undone.unknown[0].path, file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('without an open request nothing is recorded', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'a.txt');
    await writeFile(file, 'before\n');
    const store = new CheckpointStore();
    await toolWrite(store, file, 'after\n');
    assert.equal(await store.undo(), null);
    assert.equal(await readFile(file, 'utf8'), 'after\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
