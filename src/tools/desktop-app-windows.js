// Native Windows backend for desktop_app.
//
// On Linux, desktop-app.js drives GUI apps through xdotool + wmctrl + Xvfb.
// None of those exist on Windows. This module plays the same role from the
// agent's point of view — it implements the same exported surface
// (openApp, stopApp, listWindows, clickAt, typeText, pressKeys, ...) — but
// the heavy lifting is done by a long-running PowerShell host that the
// JS side keeps on a stdin/stdout pipe. Keeping the host alive for the
// whole app session avoids the 500-1000ms PowerShell startup cost on
// every click / keystroke.
//
// Why a host script and not a single-shot PowerShell per call? Typing
// "hello" would be 5 chars * (1s startup + 20ms work) = ~5 seconds of
// overhead. With a live host it is 5 * 20ms = 100ms.

import { spawn, execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute, join } from 'node:path';
import { mkdir, copyFile, readdir, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LOG_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 30000;
const HOST_INIT_TIMEOUT_MS = 30000;

const PS_SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'desktop-host.ps1',
);

const apps = new Map();
let nextRequestId = 1;

// Detect "is this an Electron-ish command" so the user knows to pass
// debug_port for renderer console access. Mirrors looksLikeElectron() in
// desktop-app.js.
export function looksLikeElectron(command = '') {
  return /\belectron\b|\bnw\b|\btauri\b/i.test(String(command));
}

// PowerShell stderr can be noisy ("Some.ps1 cannot be loaded because
// running scripts is disabled..."). We silence it after a single attempt
// to set the policy; if it still fails we surface the real reason.
const PS_CANDIDATES = [
  'pwsh.exe',
  'powershell.exe',
];
let cachedPowerShell = null;
let cachedPowerShellError = null;

export async function resolvePowerShell() {
  if (cachedPowerShell) return cachedPowerShell;
  if (cachedPowerShellError) throw cachedPowerShellError;
  for (const candidate of PS_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync('where.exe', [candidate], { encoding: 'utf8' });
      const first = String(stdout || '').split(/\r?\n/).map(l => l.trim()).find(Boolean);
      if (first && existsSync(first)) {
        cachedPowerShell = first;
        return first;
      }
    } catch {}
  }
  cachedPowerShellError = new Error(
    'desktop_app on Windows needs PowerShell (powershell.exe or pwsh.exe). Install PowerShell 7+ from https://aka.ms/powershell or enable the built-in Windows PowerShell 5.1.',
  );
  throw cachedPowerShellError;
}

const ERROR_RE = /(traceback \(most recent call last\)|fatal|\bcritical\b|panic:|unhandled (?:exception|rejection)|uncaught \w*error|\b\w*(?:Error|Exception)\b\s*[:(]|^\s*at .+:\d+:\d+\)?$|assertion .*failed|cannot find module|modulenotfounderror|command not found|permission denied|address already in use)/i;
const WARN_RE = /\b(warn|warning|deprecat)\w*\b/i;

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
      const next = raw.replace(/^\[stderr\]\s?/, '');
      if (/^\s+(at\s|File\s|\.\.\.)/.test(next) || (isError && next.trim() && /^\s/.test(next))) trail.push(raw);
      else break;
    }
    found.push({ index: i, level: isError ? 'error' : 'warning', line, trail });
    if (found.length >= limit) break;
  }
  return found;
}

export function hasDisplay(_env = process.env) {
  // On Windows, the display is always present (the desktop). A service
  // session without a desktop returns false from Screen.AllScreens; we
  // defer the real check to the host.
  return true;
}

export function isWayland(_env = process.env) {
  return false;
}

export function inputUnavailableMessage() {
  return 'no input tool available: this Windows desktop backend needs SendInput support, which the bundled PowerShell host already provides. If you see this message, the host failed to start — check `desktop_app action=errors` for the underlying reason.';
}

export function describeCapabilities(_exists = existsSync) {
  return {
    display: 'win32-desktop',
    wayland: false,
    windowManagerTool: 'enumwindows',
    screenshotTool: 'system-drawing',
    inputTool: 'sendinput',
    virtualDisplayTool: null, // not needed on Windows
  };
}

