// Drive a real browser over the Chrome DevTools Protocol.
//
// `browser_check` only fetches HTML, so it cannot see anything a web app does
// after it boots: hydration errors, failed XHRs, thrown exceptions, console
// warnings. This module launches (or attaches to) a real Chromium/Chrome,
// keeps every console message, exception, failed request and HTTP error in a
// ring buffer, and exposes clicks/typing so the agent can actually use the app
// while it watches the console.
//
// No extra dependency: CDP is plain JSON over the WebSocket client built into
// Node 22.

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PAGE_HELPERS } from './browser-page.js';

const EVENT_LIMIT = 800;
const REQUEST_LIMIT = 500;
const DEFAULT_NAV_TIMEOUT = 30000;
const sessions = new Map();

const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

// Chrome is the only hard requirement of this module; make the lookup
// injectable so the resolution order stays testable without a browser.
export function resolveChromeBinary(env = process.env, exists = existsSync) {
  const override = String(env.ETTORE_CHROME_BIN || env.CHROME_PATH || '').trim();
  if (override) return exists(override) ? override : null;
  for (const candidate of CHROME_CANDIDATES) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function hasDisplay(env = process.env) {
  return Boolean(String(env.DISPLAY || '').trim() || String(env.WAYLAND_DISPLAY || '').trim());
}

export function buildChromeArgs({
  userDataDir,
  headless = true,
  width = 1280,
  height = 800,
  extraArgs = [],
  isRoot = false,
} = {}) {
  const args = [
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-popup-blocking',
    '--password-store=basic',
    '--use-mock-keychain',
    `--window-size=${Math.round(width)},${Math.round(height)}`,
  ];
  if (headless) args.push('--headless=new', '--disable-gpu');
  if (isRoot) args.push('--no-sandbox');
  for (const extra of extraArgs) {
    const value = String(extra || '').trim();
    if (value) args.push(value);
  }
  args.push('about:blank');
  return args;
}

export function parseDevToolsActivePort(text = '') {
  const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { port, browserPath: lines[1] || '' };
}

function renderPreview(preview) {
  const props = Array.isArray(preview?.properties) ? preview.properties : [];
  const overflow = preview?.overflow ? ', …' : '';
  if (preview?.subtype === 'array') {
    return `[${props.map(p => p.value).join(', ')}${overflow}]`;
  }
  return `{${props.map(p => `${p.name}: ${p.value}`).join(', ')}${overflow}}`;
}

// CDP hands back RemoteObject descriptors, not values. Flatten them into the
// text a developer would have seen in the DevTools console.
export function renderRemoteObject(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return String(obj);
  if (obj.type === 'undefined') return 'undefined';
  if (obj.type === 'string') return String(obj.value ?? '');
  if (obj.unserializableValue) return String(obj.unserializableValue);
  if (obj.subtype === 'null') return 'null';
  if (obj.subtype === 'error') return String(obj.description || 'Error');
  if (obj.type === 'function') return String(obj.description || 'function').split('\n')[0];
  if (obj.type === 'number' || obj.type === 'boolean' || obj.type === 'bigint') {
    return String(obj.value ?? obj.description ?? '');
  }
  if (obj.value !== undefined) {
    if (typeof obj.value === 'object') {
      try { return JSON.stringify(obj.value); } catch { return String(obj.value); }
    }
    return String(obj.value);
  }
  if (obj.preview) return renderPreview(obj.preview);
  return String(obj.description || obj.className || obj.type || '');
}

const LEVEL_RANK = { debug: 0, info: 1, warning: 2, error: 3 };

export function levelRank(level) {
  return LEVEL_RANK[String(level || 'info').toLowerCase()] ?? 1;
}

function mapConsoleType(type) {
  const value = String(type || 'log').toLowerCase();
  if (value === 'error' || value === 'assert') return 'error';
  if (value === 'warning' || value === 'warn') return 'warning';
  if (value === 'debug' || value === 'trace' || value === 'timeEnd') return 'debug';
  return 'info';
}

function firstFrame(stackTrace) {
  const frame = stackTrace?.callFrames?.find(f => f?.url) || stackTrace?.callFrames?.[0];
  if (!frame) return {};
  return {
    url: frame.url || '',
    line: Number.isInteger(frame.lineNumber) ? frame.lineNumber + 1 : null,
  };
}

function stackLines(stackTrace, max = 4) {
  const frames = Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames.slice(0, max) : [];
  return frames.map(f => {
    const where = f.url ? `${f.url}:${(f.lineNumber ?? 0) + 1}:${(f.columnNumber ?? 0) + 1}` : '<anonymous>';
    return `    at ${f.functionName || '(anonymous)'} (${where})`;
  });
}

// Translate one raw CDP event into the flat record shape the console buffer
// stores. Returns null for events that are tracked elsewhere (network
// bookkeeping) or that carry no diagnostic value.
export function normalizeCdpEvent(method, params = {}, now = Date.now()) {
  if (method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(params.args) ? params.args : [];
    const { url, line } = firstFrame(params.stackTrace);
    return {
      time: now,
      kind: 'console',
      level: mapConsoleType(params.type),
      text: args.map(renderRemoteObject).join(' ').trim() || `(console.${params.type || 'log'})`,
      url,
      line,
      stack: mapConsoleType(params.type) === 'error' ? stackLines(params.stackTrace) : [],
    };
  }
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails || {};
    const text = details.exception?.description || details.text || 'Uncaught exception';
    return {
      time: now,
      kind: 'exception',
      level: 'error',
      text: String(text).split('\n')[0],
      url: details.url || firstFrame(details.stackTrace).url || '',
      line: Number.isInteger(details.lineNumber) ? details.lineNumber + 1 : null,
      stack: String(text).includes('\n')
        ? String(text).split('\n').slice(1, 5).map(l => `    ${l.trim()}`)
        : stackLines(details.stackTrace),
    };
  }
  if (method === 'Log.entryAdded') {
    const entry = params.entry || {};
    return {
      time: now,
      kind: 'log',
      level: mapConsoleType(entry.level),
      text: `[${entry.source || 'log'}] ${entry.text || ''}`.trim(),
      url: entry.url || '',
      line: Number.isInteger(entry.lineNumber) ? entry.lineNumber + 1 : null,
      stack: [],
    };
  }
  if (method === 'Network.loadingFailed') {
    if (params.canceled) return null;
    return {
      time: now,
      kind: 'network',
      level: 'error',
      text: `request failed (${params.errorText || 'unknown error'})`,
      url: '',
      line: null,
      requestId: params.requestId || '',
      stack: [],
    };
  }
  if (method === 'Page.javascriptDialogOpening') {
    return {
      time: now,
      kind: 'dialog',
      level: 'warning',
      text: `${params.type || 'dialog'}: ${params.message || ''}`.trim(),
      url: params.url || '',
      line: null,
      stack: [],
    };
  }
  return null;
}

