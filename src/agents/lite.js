/**
 * lite.js — Support layer for small/free models
 *
 * When a model is detected as "lite" (small params, :free suffix, etc.):
 *  - A simplified system prompt replaces the full one (no tool refs)
 *  - Tool schemas are NOT sent (tools = [])
 *  - Output is checked for hallucination patterns
 *  - A helpful fallback message guides the user to better models
 */

// ─── Lite system prompt (~550 chars, no tool references) ─────────────────────
export const LITE_SYSTEM_PROMPT =
`You are ETTORE, a coding assistant. Working dir: {{WORKDIR}}

Rules:
- Reply in the same language the user writes in.
- Be concise and direct. No preamble.
- For code: show complete, working snippets.
- For file edits: show the exact lines to change with enough context.
- Never invent file paths or function names you have not seen.
- If unsure, say so briefly. Do not guess.
- One task at a time. Ask if the request is ambiguous.`;

// ─── Model detection heuristics ──────────────────────────────────────────────
const LITE_PATTERNS = [
  /[:\-_](\d)b(\b|[\-_])/i,            // ≤9B: -7b, -3b, -1b
  /[:\-_](0\.\d+)b/i,                  // 0.5b, 1.5b
  /\bphi[-_]?(1|2|3|mini|small)/i,
  /\bgemma[-_]?2b\b/i,
  /\btinyllama\b/i, /\bsmollm\b/i,
  /\bqwen[\d.]*[-_]?(0\.5|1\.5|3)b\b/i,
  /\bllama[-_]?3[-_]?[13]b\b/i,
  /\bmistral[-_]?7b\b/i,
  /\bdeepseek[-_]?1\.5b\b/i,
  /\bmoondream\b/i, /\bstablelm\b/i,
  /\borca[-_]?mini\b/i,
  /[:_-]free$/i,                        // OpenRouter :free suffix
];

/** Returns true if model is small/weak and needs lite mode */
export function isLiteModel(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  return LITE_PATTERNS.some(re => re.test(modelId));
}

// ─── Garbage / hallucination detector ────────────────────────────────────────

/**
 * Detect hallucinated output from models that can't handle complex prompts.
 * @param {string} text
 * @returns {{ isGarbage: boolean, confidence: number, reason: string }}
 */
