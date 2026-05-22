import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncModeWithAgent } from '../src/app/native-ui.js';

test('syncModeWithAgent toggles mode and updates agent', () => {
  const tui = { mode: 'build', needsRender: false };
  const seen = [];
  const agent = {
    setMode(mode) {
      seen.push(mode);
    },
  };

  const next = syncModeWithAgent(tui, agent);
  assert.equal(next, 'plan');
  assert.equal(tui.mode, 'plan');
  assert.equal(tui.needsRender, true);
  assert.deepEqual(seen, ['plan']);
});

test('syncModeWithAgent toggles back to build', () => {
  const tui = { mode: 'plan', needsRender: false };
  const seen = [];
  const agent = {
    setMode(mode) {
      seen.push(mode);
    },
  };

  const next = syncModeWithAgent(tui, agent);
  assert.equal(next, 'build');
  assert.equal(tui.mode, 'build');
  assert.equal(tui.needsRender, true);
  assert.deepEqual(seen, ['build']);
});
