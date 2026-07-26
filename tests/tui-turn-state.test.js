import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/app/tui-native.js';
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

