// The questions the agent asks Jev about a turn that is trying to end.
//
// The agent already answers these with regex (see turn-recovery.js). Those
// regexes are lists of Italian and English verbs, and they carry the whole
// decision: a false yes re-prompts a model that was genuinely finished, a
// false no lets a turn end with the work half done. Jev answers the same
// questions from meaning rather than wording, and reports how sure it is.
//
// Every question is a Noul — one atomic yes/no — and all of them ride in a
// single request, evaluated in parallel against the same state. Adding a
// question costs almost nothing; asking one compound question would cost
// accuracy.

import { readChoice, readNoul } from './index.js';

// Written as statements, not questions: a Noul reports the probability that
// the statement is true.
export const TURN_QUESTIONS = {
  announced: {
    type: 'noul',
    instructions: {
      question: 'The assistant describes work it is about to do — editing, creating, running, checking something — without having done it in `assistant_reply`. Answer about this turn only.',
      note: 'A report of work already completed is not an announcement. A plan the assistant is executing right now is not an announcement.',
    },
    criteria: {
      true: 'The reply promises or announces an action that has not happened yet.',
      false: 'The reply reports work already done, answers a question, or asks the user something.',
    },
  },
  deferred: {
    type: 'noul',
    instructions: 'The assistant hands the remaining work back to the user — telling them to run, edit or check something themselves — instead of doing it.',
    criteria: {
      true: 'The user is told to perform the next step.',
      false: 'The assistant did the work itself, or the step genuinely requires the user (a password, a physical device, a decision only they can make).',
    },
  },
  unapplied_code: {
    type: 'noul',
    instructions: 'The assistant shows code for the user to copy somewhere, instead of writing it into the project files itself.',
    criteria: {
      true: 'Code is presented to be pasted or applied by the user.',
      false: 'Code is quoted to explain or report a change that was already written to a file, or no code is shown.',
    },
  },
  complete: {
    type: 'noul',
    instructions: 'Everything `user_request` asked for has been carried out in this turn, with nothing left pending.',
    criteria: {
      true: 'The request is fully satisfied.',
      false: 'Part of the request is still open, or the assistant stopped early.',
    },
  },
};

/**
 * The state Jev evaluates. Structured rather than a blob of text so each
 * question can point at the part it cares about.
 */
export function buildTurnState({ prompt, reply, toolsRan = 0, filesTouched = [], verificationDone = false }) {
  return {
    user_request: String(prompt || '').slice(0, 8000),
    assistant_reply: String(reply || '').slice(0, 8000),
    tools_used_this_turn: Number(toolsRan) || 0,
    files_changed_this_turn: filesTouched.slice(0, 20),
    verification_ran: Boolean(verificationDone),
  };
}

/**
 * Ask Jev about a finished turn. Never throws and never blocks the turn on a
 * failure: an unreachable or unsure Jev returns nulls, and the caller keeps
 * the verdict it already had.
 *
 * @returns {Promise<{ok: boolean, verdicts: object, error: string|null, usage: object|null}>}
 */
export async function judgeTurn(client, turn, { signal = null } = {}) {
  if (!client) return { ok: false, verdicts: {}, error: null, usage: null };
  try {
    const { answers, usage } = await client.evaluate({
      state: buildTurnState(turn),
      questions: TURN_QUESTIONS,
      signal,
    });
    const verdicts = {};
    for (const key of Object.keys(TURN_QUESTIONS)) {
      verdicts[key] = readNoul(answers?.[key]);
    }
    return { ok: true, verdicts, error: null, usage };
  } catch (error) {
    return { ok: false, verdicts: {}, error: error?.message || String(error), usage: null };
  }
}

/**
 * Combine one Jev verdict with the heuristic the agent would have used alone.
 * Jev only overrides when it is decisive; otherwise the regex stands. That way
 * the feature can only change an outcome Jev is actually sure about.
 */
