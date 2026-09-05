// Per-model API limits: how much the model may write, and how hard it may be
// asked to think.
//
// Kept apart from utils/pricing.js on purpose — that table answers "what does
// this cost and how much context does it have", these answer "what will the
// API accept". They move for different reasons and are read by different code.

// Ceiling applied to a model we have no facts about. Deliberately small: an
// unknown model is as likely to reject a large ceiling as to use it well.
export const DEFAULT_OUTPUT_TOKENS = 8192;

// What we ask for on a model that can take it. Not the model's maximum —
// `max_tokens` is a stop, not a target, but on a model with adaptive thinking
// the budget is shared between reasoning and the answer, so a ceiling tuned
// for answers alone cuts the reasoning off first. This is the room to think,
// and it is only ever billed if it is used.
export const AGENTIC_OUTPUT_TOKENS = 32_768;

// Known output ceilings, longest key winning as in the pricing lookup so a
// point release cannot be priced off its predecessor's row.
const OUTPUT_LIMITS = [
  ['claude-fable-5', 128_000],
  ['claude-opus-5', 128_000],
  ['claude-opus-4-8', 128_000],
  ['claude-opus-4-7', 128_000],
  ['claude-opus-4-6', 128_000],
  ['claude-opus-4-5', 64_000],
  ['claude-sonnet-5', 128_000],
  ['claude-sonnet-4-6', 128_000],
  ['claude-sonnet-4-5', 64_000],
  ['claude-haiku-4-5', 64_000],
  // Claude 3 rejects anything above 4096 with a 400 before generating a token.
  ['claude-3-opus', 4096],
  ['claude-3-sonnet', 4096],
  ['claude-3-haiku', 4096],
  ['claude-3-5-sonnet', 8192],
  ['claude-3-5-haiku', 8192],
  ['claude-3-7-sonnet', 8192],
];

// The `claude` CLI resolves these to the current model of that tier.
const ALIAS_LIMITS = {
  opus: 128_000,
  sonnet: 128_000,
  haiku: 64_000,
  opusplan: 128_000,
  default: 128_000,
};

function lookup(model, table) {
  const id = String(model || '').toLowerCase().trim();
  if (!id) return null;
  let best = null;
  let bestLen = 0;
  for (const [key, value] of table) {
    if (key.length > bestLen && (id === key || id.startsWith(key) || id.includes(key))) {
      best = value;
      bestLen = key.length;
    }
  }
  return best;
}

/** The model's own output ceiling, or null when we have no fact about it. */
export function modelOutputLimit(model) {
  const id = String(model || '').toLowerCase().trim();
  if (Object.hasOwn(ALIAS_LIMITS, id)) return ALIAS_LIMITS[id];
  return lookup(model, OUTPUT_LIMITS);
}

/**
 * How many tokens to allow this turn.
 *
 * An explicit request (user config) is honoured but still clamped to what the
 * model accepts — asking for 8192 on Claude 3 is a 400, not a long answer.
 * With nothing requested, a known model gets room to think and an unknown one
 * gets the conservative default.
 */
export function resolveOutputCap(model, requested = null) {
  const limit = modelOutputLimit(model);
  const wanted = Number(requested);
  if (Number.isFinite(wanted) && wanted > 0) {
    return limit ? Math.min(wanted, limit) : wanted;
  }
  if (limit === null) return DEFAULT_OUTPUT_TOKENS;
  return Math.min(AGENTIC_OUTPUT_TOKENS, limit);
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A recognised effort level, or null. Case- and whitespace-tolerant. */
export function normalizeEffort(value) {
  const level = String(value || '').toLowerCase().trim();
  return EFFORT_LEVELS.includes(level) ? level : null;
}

// Models that accept `effort` at all. Sonnet 4.5 and Haiku 4.5 reject it, so
// sending it there turns a working request into a 400 — the feature has to be
// gated on the model, not on the provider.
const EFFORT_MODELS = [
  'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7',
  'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-5', 'claude-sonnet-4-6',
];
const EFFORT_ALIASES = new Set(['opus', 'sonnet', 'opusplan', 'default']);
// Opus 4.5 has the ladder but not its top two rungs.
const NO_TOP_RUNGS = ['claude-opus-4-5'];

export function supportsEffort(model) {
  const id = String(model || '').toLowerCase().trim();
  if (!id) return false;
  if (EFFORT_ALIASES.has(id)) return true;
  return EFFORT_MODELS.some(key => id === key || id.startsWith(key) || id.includes(key));
}

/**
 * The effort level to send for this model, or null to send none.
 *
 * Returning null rather than a default matters: omitting `effort` means the
 * API's own default, which is what we want everywhere we have no opinion.
 */
export function effortFor(model, requested) {
  const level = normalizeEffort(requested);
  if (!level || !supportsEffort(model)) return null;
  const id = String(model).toLowerCase().trim();
  if (NO_TOP_RUNGS.some(key => id.includes(key)) && (level === 'xhigh' || level === 'max')) {
    return 'high';
  }
  return level;
}
