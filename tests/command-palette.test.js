// The `/` command palette: a framed list where each command is its name,
// its arguments and what it does, plus the selected one in full below.
// The palette is drawn with absolute cursor moves, so the tests split the
// frame on those moves and look at each row as plain text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripAllAnsi } from '../src/utils/ansi.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = (rel) => pathToFileURL(resolve(REPO_ROOT, rel)).href;

const COMMANDS = [
  { name: 'auto-approve', description: 'Stop asking for approval except before deleting files or changing anything outside the working directory', usage: 'auto-approve [on|off|status|edits on|off|installs on|off|commands on|off]', aliases: ['aa'] },
  { name: 'ci', description: 'The latest CI run on the current branch, job by job', usage: '/ci [branch]', aliases: [], plugin: 'github' },
  { name: 'clear', description: 'Clear screen', usage: 'clear', aliases: [] },
  { name: 'help', description: 'Show help', usage: 'help [command]', aliases: [] },
];

async function renderPalette({ index = 0, cols = 120, rows = 30 } = {}) {
  const { TUI } = await import(moduleUrl('src/app/tui-native.js'));
  const t = new TUI();
  t.cols = cols;
  t.rows = rows;
  t.availableHeight = rows - 4;
  t.commandPaletteOpen = true;
  t.commandList = COMMANDS;
  t.commandFiltered = COMMANDS;
  t.commandIndex = index;
  t.commandScrollOffset = 0;
  const frame = t._renderCommandPalette();
  // One entry per cursor move: the text drawn from there. The blank rows of
  // the shadow behind the frame are left out.
  return frame.split(/\x1b\[\d+;\d+H/).slice(1).map((part) => stripAllAnsi(part))
    .filter((line) => /^[╭│╰]/.test(line));
}

test('every palette row has the same width and stays inside the frame', async () => {
  const rows = await renderPalette({ cols: 90 });
  const widths = new Set(rows.map((r) => [...r].length));
  assert.equal(widths.size, 1, `rows of different widths: ${[...widths].join(', ')}`);
  assert.ok([...widths][0] <= 90 - 8);
  assert.ok(rows.some((r) => /^╭─+╮$/.test(r)), 'a top border');
  assert.ok(rows.some((r) => /^╰─+╯$/.test(r)), 'a bottom border');
});

test('the title counts the commands and every row shows name and description', async () => {
  const rows = await renderPalette();
  assert.ok(rows.some((r) => /\/ commands.*4 commands/.test(r)));
  const help = rows.find((r) => /\/help \[command\]/.test(r));
  assert.ok(help, 'the help row shows its arguments');
  assert.match(help, /Show help/);
});

test('a plugin command gets one slash and a badge naming its plugin', async () => {
  const rows = await renderPalette();
  assert.ok(!rows.some((r) => r.includes('//')), 'no double slash from a usage that already starts with /');
  const ci = rows.find((r) => r.includes('/ci'));
  assert.match(ci, /⧉ github/);
});

test('the selected command is spelled out in full below the list', async () => {
  const rows = await renderPalette({ index: 0, cols: 200 });
  const usage = rows.find((r) => r.includes('▸'));
  assert.ok(usage, 'a detail row for the selection');
  assert.match(usage, /\/auto-approve \[on\|off\|status\|edits on\|off\|installs on\|off\|commands on\|off\]/);
  assert.match(usage, /aliases: \/aa/);
  assert.ok(rows.some((r) => r.includes('outside the working directory')));
});

test('a list longer than the window scrolls and shows the position', async () => {
  // 12 rows leave room for two commands out of four.
  const rows = await renderPalette({ index: 1, rows: 12 });
  assert.ok(rows.some((r) => /↑↓ navigate.*2\/4/.test(r)), 'the hint bar shows the position');
});

test('descriptions start in the same column on every row', async () => {
  const rows = await renderPalette();
  const cols = ['Stop asking', 'The latest CI', 'Clear screen', 'Show help']
    .map((d) => rows.find((r) => r.includes(d) && !r.includes('▸'))?.indexOf(d));
  assert.ok(cols.every((c) => c === cols[0]), `description columns: ${cols.join(', ')}`);
});
