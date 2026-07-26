import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnStateMachine } from '../src/agents/turn-state.js';

test('TurnStateMachine accepts the normal model/tool lifecycle', () => {
  const machine = new TurnStateMachine();
  for (const state of ['started', 'model', 'tool_call', 'tool_result', 'model', 'completed']) {
    assert.equal(machine.transition(state).error, undefined);
  }
  assert.equal(machine.state, 'completed');
  assert.deepEqual(machine.history.map(entry => entry.state), [
    'idle',
    'started',
    'model',
    'tool_call',
    'tool_result',
    'model',
    'completed',
  ]);
});

test('TurnStateMachine rejects impossible transitions without corrupting state', () => {
  const machine = new TurnStateMachine();
  const result = machine.transition('tool_result');
  assert.match(result.error, /idle -> tool_result/);
  assert.equal(machine.state, 'idle');
});
