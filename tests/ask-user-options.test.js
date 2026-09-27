import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { toolHandlers, normalizeAskUserOption } from '../src/tools/index.js';
import { uiBridge } from '../src/tools/bridge.js';
import { applyAskUserKey, askUserRowCount, pasteIntoAskUser } from '../src/app/ask-user-input.js';

// Unit tests for the option normalizer. Regression: prior `String(o)` produced
// "[object Object]" when an LLM passed options as {label, description} objects.
test('normalizeAskUserOption: passes strings through unchanged', () => {
  assert.equal(normalizeAskUserOption('TypeScript'), 'TypeScript');
});

test('normalizeAskUserOption: extracts label from {label} objects', () => {
  assert.equal(
    normalizeAskUserOption({ label: 'Rust', description: 'systems language' }),
    'Rust'
  );
});

test('normalizeAskUserOption: falls back through text, value, name', () => {
  assert.equal(normalizeAskUserOption({ text: 'A' }), 'A');
  assert.equal(normalizeAskUserOption({ value: 'B' }), 'B');
  assert.equal(normalizeAskUserOption({ name: 'C' }), 'C');
});

test('normalizeAskUserOption: returns empty string for null/undefined', () => {
  assert.equal(normalizeAskUserOption(null), '');
  assert.equal(normalizeAskUserOption(undefined), '');
});

test('normalizeAskUserOption: returns empty string for objects with no usable label', () => {
  assert.equal(normalizeAskUserOption({ description: 'no label field' }), '');
  assert.equal(normalizeAskUserOption({}), '');
  assert.equal(normalizeAskUserOption({ label: '   ' }), '');
});

test('normalizeAskUserOption: never returns "[object Object]"', () => {
  // The whole point of the fix — any object input should not stringify to that.
  for (const o of [{ label: 'x' }, { text: 'y' }, { a: 1 }, { nested: { x: 1 } }]) {
    const out = normalizeAskUserOption(o);
    assert.notEqual(out, '[object Object]', `input ${JSON.stringify(o)} leaked`);
  }
});

// Integration: ask_user tool receives object options, the listener that builds
// the TUI payload must not see "[object Object]".
test('ask_user: object options reach the TUI as readable strings', async () => {
  const received = [];
  const handler = (payload) => {
    received.push(payload.options);
    payload.resolve(payload.options[0] ?? '');
  };
  uiBridge.on('askUser', handler);
  try {
    const result = await toolHandlers.ask_user({
      question: 'Which language?',
      options: [
        { label: 'TypeScript', description: 'typed JS' },
        { label: 'Rust', description: 'safe systems' },
      ],
    });
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], ['TypeScript', 'Rust']);
    assert.equal(result, 'User selected: TypeScript');
  } finally {
    uiBridge.off('askUser', handler);
  }
});

test('ask_user: free-text mode (empty options array) does not crash on object payload', async () => {
  // Even if a malformed model passes a non-array for options, ask_user must not
  // throw or stringify "[object Object]".
  const handler = ({ resolve }) => resolve('typed answer');
  uiBridge.on('askUser', handler);
  try {
    const result = await toolHandlers.ask_user({ question: 'Type your answer' });
    assert.equal(result, 'typed answer');
  } finally {
    uiBridge.off('askUser', handler);
  }
});

// ── an answer of the user's own ─────────────────────────────────────────────

test('ask_user offers a write-in line, and says plainly when the user used it', async () => {
  let payload = null;
  const handler = (p) => { payload = p; p.resolve('MariaDB, ce l\'ho già', { custom: true }); };
  uiBridge.on('askUser', handler);
  try {
    const result = await toolHandlers.ask_user({ question: 'Quale database?', options: ['PostgreSQL', 'SQLite'] });
    assert.equal(payload.freeText, true, 'the agent\'s options are suggestions, not the only answers');
    assert.match(result, /own words/);
    assert.match(result, /none of the offered options/, 'so the model does not map it onto the nearest option');
    assert.match(result, /MariaDB/);
  } finally {
    uiBridge.off('askUser', handler);
  }
});

const question = { options: ['PostgreSQL', 'SQLite', 'MongoDB'], freeText: true };
const press = (state, str, name = null) => applyAskUserKey(question, state, { str, key: name ? { name } : {} });

test('typing in the list jumps to the write-in line and fills it', () => {
  let state = { idx: 0, input: '' };
  for (const ch of 'Maria') state = press(state, ch);
  assert.equal(state.idx, 3, 'the selection moves to the write-in line');
  assert.equal(state.input, 'Maria');
  state = press(state, '', 'backspace');
  assert.equal(state.input, 'Mari');
  const sent = press(state, '', 'return');
  assert.deepEqual(sent.submit, { answer: 'Mari', custom: true });
});

test('the arrows still pick an option, and reach the write-in line past the last one', () => {
  let state = { idx: 0, input: '' };
  state = press(state, '', 'down');
  assert.deepEqual(press(state, '', 'return').submit, { answer: 'SQLite', custom: false });
  for (let i = 0; i < 5; i++) state = press(state, '', 'down');
  assert.equal(state.idx, askUserRowCount(question) - 1, 'the write-in line is the last row');
  assert.equal(press(state, '', 'return').submit, null, 'an empty write-in answers nothing');
});

test('a confirmation keeps its closed list: typing does not turn it into a write-in', () => {
  const confirm = { options: ['Sì, procedi', 'No, annulla'] };
  let state = applyAskUserKey(confirm, { idx: 0, input: '' }, { str: 'x', key: {} });
  assert.deepEqual(state, { idx: 0, input: '', submit: null });
  assert.equal(askUserRowCount(confirm), 2);
  state = applyAskUserKey(confirm, state, { str: '', key: { name: 'return' } });
  assert.deepEqual(state.submit, { answer: 'Sì, procedi', custom: false });
});

test('a question with no options is all write-in, as before', () => {
  let state = { idx: 0, input: '' };
  for (const ch of 'ok') state = applyAskUserKey({ options: [] }, state, { str: ch, key: {} });
  assert.deepEqual(applyAskUserKey({ options: [] }, state, { str: '', key: { name: 'return' } }).submit, { answer: 'ok', custom: true });
});

test('pasted text goes to the write-in line, never into a confirmation', () => {
  assert.deepEqual(pasteIntoAskUser(question, { idx: 1, input: '' }, 'una\nriga'), { idx: 3, input: 'una riga' });
  assert.deepEqual(pasteIntoAskUser({ options: ['Sì', 'No'] }, { idx: 0, input: '' }, 'x'), { idx: 0, input: '' });
});
