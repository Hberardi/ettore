// Platform dispatcher for desktop_app.
//
// The agent interacts with desktop apps through a single exported surface
// (openApp, stopApp, listWindows, clickAt, typeText, ...). On Linux the
// X11 backend in desktop-app-linux.js drives xdotool + wmctrl + Xvfb; on
// Windows the backend in desktop-app-windows.js spawns a long-running
// PowerShell host that uses System.Windows.Forms and Win32 SendInput.
//
// The rest of the agent — toolHandlers.desktop_app in src/tools/index.js,
// the tool-router, the system prompts — does not have to know which
// backend is active. This file is the only place that branches on
// process.platform.

import * as linux from './desktop-app-linux.js';
import * as windows from './desktop-app-windows.js';

const isWindows = process.platform === 'win32';
const backend = isWindows ? windows : linux;

export const platform = isWindows ? 'win32' : process.platform;
export const isWindowsBackend = isWindows;

// Re-export every public symbol from the chosen backend. Anything the
// agent surface depends on lives in this list; the consumers
// (src/tools/index.js line ~1410, tests) import as `import * as desktop
// from './desktop-app.js'` and use dot access, so this passthrough is
// what makes the swap transparent.
export const openApp = backend.openApp;
export const stopApp = backend.stopApp;
export const stopAllApps = backend.stopAllApps;
export const listApps = backend.listApps;
export const getApp = backend.getApp;
export const listWindows = backend.listWindows;
export const waitForWindow = backend.waitForWindow;
export const focusWindow = backend.focusWindow;
export const captureWindow = backend.captureWindow;
export const clickAt = backend.clickAt;
export const typeText = backend.typeText;
export const pressKeys = backend.pressKeys;
export const readLogs = backend.readLogs;
export const detectAppErrors = backend.detectAppErrors;
export const looksLikeElectron = backend.looksLikeElectron;
export const hasDisplay = backend.hasDisplay;
export const isWayland = backend.isWayland;
export const inputUnavailableMessage = backend.inputUnavailableMessage;
export const describeCapabilities = backend.describeCapabilities;

// Linux-only parsers. Exported unconditionally so existing test/import
// sites keep working on Windows; on Windows they return safe empties
// (already handled in the windows module).
export const parseProcessTable = backend.parseProcessTable;
export const parseWmctrlWindows = backend.parseWmctrlWindows;
export const parseXdotoolGeometry = backend.parseXdotoolGeometry;
export const descendantPids = backend.descendantPids;
export const resolveScreenshotTool = backend.resolveScreenshotTool;
export const buildScreenshotArgs = backend.buildScreenshotArgs;

// Live-view helpers (Windows-only for now; the Linux module never had
// the auto-screenshot-after-action pattern, and adding it would change
// the behaviour callers rely on). On Linux these are null and the
// tool dispatcher will fall back to a clear "not supported" message.
export const watch = backend.watch || null;
export const asciiPreview = backend.asciiPreview || null;
