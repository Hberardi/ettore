// Live ASCII preview of what the agent is doing on the desktop.
//
// The agent process writes a frame after every click/type/press to
// `.ettore/watch/<id>/latest.png`. This module reads THAT FILE and renders
// it, which is the only design that works from a second terminal: the
// desktop backend's app registry lives in the agent's process memory, so a
// separate `ettore preview` process would always find it empty. The PNG →
// ASCII conversion goes through a PowerShell host of its own (see
// `asciiPreview` in desktop-app-windows.js), which needs no app session.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as desktop from '../tools/desktop-app.js';

export const DEFAULT_WIDTH = 80;
export const DEFAULT_HEIGHT = 24;

export function framePath(appId = 'default', { cwd = process.cwd() } = {}) {
  return resolve(cwd, '.ettore', 'watch', String(appId || 'default'), 'latest.png');
}

// Render one frame. Returns { ok, ascii?, reason? } instead of throwing:
// the live loop must survive a frame that is being written while we read
// it, which on Windows is a genuinely common race.
export async function renderFrame(appId = 'default', {
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  invert = false,
  cwd = process.cwd(),
} = {}) {
  if (typeof desktop.asciiPreview !== 'function') {
    return { ok: false, reason: 'the ASCII preview pipeline is Windows-only (it needs the PowerShell desktop host).' };
  }
  const path = framePath(appId, { cwd });
  if (!existsSync(path)) {
    return { ok: false, reason: `no frame yet at ${path} — the agent writes one after its first click/type/press on this app.` };
  }
  try {
    const frame = await desktop.asciiPreview(path, { width, height, invert });
    return { ok: true, ascii: frame.ascii, width: frame.width, height: frame.height, path };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// Redraw in place: clear + home. Understood by Windows Terminal, ConEmu,
// the VS Code terminal and every xterm-alike.
export function drawFrame({ appId, ascii, frameNumber, width = DEFAULT_WIDTH, out = process.stdout }) {
  out.write('\x1b[2J\x1b[H');
  out.write(`─── ETTORE live preview: ${appId}  frame #${frameNumber}  ${new Date().toISOString().slice(11, 19)} ───\n`);
  out.write(`${ascii}\n`);
  out.write(`${'─'.repeat(Math.max(8, width))}\n`);
  out.write('Ctrl-C to stop.\n');
}

// Poll the frame file until the caller stops us. `maxFrames` exists so
// tests (and `--once`) can run the same loop without a signal.
export async function livePreview(appId = 'default', {
  intervalMs = 400,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  invert = false,
  cwd = process.cwd(),
  maxFrames = Infinity,
  out = process.stdout,
  signal = null,
} = {}) {
  let frameNumber = 0;
  let lastReason = null;
  while (frameNumber < maxFrames && !signal?.aborted) {
    const frame = await renderFrame(appId, { width, height, invert, cwd });
    if (frame.ok) {
      frameNumber++;
      drawFrame({ appId, ascii: frame.ascii, frameNumber, width, out });
    } else if (frame.reason !== lastReason) {
      // Print a changed reason once instead of once per tick: "no frame
      // yet" while the agent is still starting up would otherwise scroll
      // the terminal forever.
      lastReason = frame.reason;
      out.write(`[preview] ${frame.reason}\n`);
    }
    if (frameNumber >= maxFrames || signal?.aborted) break;
    await new Promise((done) => { setTimeout(done, Math.max(100, intervalMs)); });
  }
  return { frames: frameNumber };
}

export function watchDir(appId = 'default', { cwd = process.cwd() } = {}) {
  return resolve(cwd, join('.ettore', 'watch', String(appId || 'default')));
}
