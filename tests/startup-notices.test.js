// Why an auto-update that fails looks like an auto-update that never ran.
//
// bin/cli.js explains every outcome — "auto-update skipped: …", "update check
// did not complete …", "npm installed X but you are running Y". All of it goes
// to the terminal before the TUI starts, and native-ui.js opens the alternate
// screen buffer (\x1b[?1049h) as its first act, which discards the primary
// buffer's contents. So in interactive mode the reason was written and then
// erased, every time, and the user saw a CLI that silently stayed behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = readFileSync(resolve(ROOT, 'bin/cli.js'), 'utf-8');
const ui = readFileSync(resolve(ROOT, 'src/app/native-ui.js'), 'utf-8');

test('the TUI still opens the alternate screen buffer, which is what erases them', () => {
  // If this ever stops being true the collection below is unnecessary, and
  // this test is where that gets noticed.
  assert.match(ui, /altScreen:\s*'\\x1b\[\?1049h'/);
  assert.match(ui, /ANSI\.altScreen \+ ANSI\.clear/);
});

test('every auto-update outcome is collected, not just printed', () => {
  // Each of these used to be a bare process.stderr.write.
  for (const fragment of [
    'auto-update: git pull failed',
    'auto-update skipped:',
    'update check did not complete',
    'but you are running',
  ]) {
    const idx = cli.indexOf(fragment);
    assert.ok(idx > 0, `missing notice: ${fragment}`);
    const before = cli.slice(Math.max(0, idx - 400), idx);
    assert.ok(
      /notify\(/.test(before),
      `"${fragment}" is written straight to the terminal, so the TUI will erase it`,
    );
  }
});

test('notify writes AND keeps a copy', () => {
  assert.match(cli, /const notify = \(text, stream = 'stderr'\) => \{/);
  assert.match(cli, /startupNotices\.push/);
  assert.match(cli, /process\[stream\]\.write\(text\)/,
    'a one-shot run has no TUI, so the terminal write must stay');
});

test('the copies are colour-free, since they are re-rendered elsewhere', () => {
  const fn = cli.slice(cli.indexOf('const notify ='), cli.indexOf('let updateStatus = null;'));
  assert.match(fn, /replace\(.*\\x1b/, 'ANSI escapes would be shown literally in the transcript');
});

test('the TUI is handed the notices and shows them', () => {
  assert.match(cli, /startupNotices,/, 'they must reach startApp through tuiOptions');
  assert.match(ui, /options\.startupNotices \|\| \[\]/);
  assert.match(ui, /role: 'system', text: `⚠ \$\{notice\}`/);
});

test('nothing is shown when the update had nothing to report', () => {
  // The common case is a silent success; an empty list must not push a blank
  // system line into every session.
  assert.match(ui, /if \(!notice\) continue;/);
});