// A child PowerShell process pinned to a single app session.
class Host {
  constructor(scriptPath) {
    this.scriptPath = scriptPath;
    this.proc = null;
    this.buffer = '';
    this.pending = new Map();
    this.lastError = null;
  }

  async start() {
    const ps = await resolvePowerShell();
    if (!existsSync(this.scriptPath)) {
      throw new Error(`host script not found: ${this.scriptPath}`);
    }
    this.proc = spawn(ps, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', this.scriptPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      // Most stderr noise is harmless (PSReadLine, profile load warnings).
      // Surface it only if the host dies before answering the first ping.
      this.lastError = String(this.lastError || '') + chunk;
    });
    this.proc.on('exit', (code, signal) => {
      const err = new Error(`desktop host exited unexpectedly (code=${code} signal=${signal})${this.lastError ? `: ${String(this.lastError).slice(0, 500)}` : ''}`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.proc = null;
    });

    // Wait for ping to confirm the host is actually responsive.
    await this._request({ action: 'ping' }, HOST_INIT_TIMEOUT_MS);
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      let response;
      try { response = JSON.parse(trimmed); }
      catch { continue; }
      const id = response.id ? String(response.id) : null;
      if (id && this.pending.has(id)) {
        const { resolve, reject } = this.pending.get(id);
        this.pending.delete(id);
        if (response.ok) resolve(response); else reject(new Error(response.error || 'host returned ok=false'));
      }
    }
  }

  _request(cmd, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.proc) throw new Error('desktop host is not running');
    return new Promise((resolve, reject) => {
      const id = String(nextRequestId++);
      this.pending.set(id, { resolve, reject });
      try {
        this.proc.stdin.write(JSON.stringify({ ...cmd, id }) + '\n');
      } catch (error) {
        this.pending.delete(id);
        reject(new Error(`failed to write to host stdin: ${error.message}`));
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`host request '${cmd.action || '?'}' timed out after ${Math.round(timeoutMs / 1000)}s`));
        }
      }, timeoutMs);
    });
  }

  listWindows() {
    return this._request({ action: 'list-windows' }).then(r => r.windows || []);
  }
  getWindow(hwnd) {
    return this._request({ action: 'get-window', hwnd });
  }
  screenshot({ path, hwnd = null }) {
    return this._request({ action: 'screenshot', path, hwnd });
  }
  asciiPreview({ path, width = 80, height = 24, invert = false }) {
    return this._request({ action: 'ascii-preview', path, width, height, invert });
  }
  focus(hwnd) {
    return this._request({ action: 'focus', hwnd });
  }
  click({ x, y, button = 1, hwnd = null }) {
    return this._request({ action: 'click', x, y, button, hwnd });
  }
  type({ text, delay_ms = 20 }) {
    return this._request({ action: 'type', text, delay_ms });
  }
  press({ keys }) {
    return this._request({ action: 'press', keys });
  }

  async stop() {
    if (!this.proc) return;
    try { await this._request({ action: 'quit' }, 3000); } catch {}
    try { this.proc.kill(); } catch {}
    this.proc = null;
  }
}

// ----------------------------------------------------------------------------
// App registry — mirrors the shape of the Linux implementation so the agent
// surface (`toolHandlers.desktop_app`) is identical regardless of platform.
// ----------------------------------------------------------------------------

export function listApps() {
  return [...apps.values()].map(app => ({
    id: app.id,
    command: app.command,
    pid: app.pid,
    running: app.running,
    exitCode: app.exitCode,
    display: 'win32',
    workdir: app.workdir,
    startedAt: new Date(app.startedAt).toISOString(),
    logLines: app.logs.length,
    debugPort: app.debugPort,
  }));
}

export function getApp(id = 'default') {
  return apps.get(String(id || 'default')) || null;
}

