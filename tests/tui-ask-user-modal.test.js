// Regression: while a question was on screen the main window visibly flashed
// behind it. _renderAskUser already covered the whole frame, but _render built
// and painted the entire main view into the same buffer first, and the render
// loop repeated that at 60fps because `isRunning` stays true while the agent
// waits for the answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/app/tui-native.js';

// Capture what a render actually writes to the terminal.
function captureRender(tui) {
  const original = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try {
    tui.render();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

function tuiWithQuestion() {
  const tui = new TUI();
  tui.cols = 100;
  tui.rows = 30;
  tui.messages = [
    { role: 'user', text: 'UNIQUE_TRANSCRIPT_MARKER', tools: [], id: 1 },
    { role: 'assistant', text: 'ANOTHER_MARKER', tools: [], id: 2 },
  ];
  tui.askUser = {
    question: 'Applicare questa modifica?',
    options: ['Sì, applica', 'No, annulla'],
    resolve: () => {},
  };
  return tui;
}

test('a pending question is a blocking modal', () => {
  const tui = new TUI();
  assert.equal(tui.isBlockingModal(), false);
  tui.askUser = { question: 'q', options: ['a'], resolve: () => {} };
  assert.equal(tui.isBlockingModal(), true);
});

test('the frame behind a question is never painted', () => {
  const tui = tuiWithQuestion();
  const out = captureRender(tui);

  assert.ok(out.includes('Applicare questa modifica?'), 'the question must be drawn');
  // The flash was the transcript being written and then covered, sixty times a
  // second. If the text reaches stdout at all, the terminal can show it.
  assert.ok(!out.includes('UNIQUE_TRANSCRIPT_MARKER'), 'the transcript leaked into the frame');
  assert.ok(!out.includes('ANOTHER_MARKER'), 'the transcript leaked into the frame');
});

test('the modal frame still covers every row, so nothing shows through', () => {
  const tui = tuiWithQuestion();
  const out = captureRender(tui);
  // _renderAskUser paints rows 1..rows before drawing the dialog.
  for (const row of [1, 15, tui.rows]) {
    assert.ok(out.includes(`\x1b[${row};1H`), `row ${row} was not covered`);
  }
});

test('rendering a question twice produces identical bytes', () => {
  // Nothing may animate under or around the prompt: two consecutive frames
  // with no state change must be indistinguishable, or the screen moves.
  const tui = tuiWithQuestion();
  assert.equal(captureRender(tui), captureRender(tui));
});

test('the animation counter does not advance while a question is up', () => {
  const tui = tuiWithQuestion();
  const before = tui.animationFrame;
  captureRender(tui);
  captureRender(tui);
  assert.equal(tui.animationFrame, before, 'a spinner under the modal would keep redrawing it');
});

test('moving the selection changes the frame', () => {
  const tui = tuiWithQuestion();
  const first = captureRender(tui);
  tui.askUserIdx = 1;
  assert.notEqual(captureRender(tui), first, 'the highlighted option must follow the selection');
});

test('the frame after a question clears the modal background', () => {
  const tui = tuiWithQuestion();
  captureRender(tui);

  tui.askUser = null;
  const after = captureRender(tui);

  // The modal covers every row; the main frame owns every row but the last, so
  // without this clear its background survives along the bottom.
  assert.ok(after.includes('\x1b[2J'), 'the restored frame must clear the modal background');
  assert.ok(after.includes('UNIQUE_TRANSCRIPT_MARKER'), 'the transcript must come back');
});

test('the clear happens once, not on every later frame', () => {
  const tui = tuiWithQuestion();
  captureRender(tui);
  tui.askUser = null;
  captureRender(tui);

  const steady = captureRender(tui);
  assert.ok(!steady.includes('\x1b[2J'), 'clearing every frame is its own flicker');
});

test('an ordinary frame with no question paints the main view', () => {
  const tui = new TUI();
  tui.cols = 100;
  tui.rows = 30;
  tui.messages = [{ role: 'user', text: 'UNIQUE_TRANSCRIPT_MARKER', tools: [], id: 1 }];
  const out = captureRender(tui);
  assert.ok(out.includes('UNIQUE_TRANSCRIPT_MARKER'));
  assert.ok(!out.includes('\x1b[2J'), 'no clear when no modal preceded it');
});

// ─── The render loop's ticking ───────────────────────────────────────────────

test('the loop stops ticking while a question waits for an answer', () => {
  const tui = tuiWithQuestion();
  tui.isRunning = true;      // the agent is blocked on the answer
  tui.needsRender = false;
  assert.equal(tui.shouldRenderOnTick(), false, '60fps repaints of a static prompt are the flicker');
});

test('a keystroke inside the modal still redraws it', () => {
  const tui = tuiWithQuestion();
  tui.isRunning = true;
  tui.needsRender = true;    // set by the arrow-key handler
  assert.equal(tui.shouldRenderOnTick(), true);
});

test('a running turn with no question keeps animating', () => {
  const tui = new TUI();
  tui.isRunning = true;
  tui.needsRender = false;
  assert.equal(tui.shouldRenderOnTick(), true, 'the spinner and elapsed time must keep moving');
});

test('an idle CLI with nothing to show does not repaint', () => {
  const tui = new TUI();
  tui.isRunning = false;
  tui.needsRender = false;
  assert.equal(tui.shouldRenderOnTick(), false);
});
