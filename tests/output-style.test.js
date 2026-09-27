// How command output is dressed in the output window: titles, entries whose
// name stands out, details, meta and hints — read from the shape of the text,
// so commands keep returning plain text that also reads well in a shell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styleOutputLine } from '../src/app/output-style.js';
import { TUI } from '../src/app/tui-native.js';
import { stripAllAnsi } from '../src/utils/ansi.js';

test('the shapes a command prints are told apart', () => {
  assert.equal(styleOutputLine('Enabled plugins (7)').kind, 'title');
  assert.equal(styleOutputLine('Tools (3)').kind, 'title');
  assert.equal(styleOutputLine('Installed plugins (9):').kind, 'title');
  assert.equal(styleOutputLine('    GitHub from the agent: CI runs').kind, 'detail');
  assert.equal(styleOutputLine('    permissions: shell:exec').kind, 'meta');
  assert.equal(styleOutputLine('Run /plugins info <name> for details.').kind, 'hint');
  assert.equal(styleOutputLine('').kind, 'blank');
  assert.equal(styleOutputLine('auto-approve  edits: on').kind, 'text');
});

test('an entry splits into its bullet, its name and the rest', () => {
  const style = styleOutputLine('● github  v1.0.0 · 9 tools');
  assert.equal(style.kind, 'entry');
  assert.deepEqual(style.parts, { indent: '', marker: '●', name: 'github', rest: '  v1.0.0 · 9 tools' });
  assert.equal(styleOutputLine('  • gh_ci_failure  Why a run failed').parts.name, 'gh_ci_failure');
});

test('a status line is not mistaken for an entry', () => {
  assert.notEqual(styleOutputLine('✓ Plugin "github" enabled (v1.0.0).').kind, 'entry');
});

test('the name is bold and coloured, its details dimmed, and nothing is lost', () => {
  const tui = new TUI();
  const style = styleOutputLine('● github  v1.0.0 · 9 tools');
  const painted = tui._styledOutputLine('● github  v1.0.0 · 9 tools', style);
  assert.equal(stripAllAnsi(painted), '● github  v1.0.0 · 9 tools');
  assert.match(painted, /\x1b\[1m[^\n]*github/, 'the name is bold');
  assert.notEqual(painted.indexOf('github'), -1);
});

test('an empty output line stays empty in the window, not its internal id', () => {
  const tui = new TUI();
  tui.cols = 120;
  tui.rows = 30;
  tui.availableHeight = 24;
  tui.openSubMenu('output', [
    { value: 'line_0', label: 'Enabled plugins (1)', style: { kind: 'title' } },
    { value: 'line_1', label: '', style: { kind: 'blank' } },
    { value: 'line_2', label: '● github  v1.0.0', style: styleOutputLine('● github  v1.0.0') },
  ], { label: '/plugins' });
  const frame = stripAllAnsi(tui._renderSubMenu());
  assert.doesNotMatch(frame, /line_1/);
  assert.match(frame, /\/plugins/, 'titled with the command, not "output"');
  assert.match(frame, /● github/);
});
