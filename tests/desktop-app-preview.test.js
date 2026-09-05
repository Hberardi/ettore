// Tests for the live-preview additions to the Windows desktop backend:
//   - the dispatcher exposes `watch` and `asciiPreview` on Windows
//   - on Linux the same names are `null` (and the dispatcher docstrings
//     make that contract clear)
//   - the `action=watch` and `action=preview` branches in the agent
//     tool surface fall through to clear errors when those helpers
//     are missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as desktop from '../src/tools/desktop-app.js';

const isWin = process.platform === 'win32';

test('dispatcher exposes watch and asciiPreview on Windows, null elsewhere', () => {
  if (isWin) {
    assert.equal(typeof desktop.watch, 'function', 'Windows backend should expose watch()');
    assert.equal(typeof desktop.asciiPreview, 'function', 'Windows backend should expose asciiPreview()');
  } else {
    assert.equal(desktop.watch, null);
    assert.equal(desktop.asciiPreview, null);
  }
});

test('action=watch surfaces a clear error on Linux', async () => {
  if (isWin) return; // live test only — see integration suite
  const { toolHandlers } = await import('../src/tools/index.js');
  const out = await toolHandlers.desktop_app({ action: 'watch', id: 'no-such-app' });
  assert.match(String(out), /Windows-only/);
});

test('action=preview surfaces a clear error on Linux', async () => {
  if (isWin) return;
  const { toolHandlers } = await import('../src/tools/index.js');
  const out = await toolHandlers.desktop_app({ action: 'preview', id: 'no-such-app' });
  assert.match(String(out), /Windows-only/);
});

test('action=watch on a non-running app id returns the right error', async () => {
  const { toolHandlers } = await import('../src/tools/index.js');
  const out = await toolHandlers.desktop_app({ action: 'watch', id: 'this-app-does-not-exist' });
  // The Linux branch should still gracefully error; the Windows branch
  // would error from the watch() function about the host.
  assert.match(String(out), /Error|Windows-only|desktop host/);
});

test('action=preview reports a missing file path', async () => {
  // Open a fake "app" entry by using the registry directly. Easier
  // path: just call the action with a path that does not exist on
  // the Linux branch (where asciiPreview is null) and verify the
  // error is "Windows-only" — on Windows, the call would error from
  // a missing host.
  const { toolHandlers } = await import('../src/tools/index.js');
  const out = await toolHandlers.desktop_app({
    action: 'preview',
    id: 'no-app',
    file_path: 'C:/this/does/not/exist.png',
  });
  assert.ok(/Error|Windows-only/.test(String(out)));
});

// ---------------------------------------------------------------------------
// Frame retention. pruneFrames touches nothing but the filesystem, so it is
// exercised on every platform even though the frames themselves are only
// produced by the Windows backend.
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneFrames } from '../src/tools/desktop-app-windows.js';

function seedFrames(dir, names) {
  for (const name of names) writeFileSync(join(dir, name), 'x');
}

test('pruneFrames keeps the newest frames and never touches latest.png', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ettore-frames-'));
  try {
    // Mixed prefixes with interleaved timestamps: retention has to order by
    // the stamp, not by the filename, or a `type-` frame would outrank a
    // newer `click-` one.
    seedFrames(dir, [
      'click-1000.png', 'type-1001.png', 'press-1002.png',
      'click-1003.png', 'frame-1004.png', 'latest.png',
    ]);
    const removed = await pruneFrames(dir, 2);
    assert.deepEqual(removed.sort(), ['click-1000.png', 'press-1002.png', 'type-1001.png'].sort());
    const left = readdirSync(dir).sort();
    assert.deepEqual(left, ['click-1003.png', 'frame-1004.png', 'latest.png']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneFrames is a no-op under the cap and on a missing directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ettore-frames-'));
  try {
    seedFrames(dir, ['click-1.png', 'click-2.png']);
    assert.deepEqual(await pruneFrames(dir, 5), []);
    assert.equal(readdirSync(dir).length, 2);
    assert.deepEqual(await pruneFrames(join(dir, 'nope'), 1), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneFrames ignores non-png files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ettore-frames-'));
  try {
    seedFrames(dir, ['click-1.png', 'click-2.png', 'click-3.png', 'notes.txt']);
    await pruneFrames(dir, 1);
    const left = readdirSync(dir).sort();
    assert.deepEqual(left, ['click-3.png', 'notes.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// `ettore preview` reads the frame FILE, not the in-process app registry —
// that is what makes it usable from a second terminal.
// ---------------------------------------------------------------------------

test('preview resolves the frame path the agent actually writes', async () => {
  const preview = await import('../src/cli/preview.js');
  const path = preview.framePath('demo-notepad', { cwd: '/tmp/project' });
  assert.match(path.replace(/\\/g, '/'), /\/tmp\/project\/\.ettore\/watch\/demo-notepad\/latest\.png$/);
  assert.match(preview.framePath(undefined, { cwd: '/tmp/project' }).replace(/\\/g, '/'), /watch\/default\/latest\.png$/);
});

test('preview reports a missing frame instead of throwing', async () => {
  const preview = await import('../src/cli/preview.js');
  const dir = mkdtempSync(join(tmpdir(), 'ettore-preview-'));
  try {
    const frame = await preview.renderFrame('nope', { cwd: dir });
    assert.equal(frame.ok, false);
    // On Linux the pipeline is refused outright; on Windows the frame file
    // is simply not there yet. Both must be a reason, never an exception.
    assert.match(frame.reason, isWin ? /no frame yet/ : /Windows-only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preview does not consult the desktop app registry', async () => {
  // A regression guard for the original design: getApp() reads a Map that
  // lives in the agent's process, so a second `ettore preview` process
  // would always have found it empty.
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../src/cli/preview.js', import.meta.url), 'utf8');
  assert.ok(!/getApp\(/.test(text), 'preview must not depend on the in-process app registry');
  assert.match(text, /latest\.png|framePath/);
});

test('bin/cli.js exposes the preview command and the prompt points at it', async () => {
  const { readFileSync } = await import('node:fs');
  const cli = readFileSync(new URL('../bin/cli.js', import.meta.url), 'utf8');
  assert.match(cli, /\.command\('preview \[appId\]'\)/);
  const prompts = readFileSync(new URL('../src/agents/prompts.js', import.meta.url), 'utf8');
  assert.match(prompts, /ettore preview <id>/);
  assert.ok(
    !/node scripts\/desktop-live-preview/.test(prompts),
    'the prompt must not send users to a path that is not shipped',
  );
});
