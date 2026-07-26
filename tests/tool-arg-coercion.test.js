import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceToolArgsToSchema, validateToolArgs } from '../src/tools/index.js';

// Regression: MiniMax M3 sends numeric tool arguments as JSON strings
// ({"offset":"5020","limit":"90"}). The schema check rejected them as type
// errors, three turns in a row tripped the invalid-tool-call breaker, and the
// run died on a call whose values were perfectly correct.
test('numeric arguments sent as strings are coerced and then validate', () => {
  const raw = { file_path: '/tmp/app.py', offset: '5020', limit: '90' };
  assert.equal(validateToolArgs('read', raw).valid, false, 'precondition: raw strings fail');

  const coerced = coerceToolArgsToSchema('read', raw);
  assert.strictEqual(coerced.offset, 5020);
  assert.strictEqual(coerced.limit, 90);
  assert.equal(coerced.file_path, '/tmp/app.py', 'string fields are left alone');
  assert.equal(validateToolArgs('read', coerced).valid, true);
});

test('coercion refuses anything lossy or ambiguous', () => {
  for (const bad of ['', '  ', 'abc', '12abc', '0x10', '1e3', 'NaN', 'Infinity', '1,5']) {
    const out = coerceToolArgsToSchema('read', { file_path: '/a', offset: bad });
    assert.strictEqual(out.offset, bad, `must not coerce ${JSON.stringify(bad)}`);
  }
});

test('an integer field accepts an integral float but never a fractional one', () => {
  // todo_write.index is declared integer. "2.0" is exactly 2; "2.5" is not an
  // index at all, and silently truncating it would complete the wrong step.
  assert.strictEqual(coerceToolArgsToSchema('todo_write', { action: 'complete', index: '2.0' }).index, 2);

  const fractional = coerceToolArgsToSchema('todo_write', { action: 'complete', index: '2.5' });
  assert.strictEqual(fractional.index, '2.5', 'left alone so validation still reports it');
  assert.equal(validateToolArgs('todo_write', fractional).valid, false);
});

test('boolean fields coerce from their JSON string forms only', () => {
  assert.strictEqual(coerceToolArgsToSchema('list_dir', { path: '.', recursive: 'true' }).recursive, true);
  assert.strictEqual(coerceToolArgsToSchema('list_dir', { path: '.', recursive: 'FALSE' }).recursive, false);
  assert.strictEqual(coerceToolArgsToSchema('list_dir', { path: '.', recursive: 'yes' }).recursive, 'yes');
});

test('array fields coerce from a JSON array string', () => {
  const out = coerceToolArgsToSchema('todo_write', { action: 'set', items: '["a","b"]' });
  assert.deepEqual(out.items, ['a', 'b']);
  assert.equal(validateToolArgs('todo_write', out).valid, true);

  // Not an array literal: leave it, so the model gets a real error.
  const bad = coerceToolArgsToSchema('todo_write', { action: 'set', items: 'a, b' });
  assert.strictEqual(bad.items, 'a, b');
});

test('a string field accepts a number the model sent unquoted', () => {
  assert.strictEqual(coerceToolArgsToSchema('list_dir', { path: 42 }).path, '42');
});

test('already-correct arguments are returned untouched, same object', () => {
  const args = { file_path: '/tmp/app.py', offset: 10, limit: 20 };
  assert.strictEqual(coerceToolArgsToSchema('read', args), args);
});

test('unknown tools and non-object args pass through unchanged', () => {
  const args = { whatever: '1' };
  assert.strictEqual(coerceToolArgsToSchema('not_a_real_tool', args), args);
  assert.strictEqual(coerceToolArgsToSchema('read', null), null);
  const arr = ['a'];
  assert.strictEqual(coerceToolArgsToSchema('read', arr), arr);
});
