// What must survive the next elision.
//
// When the context fills, older tool results are cut down to a one-line stump.
// Which ones is decided by shape and age: the newest read of each recent file
// and one failing command are kept, everything else goes. That heuristic keeps
// the right thing often enough to be worth having and wrong often enough to
// cost real time — the grep that located the bug, the test output the fix is
// being written against, the API response the next call needs. Each wrong cut
// is paid for twice: once in the tokens spent re-fetching, once in the step
// the user waits through.
//
// Jev is asked about the handful of results that are actually about to be cut,
// against the goal of the turn. A decisive "still needed" keeps one whole; an
// unsure answer leaves the heuristic in charge. Every result is judged at most
// once, and only when a batch of them has piled up, so a long session pays for
// a few calls rather than one per step.

import { readNoul } from './index.js';

const CHECK_TIMEOUT_MS = 8_000;
// Below this there is nothing worth a round trip: the heuristic's own batching
// waits for a few results to pile up before eliding anything at all.
export const MIN_CANDIDATES = 4;
// Asking about more than this in one call means the state carries more text
// than the results are worth.
export const MAX_CANDIDATES = 8;

function candidateQuestion(candidate) {
  return {
    type: 'noul',
    instructions: {
      question: 'The agent still needs the content of `this_result` to finish `user_goal`, so cutting it to a one-line stump would cost it a second look.',
      note: 'It is still needed when the work is being written against it — the file being changed, the failure being fixed, the data being used. It is not needed when it has been superseded by a newer result, when its job is done, or when it was a dead end.',
      this_result: {
        tool: candidate.tool,
        input: candidate.input,
        size_chars: candidate.size,
        preview: candidate.preview,
      },
    },
    criteria: {
      true: 'Losing this content would make the agent fetch it again.',
      false: 'The agent can finish without it.',
    },
  };
}

/**
 * Ask which of `candidates` to keep whole.
 *
 * @param {object|null} client
 * @param {object} p
 * @param {string} p.goal          what the turn is trying to do
 * @param {Array} p.candidates     `{id, tool, input, size, preview}`, newest first
 * @returns {Promise<{ok: boolean, keep: Set<string>, judged: string[], ms: number, error: string|null}>}
 *   `keep` holds the ids Jev is sure about; `judged` every id it answered for,
 *   so the caller never asks about the same result twice.
 */
export async function judgeContextKeep(client, { goal, candidates = [] } = {}, { signal = null } = {}) {
  const empty = { ok: false, keep: new Set(), judged: [], ms: 0, error: null };
  if (!client || candidates.length < MIN_CANDIDATES) return empty;
  const batch = candidates.slice(0, MAX_CANDIDATES);
  const questions = {};
  const byId = new Map();
  batch.forEach((candidate, index) => {
    const key = `keep_${index}`;
    byId.set(key, candidate.id);
    questions[key] = candidateQuestion(candidate);
  });
  const startedAt = Date.now();
  try {
    const { answers } = await client.evaluate({
      state: { user_goal: String(goal || '').slice(0, 4000), results_in_question: batch.length },
      questions,
      signal,
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    const keep = new Set();
    const judged = [];
    for (const [key, id] of byId) {
      const verdict = readNoul(answers?.[key]);
      if (!verdict.decisive) continue;
      judged.push(id);
      if (verdict.yes) keep.add(id);
    }
    return { ok: true, keep, judged, ms: Date.now() - startedAt, error: null };
  } catch (error) {
    return { ...empty, ms: Date.now() - startedAt, error: error?.message || String(error) };
  }
}
