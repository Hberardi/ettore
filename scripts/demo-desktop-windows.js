// Live demo: open Notepad through the new Windows desktop backend,
// take a screenshot, type a known string, read the app's logs, and
// close the app. Run with:
//
//   node scripts/demo-desktop-windows.js
//
// On a real Windows desktop this should:
//   1. Print `host OK` and the host's pid
//   2. Open a Notepad window
//   3. Save a PNG screenshot to .ettore/demo-notepad.png
//   4. Type "ETTORE was here" into the document
//   5. Close Notepad

import * as desktop from '../src/tools/desktop-app.js';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

if (process.platform !== 'win32') {
  console.error('This demo is Windows-only. On Linux, use desktop-app.js with xdotool/wmctrl installed.');
  process.exit(1);
}

const workdir = '.ettore';
await mkdir(workdir, { recursive: true });

const log = (msg, extra) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`, extra ?? '');

try {
  log('opening notepad.exe');
  const app = await desktop.openApp({ id: 'demo-notepad', command: 'notepad.exe' });
  log('opened', { pid: app.pid, hostError: app.hostError ?? null });

  if (app.hostError) {
    log('host failed to start — PowerShell missing or blocked by execution policy?');
    log('fix: run "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy Bypass" in PowerShell, or install PowerShell 7+');
    await desktop.stopApp('demo-notepad');
    process.exit(2);
  }

  log('waiting for window');
  const win = await desktop.waitForWindow(app, { timeoutMs: 10000, title: 'pad' });
  log('window ready', { id: win.id, title: win.title, w: win.width, h: win.height });

  const shot = join(workdir, 'demo-notepad.png');
  log(`saving screenshot to ${shot}`);
  await desktop.captureWindow({ windowId: win.id, path: shot });
  log('screenshot saved');

  log('ASCII preview of the empty notepad:');
  const preview1 = await desktop.asciiPreview(shot, { width: 80, height: 16 });
  console.log(preview1.ascii);
  console.log('─'.repeat(80));

  log('focusing + typing');
  await desktop.focusWindow(win.id);
  const typeResult = await desktop.typeText({ text: 'ETTORE was here\r\n', windowId: win.id, record: true });
  log('typed', { length: typeResult.length, postShot: typeResult.screenshot });

  if (typeResult.screenshot) {
    log('ASCII preview after typing:');
    const preview2 = await desktop.asciiPreview(typeResult.screenshot, { width: 80, height: 16 });
    console.log(preview2.ascii);
    console.log('─'.repeat(80));
  }

  log('watching for 2 seconds at 400ms interval');
  const watchResult = await desktop.watch({ app, intervalMs: 400, durationMs: 2000 });
  log('captured', { frames: watchResult.frames.length, latest: watchResult.latest });

  log('reading logs');
  const logs = desktop.readLogs(app, { lines: 20 });
  log('logs', { length: logs.length, sample: logs.slice(0, 120) });

  await new Promise(r => setTimeout(r, 500));

  log('stopping');
  const stopped = await desktop.stopApp('demo-notepad');
  log('stopped', { ok: stopped });
  log('frames are in .ettore/watch/demo-notepad/ — open them in your image viewer to see what the agent saw');
} catch (error) {
  console.error('DEMO FAILED:', error.message);
  try { await desktop.stopApp('demo-notepad'); } catch {}
  process.exit(1);
}
