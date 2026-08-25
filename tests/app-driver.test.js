import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChromeArgs,
  formatEventLine,
  formatRequestLine,
  keyDescriptor,
  levelRank,
  normalizeCdpEvent,
  parseDevToolsActivePort,
  readConsole,
  readNetwork,
  renderRemoteObject,
  resolveChromeBinary,
  summarizeConsole,
  syncCursors,
  takeNewErrors,
} from '../src/tools/browser-driver.js';

import {
  buildScreenshotArgs,
  descendantPids,
  detectAppErrors,
  looksLikeElectron,
  parseProcessTable,
  parseWmctrlWindows,
  parseXdotoolGeometry,
} from '../src/tools/desktop-app.js';

import { toolDefinitions, toolHandlers, validateToolArgs } from '../src/tools/index.js';
import { selectToolDefinitions, selectedToolNames } from '../src/agents/tool-router.js';
import { getToolTimeoutMs } from '../src/agents/index.js';

// ─── browser driver ─────────────────────────────────────────────────────────

test('browser driver: chrome lookup prefers the explicit override', () => {
  const exists = (p) => p === '/custom/chrome' || p === '/usr/bin/chromium';
  assert.equal(resolveChromeBinary({ ETTORE_CHROME_BIN: '/custom/chrome' }, exists), '/custom/chrome');
  // An override that does not exist must fail loudly rather than silently
  // falling back to some other browser.
  assert.equal(resolveChromeBinary({ ETTORE_CHROME_BIN: '/missing' }, exists), null);
  assert.equal(resolveChromeBinary({}, exists), '/usr/bin/chromium');
  assert.equal(resolveChromeBinary({}, () => false), null);
});

test('browser driver: chrome arguments carry the debug port, profile and mode', () => {
  const headless = buildChromeArgs({ userDataDir: '/tmp/profile', headless: true, width: 800, height: 600 });
  assert.ok(headless.includes('--remote-debugging-port=0'));
  assert.ok(headless.includes('--user-data-dir=/tmp/profile'));
  assert.ok(headless.includes('--headless=new'));
  assert.ok(headless.includes('--window-size=800,600'));
  assert.ok(!headless.includes('--no-sandbox'));

  const visible = buildChromeArgs({ userDataDir: '/tmp/p', headless: false, isRoot: true, extraArgs: ['--lang=it'] });
  assert.ok(!visible.includes('--headless=new'));
  assert.ok(visible.includes('--no-sandbox'));
  assert.ok(visible.includes('--lang=it'));
});

test('browser driver: DevToolsActivePort file yields the port', () => {
  assert.deepEqual(parseDevToolsActivePort('45123\n/devtools/browser/abc\n'), {
    port: 45123,
    browserPath: '/devtools/browser/abc',
  });
  assert.equal(parseDevToolsActivePort(''), null);
  assert.equal(parseDevToolsActivePort('not-a-port'), null);
});

test('browser driver: remote objects render like the DevTools console', () => {
  assert.equal(renderRemoteObject({ type: 'string', value: 'hello' }), 'hello');
  assert.equal(renderRemoteObject({ type: 'number', value: 42 }), '42');
  assert.equal(renderRemoteObject({ type: 'undefined' }), 'undefined');
  assert.equal(renderRemoteObject({ type: 'object', subtype: 'null' }), 'null');
  assert.equal(
    renderRemoteObject({ type: 'object', subtype: 'error', description: 'TypeError: boom\n    at x' }),
    'TypeError: boom\n    at x'
  );
  assert.equal(
    renderRemoteObject({ type: 'object', preview: { properties: [{ name: 'a', value: '1' }], overflow: false } }),
    '{a: 1}'
  );
  assert.equal(
    renderRemoteObject({ type: 'object', preview: { subtype: 'array', properties: [{ value: '1' }, { value: '2' }], overflow: true } }),
    '[1, 2, …]'
  );
});

test('browser driver: console API calls become error records with a stack', () => {
  const record = normalizeCdpEvent('Runtime.consoleAPICalled', {
    type: 'error',
    args: [{ type: 'string', value: 'search failed for' }, { type: 'string', value: 'ordine 42' }],
    stackTrace: { callFrames: [{ functionName: 'onClick', url: 'http://localhost:3000/app.js', lineNumber: 11, columnNumber: 4 }] },
  }, 1000);
  assert.equal(record.level, 'error');
  assert.equal(record.kind, 'console');
  assert.equal(record.text, 'search failed for ordine 42');
  assert.equal(record.url, 'http://localhost:3000/app.js');
  assert.equal(record.line, 12);
  assert.match(record.stack[0], /at onClick \(http:\/\/localhost:3000\/app\.js:12:5\)/);
});

