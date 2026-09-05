// Linux / X11 backend for desktop_app.
//
// Original implementation that drove GUI apps through xdotool, wmctrl
// and Xvfb. Kept as a sibling of desktop-app-windows.js so that
// desktop-app.js can dispatch on process.platform without forking
// history. Behaviour, exports and signatures are identical to the
// Windows module so the rest of ETTORE (src/tools/index.js,
// src/agents/tool-router.js) does not have to care which backend is
// active.
//
// If you are reading this on Windows you are looking at the wrong file:
// src/tools/desktop-app.js picks desktop-app-windows.js for you.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, isAbsolute, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const LOG_LIMIT = 2000;
const apps = new Map();
let virtualDisplay = null;

const delay = (ms) => new Promise(done => { setTimeout(done, ms); });

function which(binary, exists = existsSync) {
  const dirs = String(process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of dirs) {
    const candidate = resolve(dir, binary);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function hasDisplay(env = process.env) {
  return Boolean(String(env.DISPLAY || '').trim() || String(env.WAYLAND_DISPLAY || '').trim());
}

export function isWayland(env = process.env) {
  return !String(env.DISPLAY || '').trim() && Boolean(String(env.WAYLAND_DISPLAY || '').trim());
}

// `wmctrl -lpG` prints: id desktop pid x y w h host title
export function parseWmctrlWindows(stdout = '') {
  const rows = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/i);
    if (!match) continue;
    rows.push({
      id: match[1],
      desktop: Number(match[2]),
      pid: Number(match[3]),
      x: Number(match[4]),
      y: Number(match[5]),
      width: Number(match[6]),
      height: Number(match[7]),
      host: match[8],
      title: match[9].trim(),
    });
  }
  return rows;
}

export function parseProcessTable(stdout = '') {
  const rows = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]) });
  }
  return rows;
}

// A GUI app is usually a grandchild of the command we spawned (`bash -lc npm
// start` → node → electron), so window ownership has to be matched against the
// whole subtree.
export function descendantPids(rows = [], rootPid) {
  const root = Number(rootPid);
  if (!Number.isInteger(root)) return [];
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const out = [root];
  const queue = [root];
  const seen = new Set(out);
  while (queue.length) {
    for (const child of children.get(queue.shift()) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

const ERROR_RE = /(traceback \(most recent call last\)|segmentation fault|core dumped|\bfatal\b|\bcritical\b|\bpanic:|unhandled (?:exception|rejection)|uncaught \w*error|\b\w*(?:Error|Exception)\b\s*[:(]|^\s*at .+:\d+:\d+\)?$|assertion .*failed|cannot find module|modulenotfounderror|command not found|permission denied|address already in use)/i;
const WARN_RE = /\b(warn|warning|deprecat)\w*\b/i;

// Pull the lines that matter out of a noisy app log, keeping a couple of
// following lines so a stack trace stays readable.
export function detectAppErrors(lines = [], { context = 3, limit = 40 } = {}) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] ?? '');
    if (!line.trim()) continue;
    const isError = ERROR_RE.test(line);
    const isWarn = !isError && WARN_RE.test(line);
    if (!isError && !isWarn) continue;
    const trail = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 1 + context); j++) {
      const raw = String(lines[j] ?? '');
      // Captured stderr lines carry a "[stderr] " marker; the indentation that
      // identifies a stack frame sits after it.
      const next = raw.replace(/^\[stderr\]\s?/, '');
      if (/^\s+(at\s|File\s|\.\.\.)/.test(next) || (isError && next.trim() && /^\s/.test(next))) trail.push(raw);
      else break;
    }
    found.push({ index: i, level: isError ? 'error' : 'warning', line, trail });
    if (found.length >= limit) break;
  }
  return found;
}

export function looksLikeElectron(command = '') {
  return /\belectron\b|\bnw\b|\btauri\b/i.test(String(command));
}

export function resolveScreenshotTool(exists = existsSync) {
  for (const tool of ['import', 'gnome-screenshot', 'spectacle', 'grim', 'scrot']) {
    if (which(tool, exists)) return tool;
  }
  return null;
}

export function buildScreenshotArgs(tool, { windowId = null, path } = {}) {
  if (tool === 'import') return ['-silent', '-window', windowId || 'root', path];
  if (tool === 'scrot') return windowId ? ['-u', '-o', path] : ['-o', path];
  if (tool === 'gnome-screenshot') return windowId ? ['-w', '-f', path] : ['-f', path];
  if (tool === 'spectacle') return windowId ? ['-a', '-b', '-n', '-o', path] : ['-f', '-b', '-n', '-o', path];
  if (tool === 'grim') return [path];
  return [path];
}

