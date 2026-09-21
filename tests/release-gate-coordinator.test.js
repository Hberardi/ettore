import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ReleaseGateCoordinator } from '../src/agents/release-gate-coordinator.js';
import { createReleaseGateState, recordMutation } from '../src/agents/release-gate.js';

test('release gate coordinator runs a missing suite and records its failure', async () => {
  let detects = 0;
  const runs = [];
  const coordinator = new ReleaseGateCoordinator({
    detectTestSuite: async () => { detects++; return 'npm'; },
    runTests: async args => {
      runs.push(args);
      return 'Runner: npm\nResult: FAIL\nnot ok 1 - broken';
    },
  });
  const state = createReleaseGateState();
  recordMutation(state, 'src/a.js', 'edited');
  const events = [];
  const emitter = new EventEmitter();
  emitter.on('toolStart', event => events.push(['start', event.name]));
  emitter.on('toolEnd', event => events.push(['end', event.name]));

  const result = await coordinator.check({ state, workdir: '/workspace', emitter });
  assert.equal(result.status, 'suite_failing');
  assert.equal(result.ranBy, 'harness');
  assert.equal(state.lastSuite.passed, false);
  assert.equal(detects, 1);
  assert.deepEqual(runs, [{ suite: 'auto', workdir: '/workspace' }]);
  assert.deepEqual(events, [['start', 'run_tests'], ['end', 'run_tests']]);
});

test('release gate coordinator caches suite detection and accepts a green run', async () => {
  let detects = 0;
  const coordinator = new ReleaseGateCoordinator({
    detectTestSuite: async () => { detects++; return 'npm'; },
    runTests: async () => 'Runner: npm\nResult: PASS\nok',
  });
  const state = createReleaseGateState();
  recordMutation(state, 'src/a.js', 'edited');

  assert.equal((await coordinator.check({ state, workdir: '/workspace' })).status, 'open');
  assert.equal((await coordinator.check({ state, workdir: '/workspace' })).ranBy, 'model');
  assert.equal(detects, 1);
});
