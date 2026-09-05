import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTree, parseGitignoreNames, pathIsIgnored, DEFAULT_IGNORE } from '../src/app/dir-tree.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ettore-tree-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'src', 'index.js'), '// x');
  await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), '// noise');
  return root;
}

const names = (tree) => tree.entries.map(e => e.path);

// Wait for a condition the watcher is expected to reach, rather than sleeping
// a fixed amount — a fixed sleep is either flaky or slow, usually both.
async function until(predicate, { timeout = 5000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => { setTimeout(r, step); });
  }
  return false;
}

test('the scan lists the top level closed, and skips vendor directories', async () => {
  const root = await fixture();
  const tree = new DirectoryTree(root);
  try {
    await tree.start();
    const listed = names(tree);
    assert.ok(listed.includes('package.json'));
    assert.ok(listed.includes('src'));
    // Directories start closed, so their contents are not scanned at all.
    assert.ok(!listed.includes(join('src', 'index.js')), `src was walked while closed: ${listed}`);
    assert.equal(tree.entries.find(e => e.path === 'src').open, false);
    assert.ok(!listed.some(p => p.includes('node_modules')), `node_modules leaked: ${listed}`);
  } finally {
    tree.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a file created on disk appears without another scan being asked for', async () => {
  const root = await fixture();
  let notified = 0;
  const tree = new DirectoryTree(root, { debounceMs: 20, onChange: () => { notified++; } });
  try {
    await tree.start();
    assert.ok(!names(tree).includes('NEW.md'));

    await writeFile(join(root, 'NEW.md'), 'hello');
    const arrived = await until(() => names(tree).includes('NEW.md'));

    assert.ok(arrived, `tree never picked up the new file: ${names(tree)}`);
    assert.ok(notified > 0, 'the renderer was never told to repaint');
    // Freshly created entries are marked so the panel can call them out.
    const entry = tree.entries.find(e => e.path === 'NEW.md');
    assert.ok(entry.addedAt, 'new file carries no timestamp to highlight');
    assert.deepEqual(
      { kind: tree.lastChange.kind, path: tree.lastChange.path },
      { kind: 'added', path: 'NEW.md' },
    );
  } finally {
    tree.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a deleted file disappears from the tree', async () => {
  const root = await fixture();
  const tree = new DirectoryTree(root, { debounceMs: 20 });
  try {
    await tree.start();
    assert.ok(names(tree).includes('package.json'));

    await rm(join(root, 'package.json'));
    const gone = await until(() => !names(tree).includes('package.json'));

    assert.ok(gone, `deleted file still listed: ${names(tree)}`);
    assert.deepEqual(
      { kind: tree.lastChange.kind, path: tree.lastChange.path },
      { kind: 'removed', path: 'package.json' },
    );
  } finally {
    tree.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a new nested directory and its contents are picked up once open', async () => {
  const root = await fixture();
  const tree = new DirectoryTree(root, { debounceMs: 20 });
  try {
    await tree.start();
    await tree.expand('src');
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    // The new directory has to land in the tree before it can be opened —
    // only what is on screen is ever expandable.
    assert.ok(await until(() => names(tree).includes(join('src', 'deep'))), 'new directory never appeared');
    await tree.expand(join('src', 'deep'));
    await writeFile(join(root, 'src', 'deep', 'file.txt'), 'x');
    const seen = await until(() => names(tree).includes(join('src', 'deep', 'file.txt')));
    assert.ok(seen, `nested file never appeared: ${names(tree)}`);
  } finally {
    tree.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('stop() ends the watching — a later write changes nothing', async () => {
  const root = await fixture();
  const tree = new DirectoryTree(root, { debounceMs: 20 });
  try {
    await tree.start();
    tree.stop();
    await writeFile(join(root, 'AFTER.md'), 'x');
    await new Promise(r => { setTimeout(r, 200); });
    assert.ok(!names(tree).includes('AFTER.md'), 'watcher kept running after stop()');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the entry cap bounds the scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ettore-tree-big-'));
  try {
    for (let i = 0; i < 40; i++) await writeFile(join(root, `f${i}.txt`), 'x');
    const tree = new DirectoryTree(root, { maxEntries: 10 });
    await tree.start();
    tree.stop();
    assert.equal(tree.entries.length, 10);
    assert.equal(tree.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('depth cap stops the walk without losing what is above it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ettore-tree-deep-'));
  try {
    await mkdir(join(root, 'a', 'b', 'c', 'd'), { recursive: true });
    await writeFile(join(root, 'a', 'b', 'c', 'd', 'deep.txt'), 'x');
    const tree = new DirectoryTree(root, { maxDepth: 2 });
    await tree.start();
    // The cap is a backstop behind the expansion state, so open the whole
    // chain and check the walk still refuses to go past it.
    await tree.expand('a');
    await tree.expand(join('a', 'b'));
    await tree.expand(join('a', 'b', 'c'));
    tree.stop();
    const listed = names(tree);
    assert.ok(listed.includes(join('a', 'b')));
    assert.ok(!listed.some(p => p.endsWith('deep.txt')), `walked past the cap: ${listed}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('.gitignore names are honoured, globs are left alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ettore-tree-ignore-'));
  try {
    await writeFile(join(root, '.gitignore'), 'secrets\nbuilt/\n# comment\n*.log\n!keep\nsrc/nested\n');
    await mkdir(join(root, 'secrets'), { recursive: true });
    await mkdir(join(root, 'built'), { recursive: true });
    await writeFile(join(root, 'app.log'), 'x');
    await writeFile(join(root, 'keep.txt'), 'x');

    const tree = new DirectoryTree(root);
    await tree.start();
    tree.stop();
    const listed = names(tree);
    assert.ok(!listed.includes('secrets'));
    assert.ok(!listed.includes('built'));
    assert.ok(listed.includes('keep.txt'));
    // A glob is not honoured, and the panel shows the file rather than
    // pretending to a pattern language it does not implement.
    assert.ok(listed.includes('app.log'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parseGitignoreNames keeps plain names and drops everything else', () => {
  const got = parseGitignoreNames('dist\nbuild/\n/tmp\n\n# note\n*.log\n!keep\na/b\n  spaced  \n');
  assert.deepEqual([...got].sort(), ['build', 'dist', 'spaced', 'tmp']);
});

test('pathIsIgnored matches on any segment, in either separator', () => {
  assert.equal(pathIsIgnored('node_modules/left-pad/index.js', DEFAULT_IGNORE), true);
  assert.equal(pathIsIgnored('src\\.git\\config', DEFAULT_IGNORE), true);
  assert.equal(pathIsIgnored('src/app/dir-tree.js', DEFAULT_IGNORE), false);
  assert.equal(pathIsIgnored('', DEFAULT_IGNORE), false);
});

test('a watch the platform refuses leaves a snapshot and says so', async () => {
  const root = await fixture();
  const refuse = () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
  const tree = new DirectoryTree(root, { watchFn: refuse });
  try {
    await tree.start();
    // The scan still ran; only the liveness is gone.
    assert.ok(names(tree).includes('package.json'));
    assert.match(tree.error, /snapshot only/);
  } finally {
    tree.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('events under an ignored directory never schedule a rescan', async () => {
  const root = await fixture();
  let fired = null;
  const tree = new DirectoryTree(root, {
    debounceMs: 5,
    watchFn: (_dir, _opts, cb) => { fired = cb; return { close() {} }; },
  });
  try {
    await tree.start();
    let scans = 0;
    tree.refresh = async () => { scans++; return false; };

    fired('change', 'node_modules/left-pad/index.js');
    fired('change', '.git/index');
    await new Promise(r => { setTimeout(r, 60); });
    assert.equal(scans, 0, 'a vendor-directory write triggered a rescan');

    fired('change', 'src/index.js');
    await new Promise(r => { setTimeout(r, 60); });
    assert.equal(scans, 1, 'a real write did not trigger a rescan');
  } finally {
    tree.stop();
    await rm(root, { recursive: true, force: true });
  }
});


test('directories open and close on request, and nested state is dropped', async () => {
  const root = await fixture();
  await mkdir(join(root, 'src', 'inner'), { recursive: true });
  await writeFile(join(root, 'src', 'inner', 'deep.js'), '//');
  const tree = new DirectoryTree(root);
  try {
    await tree.start();
    assert.ok(!names(tree).includes(join('src', 'index.js')));

    await tree.expand('src');
    assert.ok(names(tree).includes(join('src', 'index.js')));
    assert.equal(tree.entries.find(e => e.path === 'src').open, true);

    await tree.expand(join('src', 'inner'));
    assert.ok(names(tree).includes(join('src', 'inner', 'deep.js')));

    await tree.collapse('src');
    assert.ok(!names(tree).includes(join('src', 'index.js')));
    // Reopening shows the level as it was left, not the deep tree that was
    // closed precisely to get rid of it.
    await tree.expand('src');
    assert.ok(names(tree).includes(join('src', 'inner')));
    assert.ok(!names(tree).includes(join('src', 'inner', 'deep.js')));
  } finally {
    tree.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('toggle flips a directory and ignores files', async () => {
  const root = await fixture();
  const tree = new DirectoryTree(root);
  try {
    await tree.start();
    assert.equal(await tree.toggle('src'), true);
    assert.ok(names(tree).includes(join('src', 'index.js')));
    assert.equal(await tree.toggle('src'), true);
    assert.ok(!names(tree).includes(join('src', 'index.js')));
    // A file has nothing to open.
    assert.equal(await tree.toggle('package.json'), false);
    assert.equal(await tree.toggle(''), false);
  } finally {
    tree.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a write inside a closed directory marks the fold', async () => {
  const root = await fixture();
  let fired = null;
  const tree = new DirectoryTree(root, {
    debounceMs: 5,
    watchFn: (_dir, _opts, cb) => { fired = cb; return { close() {} }; },
  });
  try {
    await tree.start();
    assert.equal(tree.entries.find(e => e.path === 'src').hiddenChangeAt, null);

    fired('rename', join('src', 'brand-new.js'));
    await tree.refresh();

    const src = tree.entries.find(e => e.path === 'src');
    assert.ok(src.hiddenChangeAt, 'a change under a closed directory went unmarked');
    assert.equal(tree.lastChange.kind, 'changed');
    assert.equal(tree.lastChange.path, join('src', 'brand-new.js'));
  } finally {
    tree.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('closing a directory keeps the scan off its contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ettore-tree-cost-'));
  try {
    await mkdir(join(root, 'big'), { recursive: true });
    for (let i = 0; i < 50; i++) await writeFile(join(root, 'big', `f${i}.txt`), 'x');
    const tree = new DirectoryTree(root);
    await tree.start();
    assert.equal(tree.entries.length, 1, 'a closed directory was walked anyway');
    await tree.expand('big');
    assert.equal(tree.entries.length, 51);
    await tree.collapse('big');
    assert.equal(tree.entries.length, 1);
    tree.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
