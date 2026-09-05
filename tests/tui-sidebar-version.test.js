// Tests for the ETTORE version + update banner in the right-side
// sidebar. The sidebar is an ANSI renderer, so we exercise it
// indirectly: TUI is constructed directly (without spawning the
// process) and we check that the rendered lines contain the right
// text and the right colors. ANSI escape codes are stripped before
// assertions so a colour change does not break a substring check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripAllAnsi } from '../src/utils/ansi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

function renderSidebar(t) {
  t.cols = 100;
  t.rows = 30;
  t.updateSize();
  const lines = t._renderSidebar(t.sidebarWidth - 1);
  return stripAllAnsi(lines.join('\n'));
}

test('TUI class exposes version and updateStatus fields with sensible defaults', async () => {
  const { TUI } = await import(`${REPO_ROOT}/src/app/tui-native.js`);
  const t = new TUI();
  assert.equal(t.version, '', 'version defaults to empty so the sidebar shows "version unknown"');
  assert.equal(t.updateStatus, null, 'updateStatus defaults to null until the CLI populates it');
});

test('TUI sidebar header includes the version when set', async () => {
  const { TUI } = await import(`${REPO_ROOT}/src/app/tui-native.js`);
  const t = new TUI();
  t.version = '1.1.1';
  t.updateStatus = null;
  const text = renderSidebar(t);
  assert.ok(text.includes('v1.1.1'), `sidebar should show v1.1.1, got: ${text.slice(0, 200)}`);
  assert.ok(!/ettore update/.test(text), 'no update hint when status is null');
});

test('TUI sidebar header shows the update hint when outdated', async () => {
  const { TUI } = await import(`${REPO_ROOT}/src/app/tui-native.js`);
  const t = new TUI();
  t.version = '1.1.1';
  t.updateStatus = { current: '1.1.1', latest: '1.2.0', outdated: true, fromCache: false };
  const text = renderSidebar(t);
  assert.ok(text.includes('v1.1.1'), 'sidebar should still show the local version');
  assert.ok(text.includes('1.2.0'), 'sidebar should show the latest version next to the arrow');
  assert.ok(text.includes('ettore update'), 'sidebar should hint at the update command');
  assert.ok(text.includes('↻'), 'sidebar should use the up-arrow glyph to mark the bump');
});

test('TUI sidebar header shows "version unknown" when version is empty', async () => {
  const { TUI } = await import(`${REPO_ROOT}/src/app/tui-native.js`);
  const t = new TUI();
  t.version = '';
  t.updateStatus = null;
  const text = renderSidebar(t);
  assert.ok(/version unknown/.test(text), 'missing version should fall back to a clear placeholder');
});

test('TUI sidebar does not show the update hint when not outdated', async () => {
  const { TUI } = await import(`${REPO_ROOT}/src/app/tui-native.js`);
  const t = new TUI();
  t.version = '1.1.1';
  t.updateStatus = { current: '1.1.1', latest: '1.1.1', outdated: false, fromCache: true };
  const text = renderSidebar(t);
  assert.ok(text.includes('v1.1.1'), 'sidebar should show the local version');
  assert.ok(!/↻/.test(text), 'sidebar should not show the update arrow when current == latest');
  assert.ok(!/ettore update/.test(text), 'sidebar should not show the update hint when current == latest');
});

test('bin/cli.js passes version + updateStatus into startApp options', () => {
  const text = readFileSync(resolve(REPO_ROOT, 'bin/cli.js'), 'utf8');
  assert.match(text, /version:\s*packageJson\.version/);
  // The status object is computed once for the banner and reused for the
  // sidebar — calling checkForUpdateSync() twice re-read the cache file
  // for no reason and could hand the two surfaces different answers.
  assert.match(text, /checkForUpdateSync\(\)/);
  assert.match(text, /\n\s*updateStatus,/);
  assert.match(text, /startApp\(tuiOptions\)/);
});

test('native-ui.js startApp wires tui.version and tui.updateStatus', () => {
  const text = readFileSync(resolve(REPO_ROOT, 'src/app/native-ui.js'), 'utf8');
  assert.match(text, /tui\.version\s*=/);
  assert.match(text, /tui\.updateStatus\s*=/);
  assert.match(text, /checkForUpdate\(\)\.then/);
});
