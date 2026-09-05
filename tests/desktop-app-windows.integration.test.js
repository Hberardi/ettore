// Live integration test for the Windows desktop backend.
//
// Run with:
//   node --test tests/desktop-app-windows.integration.test.js
//
// This test SKIPS automatically on non-Windows. On Windows it:
//   1. Starts the PowerShell host and pings it.
//   2. Spawns notepad.exe (it is shipped with every Windows install).
//   3. Waits for its window.
//   4. Takes a screenshot of the window to verify the host's screen
//      capture path actually produces a valid PNG.
//   5. Types a fixed string into the editor.
//   6. Reads the app's captured stdout/stderr to confirm logs work.
//   7. Closes notepad.
//
// It does NOT assert on the typed text (a remote desktop / focus race
// could flake the test). Instead it asserts the host can run end-to-end
// without throwing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as desktop from '../src/tools/desktop-app.js';

const isWin = process.platform === 'win32';

test('windows desktop backend: open notepad, list windows, screenshot, type, stop', { skip: !isWin }, async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'ettore-desktop-test-'));
  try {
    // Step 1: open notepad. We deliberately do NOT pass debug_port —
    // notepad is a plain Win32 EXE, not an Electron app.
    const app = await desktop.openApp({
      id: 'integration-notepad',
      command: 'notepad.exe',
      workdir,
    });
    assert.ok(app.pid, 'open should return a pid');
    assert.equal(app.running, true, 'app should be running after open');

    // The PowerShell host may or may not start in the same try block
    // (hostError is set instead of throwing). Either way the
    // subsequent calls should report a useful error if the host is
    // missing.
    if (app.hostError) {
      throw new Error(`host did not start: ${app.hostError}`);
    }

    // Step 2: wait for a window to appear. Notepad opens a window
    // titled "Senza titolo - Blocco note" in Italian Windows, or
    // "Untitled - Notepad" in English. We accept either.
    const win = await desktop.waitForWindow(app, { timeoutMs: 15000, title: 'pad' });
    assert.ok(win, 'waitForWindow should return a window');
    assert.ok(win.id, 'window should have an hWnd');
    assert.ok(win.width > 0 && win.height > 0, 'window should have non-zero size');

    // Step 3: screenshot. Verify the file exists and looks like a PNG.
    const shotPath = join(workdir, 'notepad.png');
    const shot = await desktop.captureWindow({ windowId: win.id, path: shotPath });
    assert.ok(existsSync(shot.path), 'screenshot file should exist');
    const size = statSync(shot.path).size;
    assert.ok(size > 1000, `screenshot should be >1KB, got ${size} bytes`);
    // PNG magic: 89 50 4E 47
    const fd = await import('node:fs/promises').then(m => m.open(shotPath, 'r'));
    const buf = Buffer.alloc(8);
    await fd.read(buf, 0, 8, 0);
    await fd.close();
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50);
    assert.equal(buf[2], 0x4E);
    assert.equal(buf[3], 0x47);

    // Step 4: focus + type. We send a known string; we do not assert
    // it landed in the document because focus / DPI scaling can race.
    await desktop.focusWindow(win.id);
    await desktop.typeText({ text: 'hello from ettore\r\n', windowId: win.id });

    // Step 5: logs should at least be readable.
    const logs = desktop.readLogs(app, { lines: 50 });
    assert.equal(typeof logs, 'string');

    // Step 6: stop.
    const stopped = await desktop.stopApp('integration-notepad');
    assert.equal(stopped, true);
    // After stop, the app is removed from the registry.
    assert.equal(desktop.getApp('integration-notepad'), null);
  } finally {
    try { await desktop.stopApp('integration-notepad'); } catch {}
    try { await rm(workdir, { recursive: true, force: true }); } catch {}
  }
});
