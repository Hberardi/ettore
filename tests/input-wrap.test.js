import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal stub to instantiate TUI without touching the real terminal.
// We only need the _wrapInputText pure helper, which depends on no state.
import { TUI } from '../src/app/tui-native.js';

const tui = Object.create(TUI.prototype);

test('_wrapInputText returns single row for short text', () => {
  const rows = tui._wrapInputText('hello', 80, 5);
  assert.deepEqual(rows, ['hello']);
});

test('_wrapInputText returns [""] for empty input', () => {
  assert.deepEqual(tui._wrapInputText('', 80, 5), ['']);
});

test('_wrapInputText splits text exactly at the column boundary', () => {
  const rows = tui._wrapInputText('abcdefghij', 5, 5);
  assert.deepEqual(rows, ['abcde', 'fghij']);
});

test('_wrapInputText respects maxRows by collapsing overflow into last row', () => {
  // 30 chars, maxLen 5, maxRows 3 → first 2 full rows + tail truncated with …
  const text = 'a'.repeat(30);
  const rows = tui._wrapInputText(text, 5, 3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0], 'aaaaa');
  assert.equal(rows[1], 'aaaaa');
  assert.ok(rows[2].startsWith('…'), `expected ellipsis prefix, got "${rows[2]}"`);
  assert.equal(rows[2].length, 5); // … + 4 chars
});

test('_wrapInputText does not split inside a surrogate pair', () => {
  // Emoji "😀" is one grapheme but two UTF-16 code units; treated as width 2.
  const rows = tui._wrapInputText('a😀b', 3, 5);
  // a (w=1) + 😀 (w=2) fits row 1 exactly; b goes to row 2.
  assert.deepEqual(rows, ['a😀', 'b']);
});

test('TUI.INPUT_MAX_ROWS is a sensible cap', () => {
  assert.ok(TUI.INPUT_MAX_ROWS >= 3 && TUI.INPUT_MAX_ROWS <= 10,
    `unexpected INPUT_MAX_ROWS=${TUI.INPUT_MAX_ROWS}`);
});