function inputBackend(exists = existsSync) {
  if (which('xdotool', exists)) return { name: 'xdotool', bin: 'xdotool' };
  if (isWayland() && which('ydotool', exists)) return { name: 'ydotool', bin: 'ydotool' };
  return null;
}

export function inputUnavailableMessage() {
  return isWayland()
    ? 'no input tool available: install ydotool (`sudo apt install ydotool`) — note that Wayland also needs the ydotoold daemon running. Under X11 xdotool is the reliable option.'
    : 'no input tool available: install xdotool (`sudo apt install xdotool`) to let the agent click and type in desktop apps.';
}

export function describeCapabilities(exists = existsSync) {
  const input = inputBackend(exists);
  return {
    display: hasDisplay() ? (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) : null,
    wayland: isWayland(),
    windowManagerTool: which('wmctrl', exists) ? 'wmctrl' : (which('xdotool', exists) ? 'xdotool' : null),
    screenshotTool: resolveScreenshotTool(exists),
    inputTool: input?.name || null,
    virtualDisplayTool: which('Xvfb', exists) ? 'Xvfb' : null,
  };
}

async function startVirtualDisplay(displayNum = 99) {
  if (virtualDisplay?.proc && virtualDisplay.proc.exitCode === null) return virtualDisplay.display;
  if (!which('Xvfb')) {
    throw new Error('no DISPLAY available and Xvfb is not installed (`sudo apt install xvfb`)');
  }
  const display = `:${displayNum}`;
  const proc = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  proc.unref();
  virtualDisplay = { proc, display };
  await delay(700);
  if (proc.exitCode !== null) {
    virtualDisplay = null;
    throw new Error(`Xvfb failed to start on ${display}`);
  }
  return display;
}

export function listApps() {
  return [...apps.values()].map(app => ({
    id: app.id,
    command: app.command,
    pid: app.pid,
    running: app.running,
    exitCode: app.exitCode,
    display: app.display,
    workdir: app.workdir,
    startedAt: new Date(app.startedAt).toISOString(),
    logLines: app.logs.length,
    debugPort: app.debugPort,
  }));
}

export function getApp(id = 'default') {
  return apps.get(String(id || 'default')) || null;
}

export async function openApp({
  id = 'default',
  command,
  workdir = process.cwd(),
  env = {},
  virtual_display = null,
  debug_port = null,
} = {}) {
  const key = String(id || 'default');
  if (apps.get(key)?.running) {
    throw new Error(`desktop app "${key}" is already running (pid ${apps.get(key).pid}) — stop it or use another id`);
  }
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('open requires a non-empty "command"');

  let display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '';
  const wantVirtual = virtual_display === null ? !hasDisplay() : Boolean(virtual_display);
  if (wantVirtual) display = await startVirtualDisplay();

  const childEnv = { ...process.env, ...env };
  if (display) childEnv.DISPLAY = display;
  // Electron/Chromium apps expose their renderer console over CDP; when the
  // caller asks for a debug port, pass it through so browser_app can attach.
  const port = Number(debug_port) || null;
  const fullCommand = port && !/--remote-debugging-port/.test(cmd)
    ? `${cmd} --remote-debugging-port=${port}`
    : cmd;

  const proc = spawn('bash', ['-lc', fullCommand], {
    cwd: workdir || process.cwd(),
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const app = {
    id: key,
    command: fullCommand,
    pid: proc.pid,
    proc,
    running: true,
    exitCode: null,
    workdir: workdir || process.cwd(),
    display,
    debugPort: port,
    startedAt: Date.now(),
    logs: [],
  };
  const push = (stream) => (buf) => {
    for (const line of String(buf || '').split(/\r?\n/)) {
      if (!line) continue;
      app.logs.push(stream === 'stderr' ? `[stderr] ${line}` : line);
      if (app.logs.length > LOG_LIMIT) app.logs.splice(0, app.logs.length - LOG_LIMIT);
    }
  };
  proc.stdout?.on('data', push('stdout'));
  proc.stderr?.on('data', push('stderr'));
  proc.on('exit', (code) => {
    app.running = false;
    app.exitCode = Number.isInteger(code) ? code : null;
  });
  apps.set(key, app);
  return app;
}

export async function stopApp(id = 'default') {
  const app = apps.get(String(id || 'default'));
  if (!app) return false;
  apps.delete(app.id);
  try {
    if (app.pid) process.kill(-app.pid, 'SIGTERM');
    else app.proc.kill('SIGTERM');
  } catch {
    try { app.proc.kill('SIGTERM'); } catch {}
  }
  await delay(300);
  try {
    if (app.proc.exitCode === null && app.pid) process.kill(-app.pid, 'SIGKILL');
  } catch {}
  app.running = false;
  return true;
}

export async function stopAllApps() {
  for (const id of [...apps.keys()]) await stopApp(id);
  if (virtualDisplay?.proc) {
    try { virtualDisplay.proc.kill('SIGTERM'); } catch {}
    virtualDisplay = null;
  }
}

export function readLogs(app, { lines = 200, onlyErrors = false } = {}) {
  const max = Math.max(1, Math.min(Number(lines) || 200, LOG_LIMIT));
  if (!app.logs.length) {
    return app.running
      ? '(no output yet — the app may be running silently)'
      : `(no output; process exited with code ${app.exitCode ?? 'n/a'})`;
  }
  if (onlyErrors) {
    const found = detectAppErrors(app.logs);
    if (!found.length) return `no error pattern in ${app.logs.length} log line(s)`;
    return found
      .map(entry => [`[${entry.level}] line ${entry.index + 1}: ${entry.line}`, ...entry.trail].join('\n'))
      .join('\n');
  }
  return app.logs.slice(Math.max(0, app.logs.length - max)).join('\n');
}

async function processRows() {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid='], { maxBuffer: 8 * 1024 * 1024 });
    return parseProcessTable(stdout);
  } catch {
    return [];
  }
}

// `xdotool getwindowgeometry --shell` prints X=/Y=/WIDTH=/HEIGHT= key=value lines.
export function parseXdotoolGeometry(stdout = '') {
  const out = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z]+)=(-?\d+)$/);
    if (match) out[match[1].toLowerCase()] = Number(match[2]);
  }
  return out;
}

