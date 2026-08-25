import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/app/tui-native.js';
import { builtinCommands } from '../src/commands/index.js';
import { stripAllAnsi } from '../src/utils/ansi.js';

test('status reflects running tool phase', () => {
  const tui = new TUI();
  tui.isRunning = true;
  tui.turnState = 'tool_call';
  const status = stripAllAnsi(tui._renderStatus());
  assert.match(status, /tool/);
});

test('status reflects running processing phase', () => {
  const tui = new TUI();
  tui.isRunning = true;
  tui.turnState = 'tool_result';
  const status = stripAllAnsi(tui._renderStatus());
  assert.match(status, /processing/);
});

test('visual width preserves intentional terminal padding', () => {
  const tui = new TUI();
  assert.equal(tui._visualLen('a  b'), 4);
  assert.equal(tui._visualLen(tui._padVisual('label', 12)), 12);
});

test('ask-user modal masks transcript and stays inside the terminal', () => {
  const tui = new TUI();
  tui.cols = 60;
  tui.rows = 16;
  tui.askUser = {
    question: 'This is a deliberately long question that must wrap inside the modal instead of colliding with the CLI transcript.',
    options: ['Continue with the operation', 'Cancel the operation'],
  };

  const rendered = tui._renderAskUser();
  const cursorPositions = [...rendered.matchAll(/\x1b\[(\d+);(\d+)H/g)]
    .map(match => ({ row: Number(match[1]), col: Number(match[2]) }));

  assert.match(rendered, /\x1b\[48;5;233m/);
  assert.match(stripAllAnsi(rendered), /ETTORE needs your input/);
  assert.ok(cursorPositions.every(({ row, col }) => row >= 1 && row <= tui.rows && col >= 1 && col <= tui.cols));
});

test('command palette keeps /loop selectable after filtering', () => {
  const tui = new TUI();
  const commands = Object.entries(builtinCommands).map(([name, command]) => ({
    name,
    description: command.description || '',
    usage: command.usage || name,
    aliases: command.aliases || [],
  }));

  tui.openCommandPalette(commands);
  tui.filterCommands('loop');

  assert.equal(tui.getSelectedCommand()?.name, 'loop');
});

test('sidebar renders Mission Control progress', () => {
  const tui = new TUI();
  tui.availableHeight = 30;
  tui.mission = {
    id: 'mission-test',
    status: 'running',
    turns: 1,
    tools: { total: 2 },
    files: [{ path: 'src/app.js' }],
    progress: { plan: '1/2', todos: '1/2' },
    waves: [{ index: 1, total: 1, tools: ['read', 'grep'] }],
    lastEvent: { detail: 'wave 1/1 complete' },
  };
  const sidebar = tui._renderSidebar(31).join('\n');
  assert.match(sidebar, /MISSION/);
  assert.match(sidebar, /plan 1\/2/);
  assert.match(sidebar, /wave 1\/1/);
});