export function isGarbageOutput(text) {
  if (!text || typeof text !== 'string' || text.length < 20) {
    return { isGarbage: false, confidence: 0, reason: 'empty input' };
  }

  const reasons = [];
  let score = 0;

  // A) Mixed scripts in first 200 chars
  const sample = text.slice(0, 200);
  const SCRIPTS = {
    cjk:        /[\u3000-\u9fff\uf900-\ufaff]/,
    cyrillic:   /[\u0400-\u04ff]/,
    arabic:     /[\u0600-\u06ff]/,
    devanagari: /[\u0900-\u097f]/,
    hangul:     /[\uac00-\ud7af]/,
    thai:       /[\u0e00-\u0e7f]/,
  };
  const hasLatin = /[a-zA-Z]{3,}/.test(sample);
  const foreign = Object.entries(SCRIPTS).filter(([, re]) => re.test(sample));
  if (hasLatin && foreign.length >= 2) {
    score += 45; reasons.push(`mixed scripts (${foreign.map(([k]) => k).join(', ')}) in first 200 chars`);
  } else if (hasLatin && foreign.length === 1) {
    score += 20; reasons.push(`foreign script (${foreign[0][0]}) mixed with Latin`);
  }

  // B) Token/char repetition
  const repMatch = text.match(/(\b\w{2,}\b)(\s+\1){5,}/i);
  if (repMatch) { score += 40; reasons.push(`repeated token: "${repMatch[1]}"`); }
  if (/(.)\1{9,}/.test(text)) { score += 25; reasons.push('character-level repetition burst'); }

  // C) Fake placeholder paths
  const FAKE_PATHS = [/\/sample\/\w/i, /\/path\/to\//i, /\/your[-_/]?\w+\//i,
                      /\/test\/write\//i, /\/foo\/bar/i, /\/example\//i];
  const fakeHits = FAKE_PATHS.filter(re => re.test(text)).length;
  if (fakeHits >= 2) { score += 30; reasons.push(`${fakeHits} fake placeholder paths`); }
  else if (fakeHits === 1) { score += 10; }

  // D) Consonant-cluster word salad (BPE artefacts)
  const salad = (text.match(/\b[b-df-hj-np-tv-z]{5,}\b/gi) || []).length;
  if (salad >= 3) { score += 35; reasons.push(`${salad} consonant-cluster words`); }

  // E) Ellipsis chains
  const ellipsis = (text.match(/[.…]{4,}/g) || []).length;
  if (ellipsis >= 3) { score += 30; reasons.push(`${ellipsis} ellipsis chains`); }
  else if (ellipsis >= 1) { score += 10; }

  // F) Leaked stop tokens
  const STOP = [/[<|]endoftext[|>]/i, /[<|]im_end[|>]/i, /\[\/INST\]/, /<<SYS>>/,
                /[<|]eot_id[|>]/i, /\bHuman:\s/, /\bAssistant:\s/];
  const stopHits = STOP.filter(re => re.test(text)).length;
  if (stopHits >= 1) { score += 40; reasons.push(`leaked stop token(s)`); }

  // G) Code-block language spam in short output
  const langs = new Set((text.match(/```(\w+)/g) || []).map(s => s.slice(3)));
  if (langs.size >= 4 && text.length < 300) {
    score += 25; reasons.push(`${langs.size} code-block languages in short response`);
  }

  score = Math.min(100, score);
  const isGarbage = score >= 40;
  return {
    isGarbage,
    confidence: score / 100,
    reason: reasons.length
      ? reasons.join('; ')
      : (isGarbage ? 'multiple weak signals' : 'output looks clean'),
  };
}

// ─── Fallback message ─────────────────────────────────────────────────────────

const SUGGESTED_MODELS = [
  { provider: 'openrouter', id: 'google/gemini-flash-1.5',                label: 'Gemini 1.5 Flash' },
  { provider: 'openrouter', id: 'meta-llama/llama-3.1-8b-instruct:free',  label: 'Llama 3.1 8B (free)' },
  { provider: 'openrouter', id: 'anthropic/claude-3-haiku',               label: 'Claude 3 Haiku' },
  { provider: 'openrouter', id: 'openai/gpt-4o-mini',                     label: 'GPT-4o Mini' },
  { provider: 'groq',       id: 'llama-3.3-70b-versatile',                label: 'Llama 3.3 70B su Groq (ultra-fast)' },
  { provider: 'groq',       id: 'gemma2-9b-it',                           label: 'Gemma 2 9B su Groq' },
  { provider: 'ollama',     id: 'qwen2.5-coder:7b',                       label: 'Qwen 2.5 Coder 7B (locale)' },
];

export function buildFallbackMessage(modelId, detection, currentProvider) {
  const pct = Math.round(detection.confidence * 100);
  const same = currentProvider
    ? SUGGESTED_MODELS.filter(m => m.provider === currentProvider).slice(0, 2)
    : [];
  const others = SUGGESTED_MODELS.filter(m => m.provider !== currentProvider).slice(0, 4);
  const suggestions = [...same, ...others].slice(0, 5);
  return [
    `⚠ "${modelId}" ha generato output incoerente (confidenza: ${pct}%).`,
    `  Motivo: ${detection.reason}`,
    '',
    'Il modello corrente non gestisce task complessi. Usa /use per cambiare modello.',
    '',
    'Modelli consigliati con tool-use:',
    ...suggestions.map(m => `  • ${m.label}  (${m.provider} / ${m.id})`),
  ].join('\n');
}

// ─── Agent patch helper ───────────────────────────────────────────────────────

/**
 * Replace the system message of an Agent instance with the lite prompt.
 * Call after constructing the Agent, before run().
 */
export function applyLitePrompt(agent, workdir) {
  const prompt = LITE_SYSTEM_PROMPT.replace('{{WORKDIR}}', workdir || process.cwd());
  if (agent.messages?.[0]?.role === 'system') {
    agent.messages[0] = { role: 'system', content: prompt };
  }
}
