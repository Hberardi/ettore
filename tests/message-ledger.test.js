import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeToolTurn,
  collectToolCallIds,
  repairMessageHistory,
  safeHistoryKeepStart,
  validateMessageHistory,
} from '../src/agents/message-ledger.js';

test('message ledger accepts a complete ordered tool exchange', () => {
  const messages = [
    { role: 'user', content: 'read it' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'body' },
  ];
  assert.deepEqual(validateMessageHistory(messages), { valid: true, issues: [] });
});

test('message ledger detects orphaned and out-of-order tool results', () => {
  const messages = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'a', function: { name: 'read', arguments: '{}' } },
        { id: 'b', function: { name: 'grep', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'b', content: 'second' },
    { role: 'tool', tool_call_id: 'a', content: 'first' },
    { role: 'tool', tool_call_id: 'orphan', content: 'bad' },
  ];
  const result = validateMessageHistory(messages);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.code === 'tool_result_mismatch'));
  assert.ok(result.issues.some(issue => issue.code === 'orphan_tool_result'));
});

test('repairMessageHistory removes unmatched calls and restores strict order', () => {
  const messages = [
    { role: 'system', content: 'system' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'a', function: { name: 'read', arguments: '{}' } },
        { id: 'b', function: { name: 'grep', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'b', content: 'second' },
    { role: 'tool', tool_call_id: 'orphan', content: 'bad' },
  ];
  const result = repairMessageHistory(messages);
  assert.equal(result.repaired, true);
  assert.equal(result.valid, true);
  assert.deepEqual(result.messages[1].tool_calls.map(call => call.id), ['b']);
  assert.equal(result.messages[2].tool_call_id, 'b');
  assert.equal(result.messages.some(message => message.tool_call_id === 'orphan'), false);
});

test('canonicalizeToolTurn repairs missing and duplicate ids', () => {
  const result = canonicalizeToolTurn({
    tool_calls: [
      { function: { name: 'read', arguments: '{}' } },
      { id: 'same', function: { name: 'grep', arguments: '{}' } },
      { id: 'same', function: { name: 'glob', arguments: '{}' } },
    ],
    message: { content: null },
  });
  assert.equal(result.calls.length, 3);
  assert.equal(new Set(result.calls.map(call => call.id)).size, 3);
  assert.ok(result.issues.some(issue => issue.code === 'missing_tool_call_id'));
  assert.ok(result.issues.some(issue => issue.code === 'duplicate_tool_call_id'));
});

test('safeHistoryKeepStart never starts inside tool results', () => {
  const messages = [
    { role: 'user', content: 'old' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'a', function: { name: 'read', arguments: '{}' } },
        { id: 'b', function: { name: 'grep', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'a', content: 'a' },
    { role: 'tool', tool_call_id: 'b', content: 'b' },
    { role: 'assistant', content: 'done' },
  ];
  assert.equal(safeHistoryKeepStart(messages, 2), 1);
});

// ─── Ids that repeat across turns ────────────────────────────────────────────
// Regression: MiniMax mints tool-call ids from the tool name and its slot, so
// the first bash call of every turn is `bash:0`. canonicalizeToolTurn only
// deduplicated within a batch while validateMessageHistory checks ids across
// the whole history, so the second such turn poisoned the ledger and *every*
// later turn died with "Internal message ledger invalid".

function toolTurn(id, name, output) {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: id, content: output },
  ];
}

test('a history reusing one id across turns is repaired, not rejected', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    ...toolTurn('bash:0', 'bash', 'first output'),
    ...toolTurn('bash:0', 'bash', 'second output'),
  ];
  assert.equal(validateMessageHistory(messages).valid, false, 'precondition: the duplicate is a real problem');

  const out = repairMessageHistory(messages);
  assert.equal(out.valid, true, `repair left it invalid: ${JSON.stringify(out.issues)}`);
  assert.equal(validateMessageHistory(out.messages).valid, true);

  const ids = out.messages.filter(m => m.role === 'assistant' && m.tool_calls)
    .flatMap(m => m.tool_calls.map(c => c.id));
  assert.equal(new Set(ids).size, ids.length, `ids still collide: ${ids}`);
});

test('renaming a call carries its result with it', () => {
  const out = repairMessageHistory([
    { role: 'user', content: 'go' },
    ...toolTurn('bash:0', 'bash', 'FIRST'),
    ...toolTurn('bash:0', 'bash', 'SECOND'),
  ]);

  const pairs = [];
  for (let i = 0; i < out.messages.length; i++) {
    const m = out.messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      pairs.push({ callId: m.tool_calls[0].id, result: out.messages[i + 1] });
    }
  }
  assert.equal(pairs.length, 2);
  for (const { callId, result } of pairs) {
    assert.equal(result.role, 'tool');
    assert.equal(result.tool_call_id, callId, 'the result must follow its renamed call');
  }
  // Each turn keeps its own output — renaming must not shuffle them.
  assert.equal(pairs[0].result.content, 'FIRST');
  assert.equal(pairs[1].result.content, 'SECOND');
});

test('three turns on the same id all end up distinct', () => {
  const out = repairMessageHistory([
    { role: 'user', content: 'go' },
    ...toolTurn('bash:0', 'bash', 'a'),
    ...toolTurn('bash:0', 'bash', 'b'),
    ...toolTurn('bash:0', 'bash', 'c'),
  ]);
  assert.equal(out.valid, true, JSON.stringify(out.issues));
  const ids = out.messages.filter(m => m.tool_calls).flatMap(m => m.tool_calls.map(c => c.id));
  assert.deepEqual([...new Set(ids)].length, 3, `expected 3 distinct ids, got ${ids}`);
});

test('a clean history is left exactly as it was', () => {
  const messages = [
    { role: 'user', content: 'go' },
    ...toolTurn('call_1', 'bash', 'a'),
    ...toolTurn('call_2', 'read', 'b'),
  ];
  const out = repairMessageHistory(messages);
  assert.equal(out.repaired, false, `needless repair: ${JSON.stringify(out.issues)}`);
  const ids = out.messages.filter(m => m.tool_calls).flatMap(m => m.tool_calls.map(c => c.id));
  assert.deepEqual(ids, ['call_1', 'call_2']);
});

test('usedIds keeps a fresh turn from colliding with the ledger', () => {
  const history = [
    { role: 'user', content: 'go' },
    ...toolTurn('bash:0', 'bash', 'earlier'),
  ];
  const used = collectToolCallIds(history);
  assert.deepEqual([...used], ['bash:0']);

  const canonical = canonicalizeToolTurn({
    tool_calls: [{ id: 'bash:0', type: 'function', function: { name: 'bash', arguments: '{}' } }],
  }, { usedIds: used });

  assert.notEqual(canonical.calls[0].id, 'bash:0', 'a new turn must not reuse an id already in the ledger');
  assert.equal(canonical.sourceIds[0], 'bash:0', 'the original id is reported so results can be matched');
});

test('collectToolCallIds ignores anything that is not an assistant tool call', () => {
  const ids = collectToolCallIds([
    { role: 'system', content: 'x' },
    { role: 'tool', tool_call_id: 'not-a-call', content: 'y' },
    { role: 'assistant', content: 'plain' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'real', function: { name: 'bash' } }] },
  ]);
  assert.deepEqual([...ids], ['real']);
});
