// The bundled git-history plugin, exercised against a repository built for
// the test rather than against this one — the assertions have to hold on any
// history, not on the one that happens to be checked out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tools, commands } from '../examples/plugins/git-history/index.js';

const run = (cwd, ...args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  },
});

/** A repo with three commits, the last touching only some lines of a file. */
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-githist-'));
  run(dir, 'init', '-q', '-b', 'main');
  await writeFile(join(dir, 'app.js'), 'one\ntwo\nthree\n');
  run(dir, 'add', '-A');
  run(dir, 'commit', '-q', '-m', 'Add app');

  await writeFile(join(dir, 'other.js'), 'unrelated\n');
  run(dir, 'add', '-A');
  run(dir, 'commit', '-q', '-m', 'Add something else entirely');

  await writeFile(join(dir, 'app.js'), 'one\nTWO changed\nthree\n');
  run(dir, 'add', '-A');
  run(dir, 'commit', '-q', '-m', 'Change the middle line');
  return dir;
}

const ctx = (dir) => ({ workspace: dir, signal: null });

// ── git_log ──────────────────────────────────────────────────────────────────

test('git_log returns structured commits, newest first', async () => {
  const dir = await repo();
  try {
    const out = await tools.git_log.handler({}, ctx(dir));
    assert.equal(out.count, 3);
    assert.equal(out.commits[0].subject, 'Change the middle line');
    assert.equal(out.commits[2].subject, 'Add app');
    assert.equal(out.commits[0].author, 'Test Author');
    assert.match(out.commits[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(out.commits[0].sha, /^[0-9a-f]{7,}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a path scopes the log to commits that touched it', async () => {
  const dir = await repo();
  try {
    const out = await tools.git_log.handler({ path: 'app.js' }, ctx(dir));
    assert.equal(out.count, 2, JSON.stringify(out.commits));
    assert.ok(!out.commits.some(c => c.subject.includes('something else')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a subject containing the field separator would still parse', async () => {
  // The separator is a control byte git substitutes itself, so no subject a
  // human can type collides with it. This is the assertion that keeps someone
  // from "simplifying" it back to a pipe or a comma.
  const dir = await repo();
  try {
    await writeFile(join(dir, 'app.js'), 'one\ntwo\nthree\nfour\n');
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '-m', 'Subject with | pipes, commas and\ttabs');
    const out = await tools.git_log.handler({ limit: 1 }, ctx(dir));
    assert.equal(out.commits[0].subject, 'Subject with | pipes, commas and\ttabs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('log filters compose, and an empty result explains itself', async () => {
  const dir = await repo();
  try {
    const hit = await tools.git_log.handler({ grep: 'middle' }, ctx(dir));
    assert.equal(hit.count, 1);
    const miss = await tools.git_log.handler({ grep: 'nothing matches this' }, ctx(dir));
    assert.equal(typeof miss, 'string');
    assert.match(miss, /No commits match/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the commit count is bounded however large a limit is asked for', async () => {
  const dir = await repo();
  try {
    const out = await tools.git_log.handler({ limit: 999_999 }, ctx(dir));
    assert.equal(out.count, 3);
    const one = await tools.git_log.handler({ limit: 1 }, ctx(dir));
    assert.equal(one.count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── git_blame ────────────────────────────────────────────────────────────────

test('blame groups consecutive lines from one commit', async () => {
  const dir = await repo();
  try {
    const out = await tools.git_blame.handler({ file: 'app.js' }, ctx(dir));
    // Lines 1 and 3 are original, line 2 was changed later: three groups, not
    // three identical rows per line.
    assert.equal(out.changes.length, 3, JSON.stringify(out.changes));
    assert.equal(out.changes[0].lines, '1');
    assert.equal(out.changes[1].lines, '2');
    assert.equal(out.changes[1].summary, 'Change the middle line');
    assert.equal(out.changes[0].summary, 'Add app');
    assert.equal(out.changes[2].summary, 'Add app');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('blame honours a line range', async () => {
  const dir = await repo();
  try {
    const out = await tools.git_blame.handler({ file: 'app.js', start_line: 2, end_line: 2 }, ctx(dir));
    assert.equal(out.changes.length, 1);
    assert.equal(out.changes[0].lines, '2');
    assert.equal(out.range, '2-2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── git_show ─────────────────────────────────────────────────────────────────

test('git_show reports the message, the files, and the diff on request', async () => {
  const dir = await repo();
  try {
    const bare = await tools.git_show.handler({ ref: 'HEAD' }, ctx(dir));
    assert.equal(bare.subject, 'Change the middle line');
    assert.match(bare.author, /Test Author <test@example\.com>/);
    assert.ok(bare.files.some(f => f.includes('app.js')), JSON.stringify(bare.files));
    assert.equal(bare.diff, undefined, 'the patch is opt-in');

    const withDiff = await tools.git_show.handler({ ref: 'HEAD', diff: true }, ctx(dir));
    assert.match(withDiff.diff, /TWO changed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Refusals and failures ────────────────────────────────────────────────────

test('a path outside the workspace is refused by us, not left to git', async () => {
  const dir = await repo();
  try {
    for (const bad of ['../../etc/passwd', '/etc/passwd']) {
      await assert.rejects(
        () => tools.git_log.handler({ path: bad }, ctx(dir)),
        /outside the workspace/,
        `accepted ${bad}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git's own error is passed through, since it says what to do next", async () => {
  const dir = await repo();
  try {
    await assert.rejects(
      () => tools.git_show.handler({ ref: 'no-such-ref-anywhere' }, ctx(dir)),
      (err) => {
        // Not a generic wrapper: the message has to name the ref.
        assert.match(err.message, /no-such-ref-anywhere/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a directory that is not a repository fails clearly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-nogit-'));
  try {
    await assert.rejects(() => tools.git_log.handler({}, ctx(dir)), /git/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Manifest and shape ───────────────────────────────────────────────────────

test('the manifest matches what the module exports', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../examples/plugins/git-history/plugin.json', import.meta.url), 'utf8'),
  );
  assert.equal(manifest.name, 'git-history');
  assert.equal(manifest.apiVersion, '1');
  assert.equal(manifest.main, 'index.js');
  // Declared permissions must describe what it actually does: it reads files
  // and runs git, and it writes nothing.
  assert.deepEqual([...manifest.permissions].sort(), ['fs:read', 'shell:exec']);
});

test('every tool declares a schema the model can be held to', async () => {
  for (const [name, def] of Object.entries(tools)) {
    assert.ok(def.description?.length > 40, `${name} needs a description worth reading`);
    assert.equal(def.parameters.type, 'object', name);
    assert.equal(def.parameters.additionalProperties, false, `${name} must reject unknown arguments`);
    assert.equal(typeof def.handler, 'function', name);
  }
  assert.deepEqual(Object.keys(tools).sort(), ['git_blame', 'git_log', 'git_show']);
  assert.deepEqual(Object.keys(commands), ['history']);
});

test('the slash command renders one line per commit', async () => {
  const dir = await repo();
  try {
    const out = await commands.history.handler('app.js', ctx(dir));
    const lines = out.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /Change the middle line$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Reaching a user at all ───────────────────────────────────────────────────

test('the plugin ships in the published package', async () => {
  // `files` decides what npm puts on a user's disk. A bundled plugin that is
  // not listed there exists only for people who clone the repository.
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(
    pkg.files.includes('examples/plugins'),
    `bundled plugins are not published: files = ${JSON.stringify(pkg.files)}`,
  );
});

test('bundled plugins are discoverable by name', async () => {
  const { listBundledPlugins } = await import('../src/plugins/loader.js');
  const names = (await listBundledPlugins()).map(p => p.name);
  assert.ok(names.includes('git-history'), names.join(','));
  const entry = (await listBundledPlugins()).find(p => p.name === 'git-history');
  assert.ok(entry.description.length > 20, 'a bundled plugin needs a description to be offered by');
  assert.equal(entry.version, '1.0.0');
});

test('installing copies the plugin where the runtime will find it', async () => {
  const { installBundledPlugin, discoverPlugins } = await import('../src/plugins/loader.js');
  const dir = await mkdtemp(join(tmpdir(), 'ettore-plugdir-'));
  try {
    const installed = await installBundledPlugin('git-history', { pluginsDir: dir });
    assert.equal(installed.name, 'git-history');
    const found = await discoverPlugins(dir);
    assert.deepEqual(found.map(f => f.name), ['git-history']);
    // The whole plugin, not just its manifest.
    await readFile(join(dir, 'git-history', 'index.js'), 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installing over an existing copy needs saying so', async () => {
  const { installBundledPlugin } = await import('../src/plugins/loader.js');
  const dir = await mkdtemp(join(tmpdir(), 'ettore-plugdir-'));
  try {
    await installBundledPlugin('git-history', { pluginsDir: dir });
    // An installed plugin may have been edited; replacing it silently is worse
    // than making the user ask.
    await assert.rejects(
      () => installBundledPlugin('git-history', { pluginsDir: dir }),
      /already installed/,
    );
    const forced = await installBundledPlugin('git-history', { pluginsDir: dir, force: true });
    assert.equal(forced.name, 'git-history');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown name is refused, and lists what there is', async () => {
  const { installBundledPlugin } = await import('../src/plugins/loader.js');
  const dir = await mkdtemp(join(tmpdir(), 'ettore-plugdir-'));
  try {
    await assert.rejects(
      () => installBundledPlugin('nothing-like-this', { pluginsDir: dir }),
      /no bundled plugin named .* Bundled: .*git-history/s,
    );
    // A name that could escape the directory is refused before any filesystem
    // work happens.
    await assert.rejects(() => installBundledPlugin('../../etc', { pluginsDir: dir }), /not a valid plugin name/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