function clockOf(record, startedAt) {
  const delta = Math.max(0, (record.time || 0) - startedAt);
  return `+${(delta / 1000).toFixed(1)}s`;
}

export function formatEventLine(record, startedAt = record.time || 0) {
  const level = String(record.level || 'info').toUpperCase();
  const where = record.url
    ? ` (${record.url}${record.line ? `:${record.line}` : ''})`
    : '';
  const head = `${clockOf(record, startedAt)} ${level} ${record.kind}: ${record.text}${where}`;
  const stack = Array.isArray(record.stack) ? record.stack : [];
  return [head, ...stack].join('\n');
}

export function summarizeConsole(records = [], { minLevel = 'info', limit = 80, startedAt = 0 } = {}) {
  const floor = levelRank(minLevel);
  const matching = records.filter(r => levelRank(r.level) >= floor);
  const shown = matching.slice(Math.max(0, matching.length - limit));
  const errors = records.filter(r => levelRank(r.level) >= 3).length;
  const warnings = records.filter(r => levelRank(r.level) === 2).length;
  const header = `console: ${records.length} message(s), ${errors} error(s), ${warnings} warning(s)`;
  if (!shown.length) {
    return `${header}\n(no message at level >= ${minLevel})`;
  }
  const skipped = matching.length - shown.length;
  const body = shown.map(r => formatEventLine(r, startedAt || shown[0].time)).join('\n');
  return skipped > 0
    ? `${header}\n… ${skipped} older message(s) omitted\n${body}`
    : `${header}\n${body}`;
}

