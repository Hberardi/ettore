// Regression tests for the TUI command palette.
//
// The crash on startup looked like:
//   TypeError: Cannot read properties of undefined (reading 'length')
//     at TUI._renderCommandPalette (tui-native.js:1853)
//   ...
//   at Timeout._onTimeout (native-ui.js:1297)
//
// The render loop is 60fps (`setInterval(..., 16)` in native-ui.js), so
// a single missing initializer cascades into a TypeError every tick.
//
// The bug had two contributing factors:
//   1. The TUI constructor never set `commandFiltered` to a default
//      value, so it was `undefined` until the first call to
//      `openCommandPalette(...)`.
//   2. Two keypress paths in native-ui.js (sub-menu backspace and
//      sub-menu left) flipped `tui.commandPaletteOpen = true` directly
//      without going through `openCommandPalette`, so if the palette
//      had never been opened, `commandFiltered` was still `undefined`
//      by the time the next render frame ran.
//
// These tests pin down the invariants:
//   - the constructor initializes every command-palette field;
//   - `_renderCommandPalette` survives a direct flip of the flag with
//     `commandFiltered` still `undefined`;
//   - `_render` (the entry point used by the 60fps loop) does not
//     throw when the palette is opened via the legacy direct-flag path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const SAMPLE_COMMANDS = [
  { name: 'help', aliases: ['h'], description: 'Show help' },
  { name: 'connect', aliases: ['c'], description: 'Connect to a provider' },
  { name: 'models', aliases: ['m'], description: 'List models' },
];

function newTui() {
  return import(`${REPO_ROOT}/src/app/tui-native.js`).then(({ TUI }) => new TUI());
}

function stubStdout() {
  const original = process.stdout.write.bind(process.stdout);
  const calls = [];
  process.stdout.write = (chunk) => {
    calls.push(String(chunk));
    return true;
  };
  return {
    calls,
    restore: () => { process.stdout.write = original; },
  };
}

test('TUI constructor initializes every command-palette field', async () => {
  const t = await newTui();
  // Without these defaults, `_renderCommandPalette` would dereference
  // `commandFiltered.length` on `undefined` the first time someone flips
  // `commandPaletteOpen = true` without calling `openCommandPalette`.
  assert.equal(t.commandPaletteOpen, false, 'palette closed by default');
  assert.ok(Array.isArray(t.commandList), 'commandList defaults to an array');
  assert.equal(t.commandList.length, 0, 'commandList defaults to empty');
  assert.ok(Array.isArray(t.commandFiltered), 'commandFiltered defaults to an array');
  assert.equal(t.commandFiltered.length, 0, 'commandFiltered defaults to empty');
  assert.equal(typeof t.commandFilter, 'string', 'commandFilter defaults to a string');
  assert.equal(typeof t.commandInput, 'string', 'commandInput defaults to a string');
  assert.equal(typeof t.commandIndex, 'number', 'commandIndex defaults to a number');
  assert.equal(typeof t.commandScrollOffset, 'number', 'commandScrollOffset defaults to a number');
});

test('_renderCommandPalette returns empty when the palette is closed', async () => {
  const t = await newTui();
  t.cols = 100;
  t.rows = 30;
  t.updateSize();
  // Even if the state is fully populated, a closed palette must render as
  // an empty string — no chrome, no crash.
  t.openCommandPalette(SAMPLE_COMMANDS);
  t.closeCommandPalette();
  const out = t._renderCommandPalette();
  assert.equal(out, '', 'closed palette renders nothing');
});

test('_renderCommandPalette survives commandFiltered=undefined (legacy direct flip)', async () => {
  // Reproduces the original crash: the sub-menu backspace/left handlers
  // historically did `tui.commandPaletteOpen = true` without touching
  // `commandFiltered`. The defensive guard inside `_renderCommandPalette`
  // must rewrite `commandFiltered` to an array instead of throwing.
  const t = await newTui();
  t.cols = 100;
  t.rows = 30;
  t.updateSize();
  t.commandList = [...SAMPLE_COMMANDS];
  t.commandPaletteOpen = true;          // legacy direct flip
  t.commandFiltered = undefined;        // explicit: nothing initialized it
  assert.doesNotThrow(() => t._renderCommandPalette(),
    'render must not throw on legacy direct flip of commandPaletteOpen');
  assert.ok(Array.isArray(t.commandFiltered),
    'defensive guard should have rewritten commandFiltered to an array');
  assert.equal(t.commandFiltered.length, SAMPLE_COMMANDS.length,
    'with no filter, the guard should fall back to the full commandList');
});

test('_renderCommandPalette survives when commandFiltered is a non-array (e.g. null)', async () => {
  // Same shape as the legacy bug, but a different missing value. Catches
  // future regressions where someone assigns the wrong type.
  const t = await newTui();
  t.cols = 100;
  t.rows = 30;
  t.updateSize();
  t.commandList = [...SAMPLE_COMMANDS];
  t.commandPaletteOpen = true;
  t.commandFiltered = null;
  assert.doesNotThrow(() => t._renderCommandPalette(),
    'render must not throw when commandFiltered is null');
  assert.ok(Array.isArray(t.commandFiltered),
    'defensive guard should turn null into an array');
});

test('openCommandPalette still initializes state the way it always did', async () => {
  const t = await newTui();
  t.cols = 100;
  t.rows = 30;
  t.updateSize();
  t.openCommandPalette(SAMPLE_COMMANDS);
  assert.equal(t.commandPaletteOpen, true, 'palette is open');
  assert.strictEqual(t.commandList, SAMPLE_COMMANDS, 'commandList is set');
  assert.strictEqual(t.commandFiltered, SAMPLE_COMMANDS, 'commandFiltered defaults to the full list');
  assert.equal(t.commandFilter, '', 'no filter on open');
  assert.equal(t.commandIndex, 0, 'selection at top');
  assert.equal(t.commandScrollOffset, 0, 'no scroll on open');
  // And it renders without throwing.
  assert.doesNotThrow(() => t._renderCommandPalette());
});

test('filterCommands narrows the list and re-renders without crashing', async () => {
  const t = await newTui();
  t.cols = 100;
  t.rows = 30;
  t.updateSize();
  t.openCommandPalette(SAMPLE_COMMANDS);
  t.filterCommands('mod');
  assert.equal(t.commandFiltered.length, 1, 'only `models` matches "mod"');
  assert.equal(t.commandFiltered[0].name, 'models');
  assert.doesNotThrow(() => t._renderCommandPalette());
});

test('full _render() survives a legacy direct flip of commandPaletteOpen', async () => {
  // The end-to-end version of the bug: the 60fps render loop calls
  // `tui.render()` → `tui._render()` → `tui._renderCommandPalette()`.
  // If the flag was flipped directly, this used to throw every frame.
  const t = await newTui();
  t.cols = 100;
  t.rows = 30;
  t.updateSize();
  t.commandList = [...SAMPLE_COMMANDS];
  t.commandPaletteOpen = true;
  t.commandFiltered = undefined;

  const stub = stubStdout();
  try {
    assert.doesNotThrow(() => t.render(),
      'full render() must not throw on legacy direct flip');
  } finally {
    stub.restore();
  }
  // The guard should have populated commandFiltered so the next frame is
  // safe too — without this, the next tick of the 60fps loop would throw
  // again the moment something else flips the flag.
  assert.ok(Array.isArray(t.commandFiltered),
    'commandFiltered must be a sane array after render()');
});