test('browser driver: uncaught exceptions, browser log entries and dialogs are captured', () => {
  const thrown = normalizeCdpEvent('Runtime.exceptionThrown', {
    exceptionDetails: {
      text: 'Uncaught',
      exception: { description: "TypeError: Cannot read properties of null (reading 'boom')\n    at HTMLButtonElement.<anonymous> (http://x/:15:8)" },
      url: 'http://x/',
      lineNumber: 14,
    },
  });
  assert.equal(thrown.level, 'error');
  assert.equal(thrown.text, "TypeError: Cannot read properties of null (reading 'boom')");
  assert.equal(thrown.line, 15);

  const entry = normalizeCdpEvent('Log.entryAdded', {
    entry: { source: 'network', level: 'error', text: 'Failed to load resource: 404', url: 'http://x/api', lineNumber: 0 },
  });
  assert.equal(entry.level, 'error');
  assert.equal(entry.text, '[network] Failed to load resource: 404');

  const dialog = normalizeCdpEvent('Page.javascriptDialogOpening', { type: 'alert', message: 'salvato' });
  assert.equal(dialog.level, 'warning');
  assert.match(dialog.text, /alert: salvato/);

  // A cancelled request is normal navigation noise, not a failure.
  assert.equal(normalizeCdpEvent('Network.loadingFailed', { canceled: true, errorText: 'net::ERR_ABORTED' }), null);
  assert.equal(normalizeCdpEvent('Network.loadingFailed', { errorText: 'net::ERR_CONNECTION_REFUSED' }).level, 'error');
  assert.equal(normalizeCdpEvent('Page.frameNavigated', {}), null);
});

test('browser driver: console summary counts and filters by level', () => {
  const records = [
    { time: 1000, kind: 'console', level: 'info', text: 'boot', url: '', line: null, stack: [] },
    { time: 1200, kind: 'console', level: 'warning', text: 'deprecated', url: '', line: null, stack: [] },
    { time: 1400, kind: 'exception', level: 'error', text: 'ReferenceError: x', url: 'http://x/', line: 3, stack: [] },
  ];
  const all = summarizeConsole(records, { minLevel: 'info', limit: 10, startedAt: 1000 });
  assert.match(all, /3 message\(s\), 1 error\(s\), 1 warning\(s\)/);
  assert.match(all, /\+0\.4s ERROR exception: ReferenceError: x \(http:\/\/x\/:3\)/);

  const onlyErrors = summarizeConsole(records, { minLevel: 'error', limit: 10, startedAt: 1000 });
  assert.ok(!onlyErrors.includes('deprecated'));
  assert.match(onlyErrors, /ReferenceError/);

  const truncated = summarizeConsole(records, { minLevel: 'info', limit: 1, startedAt: 1000 });
  assert.match(truncated, /2 older message\(s\) omitted/);

  assert.match(summarizeConsole([], { minLevel: 'error' }), /no message at level >= error/);
  assert.ok(levelRank('error') > levelRank('warning'));
  assert.ok(levelRank('warning') > levelRank('info'));
});

test('browser driver: only new errors are reported after each interaction', () => {
  const session = {
    startedAt: 0,
    cursor: 0,
    autoCursor: 0,
    events: [
      { time: 10, kind: 'console', level: 'info', text: 'boot', stack: [] },
      { time: 20, kind: 'console', level: 'error', text: 'first failure', stack: [] },
    ],
    requests: new Map(),
  };
  const first = takeNewErrors(session);
  assert.equal(first.length, 1);
  assert.equal(first[0].text, 'first failure');
  // Nothing new happened, so nothing is reported twice.
  assert.equal(takeNewErrors(session).length, 0);

  session.events.push({ time: 30, kind: 'exception', level: 'error', text: 'second failure', stack: [] });
  assert.equal(takeNewErrors(session)[0].text, 'second failure');

  session.events.push({ time: 40, kind: 'console', level: 'error', text: 'third failure', stack: [] });
  syncCursors(session);
  assert.equal(takeNewErrors(session).length, 0);
  assert.equal(session.cursor, session.events.length);
});