// wmctrl talks to the window manager; xdotool reads the X tree directly, so it
// still works on a bare Xvfb display where no WM is running.
async function listWindowsWithXdotool(app, env) {
  const pids = app ? descendantPids(await processRows(), app.pid) : [];
  const ids = new Set();
  if (pids.length) {
    for (const pid of pids) {
      try {
        const { stdout } = await execFileAsync('xdotool', ['search', '--onlyvisible', '--pid', String(pid)], { env });
        for (const id of stdout.split(/\r?\n/)) if (id.trim()) ids.add(id.trim());
      } catch {}
    }
  } else {
    try {
      const { stdout } = await execFileAsync('xdotool', ['search', '--onlyvisible', '--name', '.'], { env });
      for (const id of stdout.split(/\r?\n/)) if (id.trim()) ids.add(id.trim());
    } catch {}
  }
  const windows = [];
  for (const id of ids) {
    try {
      const [{ stdout: geo }, { stdout: name }] = await Promise.all([
        execFileAsync('xdotool', ['getwindowgeometry', '--shell', id], { env }),
        execFileAsync('xdotool', ['getwindowname', id], { env }).catch(() => ({ stdout: '' })),
      ]);
      const g = parseXdotoolGeometry(geo);
      if (!g.width || !g.height) continue;
      windows.push({
        id: `0x${Number(id).toString(16)}`,
        rawId: id,
        desktop: 0,
        pid: app?.pid ?? 0,
        x: g.x ?? 0,
        y: g.y ?? 0,
        width: g.width,
        height: g.height,
        host: '',
        title: String(name || '').trim(),
      });
    } catch {}
  }
  return windows;
}

export async function listWindows(app = null) {
  const envDisplay = app?.display ? { ...process.env, DISPLAY: app.display } : process.env;
  let windows = null;
  let wmctrlError = '';
  if (which('wmctrl')) {
    try {
      const { stdout } = await execFileAsync('wmctrl', ['-lpG'], { env: envDisplay, maxBuffer: 2 * 1024 * 1024 });
      windows = parseWmctrlWindows(stdout);
    } catch (error) {
      wmctrlError = String(error?.stderr || error?.message || '').trim();
    }
  }
  if (!windows && which('xdotool')) windows = await listWindowsWithXdotool(app, envDisplay);
  if (!windows) {
    if (/client list properties/i.test(wmctrlError)) {
      throw new Error(`no window manager is running on ${envDisplay.DISPLAY || 'this display'}, so wmctrl cannot list windows. Start one (e.g. \`openbox &\`) on that display, or install xdotool, or take a full-screen screenshot instead.`);
    }
    throw new Error(wmctrlError
      ? `wmctrl failed: ${wmctrlError}`
      : 'neither wmctrl nor xdotool is installed (`sudo apt install wmctrl xdotool`) — cannot enumerate desktop windows');
  }
  if (!app) return windows;
  const owned = new Set(descendantPids(await processRows(), app.pid));
  const mine = windows.filter(w => owned.has(w.pid));
  return mine.length ? mine : windows;
}