export function formatRequestLine(req) {
  const status = req.failed
    ? `FAILED ${req.errorText || ''}`.trim()
    : (req.status ? String(req.status) : 'pending');
  return `${status} ${req.method || 'GET'} ${req.url}`;
}

const KEY_MAP = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

export function keyDescriptor(key) {
  const name = String(key || '').trim();
  if (!name) return null;
  const mapped = KEY_MAP[name.toLowerCase()];
  if (mapped) return mapped;
  if (name.length === 1) {
    return { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: name };
  }
  return null;
}

const delay = (ms) => new Promise(done => { setTimeout(done, ms); });

async function httpJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

// Minimal CDP client: request/response by id plus an event fan-out.
function createCdpClient(ws) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  let closed = false;

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); }
    catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolveFn, rejectFn, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) rejectFn(new Error(msg.error.message || 'CDP error'));
      else resolveFn(msg.result || {});
      return;
    }
    if (msg.method) {
      for (const listener of listeners) {
        try { listener(msg.method, msg.params || {}); } catch {}
      }
    }
  });

  const fail = (reason) => {
    closed = true;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.rejectFn(new Error(reason));
    }
    pending.clear();
  };
  ws.addEventListener('close', () => fail('browser connection closed'));
  ws.addEventListener('error', () => fail('browser connection error'));

  return {
    get closed() { return closed || ws.readyState > 1; },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    send(method, params = {}, timeoutMs = 30000) {
      if (closed || ws.readyState !== 1) return Promise.reject(new Error('browser connection is not open'));
      const id = nextId++;
      return new Promise((resolveFn, rejectFn) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectFn(new Error(`CDP timeout on ${method} after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolveFn, rejectFn, timer });
        try { ws.send(JSON.stringify({ id, method, params })); }
        catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          rejectFn(error);
        }
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}

function openSocket(wsUrl, timeoutMs = 10000) {
  return new Promise((resolveFn, rejectFn) => {
    if (typeof WebSocket !== 'function') {
      rejectFn(new Error('this Node build has no global WebSocket (Node 22+ required for browser_app)'));
      return;
    }
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      rejectFn(new Error(`timed out connecting to ${wsUrl}`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveFn(ws);
    }, { once: true });
    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectFn(new Error(`cannot connect to ${wsUrl}`));
    }, { once: true });
  });
}

async function waitForDebugPort(userDataDir, proc, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const portFile = resolve(userDataDir, 'DevToolsActivePort');
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`browser exited before exposing a debugging port (code ${proc.exitCode})`);
    }
    try {
      const parsed = parseDevToolsActivePort(await readFile(portFile, 'utf8'));
      if (parsed) return parsed;
    } catch {}
    await delay(120);
  }
  throw new Error('browser did not expose a debugging port in time');
}

async function pickPageTarget(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no page target found';
  while (Date.now() < deadline) {
    try {
      const targets = await httpJson(`http://127.0.0.1:${port}/json/list`);
      const page = (Array.isArray(targets) ? targets : []).find(
        t => t?.type === 'page' && t?.webSocketDebuggerUrl
      );
      if (page) return page;
    } catch (error) {
      lastError = error.message;
    }
    await delay(150);
  }
  throw new Error(lastError);
}

function attachInstrumentation(session) {
  const push = (record) => {
    if (!record) return;
    session.events.push(record);
    if (session.events.length > EVENT_LIMIT) session.events.splice(0, session.events.length - EVENT_LIMIT);
  };

  session.client.onEvent((method, params) => {
    if (method === 'Network.requestWillBeSent') {
      session.requests.set(params.requestId, {
        requestId: params.requestId,
        url: params.request?.url || '',
        method: params.request?.method || 'GET',
        status: null,
        failed: false,
        errorText: '',
        time: Date.now(),
      });
      if (session.requests.size > REQUEST_LIMIT) {
        const oldest = session.requests.keys().next().value;
        session.requests.delete(oldest);
      }
      return;
    }
    if (method === 'Network.responseReceived') {
      const req = session.requests.get(params.requestId);
      const status = Number(params.response?.status) || 0;
      const url = params.response?.url || req?.url || '';
      if (req) {
        req.status = status;
        req.url = url;
      }
      // A 4xx/5xx never reaches console.error on its own, yet it is the most
      // common cause of "the app looks broken" — record it as an error.
      if (status >= 400) {
        push({
          time: Date.now(),
          kind: 'http',
          level: 'error',
          text: `HTTP ${status} ${req?.method || 'GET'} ${url}`,
          url: '',
          line: null,
          stack: [],
        });
      }
      return;
    }
    const record = normalizeCdpEvent(method, params);
    if (record?.kind === 'network' && record.requestId) {
      const req = session.requests.get(record.requestId);
      if (req) {
        req.failed = true;
        req.errorText = String(record.text).replace(/^request failed \(|\)$/g, '');
        record.url = req.url;
        record.text = `${record.text} ${req.method} ${req.url}`;
      }
    }
    if (method === 'Page.javascriptDialogOpening') {
      // A modal dialog freezes the page until somebody answers it; accept and
      // keep going, but leave the trace in the console buffer.
      session.client.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
    push(record);
  });
}

async function enableDomains(client) {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Network.enable');
  await client.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});
}

async function connectSession({ id, port, proc = null, userDataDir = null, headless = true, attached = false }) {
  const target = await pickPageTarget(port);
  const ws = await openSocket(target.webSocketDebuggerUrl);
  const client = createCdpClient(ws);
  const session = {
    id,
    port,
    proc,
    userDataDir,
    headless,
    attached,
    client,
    targetId: target.id,
    events: [],
    requests: new Map(),
    cursor: 0,
    autoCursor: 0,
    url: target.url || 'about:blank',
    startedAt: Date.now(),
  };
  attachInstrumentation(session);
  await enableDomains(client);
  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(String(id || 'default')) || null;
}

export function listSessions() {
  return [...sessions.values()].map(s => ({
    id: s.id,
    url: s.url,
    port: s.port,
    headless: s.headless,
    attached: s.attached,
    pid: s.proc?.pid ?? null,
    events: s.events.length,
    errors: s.events.filter(e => levelRank(e.level) >= 3).length,
    startedAt: new Date(s.startedAt).toISOString(),
  }));
}

export async function launchSession({
  id = 'default',
  headless = null,
  width = 1280,
  height = 800,
  chromeArgs = [],
  env = process.env,
} = {}) {
  const key = String(id || 'default');
  if (sessions.has(key)) throw new Error(`browser session "${key}" already open — close it first or use another id`);
  const binary = resolveChromeBinary(env);
  if (!binary) {
    throw new Error('no Chrome/Chromium found. Install one (e.g. `sudo apt install chromium`) or set ETTORE_CHROME_BIN to its path');
  }
  // Visible when there is a desktop to show it on, headless otherwise, so the
  // same call works over SSH and in CI.
  const runHeadless = headless === null ? !hasDisplay(env) : Boolean(headless);
  const userDataDir = await mkdtemp(resolve(tmpdir(), 'ettore-browser-'));
  const args = buildChromeArgs({
    userDataDir,
    headless: runHeadless,
    width,
    height,
    extraArgs: chromeArgs,
    isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
  });
  const proc = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  const stderrTail = [];
  proc.stderr?.on('data', chunk => {
    stderrTail.push(String(chunk));
    if (stderrTail.length > 40) stderrTail.shift();
  });

  try {
    const { port } = await waitForDebugPort(userDataDir, proc);
    return await connectSession({ id: key, port, proc, userDataDir, headless: runHeadless });
  } catch (error) {
    try { proc.kill('SIGKILL'); } catch {}
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    const hint = stderrTail.join('').trim().split('\n').slice(-3).join(' | ');
    throw new Error(hint ? `${error.message} — browser said: ${hint}` : error.message);
  }
}

export async function attachSession({ id = 'default', port, host = '127.0.0.1' } = {}) {
  const key = String(id || 'default');
  if (sessions.has(key)) throw new Error(`browser session "${key}" already open — close it first or use another id`);
  const debugPort = Number(port);
  if (!Number.isInteger(debugPort) || debugPort <= 0) throw new Error('attach requires a numeric "port"');
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('attach only supports a local debugging port');
  }
  return connectSession({ id: key, port: debugPort, attached: true });
}

