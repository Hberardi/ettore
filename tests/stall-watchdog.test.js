// The watchdog that was being defeated by the thing it watches.
//
// The render loop refreshed the activity timestamp on every frame while a tool
// ran, so a tool that never returned kept its own watchdog fed 60 times a
// second: idleMs never passed one frame, and neither the warning nor the
// cancel could fire. These tests describe progress as something the tool or
// the model reports, never something the CLI drew.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateStall,
  TOOL_HARD_STALL_MS,
  TOOL_SOFT_WARN_MS,
  MODEL_HARD_STALL_MS,
  MODEL_HARD_STALL_LONG_REASONING_MS,
} from '../src/app/stall-watchdog.js';

test('a tool that reports nothing is warned about, then cancelled', () => {
  assert.deepEqual(
    evaluateStall({ idleMs: 5_000, waitKind: 'tool' }),
    { warn: false, cancel: false, idleSec: 5 },
  );
  const warned = evaluateStall({ idleMs: TOOL_SOFT_WARN_MS + 10, waitKind: 'tool' });
  assert.equal(warned.warn, true);
  assert.equal(warned.cancel, false);
  const dead = evaluateStall({ idleMs: TOOL_HARD_STALL_MS + 10, waitKind: 'tool' });
  assert.equal(dead.cancel, true);
});

test('the warning fires once, but a late tick does not lose it', () => {
  // One-shot, so a second tick past the threshold stays quiet...
  assert.equal(evaluateStall({ idleMs: TOOL_SOFT_WARN_MS + 10, waitKind: 'tool', alreadyWarned: true }).warn, false);
  // ...but a tick that lands well past it, having never warned, still warns.
  // The old inline check only fired inside a 1.5s window after the threshold.
  assert.equal(evaluateStall({ idleMs: TOOL_SOFT_WARN_MS + 90_000, waitKind: 'tool' }).warn, true);
});

test('the tool ceiling sits above every per-tool timeout', async () => {
  const { getToolTimeoutMs } = await import('../src/agents/index.js');
  // A tool that is legitimately slow must be stopped by its own timeout, with
  // its own message — not by a watchdog that cannot say which tool it was.
  for (const name of ['bash', 'run_tests', 'run_checks', 'read', 'file_info']) {
    assert.ok(
      getToolTimeoutMs(name) < TOOL_HARD_STALL_MS,
      `${name} (${getToolTimeoutMs(name)}ms) must expire before the watchdog at ${TOOL_HARD_STALL_MS}ms`,
    );
  }
});

test('a model wait is judged on its own thresholds', () => {
  assert.equal(evaluateStall({ idleMs: MODEL_HARD_STALL_MS + 10, waitKind: 'model' }).cancel, true);
  // A reasoning model is allowed its longer pauses.
  assert.equal(
    evaluateStall({ idleMs: MODEL_HARD_STALL_MS + 10, waitKind: 'model', longReasoningModel: true }).cancel,
    false,
  );
  assert.equal(
    evaluateStall({ idleMs: MODEL_HARD_STALL_LONG_REASONING_MS + 10, waitKind: 'model', longReasoningModel: true }).cancel,
    true,
  );
});

test('the override applies to model waits and never shortens a tool ceiling', () => {
  assert.equal(evaluateStall({ idleMs: 6_000, waitKind: 'model', overrideMs: 5_000 }).cancel, true);
  assert.equal(evaluateStall({ idleMs: 6_000, waitKind: 'tool', overrideMs: 5_000 }).cancel, false);
});
