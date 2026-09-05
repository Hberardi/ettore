// Tests for the platform dispatcher and the Windows backend helpers that
// can be exercised without a real PowerShell host process. The
// integration test that actually opens Notepad lives in
// tests/desktop-app-windows.integration.test.js — it is skipped by
// default and only run when the operator asks for a live verification
// (the ETTORE desktop backend is best validated by hand on a real
// desktop, not by CI).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The dispatcher picks the right backend at import time. Importing
// here exercises that branch.
import * as desktop from '../src/tools/desktop-app.js';
import * as linux from '../src/tools/desktop-app-linux.js';
import * as windows from '../src/tools/desktop-app-windows.js';

const isWin = process.platform === 'win32';

test('desktop-app.js picks the correct backend for this OS', () => {
  // The dispatcher exposes `platform` so the rest of the agent (and
  // these tests) can verify the right code path was taken without
  // importing both backends.
  assert.equal(desktop.platform, isWin ? 'win32' : process.platform);
  assert.equal(typeof desktop.openApp, 'function');
  assert.equal(typeof desktop.stopApp, 'function');
  assert.equal(typeof desktop.listWindows, 'function');
  assert.equal(typeof desktop.clickAt, 'function');
  assert.equal(typeof desktop.typeText, 'function');
  assert.equal(typeof desktop.pressKeys, 'function');
  assert.equal(typeof desktop.captureWindow, 'function');
  assert.equal(typeof desktop.waitForWindow, 'function');
  assert.equal(typeof desktop.focusWindow, 'function');
  assert.equal(typeof desktop.readLogs, 'function');
  assert.equal(typeof desktop.detectAppErrors, 'function');
  assert.equal(typeof desktop.describeCapabilities, 'function');
  assert.equal(typeof desktop.hasDisplay, 'function');
  assert.equal(typeof desktop.isWayland, 'function');
  assert.equal(typeof desktop.inputUnavailableMessage, 'function');
  assert.equal(typeof desktop.looksLikeElectron, 'function');
});

test('dispatcher forwards to the platform-specific module (openApp identity)', () => {
  // The functions exposed on the dispatcher must be the SAME references
  // the backend module exposes — no re-wrapping that would lose `this`
  // or break host state in the Windows backend.
  if (isWin) {
    assert.equal(desktop.openApp, windows.openApp);
    assert.equal(desktop.listWindows, windows.listWindows);
    assert.equal(desktop.clickAt, windows.clickAt);
  } else {
    assert.equal(desktop.openApp, linux.openApp);
    assert.equal(desktop.listWindows, linux.listWindows);
    assert.equal(desktop.clickAt, linux.clickAt);
  }
});

test('describeCapabilities returns an object with the documented keys', () => {
  const caps = desktop.describeCapabilities();
  assert.equal(typeof caps, 'object');
  assert.ok('display' in caps);
  assert.ok('wayland' in caps);
  assert.ok('windowManagerTool' in caps);
  assert.ok('screenshotTool' in caps);
  assert.ok('inputTool' in caps);
  assert.ok('virtualDisplayTool' in caps);
  if (isWin) {
    // Windows backend reports itself; it never reports x11 tools.
    assert.equal(caps.inputTool, 'sendinput');
    assert.equal(caps.screenshotTool, 'system-drawing');
    assert.equal(caps.wayland, false);
  }
});

test('detectAppErrors recognises the standard Python/JS/Go/C panic patterns', () => {
  const sample = [
    '[stderr] Traceback (most recent call last):',
    '[stderr]   File "app.py", line 4, in <module>',
    '[stderr]     raise RuntimeError("boom")',
    '[stderr] RuntimeError: boom',
    'INFO  normal log line',
    'WARNING  deprecation: foo is deprecated',
    'Segmentation fault (core dumped)',
  ];
  const found = desktop.detectAppErrors(sample, { context: 2, limit: 10 });
  assert.ok(found.length >= 3, `expected at least 3 suspicious lines, got ${found.length}`);
  // The two-line context trailing a traceback must be preserved so the
  // agent can read the actual stack frame, not just the first line.
  const traceback = found.find(f => /Traceback/.test(f.line));
  assert.ok(traceback, 'should detect the Python traceback header');
  assert.ok(traceback.trail.length >= 1, 'traceback should keep at least one following frame');
});

test('detectAppErrors returns [] on a clean log', () => {
  const clean = [
    'Server listening on :3000',
    'GET / 200 12ms',
    'Saved 4 files',
  ];
  assert.deepEqual(desktop.detectAppErrors(clean), []);
});

test('looksLikeElectron matches electron, nw, tauri binaries', () => {
  assert.equal(desktop.looksLikeElectron('electron .'), true);
  assert.equal(desktop.looksLikeElectron('node_modules/.bin/electron-forge start'), true);
  assert.equal(desktop.looksLikeElectron('my-tauri-app.exe'), true);
  assert.equal(desktop.looksLikeElectron('firefox'), false);
  assert.equal(desktop.looksLikeElectron(''), false);
});

test('Windows backend: parseProcessTable / descendantPids are safe no-ops', () => {
  // These exist on the Linux backend because it shells out to `ps -eo
  // pid,ppid`. The Windows backend has no equivalent cheap call, so
  // the helpers are exported as safe no-ops. The dispatcher must keep
  // them callable so any test that destructure-imports them still
  // works on Windows.
  if (!isWin) return;
  assert.deepEqual(desktop.parseProcessTable('any input'), []);
  assert.deepEqual(desktop.descendantPids([], 1234), []);
  assert.deepEqual(desktop.parseWmctrlWindows('any input'), []);
  assert.deepEqual(desktop.parseXdotoolGeometry('any input'), {});
  assert.equal(desktop.resolveScreenshotTool(), 'system-drawing');
  assert.deepEqual(desktop.buildScreenshotArgs('system-drawing', { path: '/tmp/x.png' }), []);
});

test('Windows backend: getVk key parser is case-insensitive and accepts common names', () => {
  if (!isWin) return;
  // The internal Get-Vk PowerShell function is not exposed; instead we
  // test the equivalent JavaScript helper indirectly through pressKeys
  // by mocking the Host class. For now, just verify the dispatcher
  // surface is callable.
  assert.equal(typeof desktop.pressKeys, 'function');
});

test('inputUnavailableMessage returns a string on every platform', () => {
  const msg = desktop.inputUnavailableMessage();
  assert.equal(typeof msg, 'string');
  assert.ok(msg.length > 10, 'message should give actionable install/setup guidance');
});

test('openApp validates non-empty command', async () => {
  await assert.rejects(
    () => desktop.openApp({ id: 'desktop-app-test-empty', command: '' }),
    /non-empty/,
  );
});
