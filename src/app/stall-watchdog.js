// When a wait has gone on long enough to be a fault rather than patience.
//
// Extracted from the render loop because it was being defeated by it. The loop
// bumped the activity timestamp on every frame while a tool was running, so
// that a silent tool — one that reports no progress of its own — would not look
// idle. The effect was the opposite of the intent: a tool that never returned
// kept its own watchdog fed 60 times a second, `idleMs` never exceeded a frame,
// and neither the warning nor the cancel could ever fire. A turn stuck on a
// tool stayed stuck until the user noticed.
//
// Progress now means progress the tool or the model reported. A repaint is not
// progress; it is the CLI drawing the same thing again.

// Above every per-tool timeout in getToolTimeoutMs (the longest is 300s for
// bash and the test suite), so a tool that is legitimately slow is stopped by
// its own timeout with a precise message, and this only catches what escapes
// that — a tool whose promise never settles at all.
export const TOOL_HARD_STALL_MS = 420_000;
export const TOOL_SOFT_WARN_MS = 120_000;
export const MODEL_SOFT_WARN_MS = 60_000;
// The model is expected to stream regularly; a reasoning model may pause.
export const MODEL_HARD_STALL_MS = 90_000;
export const MODEL_HARD_STALL_LONG_REASONING_MS = 180_000;

/**
 * @param {object} p
 * @param {number} p.idleMs         since the last reported progress
 * @param {'tool'|'model'} p.waitKind
 * @param {boolean} p.longReasoningModel
 * @param {number} p.overrideMs     ETTORE_STALL_TIMEOUT_MS, model waits only
 * @param {boolean} p.alreadyWarned
 * @returns {{warn: boolean, cancel: boolean, idleSec: number}}
 */
export function evaluateStall({
  idleMs,
  waitKind = 'model',
  longReasoningModel = false,
  overrideMs = 0,
  alreadyWarned = false,
} = {}) {
  const idle = Number(idleMs) || 0;
  const isTool = waitKind === 'tool';
  const hardMs = isTool
    ? TOOL_HARD_STALL_MS
    : (overrideMs > 0 ? overrideMs : (longReasoningModel ? MODEL_HARD_STALL_LONG_REASONING_MS : MODEL_HARD_STALL_MS));
  const softMs = isTool ? TOOL_SOFT_WARN_MS : MODEL_SOFT_WARN_MS;

  const idleSec = Math.round(idle / 1000);
  if (idle >= hardMs) return { warn: false, cancel: true, idleSec };
  // The warning is a one-shot, but it must not be missed when a tick lands
  // late: anything past the threshold that has not warned yet still warns.
  if (idle >= softMs && !alreadyWarned) return { warn: true, cancel: false, idleSec };
  return { warn: false, cancel: false, idleSec };
}