export function resolveVerdict(heuristic, verdict) {
  if (!verdict || !verdict.decisive) return { value: Boolean(heuristic), source: 'heuristic' };
  const value = Boolean(verdict.yes);
  return { value, source: value === Boolean(heuristic) ? 'agreed' : 'jev' };
}

// ── the pre-turn judgment ──────────────────────────────────────────────────
//
// Two decisions are made before the first model call, and they ride in one
// request: many questions evaluated in parallel against one state is the shape
// Jev is built for, and adding questions barely moves the latency. Asking them
// separately would pay the round trip twice while the user waits.
//
// 1. How to investigate. ETTORE has a read-only sub-agent (the `explore` tool)
//    that answers one question about the codebase in a context of its own and
//    returns a short report, so the greps and reads behind it never fill the
//    main conversation. It is offered on every build turn and models still
//    search by hand. This is the docs' intent-routing pattern.
//
// 2. Which skills apply. Skill activation scores words — stems, exact hits,
//    thresholds, relative cutoffs — and the skill system's own comments admit
//    the guesswork: a stem match is `funziona` against `funzionale`, so "questo
//    non funziona" could wake a web-design skill. Jev reads the request against
//    each skill's description instead, which is a judgment about two pieces of
//    text and needs no sight of the codebase.

export const APPROACH_QUESTION = {
  type: 'choice',
  instructions: 'How should this request be investigated, before anything is changed? Judge the request itself, not any codebase you cannot see.',
  criteria: {
    direct: 'The files to look at are named or obvious. A couple of reads settle it.',
    explore: 'Answering needs a search across the codebase first — where something lives, how a flow works end to end, which files a change would touch — and the raw search output is not worth keeping afterwards.',
    none: 'No code needs looking at: a question about a concept, a chat message, or a task the request already specifies in full.',
  },
};

// Question ids are ours to choose and are never shown to the model, so a skill
// whose name is not a usable key gets a positional one.
function skillQuestionId(index) {
  return `skill_${index}`;
}

export function buildSkillQuestions(skills = []) {
  const questions = {};
  const byId = new Map();
  skills.forEach((skill, index) => {
    const id = skillQuestionId(index);
    byId.set(id, skill.name);
    questions[id] = {
      type: 'noul',
      instructions: {
        skill_covers: String(skill.description || skill.name).slice(0, 1000),
        question: 'The user request falls within what `skill_covers` describes, so that guidance would help answer it.',
      },
      criteria: {
        true: 'The request is about this subject, and the guidance applies to it.',
        false: 'The request is about something else. A word the two happen to share is not enough.',
      },
    };
  });
  return { questions, byId };
}

/**
 * The decisions worth making before the turn starts. Never throws: with Jev
 * off, unreachable or unsure, every field comes back undecided and the agent
 * keeps the heuristics it already had.
 *
 * @returns {Promise<{approach: object, skills: Record<string, object>, error: string|null, ms: number}>}
 */
export async function judgePreTurn(client, { prompt, skills = [] } = {}, { signal = null } = {}) {
  const empty = { approach: { choice: null, confidence: null, decisive: false }, skills: {}, error: null, ms: 0 };
  if (!client) return empty;
  const startedAt = Date.now();
  const { questions, byId } = buildSkillQuestions(skills);
  try {
    const { answers } = await client.evaluate({
      state: { user_request: String(prompt || '').slice(0, 8000) },
      questions: { approach: APPROACH_QUESTION, ...questions },
      signal,
    });
    const skillVerdicts = {};
    for (const [id, name] of byId) skillVerdicts[name] = readNoul(answers?.[id]);
    return {
      approach: readChoice(answers?.approach),
      skills: skillVerdicts,
      error: null,
      ms: Date.now() - startedAt,
    };
  } catch (error) {
    return { ...empty, error: error?.message || String(error), ms: Date.now() - startedAt };
  }
}