test('browser driver: console and network reads honour since_last and only_failed', () => {
  const session = {
    startedAt: 0,
    cursor: 0,
    autoCursor: 0,
    events: [{ time: 10, kind: 'console', level: 'error', text: 'boom', stack: [] }],
    requests: new Map([
      ['1', { url: 'http://x/ok', method: 'GET', status: 200, failed: false }],
      ['2', { url: 'http://x/missing', method: 'GET', status: 404, failed: false }],
      ['3', { url: 'http://x/dead', method: 'POST', status: null, failed: true, errorText: 'net::ERR_FAILED' }],
    ]),
  };
  assert.match(readConsole(session, { minLevel: 'info', limit: 10 }), /boom/);
  assert.match(readConsole(session, { sinceLast: true }), /no new message since the last read/);

  const failed = readNetwork(session, { onlyFailed: true });
  assert.ok(!failed.includes('/ok'));
  assert.match(failed, /404 GET http:\/\/x\/missing/);
  assert.match(failed, /FAILED net::ERR_FAILED POST http:\/\/x\/dead/);
  assert.match(readNetwork(session, { onlyFailed: false }), /http:\/\/x\/ok/);

  assert.equal(formatRequestLine({ url: 'http://x/', method: 'GET', status: 200 }), '200 GET http://x/');
  assert.equal(
    formatEventLine({ time: 500, kind: 'console', level: 'warning', text: 'slow', url: '', line: null }, 0),
    '+0.5s WARNING console: slow'
  );
});

test('browser driver: key names map to CDP key descriptors', () => {
  assert.equal(keyDescriptor('Enter').keyCode, 13);
  assert.equal(keyDescriptor('enter').text, '\r');
  assert.equal(keyDescriptor('ArrowDown').code, 'ArrowDown');
  assert.equal(keyDescriptor('a').text, 'a');
  assert.equal(keyDescriptor('F13'), null);
  assert.equal(keyDescriptor(''), null);
});

// ─── desktop driver ─────────────────────────────────────────────────────────

test('desktop driver: wmctrl output becomes window records', () => {
  const windows = parseWmctrlWindows([
    '0x03200007  0 32847  343  185  1252 668  host  Ettore Demo App',
    '0x04c00004  0 16546  0    0    1920 1040 host  Claude',
    'garbage line',
  ].join('\n'));
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], {
    id: '0x03200007', desktop: 0, pid: 32847, x: 343, y: 185,
    width: 1252, height: 668, host: 'host', title: 'Ettore Demo App',
  });
});

test('desktop driver: window ownership follows the whole process subtree', () => {
  const rows = parseProcessTable('  100   1\n  200 100\n  300 200\n  400   1\nbad row\n');
  assert.deepEqual(rows, [
    { pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }, { pid: 300, ppid: 200 }, { pid: 400, ppid: 1 },
  ]);
  // bash -lc → node → electron: the window belongs to a grandchild.
  assert.deepEqual(descendantPids(rows, 100), [100, 200, 300]);
  assert.deepEqual(descendantPids(rows, 400), [400]);
  assert.deepEqual(descendantPids(rows, undefined), []);
});

test('desktop driver: suspicious log lines are extracted with their trace', () => {
  const logs = [
    'gui: starting',
    'gui: ready',
    '[stderr] Traceback (most recent call last):',
    '[stderr]   File "app.py", line 7, in boom',
    '[stderr] ValueError: configurazione non valida',
    'normal line',
  ];
  const found = detectAppErrors(logs);
  assert.equal(found[0].level, 'error');
  assert.match(found[0].line, /Traceback/);
  assert.ok(found[0].trail.some(l => /File "app\.py"/.test(l)));
  assert.ok(found.some(f => /ValueError/.test(f.line)));
  assert.equal(detectAppErrors(['all good', 'still fine']).length, 0);
  assert.equal(detectAppErrors(['DeprecationWarning: old api'])[0].level, 'warning');
});

test('desktop driver: screenshot arguments match each tool', () => {
  assert.deepEqual(buildScreenshotArgs('import', { windowId: '0xabc', path: '/tmp/a.png' }), ['-silent', '-window', '0xabc', '/tmp/a.png']);
  assert.deepEqual(buildScreenshotArgs('import', { path: '/tmp/a.png' }), ['-silent', '-window', 'root', '/tmp/a.png']);
  assert.deepEqual(buildScreenshotArgs('gnome-screenshot', { windowId: '0xabc', path: '/tmp/a.png' }), ['-w', '-f', '/tmp/a.png']);
  assert.deepEqual(buildScreenshotArgs('grim', { path: '/tmp/a.png' }), ['/tmp/a.png']);
});