export async function closeSession(id = 'default') {
  const key = String(id || 'default');
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  try { session.client.close(); } catch {}
  if (session.proc) {
    try { session.proc.kill('SIGTERM'); } catch {}
    await delay(200);
    try { if (session.proc.exitCode === null) session.proc.kill('SIGKILL'); } catch {}
  }
  if (session.userDataDir) await rm(session.userDataDir, { recursive: true, force: true }).catch(() => {});
  return true;
}

export async function closeAllSessions() {
  for (const id of [...sessions.keys()]) await closeSession(id);
}

export async function navigate(session, url, { timeoutMs = DEFAULT_NAV_TIMEOUT, settleMs = 400 } = {}) {
  const loaded = new Promise(done => {
    const off = session.client.onEvent((method) => {
      if (method === 'Page.loadEventFired') { off(); done(true); }
    });
    setTimeout(() => { off(); done(false); }, timeoutMs);
  });
  const result = await session.client.send('Page.navigate', { url }, timeoutMs);
  if (result?.errorText) throw new Error(`navigation failed: ${result.errorText} (${url})`);
  const ok = await loaded;
  await delay(settleMs);
  session.url = url;
  // The overlay lives in the document, so every navigation wipes it. Rebuild
  // it now rather than on the first click, so a visible window shows the
  // agent's pointer from the moment the page appears.
  await initPointer(session);
  return ok;
}