export async function waitForWindow(app, { timeoutMs = 15000, title = '' } = {}) {
  const deadline = Date.now() + Math.max(500, timeoutMs);
  const needle = String(title || '').toLowerCase();
  while (Date.now() < deadline) {
    if (!app.running) throw new Error(`app "${app.id}" exited (code ${app.exitCode ?? 'n/a'}) before opening a window`);
    try {
      const windows = await listWindows(app);
      const match = needle ? windows.filter(w => w.title.toLowerCase().includes(needle)) : windows;
      if (match.length) return match[0];
    } catch (error) {
      if (/not installed/.test(error.message)) throw error;
    }
    await delay(400);
  }
  throw new Error(`no window appeared for "${app.id}" within ${timeoutMs}ms`);
}

export async function focusWindow(windowId, display = null) {
  const env = display ? { ...process.env, DISPLAY: display } : process.env;
  if (which('wmctrl')) {
    await execFileAsync('wmctrl', ['-ia', windowId], { env });
  } else if (which('xdotool')) {
    await execFileAsync('xdotool', ['windowactivate', '--sync', windowId], { env });
  } else {
    throw new Error('neither wmctrl nor xdotool is installed — cannot focus a window');
  }
  await delay(250);
}

export async function captureWindow({ windowId = null, path, display = null }) {
  const tool = resolveScreenshotTool();
  if (!tool) {
    throw new Error('no screenshot tool found (install one of: imagemagick `import`, gnome-screenshot, scrot, spectacle, grim)');
  }
  const target = isAbsolute(path) ? path : resolve(process.cwd(), path);
  await mkdir(dirname(target), { recursive: true });
  const env = display ? { ...process.env, DISPLAY: display } : process.env;
  if (windowId && (tool === 'gnome-screenshot' || tool === 'scrot')) await focusWindow(windowId, display);
  await execFileAsync(tool, buildScreenshotArgs(tool, { windowId, path: target }), { env, timeout: 30000 });
  return { path: target, tool };
}

export async function clickAt({ x, y, button = 1, windowId = null, display = null, windows = [] }) {
  const backend = inputBackend();
  if (!backend) throw new Error(inputUnavailableMessage());
  const env = display ? { ...process.env, DISPLAY: display } : process.env;
  let screenX = Math.round(Number(x));
  let screenY = Math.round(Number(y));
  if (windowId) {
    const win = windows.find(w => w.id === windowId);
    if (win) { screenX += win.x; screenY += win.y; }
    await focusWindow(windowId, display).catch(() => {});
  }
  if (backend.name === 'xdotool') {
    await execFileAsync('xdotool', ['mousemove', '--sync', String(screenX), String(screenY), 'click', String(button)], { env, timeout: 15000 });
  } else {
    await execFileAsync('ydotool', ['mousemove', '--absolute', '-x', String(screenX), '-y', String(screenY)], { env, timeout: 15000 });
    await execFileAsync('ydotool', ['click', button === 3 ? '0xC1' : '0xC0'], { env, timeout: 15000 });
  }
  return { x: screenX, y: screenY };
}

export async function typeText({ text, windowId = null, display = null }) {
  const backend = inputBackend();
  if (!backend) throw new Error(inputUnavailableMessage());
  const env = display ? { ...process.env, DISPLAY: display } : process.env;
  if (windowId) await focusWindow(windowId, display).catch(() => {});
  if (backend.name === 'xdotool') {
    await execFileAsync('xdotool', ['type', '--clearmodifiers', '--delay', '25', '--', String(text ?? '')], { env, timeout: 30000 });
  } else {
    await execFileAsync('ydotool', ['type', String(text ?? '')], { env, timeout: 30000 });
  }
}

export async function pressKeys({ keys, windowId = null, display = null }) {
  const backend = inputBackend();
  if (!backend) throw new Error(inputUnavailableMessage());
  const env = display ? { ...process.env, DISPLAY: display } : process.env;
  if (windowId) await focusWindow(windowId, display).catch(() => {});
  const combo = String(keys || '').trim();
  if (!combo) throw new Error('press requires a key or combination, e.g. "Return" or "ctrl+s"');
  if (backend.name === 'xdotool') {
    await execFileAsync('xdotool', ['key', '--clearmodifiers', '--', combo], { env, timeout: 15000 });
  } else {
    await execFileAsync('ydotool', ['key', combo], { env, timeout: 15000 });
  }
}

// Same reasoning as browser-driver.js: never leave a GUI app (or the Xvfb we
// started for it) running after the CLI is gone.
function killAppsSync() {
  for (const app of apps.values()) {
    try {
      if (app.pid) process.kill(-app.pid, 'SIGKILL');
      else app.proc?.kill('SIGKILL');
    } catch {
      try { app.proc?.kill('SIGKILL'); } catch {}
    }
  }
  apps.clear();
  if (virtualDisplay?.proc) {
    try { virtualDisplay.proc.kill('SIGKILL'); } catch {}
    virtualDisplay = null;
  }
}

process.on('exit', killAppsSync);
process.on('SIGINT', killAppsSync);