test('desktop driver: xdotool geometry parses and Electron apps are recognised', () => {
  assert.deepEqual(parseXdotoolGeometry('WINDOW=123\nX=10\nY=20\nWIDTH=800\nHEIGHT=600\nSCREEN=0'), {
    window: 123, x: 10, y: 20, width: 800, height: 600, screen: 0,
  });
  assert.equal(looksLikeElectron('npx electron .'), true);
  assert.equal(looksLikeElectron('npm run tauri dev'), true);
  assert.equal(looksLikeElectron('python3 app.py'), false);
});

// ─── tool layer ─────────────────────────────────────────────────────────────

test('app tools: both tools are registered with validated schemas', () => {
  const names = toolDefinitions.map(t => t.function.name);
  assert.ok(names.includes('browser_app'));
  assert.ok(names.includes('desktop_app'));
  assert.equal(typeof toolHandlers.browser_app, 'function');
  assert.equal(typeof toolHandlers.desktop_app, 'function');

  assert.equal(validateToolArgs('browser_app', { action: 'click', selector: 'button' }).valid, true);
  const bad = validateToolArgs('browser_app', { action: 'clickk' });
  assert.equal(bad.valid, false);
  assert.match(bad.error, /action expected one of/);
  assert.equal(validateToolArgs('desktop_app', { action: 'open', command: 'python3 app.py' }).valid, true);
});

test('app tools: acting without a session returns a recoverable instruction', async () => {
  const out = await toolHandlers.browser_app({ action: 'click', id: 'nope', selector: 'button' });
  assert.match(out, /^Error: no browser session "nope"/);
  assert.match(out, /action=open/);

  assert.match(await toolHandlers.browser_app({ action: 'status', id: 'nope' }), /No browser session/);
  assert.match(await toolHandlers.desktop_app({ action: 'open', id: 'y' }), /requires "command"/);
  assert.match(await toolHandlers.desktop_app({ action: 'logs', id: 'nope' }), /^Error: no desktop app "nope"/);
  assert.match(await toolHandlers.browser_app({ action: 'list' }), /No browser session open|:/);
});

test('app tools: desktop_app reports what the machine can actually do', async () => {
  const caps = await toolHandlers.desktop_app({ action: 'capabilities' });
  assert.match(caps, /display:/);
  assert.match(caps, /screenshot:/);
  assert.match(caps, /input:/);
});

test('app tools: desktop_app captures output and flags errors over a full lifecycle', async () => {
  const command = `node -e "console.log('app ready'); console.error('Traceback (most recent call last):'); console.error('ValueError: manca api_key')"`;
  const opened = await toolHandlers.desktop_app({
    id: 'lifecycle',
    action: 'open',
    command,
    virtual_display: false,
    ms: 600,
  });
  assert.match(opened, /Desktop app "lifecycle" started/);
  assert.match(opened, /app ready/);
  assert.match(opened, /suspicious line\(s\)/);

  const errors = await toolHandlers.desktop_app({ action: 'errors', id: 'lifecycle' });
  assert.match(errors, /ValueError: manca api_key/);

  const logs = await toolHandlers.desktop_app({ action: 'logs', id: 'lifecycle', lines: 10 });
  assert.match(logs, /\[stderr\] Traceback/);

  const status = await toolHandlers.desktop_app({ action: 'status', id: 'lifecycle' });
  assert.match(status, /pid: \d+/);

  assert.match(await toolHandlers.desktop_app({ action: 'stop', id: 'lifecycle' }), /stopped/);
  assert.match(await toolHandlers.desktop_app({ action: 'status', id: 'lifecycle' }), /^Error: no desktop app/);
});

test('app tools: runtime intents expose the app drivers to the model', () => {
  const runtime = selectedToolNames(selectToolDefinitions(toolDefinitions, {
    mode: 'build',
    prompt: 'apri la web app e controlla la console del browser',
    maxTools: 30,
  }));
  assert.ok(runtime.includes('browser_app'));
  assert.ok(runtime.includes('desktop_app'));

  const desktopIntent = selectedToolNames(selectToolDefinitions(toolDefinitions, {
    mode: 'build',
    prompt: 'the desktop app crashes when I click save',
    maxTools: 30,
  }));
  assert.ok(desktopIntent.includes('desktop_app'));

  // Driving an app is slower than a plain fetch, but still bounded.
  assert.equal(getToolTimeoutMs('browser_app'), 180_000);
  assert.equal(getToolTimeoutMs('desktop_app'), 180_000);
});
