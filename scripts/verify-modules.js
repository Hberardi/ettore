// Static verification: confirms the dispatcher + backends can be
// imported and that the dispatch surface matches what the agent
// surface (src/tools/index.js) actually uses.

import * as desktop from '../src/tools/desktop-app.js';
import { toolHandlers } from '../src/tools/index.js';

const required = [
  'openApp', 'stopApp', 'stopAllApps', 'listApps', 'getApp',
  'listWindows', 'waitForWindow', 'focusWindow', 'captureWindow',
  'clickAt', 'typeText', 'pressKeys', 'readLogs', 'detectAppErrors',
  'looksLikeElectron', 'hasDisplay', 'isWayland',
  'inputUnavailableMessage', 'describeCapabilities',
  'parseProcessTable', 'parseWmctrlWindows', 'parseXdotoolGeometry',
  'descendantPids', 'resolveScreenshotTool', 'buildScreenshotArgs',
];

const missing = required.filter(name => typeof desktop[name] !== 'function');
if (missing.length) {
  console.error('MISSING exports on desktop-app.js:', missing);
  process.exit(1);
}

const dAct = toolHandlers.desktop_app;
if (typeof dAct !== 'function') {
  console.error('toolHandlers.desktop_app is not registered');
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  platform: desktop.platform,
  isWindowsBackend: desktop.isWindowsBackend,
  exports: required.length,
  agentUses: 'desktop_app',
  caps: desktop.describeCapabilities(),
  hasDisplay: desktop.hasDisplay(),
  isWayland: desktop.isWayland(),
  inputMessageSample: desktop.inputUnavailableMessage().slice(0, 80) + '…',
}, null, 2));