export async function initPointer(session) {
  if (!session || session.headless) return false;
  try {
    const result = await callPage(session, 'ettoreCursorEnsure');
    return !!result?.ok;
  } catch {
    return false;
  }
}

export async function evaluate(session, expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
  const result = await session.client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.text || 'evaluation failed');
  }
  return result.result?.value;
}

// Page-side helpers, serialized straight from ./browser-page.js so the logic
// that runs in the browser is the same source the unit tests exercise.
const PAGE_BUNDLE = PAGE_HELPERS.map(fn => fn.toString()).join('\n');

function pageCall(name, args = []) {
  const encoded = args.map(arg => JSON.stringify(arg === undefined ? null : arg)).join(', ');
  return `(function(){\n${PAGE_BUNDLE}\nreturn ${name}(${encoded ? encoded + ', ' : ''}document, window);\n})()`;
}

async function callPage(session, name, args = []) {
  return evaluate(session, pageCall(name, args), { awaitPromise: false });
}

// Long enough for the pointer's CSS transition to actually play, short enough
// not to slow a scripted run to a crawl.
const POINTER_SETTLE_MS = 260;

// Show where the agent is about to act. Pointless work in headless mode, and
// never allowed to break the action it is only illustrating.
export async function showPointer(session, box, label) {
  if (!session || session.headless) return false;
  try {
    await callPage(session, 'ettoreCursorShow', [{
      x: box.x,
      y: box.y,
      label: label || '',
      rect: {
        left: box.x - box.width / 2,
        top: box.y - box.height / 2,
        width: box.width,
        height: box.height,
      },
    }]);
    await delay(POINTER_SETTLE_MS);
    return true;
  } catch {
    return false;
  }
}

async function pulsePointer(session) {
  if (!session || session.headless) return;
  try { await callPage(session, 'ettoreCursorPulse'); } catch { /* decoration only */ }
}

export async function hidePointer(session) {
  try { return await callPage(session, 'ettoreCursorClear'); } catch { return { ok: false }; }
}

let markCounter = 0;
function nextMark() {
  markCounter += 1;
  return `t${Date.now().toString(36)}${markCounter}`;
}

export async function locate(session, locator, { field = false, clickable = false, mark = '' } = {}) {
  const found = await callPage(session, 'ettoreLocate', [locator, { field, clickable, mark }]);
  if (!found || found.error) throw new Error(found?.error || `no element matches ${locator}`);
  if (!found.visible) throw new Error(`element ${locator} is present but not visible (${found.width}x${found.height})`);
  if (found.occluder) {
    throw new Error(
      `${found.describe} is covered by ${found.occluder} — dismiss the overlay (cookie banner, modal) first, `
      + 'or target the element directly with a CSS selector.',
    );
  }
  return found;
}

async function dispatchClick(session, box, { button = 'left', clickCount = 1 } = {}) {
  const point = { x: Math.round(box.x), y: Math.round(box.y) };
  await pulsePointer(session);
  await session.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', buttons: 0 });
  await session.client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', ...point, button, buttons: button === 'left' ? 1 : 2, clickCount,
  });
  await session.client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', ...point, button, buttons: 0, clickCount,
  });
}

