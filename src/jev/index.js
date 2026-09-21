// Jev — TypeSafe's System One model, used here as the agent's judgment layer.
//
// Jev does not generate text. It evaluates typed questions against a state and
// returns structured answers: a Noul is a yes/no probability, a Choice picks an
// option, a Score rates against a rubric. Choice and Score also carry a
// confidence. https://docs.typesafe.ai/api
//
// What that buys the agent loop: the end-of-turn decisions in turn-recovery.js
// ("did the model announce work it never did?", "did it defer the job back to
// the user?", "is this really finished?") are lists of Italian and English
// verbs matched by regex. A false yes wastes a turn re-prompting a model that
// was already done; a false no ends a turn with the work half finished. Those
// are exactly the atomic gut-checks Jev is built for.
//
// Three rules this module keeps, in order of importance:
//   1. Jev decides, it never writes. No answer of its own ever reaches the user.
//   2. One request per judgment, with every question evaluated in parallel
//      against one state — that is the shape the model is designed for, and
//      adding questions barely changes the response time.
//   3. It can always be wrong or absent. Every caller has the regex path it
//      had before, and takes it whenever Jev is off, fails, or is unsure.

import { getSecret, saveSecret, deleteSecret } from '../utils/secret-store.js';
import { getConfig, saveConfig } from '../config/index.js';
import { maskSecret } from '../utils/secrets.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
// The id the encrypted store files the key under, beside the LLM providers.
export const JEV_SECRET_ID = 'typesafe';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
// The API asks for backoff on 429/529 rather than an immediate retry.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

// A Noul answers with a probability, not a verdict: 0.97 is a confident yes,
// 0.51 is a coin flip wearing a yes. Anything inside this band around the
// middle is "Jev does not know", and the caller keeps its own heuristic.
const NOUL_DECISION_MARGIN = 0.25;
// Choice and Score report confidence directly; below this the answer is not
// worth acting on. The docs call this confidence-gated routing.
const MIN_CONFIDENCE = 0.6;

export class JevError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.retryable = retryable;
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
  });
}

export class JevClient {
  constructor({ apiKey, model = JEV_DEFAULT_MODEL, endpoint = JEV_ENDPOINT, fetchImpl = null } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = endpoint;
    this._fetch = fetchImpl || globalThis.fetch;
  }

  /**
   * Evaluate `questions` against `state` in one call.
   * @returns {Promise<{model: string, answers: object, usage: object}>}
   */
  async evaluate({ state, questions, signal = null, timeoutMs = REQUEST_TIMEOUT_MS }) {
    if (!this.apiKey) throw new JevError('no API key — activate Jev with /jev active <api key>');
    if (!questions || !Object.keys(questions).length) throw new JevError('no questions to evaluate');

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await wait(Math.min(4000, 500 * (2 ** (attempt - 1))), signal);
      }
      // A timeout of its own: a judgment is an aside to the turn, and the turn
      // must not hang on it.
      const timer = new AbortController();
      const onAbort = () => timer.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(() => timer.abort(new JevError('request timed out')), timeoutMs);
      try {
        const response = await this._fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state, model: this.model, questions }),
          signal: timer.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          const error = new JevError(
            describeStatus(response.status, detail),
            { status: response.status, retryable: RETRYABLE_STATUS.has(response.status) },
          );
          if (!error.retryable) throw error;
          lastError = error;
          continue;
        }
        const body = await response.json();
        return { model: body?.model, answers: body?.answers || {}, usage: body?.usage || {} };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof JevError && !error.retryable) throw error;
        lastError = error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    throw lastError instanceof JevError
      ? lastError
      : new JevError(`Jev unreachable: ${lastError?.message || 'unknown error'}`);
  }

  /** One Noul question, as a convenience for callers that only need a yes/no. */
  async ask(state, instructions, options = {}) {
    const { answers } = await this.evaluate({
      state,
      questions: { answer: { type: 'noul', instructions } },
      ...options,
    });
    return readNoul(answers.answer);
  }
}

function describeStatus(status, detail) {
  const tail = detail ? ` — ${String(detail).slice(0, 300)}` : '';
  if (status === 401) return 'Jev rejected the API key (401). Run /jev active <api key> with a valid key.';
  if (status === 422) return `Jev could not process the request (422)${tail}`;
  if (status === 429) return 'Jev rate limit reached (429).';
  if (status === 529) return 'Jev is temporarily overloaded (529).';
  return `Jev returned HTTP ${status}${tail}`;
}

/**
 * A Noul answer as a decision: `{ value, yes, decisive }`. `yes` is only
 * meaningful when `decisive` is true — otherwise the model is near the middle
 * and the caller should keep its own judgment.
 */
export function readNoul(answer, { margin = NOUL_DECISION_MARGIN } = {}) {
  const value = Number(answer?.noul);
  if (!Number.isFinite(value)) return { value: null, yes: false, decisive: false };
  return {
    value,
    yes: value > 0.5,
    decisive: Math.abs(value - 0.5) >= margin,
  };
}

/** A Choice answer as a decision, gated on the confidence Jev reports. */
export function readChoice(answer, { minConfidence = MIN_CONFIDENCE } = {}) {
  const choice = answer?.choice;
  const confidence = Number(answer?.confidence);
  if (typeof choice !== 'string' || !Number.isFinite(confidence)) {
    return { choice: null, confidence: null, decisive: false };
  }
  return { choice, confidence, decisive: confidence >= minConfidence };
}

// ── activation state ────────────────────────────────────────────────────────
//
// The key lives in the encrypted store next to the LLM provider keys; the
// on/off switch is ordinary config, so turning Jev off never destroys the key.

export function getJevKey() {
  return process.env.TYPESAFE_API_KEY || getSecret(JEV_SECRET_ID) || null;
}

/**
 * Jev is on when there is a key and nothing has switched it off.
 *
 * `TYPESAFE_API_KEY` in the environment is enough on its own: exporting the
 * key is a clear statement of intent, and it gives anyone who cannot reach the
 * command — a script, a sandbox, a CLI already running — a way in. An explicit
 * `/jev out` still wins over it, so turning the feature off never depends on
 * unsetting a variable.
 */
export function isJevEnabled() {
  if (!getJevKey()) return false;
  const flag = getConfig('jevEnabled');
  if (flag === false) return false;
  return flag === true || Boolean(process.env.TYPESAFE_API_KEY);
}

/** Store the key and switch Jev on. Returns the masked key for display. */
export function activateJev(apiKey, { model = JEV_DEFAULT_MODEL } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new JevError('missing API key — usage: /jev active <api key>');
  saveSecret(JEV_SECRET_ID, key);
  saveConfig('jevEnabled', true);
  saveConfig('jevModel', model);
  return { masked: maskSecret(key), model };
}

/**
 * Switch Jev off. The key is kept by default, so /jev active works again with
 * no argument; `forget` deletes it.
 */
export function deactivateJev({ forget = false } = {}) {
  saveConfig('jevEnabled', false);
  if (forget) deleteSecret(JEV_SECRET_ID);
  return { forgotten: forget };
}

/** The client for the active configuration, or null when Jev is off. */
export function getJevClient(overrides = {}) {
  if (!isJevEnabled()) return null;
  return new JevClient({
    apiKey: getJevKey(),
    model: getConfig('jevModel') || JEV_DEFAULT_MODEL,
    ...overrides,
  });
}
