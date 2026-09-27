// What a keystroke does to an open question.
//
// A question from the agent used to be one of two things: a list to pick from,
// or a line to type into. The list was a closed door — when none of the
// options fitted, the only way out was Esc, which the agent read as a refusal.
// A question can now offer both: the agent's options, and below them a line
// where the user writes their own answer. Typing anywhere in the list jumps to
// that line, so there is nothing to learn.
//
// Confirmations the harness asks for itself ("Sì, procedi" / "No, annulla")
// keep the closed list: their answer is matched against those exact words, and
// a free-text reply there would read as a refusal nobody meant.

/** How many selectable rows the question has: its options, plus the write-in. */
export function askUserRowCount(ask) {
  const options = Array.isArray(ask?.options) ? ask.options.length : 0;
  return options + (ask?.freeText && options > 0 ? 1 : 0);
}

/** Whether `idx` points at the write-in line rather than at an option. */
export function onWriteInRow(ask, idx) {
  const options = Array.isArray(ask?.options) ? ask.options.length : 0;
  return Boolean(ask?.freeText) && options > 0 && idx === options;
}

/**
 * Apply one keystroke. Pure: returns the new selection and text, and — when
 * the keystroke answers the question — `submit: { answer, custom }`, where
 * `custom` says the user wrote it rather than picked it.
 *
 * Esc and Ctrl+C are not handled here; they cancel the question whatever it is.
 */
export function applyAskUserKey(ask, { idx = 0, input = '' } = {}, { str = '', key = {} } = {}) {
  const options = Array.isArray(ask?.options) ? ask.options : [];
  const name = key?.name;
  const isEnter = name === 'return' || name === 'enter';
  const printable = Boolean(str) && !key?.ctrl && !key?.meta && str.codePointAt(0) >= 32;
  const state = { idx, input, submit: null };

  // Nothing to pick from: the whole question is the write-in line.
  if (options.length === 0) {
    if (isEnter) {
      const answer = input.trim();
      if (answer) state.submit = { answer, custom: true };
    } else if (name === 'backspace') {
      state.input = input.slice(0, -1);
    } else if (printable) {
      state.input = input + str;
    }
    return state;
  }

  const rows = askUserRowCount(ask);
  const writeIn = onWriteInRow(ask, idx);
  if (name === 'up') {
    state.idx = Math.max(0, idx - 1);
  } else if (name === 'down') {
    state.idx = Math.min(rows - 1, idx + 1);
  } else if (isEnter) {
    if (writeIn) {
      const answer = input.trim();
      if (answer) state.submit = { answer, custom: true };
    } else {
      state.submit = { answer: options[idx], custom: false };
    }
  } else if (name === 'backspace') {
    if (writeIn) state.input = input.slice(0, -1);
  } else if (printable && ask?.freeText) {
    // Typing is choosing to write: the selection moves to the write-in line.
    state.idx = options.length;
    state.input = input + str;
  }
  return state;
}

/** Pasted text lands on the write-in line when the question has one. */
export function pasteIntoAskUser(ask, { idx = 0, input = '' } = {}, text = '') {
  const clean = String(text || '').replace(/\r?\n/g, ' ');
  const options = Array.isArray(ask?.options) ? ask.options : [];
  if (options.length === 0) return { idx, input: input + clean };
  if (!ask?.freeText) return { idx, input };
  return { idx: options.length, input: input + clean };
}
