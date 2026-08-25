// Tests for the /loop module: runtime state, persistence, JSON extraction.
// Run with: npm test (picked up by the node --test glob in package.json).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as loops from '../src/loops/index.js';

test('loops: getLoopStatus starts inactive', () => {
  const s = loops.getLoopStatus();
  assert.equal(s.active, false);
  assert.equal(s.totalSteps, 0);
});

test('loops: startLoopRuntime activates with the right step count', () => {
  loops.startLoopRuntime({
    plan: {
      goal: 'build x',
      rationale: 'r',
      steps: [
        { title: 'one', prompt: 'p1' },
        { title: 'two', prompt: 'p2' },
      ],
    },
    name: 'rt-test',
  });
  const s = loops.getLoopStatus();
  assert.equal(s.active, true);
  assert.equal(s.totalSteps, 2);
  assert.equal(s.name, 'rt-test');
  assert.deepEqual(s.steps.map(x => x.title), ['one', 'two']);
});

test('loops: advance returns each step then null', () => {
  loops.startLoopRuntime({
    plan: {
      goal: 'g',
      steps: [
        { title: 'a', prompt: 'first' },
        { title: 'b', prompt: 'second' },
      ],
    },
    name: 'advance-test',
  });
  assert.equal(loops.advanceLoopRuntime(), 'first');
  assert.equal(loops.advanceLoopRuntime(), 'second');
  assert.equal(loops.advanceLoopRuntime(), null);
  assert.equal(loops.getLoopStatus().active, false);
});

test('loops: stopLoopRuntime clears the queue and reports wasActive', () => {
  loops.startLoopRuntime({
    plan: { goal: 'g', steps: [{ title: 'a', prompt: 'a' }, { title: 'b', prompt: 'b' }] },
    name: 'stop-test',
  });
  assert.equal(loops.stopLoopRuntime(), true);
  assert.equal(loops.getLoopStatus().active, false);
  // Idempotent: stopping an inactive loop returns false.
  assert.equal(loops.stopLoopRuntime(), false);
});

test('loops: startLoopRuntime filters out empty-prompt steps', () => {
  loops.startLoopRuntime({
    plan: {
      goal: 'g',
      steps: [
        { title: 'good', prompt: 'do it' },
        { title: 'empty', prompt: '' },
        { title: 'whitespace', prompt: '   ' },
        { title: 'also good', prompt: 'next' },
      ],
    },
    name: 'filter-test',
  });
  const s = loops.getLoopStatus();
  assert.equal(s.totalSteps, 2);
  assert.deepEqual(s.steps.map(x => x.title), ['good', 'also good']);
});

test('loops: persistence roundtrip (save → load → list → delete) — isolated cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'loops-test-'));
  try {
    const plan = {
      goal: 'build an API',
      rationale: 'step by step',
      steps: [
        { title: 'scaffold', prompt: 'create the project' },
        { title: 'routes', prompt: 'add the routes' },
      ],
    };
    const saved = await loops.saveLoop('demo', plan, { goal: 'build an API' }, { cwd });
    assert.equal(saved.name, 'demo');

    const loaded = await loops.loadLoop('demo', { cwd });
    assert.equal(loaded.steps.length, 2);
    assert.equal(loaded.goal, 'build an API');

    const items = await loops.listLoops({ cwd });
    assert.ok(items.find(i => i.name === 'demo'), 'demo should appear in list');

    assert.equal(await loops.deleteLoop('demo', { cwd }), true);
    assert.equal(await loops.deleteLoop('demo', { cwd }), false); // already gone
    const after = await loops.listLoops({ cwd });
    assert.equal(after.find(i => i.name === 'demo'), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
});

test('loops: safeName sanitizes filesystem-unsafe characters', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'loops-name-'));
  try {
    await loops.saveLoop(
      'Auth System V2!',
      { goal: 'g', steps: [{ title: 'a', prompt: 'a' }] },
      {},
      { cwd },
    );
    const items = await loops.listLoops({ cwd });
    assert.equal(items.length, 1);
    // Should be lowercased, no spaces, no '!'
    assert.match(items[0].name, /^[a-z0-9_-]+$/);
    await loops.deleteLoop(items[0].name, { cwd });
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
});

test('loops: generatePlan throws on empty goal', async () => {
  await assert.rejects(
    () => loops.generatePlan('', { maxSteps: 3 }),
    /Goal is empty|No active model/,
  );
});