export async function clickElement(session, locator, { button = 'left', clickCount = 1 } = {}) {
  const box = await locate(session, locator, { clickable: true });
  await showPointer(session, box, `click ${box.describe}`);
  await dispatchClick(session, box, { button, clickCount });
  return box;
}

// Report whether an element can actually be used, without touching it, and
// park the pointer on it so the person watching sees which one is being
// checked. Opening a page and listing selectors proves nothing on its own.
export async function probe(session, locator, { field = false, point = true } = {}) {
  const result = await callPage(session, 'ettoreProbe', [locator, { field }]);
  if (point && result && !result.problem && Number.isFinite(result.x)) {
    await showPointer(session, {
      x: result.x,
      y: result.y,
      width: result.rect?.width || 0,
      height: result.rect?.height || 0,
    }, `check ${result.describe}`);
  }
  return result;
}

export async function probeAll(session, limit = 40) {
  return callPage(session, 'ettoreProbeAll', [Math.max(1, Math.min(Number(limit) || 40, 200))]);
}

export async function pressKey(session, key) {
  const descriptor = keyDescriptor(key);
  if (!descriptor) throw new Error(`unsupported key "${key}"`);
  const base = {
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode,
  };
  await session.client.send('Input.dispatchKeyEvent', {
    type: descriptor.text ? 'keyDown' : 'rawKeyDown',
    text: descriptor.text || '',
    ...base,
  });
  await session.client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// Types into the field a locator names — and proves it landed there.
//
// The old version clicked the locator and pushed the text at whatever had
// focus. On a login form that silently mis-fills: "text=Password" matches the
// <label>, clicking a label focuses nothing on most styled forms, and the
// password went into the previously focused email box. Now the locator is
// resolved to the actual control (`field: true`), focus is verified after the
// click, and the resulting value is read back before reporting success.
export async function typeInto(session, locator, text, { replace = true, submit = false } = {}) {
  const value = String(text ?? '');
  const report = { target: '(focused element)', via: 'active', length: value.length, resolvedFrom: '' };

  if (!locator) {
    const active = await callPage(session, 'ettoreDescribeActive');
    if (!active || !active.field) {
      throw new Error(
        `nothing editable has focus (active element: ${active?.describe || 'unknown'}). `
        + 'Pass a selector — CSS, or text=/label=/placeholder= — so the text goes into a known field.',
      );
    }
    report.target = active.describe;
    await session.client.send('Input.insertText', { text: value });
    if (submit) await pressKey(session, 'Enter');
    return report;
  }

  const mark = nextMark();
  let box;
  try {
    box = await locate(session, locator, { field: true, mark });
  } catch (e) {
    await callPage(session, 'ettoreUnmark', [mark]).catch(() => {});
    throw e;
  }

  try {
    if (box.disabled) throw new Error(`${box.describe} is disabled — it cannot be filled.`);
    if (box.readOnly) throw new Error(`${box.describe} is read-only — it cannot be filled.`);
    report.target = box.describe;
    report.resolvedFrom = box.resolvedFrom || '';

    await showPointer(session, box, `type into ${box.describe}`);
    await dispatchClick(session, box);
    const focus = await callPage(session, 'ettoreEnsureFocus', [mark]);
    if (focus?.error) throw new Error(focus.error);
    if (!focus?.focused) {
      throw new Error(
        `could not focus ${box.describe}: after clicking it the focus is on ${focus?.activeDescribe || 'nothing'}. `
        + 'Typing here would put the text in the wrong place.',
      );
    }
    report.via = focus.via;

    if (replace) {
      const cleared = await callPage(session, 'ettoreSetValue', [mark, '', false]);
      if (cleared?.error) throw new Error(cleared.error);
    }

    const before = await callPage(session, 'ettoreReadState', [mark]);
    await session.client.send('Input.insertText', { text: value });
    let after = await callPage(session, 'ettoreReadState', [mark]);
    if (after?.error) throw new Error(after.error);

    // Some widgets swallow insertText (custom editors, inputs re-rendered on
    // focus). Fall back to the framework-safe setter rather than reporting a
    // success that never reached the field.
    const expected = replace ? value.length : (before?.length || 0) + value.length;
    if (after.length !== expected) {
      const forced = await callPage(session, 'ettoreSetValue', [mark, value, !replace]);
      if (forced?.error) throw new Error(forced.error);
      after = await callPage(session, 'ettoreReadState', [mark]);
      report.via = `${report.via}+setValue`;
    }

    if (!after || after.length === 0 && value.length > 0) {
      throw new Error(`${box.describe} is still empty after typing — the page rejected the input.`);
    }
    report.length = after.length;
    if (submit) await pressKey(session, 'Enter');
    return report;
  } finally {
    await callPage(session, 'ettoreUnmark', [mark]).catch(() => {});
  }
}

export async function snapshot(session, limit = 40) {
  return callPage(session, 'ettoreSnapshot', [Math.max(1, Math.min(Number(limit) || 40, 200))]);
}

export async function pageText(session, maxChars = 4000) {
  const text = await evaluate(session, `(document.body && document.body.innerText || '').slice(0, ${Math.max(200, Math.min(Number(maxChars) || 4000, 40000))})`, { awaitPromise: false });
  return String(text || '');
}

export async function waitForSelector(session, selector, timeoutMs = 10000) {
  const deadline = Date.now() + Math.max(200, timeoutMs);
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const box = await locate(session, selector);
      return box;
    } catch (error) {
      lastError = error.message;
    }
    await delay(200);
  }
  throw new Error(`timeout waiting for ${selector}${lastError ? ` (${lastError})` : ''}`);
}

