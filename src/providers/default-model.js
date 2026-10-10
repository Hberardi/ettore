// Which model a freshly connected provider starts on.
//
// It used to be "the first one in the list". For the providers with a list
// written by hand that is a decision; for every provider whose list comes
// from its `/models` endpoint it is the alphabet's. A new user with a Google
// key in the environment was put on `models/antigravity-preview-05-2026`,
// sent "hello", and got `400 status code (no body)` back as their first
// experience of the CLI — while `gemini-2.5-flash` sat further down the list.
//
// Model ids change faster than this file will be edited, so nothing here
// names a model. It reads what the id says about itself: whether it is a chat
// model at all, whether it is a preview, whether ETTORE knows its price (the
// mainstream ones) and can drive tools with it, and which version it is.

import { getModelCapability } from './model_capability.js';
import { getModelPricing } from '../utils/pricing.js';

const idOf = model => (typeof model === 'string' ? model : model?.id) || '';

// A catalog lists everything the key can call. Most of that cannot hold a
// conversation, let alone call tools.
const NOT_CHAT_RE = /embed|rerank|moderat|guard|whisper|transcri|tts|speech|audio|voice|realtime|\blive\b|image|imagen|dall-?e|veo|video|sora|music|lyria|ocr|aqa|robotics|computer-use|similarity|search-preview|deep-research/i;
// Works, probably — but not what to hand someone who has not chosen it.
const UNSETTLED_RE = /preview|experimental|\bexp\b|-exp-|beta|alpha|nightly|canary|latest-internal/i;
// A dated snapshot of a model that also has a plain name; the plain one moves
// with the provider.
const SNAPSHOT_RE = /[-@](?:20\d{2}-?\d{2}-?\d{2}|\d{4})$/;
// The small end of a family: fine for a chat, weak at a long tool loop.
const SMALL_RE = /nano|tiny|\b[0-9.]+[bB]?-?lite\b|-lite\b|-8b\b|\b[0-3](?:\.\d+)?b\b|mini(?!max)/i;

/** The leading version number in an id: `gemini-2.5-flash` → 2.5. */
function versionOf(id) {
  const match = /(?:^|[-_/ v])(\d{1,2}(?:\.\d{1,2})?)(?=[-_.: ]|$)/.exec(id.replace(/^models\//, ''));
  return match ? Number(match[1]) : 0;
}

export function defaultModelScore(model) {
  const id = idOf(model);
  let score = 0;
  if (NOT_CHAT_RE.test(id)) score -= 100;
  if (UNSETTLED_RE.test(id)) score -= 4;
  if (SNAPSHOT_RE.test(id)) score -= 1;
  if (SMALL_RE.test(id)) score -= 2;
  if (getModelPricing(id).in !== null) score += 2;
  const capability = getModelCapability(id, typeof model === 'object' && model ? model : {});
  if (capability === 'full') score += 3;
  else if (capability === 'lite') score -= 3;
  return score;
}

/**
 * The model to make active when the user has not picked one.
 *
 * @param {Array<string|{id: string}>} models what the provider offers
 * @param {{curated?: Array<string|{id: string}>}} options `curated`: the
 *   provider's hand-written list, in its own order of preference. Its first
 *   entry that the provider still offers wins outright.
 * @returns {string|null}
 */
export function pickDefaultModel(models = [], { curated = [] } = {}) {
  const ids = models.map(idOf).filter(Boolean);
  if (!ids.length) return null;
  for (const wanted of curated.map(idOf)) {
    if (wanted && ids.includes(wanted)) return wanted;
  }
  let best = null;
  models.forEach((model, index) => {
    const id = idOf(model);
    if (!id) return;
    const candidate = { id, score: defaultModelScore(model), version: versionOf(id), index };
    if (!best
      || candidate.score > best.score
      || (candidate.score === best.score && candidate.version > best.version)) {
      best = candidate;
    }
  });
  return best.id;
}