// Spawn the command directly. On Windows we don't go through `bash -lc`
// (the Linux implementation does because npm scripts on Linux are
// typically `npm start` which needs PATH lookup + shell). On Windows the
// caller can pass the full path to the executable, or we resolve simple
// command names through `where.exe`.
function resolveCommand(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return { cmd: '', args: [] };
  // If it contains spaces and the first token is a real path, split
  // naively. Otherwise try to find the binary in PATH.
  const m = trimmed.match(/^"([^"]+)"(?:\s+(.*))?$/) || trimmed.match(/^(\S+)(?:\s+(.*))?$/);
  if (!m) return { cmd: trimmed, args: [] };
  const head = m[1];
  const rest = m[2] ? m[2].match(/(?:"[^"]+"|\S+)/g)?.map(s => s.replace(/^"|"$/g, '')) || [] : [];
  if (isAbsolute(head) || head.includes('\\') || head.includes('/') || /\.exe$/i.test(head)) {
    return { cmd: head, args: rest };
  }
  // Resolve through where.exe; fall back to the raw token if not found.
  try {
    const { stdout } = execFileSync('where.exe', [head], { encoding: 'utf8' });
    const found = String(stdout || '').split(/\r?\n/).map(l => l.trim()).find(Boolean);
    if (found) return { cmd: found, args: rest };
  } catch {}
  return { cmd: head, args: rest };
}

// Lazy import to avoid pulling child_process sync into top of file.