export async function screenshot(session, filePath, { fullPage = false } = {}) {
  const target = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  await mkdir(dirname(target), { recursive: true });
  const params = { format: 'png' };
  if (fullPage) params.captureBeyondViewport = true;
  const result = await session.client.send('Page.captureScreenshot', params, 60000);
  if (!result?.data) throw new Error('browser returned an empty screenshot');
  const buffer = Buffer.from(result.data, 'base64');
  await writeFile(target, buffer);
  return { path: target, bytes: buffer.length };
}

export function readConsole(session, { minLevel = 'info', limit = 80, sinceLast = false, clear = false } = {}) {
  const from = sinceLast ? session.cursor : 0;
  const slice = session.events.slice(from);
  session.cursor = session.events.length;
  const text = summarizeConsole(slice, { minLevel, limit, startedAt: session.startedAt });
  if (clear) {
    session.events.length = 0;
    session.cursor = 0;
  }
  return sinceLast && !slice.length ? 'console: no new message since the last read' : text;
}

// Console errors that appeared since the last check. Every interaction result
// ends with these, so the agent notices a breakage at the moment it causes it
// instead of only when it thinks to read the console.
export function takeNewErrors(session, limit = 6) {
  const fresh = session.events.slice(session.autoCursor || 0);
  session.autoCursor = session.events.length;
  const errors = fresh.filter(r => levelRank(r.level) >= 3);
  return errors.slice(Math.max(0, errors.length - limit));
}

// Keep both read cursors in sync after a call already showed the buffer, so
// the same message is not reported twice.
export function syncCursors(session) {
  session.cursor = session.events.length;
  session.autoCursor = session.events.length;
}

export function readNetwork(session, { onlyFailed = true, limit = 40 } = {}) {
  const all = [...session.requests.values()];
  const rows = onlyFailed ? all.filter(r => r.failed || (r.status && r.status >= 400)) : all;
  const shown = rows.slice(Math.max(0, rows.length - limit));
  if (!shown.length) {
    return onlyFailed
      ? `network: ${all.length} request(s), no failure and no HTTP >= 400`
      : 'network: no request recorded';
  }
  return [`network: ${shown.length} of ${all.length} request(s)`, ...shown.map(formatRequestLine)].join('\n');
}

// A leaked headless browser would keep running after the CLI exits, so tear
// every session down synchronously on the way out (same approach as
// bash-session.js).
function killBrowsersSync() {
  for (const session of sessions.values()) {
    try { session.client.close(); } catch {}
    try { session.proc?.kill('SIGKILL'); } catch {}
    try { if (session.userDataDir) rmSync(session.userDataDir, { recursive: true, force: true }); } catch {}
  }
  sessions.clear();
}

process.on('exit', killBrowsersSync);
process.on('SIGINT', killBrowsersSync);
