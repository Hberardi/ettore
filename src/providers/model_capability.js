/**
 * model_capability.js
 * Capability detection for OpenRouter (and generic OpenAI-compat) models.
 *
 * Returns one of three tiers:
 *   'full'    – tool/function calling OK, complex JSON schemas, large context
 *   'lite'    – chat-only; skip function calling and complex system prompts
 *   'unknown' – insufficient data; treat conservatively (like lite)
 */

// ─── FULL patterns (checked FIRST — protects large free models like DeepSeek-R1) ─
const FULL_PATTERNS = [
  // Explicit large param counts ≥ 14B
  /[:\-_/](\d{2,})[bB](\b|[\-_])/,    // 14b, 70b, 72b, 123b, 405b, 671b
  /\b8x7b\b/, /\b8x22b\b/,            // Mixtral MoE
  // OpenAI
  /\bgpt[-_]?4\b/, /\bgpt[-_]?4o\b/,
  /\bo[13][-_]?(mini|preview|pro)?\b/,
  // Anthropic (all sizes support tools)
  /\bclaude[-_]?(3|3\.5|opus|sonnet|haiku)\b/,
  // Mistral capable
  /\bmistral[-_]?(large|medium|next|small)\b/,
  /\bmixtral\b/, /\bcodestral\b/,
  // DeepSeek
  /\bdeepseek[-_]?v[23]\b/,
  /\bdeepseek[-_]?r[12]\b/,
  /\bdeepseek[-_]?coder[-_]?v2\b/,
  // Llama large
  /\bllama[-_]?3[\._]?[123][-_]?70b\b/,
  /\bllama[-_]?3[\._]?1[-_]?405b\b/,
  /\bllama[-_]?3[\._]?3[-_]?70b\b/,
  /\bllama[-_]?3[\._]?1[-_]?8b\b/,    // 8B can handle tools
  // Qwen capable
  /\bqwen[-_]?2\.5[-_]?(14|32|72)b\b/,
  /\bqwen[-_]?(plus|turbo|max)\b/,
  // Gemini
  /\bgemini[-_]?(1\.5|2\.0|2)[-_]?pro\b/,
  /\bgemini[-_]?(1\.5|2\.0|2)[-_]?flash(?![-_]?(lite|8b))\b/,
  // Cohere
  /\bcommand[-_]?(r[-_]?plus|r|a)\b/,
  // Others
  /\bnemotron[-_]?(70b|340b|super)\b/,
  /\bjamba\b/,
  /\bkimi[-_]?k[12]\b/, /\bmoonshot\b/,
  /\bsonar[-_]?(pro|reasoning)\b/,
  /\byi[-_]?(large|34b|lightning)\b/,
  /\bglm[-_]?4(?![-_]?(air|flash))\b/,
  /\bnova[-_]?(pro|premier)\b/,
  /\bminimax[-_]?m[23](?:\.(?:1|5|7))?(?:[-_]?highspeed)?\b/,
];

// ─── LITE patterns (checked AFTER FULL) ──────────────────────────────────────
const LITE_PATTERNS = [
  /:free$/, /[-_]free$/,              // OpenRouter :free suffix
  /\bphi[-_]?\d/, /\bphi\b/,
  /\btinyllama\b/, /\bsmollm\b/,
  /\bgemma[-_]?2[-_]?2b\b/, /\bgemma[-_]?2b\b/,
  /\bqwen[-_]?1\.5[-_]?(0\.5|1\.8|4)b\b/,
  /\bqwen[-_]?2\.5[-_]?(0\.5|1\.5|3)b\b/,
  /\bllama[-_]?3[\._]?2[-_]?(1|3)b\b/,
  /\b(tiny|nano)\b/,
  /\bflash[-_]?lite\b/, /\bflash[-_]?8b\b/,
  /\bgguf\b/, /\bq[2-5]_[0-9kKmMsS]+\b/, /\bawq\b/, /\bgptq\b/,
  /\bglm[-_]?4[-_]?(air|flash)\b/,
  /\bmistral[-_]?7b\b/,
  /\bmoondream\b/, /\bstablelm\b/, /\borca[-_]?mini\b/,
];

// Exact model IDs that are definitively lite
const LITE_EXACT = new Set([
  'google/gemma-2-2b-it:free',
  'microsoft/phi-3-mini-128k-instruct:free',
  'microsoft/phi-3-mini-4k-instruct:free',
  'microsoft/phi-3.5-mini-128k-instruct:free',
  'huggingfaceh4/zephyr-7b-beta:free',
  'openchat/openchat-7b:free',
  'gryphe/mythomist-7b:free',
  'undi95/toppy-m-7b:free',
]);

const CTX_FULL_MIN = 32_768;
const CTX_LITE_MAX =  8_192;

/**
 * Determine model capability from model ID and optional API metadata.
 * @param {string} modelId
 * @param {object} [modelMeta] Raw object from OpenRouter /models API
 * @returns {'full' | 'lite' | 'unknown'}
 */
export function getModelCapability(modelId, modelMeta = {}) {
  const id = (modelId ?? '').toLowerCase();

  // Exact override
  if (LITE_EXACT.has(id)) return 'lite';

  // API declared tool support
  const supportedParams = modelMeta?.supported_parameters;
  if (Array.isArray(supportedParams) && supportedParams.length > 0) {
    if (supportedParams.some(p => p === 'tools' || p === 'tool_choice' || p === 'functions')) {
      return 'full';
    }
  }
  const apiSaysNoTools = Array.isArray(supportedParams) && supportedParams.length > 0;

  // Context length signal
  const ctx = modelMeta?.context_length;
  let ctxSignal = null;
  if (typeof ctx === 'number') {
    if (ctx >= CTX_FULL_MIN) ctxSignal = 'full';
    else if (ctx <= CTX_LITE_MAX) ctxSignal = 'lite';
  }

  // FULL patterns first (protects large :free models)
  if (FULL_PATTERNS.some(rx => rx.test(id))) return 'full';

  // LITE patterns
  if (LITE_PATTERNS.some(rx => rx.test(id))) return 'lite';

  // Fallback combinations
  if (apiSaysNoTools) return ctxSignal === 'full' ? 'unknown' : 'lite';

  const isFreeModel = _isFreeByPricing(modelMeta) || /:free$/.test(id) || /[-_]free$/.test(id);
  if (isFreeModel && ctxSignal !== 'full') return 'unknown';

  if (ctxSignal === 'full') return 'full';
  if (ctxSignal === 'lite') return 'lite';

  return 'unknown';
}

function _isFreeByPricing(meta) {
  const p = meta?.pricing;
  if (!p) return false;
  return parseFloat(p.prompt ?? p.input ?? '1') === 0
      && parseFloat(p.completion ?? p.output ?? '1') === 0;
}
