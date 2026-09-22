// Jev watching a turn while it runs, not only when it tries to end.
//
// Every brake the agent loop already has counts something: identical calls,
// read-only batches, invalid batches, the per-turn tool budget. None of them
// can see a model that varies its calls while getting nowhere — the same
// failing test run with a different flag each time, a search that drifts to
// code the request never mentioned. By the time a counter trips, the turn has
// spent its budget. Those are judgments about meaning, which is what Jev reads.
//
// It is asked only now and then — on a cadence, after repeated errors, or when
// one call keeps coming back — so a turn pays for a check when there is
// something to check, and a quick turn pays nothing.

import { readNoul } from './index.js';

// Tool calls between two checks on cadence alone.
export const CHECK_EVERY_TOOL_CALLS = 8;
// Never two checks closer than this, whatever triggers them.
const MIN_CALLS_BETWEEN_CHECKS = 3;
// How much of the recent activity Jev is shown.
const RECENT_CALLS = 10;
// A check is an aside to the turn; it must not hold it up for long.
const CHECK_TIMEOUT_MS = 8_000;

export const PROGRESS_QUESTIONS = {
  looping: {
    type: 'noul',
    instructions: {
      question: 'In `recent_tool_calls` the agent keeps repeating the same kind of action without getting closer to what `user_request` asks for.',
      note: 'Running tests again after changing code is progress, not repetition. Reading several different files to understand a flow is progress.',
    },
    criteria: {
      true: 'The recent calls go round in a circle: same attempt, same outcome.',
      false: 'Each call moves the work forward, or the calls are different steps of one plan.',
    },
  },
  stuck_on_error: {
    type: 'noul',
    instructions: 'The recent tool calls keep failing with the same error, and the agent has not changed its approach in response to it.',
    criteria: {
      true: 'The same failure repeats and the agent keeps trying essentially the same fix.',
      false: 'There are no repeated failures, or each attempt tries something genuinely different.',
    },
  },
  off_track: {
    type: 'noul',
    instructions: 'The recent tool calls are about something other than what `user_request` asked for.',
    criteria: {
      true: 'The agent is working on files, features or problems the request did not ask about.',
      false: 'The work is on the request, including the code it has to read to do it.',
    },
  },
};

export function createProgressGuardState() {
  return { lastCheckAt: 0, errorStreak: 0, corrections: 0, recent: [] };
}

function preview(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Remember what one tool call did, in the few characters Jev needs. */
export function recordToolForGuard(state, { name, args = {}, output = '' }) {
  const firstArg = Object.values(args || {}).find(v => typeof v === 'string');
  const text = String(output ?? '');
  state.recent.push({
    tool: name,
    input: preview(firstArg, 160),
    outcome: preview(text, 240),
    failed: /^Error:|\[exit code [1-9]|\[timeout/i.test(text),
  });
  if (state.recent.length > RECENT_CALLS) state.recent.splice(0, state.recent.length - RECENT_CALLS);
}

/** Record whether a whole batch failed, which is what the error trigger counts. */
export function recordBatchForGuard(state, results = []) {
  const failed = results.length > 0 && results.every(r => /^Error:|\[exit code [1-9]|\[timeout/i.test(String(r.output ?? '')));
  state.errorStreak = failed ? state.errorStreak + 1 : 0;
}

/**
 * Why a check is due now, or null. `repeatedCount` is how many times the
 * turn's most repeated call has run.
 */
export function progressCheckDue(state, { toolCallCount, repeatedCount = 0 }) {
  const since = toolCallCount - state.lastCheckAt;
  if (since < MIN_CALLS_BETWEEN_CHECKS) return null;
  if (state.errorStreak >= 2) return 'errors';
  if (repeatedCount >= 3) return 'repeat';
  if (since >= CHECK_EVERY_TOOL_CALLS) return 'cadence';
  return null;
}

export function buildProgressState({ prompt, recent = [], toolsRan = 0, filesTouched = [] }) {
  return {
    user_request: String(prompt || '').slice(0, 4000),
    recent_tool_calls: recent.slice(-RECENT_CALLS),
    tools_used_this_turn: Number(toolsRan) || 0,
    files_changed_this_turn: filesTouched.slice(0, 20),
  };
}

/**
 * Ask Jev how the turn is going. Never throws: a failure comes back as
 * `ok: false` and the turn carries on as if nothing had been asked.
 */
export async function judgeProgress(client, snapshot, { signal = null } = {}) {
  if (!client) return { ok: false, verdicts: {}, error: null, ms: 0 };
  const startedAt = Date.now();
  try {
    const { answers } = await client.evaluate({
      state: buildProgressState(snapshot),
      questions: PROGRESS_QUESTIONS,
      signal,
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    const verdicts = {};
    for (const key of Object.keys(PROGRESS_QUESTIONS)) verdicts[key] = readNoul(answers?.[key]);
    return { ok: true, verdicts, error: null, ms: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, verdicts: {}, error: error?.message || String(error), ms: Date.now() - startedAt };
  }
}

/**
 * What to do with a verdict: nothing, a correction, or — for a turn already
 * corrected once and still going round in circles — stop calling tools.
 * `off_track` alone never stops a turn: drifting is worth pointing out, and
 * the model may well be reading what it needs.
 */
export function decideProgressAction(verdicts, state) {
  const issues = Object.keys(PROGRESS_QUESTIONS).filter(key => verdicts[key]?.decisive && verdicts[key].yes);
  if (!issues.length) return { action: 'ok', issues };
  const circling = issues.includes('looping') || issues.includes('stuck_on_error');
  if (circling && state.corrections >= 1) return { action: 'stop', issues };
  if (state.corrections >= 2) return { action: 'ok', issues };
  return { action: 'correct', issues };
}