export async function openApp({
  id = 'default',
  command,
  workdir = process.cwd(),
  env = {},
  // `virtual_display` is accepted for API parity with the Linux
  // backend; on Windows there is no Xvfb-style virtual display, so
  // we ignore it. Prefixed with `_` to silence no-unused-vars without
  // changing the public signature.
  _virtual_display = null,
  debug_port = null,
} = {}) {
  void _virtual_display;
  const key = String(id || 'default');
  if (apps.get(key)?.running) {
    throw new Error(`desktop app "${key}" is already running (pid ${apps.get(key).pid}) — stop it or use another id`);
  }
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('open requires a non-empty "command"');

  const { cmd: bin, args } = resolveCommand(cmd);
  if (!bin) throw new Error('open: could not resolve the command to an executable');

  // Spawn the target process. We do NOT pass `bash` — Windows runs the
  // exe directly. stdout/stderr are captured so crashes, tracebacks and
  // GTK/Qt criticals show up in the same place as on Linux.
  const port = Number(debug_port) || null;
  const childEnv = { ...process.env, ...env };
  if (port && !args.some(a => a.startsWith('--remote-debugging-port'))) {
    args.push(`--remote-debugging-port=${port}`);
  }
  const proc = spawn(bin, args, {
    cwd: workdir || process.cwd(),
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const app = {
    id: key,
    command: bin + (args.length ? ' ' + args.join(' ') : ''),
    pid: proc.pid,
    proc,
    running: true,
    exitCode: null,
    workdir: workdir || process.cwd(),
    display: 'win32',
    debugPort: port,
    startedAt: Date.now(),
    logs: [],
    host: null,
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

  // Start the host right away so subsequent clicks don't pay the cold-
  // start tax. A failing host should not abort the open — clicks will
  // surface the host error.
  try {
    app.host = new Host(PS_SCRIPT_PATH);
    await app.host.start();
  } catch (error) {
    app.hostError = error.message;
  }
  return app;
}

export async function stopApp(id = 'default') {
  const app = apps.get(String(id || 'default'));
  if (!app) return false;
  apps.delete(app.id);
  if (app.host) {
    try { await app.host.stop(); } catch {}
  }
  try { app.proc?.kill(); } catch {}
  app.running = false;
  return true;
}

export async function stopAllApps() {
  for (const id of [...apps.keys()]) await stopApp(id);
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

function requireHost(app) {
  if (!app.host) {
    throw new Error(app.hostError || 'desktop host is not running for this app');
  }
  return app.host;
}

// Windows does not have a `ps -eo pid,ppid` equivalent that is fast
// enough to query on every listWindows call. We pass `pid` from the
// window enumeration (GetWindowThreadProcessId) and let the JS side
// build a synthetic descendant set: the root pid + any pid reachable
// through repeated Get-CimInstance calls is too slow, so we approximate
// "owned by this app" by matching the root pid directly. If the app
// spawns a single child that owns the window (typical for Win32
// executables), this works. For multi-process apps like Electron, the
// user should pass debug_port and read the renderer console through
// browser_app action=attach.
export function parseProcessTable(_stdout = '') { return []; }
export function descendantPids(_rows = [], _root) { return _rows && _rows.length ? [] : []; }
export function parseWmctrlWindows(_stdout = '') { return []; }
export function parseXdotoolGeometry(_stdout = '') { return {}; }
export function resolveScreenshotTool() { return 'system-drawing'; }
export function buildScreenshotArgs(_tool, _opts) { return []; }

async function ownedWindows(app) {
  if (!app?.host) return [];
  const all = await app.host.listWindows();
  if (!app.pid) return all;
  // Find any window whose pid matches the app or one of its direct
  // children. We do a one-shot Get-CimInstance to discover children.
  let descendantPids = new Set([app.pid]);
  try {
    const ps = await resolvePowerShell();
    const script = `$p = Get-CimInstance Win32_Process -Filter "ParentProcessId=${app.pid}"; @($p | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], { encoding: 'utf8' });
    const parsed = JSON.parse(String(stdout || '[]'));
    const arr = Array.isArray(parsed) ? parsed : (parsed == null ? [] : [parsed]);
    for (const child of arr) descendantPids.add(Number(child));
  } catch {}
  const mine = all.filter(w => descendantPids.has(Number(w.pid)));
  return mine.length ? mine : all;
}

export async function listWindows(app = null) {
  if (!app?.host) return [];
  return ownedWindows(app);
}

export async function waitForWindow(app, { timeoutMs = 15000, title = '' } = {}) {
  const deadline = Date.now() + Math.max(500, timeoutMs);
  const needle = String(title || '').toLowerCase();
  const host = requireHost(app);
  while (Date.now() < deadline) {
    if (!app.running) {
      throw new Error(`app "${app.id}" exited (code ${app.exitCode ?? 'n/a'}) before opening a window`);
    }
    const all = await host.listWindows();
    const owned = await ownedWindows(app);
    const pool = owned.length ? owned : all;
    const match = needle ? pool.filter(w => String(w.title || '').toLowerCase().includes(needle)) : pool;
    if (match.length) return match[0];
    await new Promise((done) => { setTimeout(done, 400); });
  }
  throw new Error(`no window appeared for "${app.id}" within ${timeoutMs}ms`);
}

export async function focusWindow(windowId, _display = null) {
  for (const app of apps.values()) {
    if (app.host) {
      try {
        await app.host.focus(String(windowId));
        return;
      } catch (error) {
        // Try the next app's host — there is only one host per app on
        // Windows, so the wrong host is the most likely cause of failure.
        const msg = String(error?.message || '');
        if (/hwnd|window/i.test(msg) && /unknown|invalid/i.test(msg)) continue;
        throw error;
      }
    }
  }
  throw new Error('no desktop app session owns a host that can focus this window');
}

export async function captureWindow({ windowId = null, path, display = null } = {}) {
  // `display` is accepted for API parity but ignored on Windows.
  void display;
  const target = isAbsolute(path) ? path : resolve(process.cwd(), path);
  await mkdir(dirname(target), { recursive: true });
  for (const app of apps.values()) {
    if (!app.host) continue;
    try {
      const result = await app.host.screenshot({ path: target, hwnd: windowId || null });
      return { path: result.path, tool: 'system-drawing' };
    } catch (error) {
      // Try the next app if this host cannot satisfy the request.
      continue;
    }
  }
  throw new Error('no desktop app session owns a host that can take this screenshot');
}

// Every click/type/press writes a full-screen PNG, and `watch` can add one
// every 50ms for up to ten minutes. Left unbounded that buries the user's
// project under gigabytes of frames — and `.ettore/` is gitignored in THIS
// repo, not in theirs. Keep a bounded ring of the most recent frames per
// app instead; latest.png is never a candidate.
const DEFAULT_MAX_FRAMES = Number(process.env.ETTORE_WATCH_MAX_FRAMES) > 0
  ? Number(process.env.ETTORE_WATCH_MAX_FRAMES)
  : 200;

// Frame names are "<prefix>-<epoch-ms>.png" with prefixes that differ per
// action (click-, type-, frame-), so ordering has to come from the stamp,
// not from the name.
function frameStamp(name = '') {
  const match = /-(\d+)\.png$/.exec(String(name));
  return match ? Number(match[1]) : 0;
}

export async function pruneFrames(dir, max = DEFAULT_MAX_FRAMES) {
  try {
    const frames = (await readdir(dir)).filter(n => n.endsWith('.png') && n !== 'latest.png');
    if (frames.length <= max) return [];
    frames.sort((a, b) => frameStamp(a) - frameStamp(b));
    const doomed = frames.slice(0, frames.length - max);
    const removed = [];
    for (const name of doomed) {
      try {
        await unlink(join(dir, name));
        removed.push(name);
      } catch {
        // A frame the user opened in a viewer can be locked on Windows;
        // skipping it is fine, the next prune will catch it.
      }
    }
    return removed;
  } catch {
    return [];
  }
}

// Take a screenshot into the .ettore/watch/ folder and ALSO update a
// "<id>-latest.png" pointer so the TUI can poll a single file rather
// than enumerate the directory. Returns the full path of the new
// frame.
async function recordFrame(app, { prefix = 'frame', windowId = null } = {}) {
  if (!app?.host) return null;
  const dir = resolve(process.cwd(), '.ettore', 'watch', app.id);
  await mkdir(dir, { recursive: true });
  const stamp = String(Date.now());
  const target = join(dir, `${prefix}-${stamp}.png`);
  const latest = join(dir, 'latest.png');
  try {
    await app.host.screenshot({ path: target, hwnd: windowId || null });
    // Best-effort: keep "latest" pointing at the most recent frame.
    try { await copyFile(target, latest); } catch {}
    await pruneFrames(dir);
    return target;
  } catch (error) {
    return null;
  }
}

// A host that belongs to no app session. Turning a PNG into ASCII is a
// pure image operation — it needs PowerShell, not a running application —
// and `ettore preview` renders frames from a SECOND process, where the
// `apps` registry of this module is necessarily empty. Without this the
// live preview could only ever have worked inside the agent's own
// process, which is not where anyone watches it from.
let standaloneHost = null;

async function getStandaloneHost() {
  if (standaloneHost?.proc) return standaloneHost;
  const host = new Host(PS_SCRIPT_PATH);
  await host.start();
  standaloneHost = host;
  return host;
}

export async function stopStandaloneHost() {
  const host = standaloneHost;
  standaloneHost = null;
  if (host) await host.stop();
}

// Convert a PNG to a small ASCII art string via the host. Width 80 /
// height 24 fits a 132-col terminal sidebar at 2x vertical density.
export async function asciiPreview(path, { width = 80, height = 24, invert = false } = {}) {
  for (const app of apps.values()) {
    if (!app.host) continue;
    try {
      const result = await app.host.asciiPreview({ path, width, height, invert });
      return result;
    } catch (error) {
      continue;
    }
  }
  // No app session here (or none of their hosts could answer). Fall back
  // to a host of our own rather than refusing work that needs no app.
  const host = await getStandaloneHost();
  return host.asciiPreview({ path, width, height, invert });
}

// Take screenshots at a fixed interval for `durationMs` milliseconds,
// saving each to .ettore/watch/<id>/frame-<ts>.png and updating
// latest.png. Designed for "open the app and let the user watch what
// the agent does in real time". Returns the list of frames captured.
export async function watch({
  app = null,
  intervalMs = 500,
  durationMs = 10000,
  windowId = null,
  outDir = null,
} = {}) {
  const target = app || (apps.size ? [...apps.values()][0] : null);
  if (!target) throw new Error('no desktop app to watch — call open first');
  if (!target.host) throw new Error(target.hostError || 'desktop host is not running for this app');
  const dir = outDir ? resolve(process.cwd(), outDir) : resolve(process.cwd(), '.ettore', 'watch', target.id);
  await mkdir(dir, { recursive: true });
  const latest = join(dir, 'latest.png');
  const startedAt = Date.now();
  const frames = [];
  const interval = Math.max(50, Math.min(Number(intervalMs) || 500, 5000));
  const total = Math.max(interval, Math.min(Number(durationMs) || 10000, 600000));
  while (Date.now() - startedAt < total) {
    if (!target.running) break;
    const stamp = Date.now();
    const target_path = join(dir, `frame-${stamp}.png`);
    try {
      await target.host.screenshot({ path: target_path, hwnd: windowId || null });
      frames.push(target_path);
      try { await copyFile(target_path, latest); } catch {}
    } catch (error) {
      // Keep going on transient errors; one bad frame is better than
      // aborting the whole watch session.
    }
    // Prune on a cadence rather than every frame: at a 50ms interval a
    // readdir per tick would cost more than the screenshot it follows.
    if (frames.length % 20 === 0) await pruneFrames(dir);
    await new Promise((r) => { setTimeout(r, interval); });
  }
  const removed = await pruneFrames(dir);
  const dropped = new Set(removed.map(name => join(dir, name)));
  // Report only the frames that are still on disk, so a caller that walks
  // the list does not hit ENOENT on the ones retention just reclaimed.
  const kept = frames.filter(path => !dropped.has(path));
  return { frames: kept, captured: frames.length, dir, latest, durationMs: total, appId: target.id };
}

export async function clickAt({ x, y, button = 1, windowId = null, _display = null, windows = [], record = true } = {}) {
  let screenX = Math.round(Number(x));
  let screenY = Math.round(Number(y));
  let host = null;
  let app = null;
  for (const candidate of apps.values()) {
    if (candidate.host) { host = candidate.host; app = candidate; break; }
  }
  if (!host) throw new Error(inputUnavailableMessage());
  if (windowId) {
    let win = windows.find(w => w.id === windowId);
    if (!win) {
      try { win = await host.getWindow(String(windowId)); } catch {}
    }
    if (win) {
      screenX += win.x;
      screenY += win.y;
      try { await host.focus(String(windowId)); } catch {}
    }
  }
  const result = await host.click({ x: screenX, y: screenY, button, hwnd: windowId || null });
  // Auto-screenshot AFTER the action: the user (and the TUI's live
  // preview) needs to see the result of the click, not just where the
  // cursor was. The host already waits 150ms after SetCursorPos and
  // the click is instant, so a frame taken right after captures the
  // visible state.
  let postShot = null;
  if (record) postShot = await recordFrame(app, { prefix: 'click', windowId });
  return { x: result.x, y: result.y, button, windowId, screenshot: postShot };
}

export async function typeText({ text, windowId = null, _display = null, record = true } = {}) {
  let host = null;
  let app = null;
  for (const candidate of apps.values()) {
    if (candidate.host) { host = candidate.host; app = candidate; break; }
  }
  if (!host) throw new Error(inputUnavailableMessage());
  if (windowId) {
    try { await host.focus(String(windowId)); } catch {}
  }
  await host.type({ text: String(text ?? ''), delay_ms: 20 });
  let postShot = null;
  if (record) postShot = await recordFrame(app, { prefix: 'type', windowId });
  return { length: String(text ?? '').length, windowId, screenshot: postShot };
}

export async function pressKeys({ keys, windowId = null, _display = null, record = true } = {}) {
  let host = null;
  let app = null;
  for (const candidate of apps.values()) {
    if (candidate.host) { host = candidate.host; app = candidate; break; }
  }
  if (!host) throw new Error(inputUnavailableMessage());
  if (windowId) {
    try { await host.focus(String(windowId)); } catch {}
  }
  await host.press({ keys: String(keys) });
  let postShot = null;
  if (record) postShot = await recordFrame(app, { prefix: 'press', windowId });
  return { keys, windowId, screenshot: postShot };
}

// Re-export parseProcessTable / descendantPids / parseWmctrlWindows / etc.
// as empty stubs above so any leftover import sites that destructure them
// get a defined value. They were never meaningful on Windows.

// Keep the same exit-time cleanup hook that the Linux module uses.
function killAppsSync() {
  for (const app of apps.values()) {
    try { if (app.host) { app.host.stop().catch(() => {}); } } catch {}
    try { app.proc?.kill('SIGKILL'); } catch {}
  }
  apps.clear();
  // `ettore preview` owns no app but does own a PowerShell host; a Ctrl-C
  // there must not leave it running either.
  try { standaloneHost?.stop().catch(() => {}); } catch {}
  standaloneHost = null;
}
process.on('exit', killAppsSync);
process.on('SIGINT', killAppsSync);
