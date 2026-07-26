import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { toolHandlers, normalizeAskUserOption } from '../src/tools/index.js';
import { uiBridge } from '../src/tools/bridge.js';

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
