// Local web "studio" for music-video generation.
//
// The /video_music command starts this server and opens a browser page where
// the user uploads an mp3 + a character photo, reviews the auto-generated
// storyboard, and watches the final video render. All heavy lifting reuses the
// existing tools: readAudio (song understanding), generateSceneClip (MiniMax
// Hailuo), lyricsToSrt + assembleMusicVideo (ffmpeg). The active LLM drafts the
// storyboard.
//
// Uploads arrive as base64 JSON (no multipart parser / no extra deps). Jobs run
// in the background and the page polls /api/status.

import { createServer } from 'http';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

import { readAudio, renderAudioResult } from '../tools/audio-read.js';
import {
  assembleMusicVideo, lyricsToSrt, getMinimaxApiKey,
  getMinimaxBalance, isMinimaxBillingError,
} from '../tools/music-video.js';
import { estimateVideoCost, estimateVideoPoints, VIDEO_POINT_COSTS } from '../utils/pricing.js';
import { connectionManager } from '../providers/index.js';
import { createClient, OpenAICompatClient, AnthropicClient } from '../llm/client.js';
import { saveSecret, getSecret, deleteSecret, listSecrets } from '../utils/secret-store.js';
import { getProviderClass } from '../providers/registry.js';
import { generateClipWith } from '../tools/video-providers.js';

const AUDIO_EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg' };
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_BODY = 80 * 1024 * 1024; // 80MB — a full song + photo, base64-inflated

// Video engines the studio offers, with the resolutions each supports. Per-clip
// prices come from estimateVideoCost so the UI shows the real generation cost.
// Both engines are MiniMax models and use the SAME MINIMAX_API_KEY — "Hailuo"
// is MiniMax's video product name, not a separate provider/key.
const VIDEO_MODELS = [
  { id: 'S2V-01', label: 'MiniMax S2V-01 · stesso personaggio', hint: 'La foto resta lo stesso personaggio in tutte le scene (costo non a punti)', resolutions: ['768P'] },
  { id: 'MiniMax-Hailuo-2.3', label: 'MiniMax Hailuo 2.3 · da fotogramma', hint: 'Anima la foto come primo frame · qualità alta', resolutions: ['768P', '1080P'] },
  { id: 'MiniMax-Hailuo-2.3-Fast', label: 'MiniMax Hailuo 2.3 Fast · economico', hint: 'Più veloce ed economico · da fotogramma', resolutions: ['768P', '1080P'] },
  { id: 'MiniMax-Hailuo-02', label: 'MiniMax Hailuo 02 · 512P il più economico', hint: 'Supporta 512P: il costo/clip più basso', resolutions: ['512P', '768P', '1080P'] },
];
const VIDEO_MODEL_IDS = new Set(VIDEO_MODELS.map(m => m.id));
const VIDEO_RESOLUTIONS = new Set(['512P', '768P', '1080P']);

const jobs = new Map();
let server = null;
let baseUrl = null;

const STUDIO_ROOT = join(tmpdir(), 'ettore-mv-studio');

function decodeDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  return { mime: m[1], bytes: Buffer.from(m[2], 'base64') };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Upload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function activeModelConfig() {
  const provider = connectionManager.activeProvider;
  const model = connectionManager.activeModel;
  if (!provider || !model) return null;
  return { provider, model };
}

// Last-resort provider selection from environment variables. Lets the studio
// stay usable when the user has, say, OPENAI_API_KEY in the shell but never
// ran /connect.
function pickProviderFromEnv() {
  if (process.env.OPENAI_API_KEY)       return { provider: 'openai',     model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY };
  if (process.env.ANTHROPIC_API_KEY)    return { provider: 'anthropic',  model: 'claude-3-5-sonnet-20241022', apiKey: process.env.ANTHROPIC_API_KEY };
  if (process.env.OPENROUTER_API_KEY)   return { provider: 'openrouter', model: 'openai/gpt-4o-mini', apiKey: process.env.OPENROUTER_API_KEY };
  if (process.env.GEMINI_API_KEY)       return { provider: 'google',     model: 'gemini-2.0-flash-exp', apiKey: process.env.GEMINI_API_KEY };
  if (process.env.GOOGLE_API_KEY)       return { provider: 'google',     model: 'gemini-2.0-flash-exp', apiKey: process.env.GOOGLE_API_KEY };
  return null;
}

// Resolve the LLM config for a studio request, applying the same priority
// chain as draftStoryboard. Returns { provider, model, apiKey, source } or null.
export function resolveStoryboardLlm({ llmOverride, saved } = {}) {
  if (llmOverride && llmOverride.provider && llmOverride.apiKey && llmOverride.model) {
    return { ...llmOverride, source: 'override' };
  }
  const active = activeModelConfig();
  if (active) return { ...active, source: 'active' };
  if (saved) {
    for (const p of STUDIO_LLM_PROVIDERS) {
      if (saved[p.id]?.hasKey) {
        const key = getSecret(p.id);
        if (key) return { provider: p.id, model: p.defaultModel, apiKey: key, source: `saved:${p.id}` };
      }
    }
  }
  const env = pickProviderFromEnv();
  if (env) return { ...env, source: 'env' };
  return null;
}

// Build the *full* fallback chain in priority order. The storyboard call
// walks it and uses the first source whose LLM call actually succeeds — so
// a stale active model (e.g. `models/antigravity-preview-...` no longer
// served by the provider) doesn't lock the user out when they have a working
// saved key.
function buildLlmChain({ llmOverride, saved } = {}) {
  const chain = [];
  if (llmOverride && llmOverride.provider && llmOverride.apiKey && llmOverride.model) {
    chain.push({ ...llmOverride, source: 'override' });
  }
  const active = activeModelConfig();
  if (active) chain.push({ ...active, source: 'active' });
  if (saved) {
    for (const p of STUDIO_LLM_PROVIDERS) {
      if (saved[p.id]?.hasKey) {
        const key = getSecret(p.id);
        if (key) chain.push({ provider: p.id, model: p.defaultModel, apiKey: key, source: `saved:${p.id}` });
      }
    }
  }
  const env = pickProviderFromEnv();
  if (env) chain.push({ ...env, source: 'env' });
  return chain;
}

// Friendly Italian message for common LLM failures. Without this the user
// just sees "400 status code (no body)" and doesn't know what to do.
export function friendlyLlmError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return 'LLM non disponibile.';
  if (msg.includes('no active connection')) {
    return 'Nessuna connessione attiva. Usa /connect + /use per selezionare un provider, oppure inserisci una chiave nel pannello "API keys".';
  }
  if (msg.includes('no llm available') || msg.includes('no active model')) {
    return 'Nessun LLM disponibile per lo storyboard. Aggiungi una chiave nel pannello "API keys" o seleziona un modello attivo con /connect + /use.';
  }
  if (msg.match(/\b(401|403)\b/) || msg.includes('unauthorized') || msg.includes('api key') || msg.includes('authentication')) {
    return 'Chiave API non valida o scaduta. Aggiorna la chiave nel pannello "API keys" o con /connect.';
  }
  if (msg.includes('model') && (msg.includes('not found') || msg.includes('not supported') || msg.includes('does not exist') || msg.includes('invalid'))) {
    return 'Modello non disponibile per questo provider. Scegline un altro nel pannello "API keys" (campo LLM per lo storyboard).';
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) {
    return 'Limite di richieste raggiunto. Aspetta qualche secondo e riprova, oppure usa un altro provider.';
  }
  if (msg.match(/\b(400|404|500|502|503|504)\b/) && msg.includes('status code')) {
    return `Errore dal provider LLM (${msg.match(/\b\d{3}\b/)?.[0] || 'HTTP'}). Il modello potrebbe non essere supportato o la richiesta è stata rifiutata.`;
  }
  return err?.message || 'LLM non disponibile.';
}

// Build an LLM client for the studio WITHOUT mutating the user's CLI
// /connect state. Mirrors what createClient() does, but instantiates a fresh
// provider instance from the user-provided key + baseURL.
function createStudioClient({ provider, model, apiKey }) {
  if (provider === 'anthropic') {
    return new AnthropicClient(apiKey, model);
  }
  const ProviderClass = getProviderClass(provider);
  if (!ProviderClass) throw new Error(`Provider sconosciuto: ${provider}`);
  const instance = new ProviderClass(apiKey);
  const openaiClient = instance.getClient?.();
  if (!openaiClient) throw new Error(`Il provider ${provider} non espone un client OpenAI-compat.`);
  return new OpenAICompatClient(openaiClient, model);
}

// Ask the LLM to turn the song analysis into a storyboard of scenes. The studio
// tries every available source in priority order and uses the first one whose
// LLM call actually succeeds — so a stale active model doesn't lock the user
// out when they have a working saved key configured.
//
// Priority chain:
//   1. Explicit `llm = { provider, apiKey, model }` from the request body
//   2. The CLI's active provider/model (/connect + /use)
//   3. Each saved key, in the order listed in STUDIO_LLM_PROVIDERS
//   4. Any env-var key (OPENAI_API_KEY, ANTHROPIC_API_KEY, …)
async function draftStoryboard({ analysisText, lyrics, durationSeconds, clipLength, sceneCount, llm }) {
  const chain = buildLlmChain({ llmOverride: llm, saved: listSecrets() });
  if (chain.length === 0) {
    throw new Error('No LLM available for the storyboard. Inserisci una chiave nel pannello "API keys" o usa /connect + /use per selezionare un modello.');
  }

  const sys = 'You are a music-video director. You output ONLY valid JSON, no prose, no markdown fences.';
  const user = `Design a storyboard of exactly ${sceneCount} scenes for a music video. Each scene becomes one ${clipLength}s animated clip featuring the SAME recurring main character (kept consistent by a reference photo — never describe the character's face, only their action, wardrobe cues, setting, mood, and camera movement).

Song analysis:
${analysisText}

Lyrics (timestamped):
${String(lyrics || '').slice(0, 4000)}

Total song duration: ${Math.round(durationSeconds)}s.

Return a JSON array of exactly ${sceneCount} objects, each: {"title": short label, "prompt": vivid scene + camera-motion description (1-2 sentences), "duration": ${clipLength}}. Scenes should follow the song's emotional arc and structure. Output ONLY the JSON array.`;

  const errors = [];
  for (const candidate of chain) {
    try {
      // For the CLI's active provider, the cached connection already has
      // the right key + baseURL — call createClient. For everything else
      // (override / saved / env) we instantiate a fresh client from the
      // candidate's apiKey so the key actually flows through.
      const client = candidate.source === 'active'
        ? createClient({ provider: candidate.provider, model: candidate.model })
        : createStudioClient({ provider: candidate.provider, model: candidate.model, apiKey: candidate.apiKey });

      const result = await client.turn(
        [{ role: 'system', content: sys }, { role: 'user', content: user }],
        [], () => {}, undefined,
      );
      const text = typeof result?.content === 'string' ? result.content : '';
      const parsed = extractJsonArray(text);
      if (!parsed) throw new Error('The model did not return a usable storyboard. Try again.');
      return parsed.slice(0, sceneCount).map((s, i) => ({
        title: String(s.title || `Scene ${i + 1}`).slice(0, 80),
        prompt: String(s.prompt || '').slice(0, 600),
        duration: clipLength,
      })).filter(s => s.prompt);
    } catch (e) {
      // Don't surface the chain state to the caller — collect errors and
      // keep trying. The final error (last failure OR the "no LLM" error)
      // is what runAnalysis sees.
      errors.push({ source: candidate.source, provider: candidate.provider, model: candidate.model, message: e?.message || String(e) });
    }
  }
  // All sources failed — surface the most informative error.
  const last = errors[errors.length - 1];
  const tried = errors.map(e => `${e.source}/${e.provider}/${e.model}`).join(', ');
  const err = new Error(friendlyLlmError(last) + `\n(Provato: ${tried})`);
  err.cause = errors;
  throw err;
}

function extractJsonArray(text) {
  if (!text) return null;
  let t = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

// Providers the studio lets the user plug into directly. Each entry maps to
// (a) the provider id used by the secret-store and by /connect, (b) the env
// var that already works for that provider, (c) a label and default model
// for the UI.
const STUDIO_LLM_PROVIDERS = [
  { id: 'openai',     label: 'OpenAI',           hint: 'gpt-4o, gpt-4-turbo, o1…', defaultModel: 'gpt-4o-mini', env: 'OPENAI_API_KEY' },
  { id: 'anthropic',  label: 'Anthropic',        hint: 'claude-3-5-sonnet, claude-3-opus…', defaultModel: 'claude-3-5-sonnet-20241022', env: 'ANTHROPIC_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter',       hint: '300+ modelli (Claude, GPT, Gemini, Llama…)', defaultModel: 'openai/gpt-4o-mini', env: 'OPENROUTER_API_KEY' },
  { id: 'google',     label: 'Google Gemini',    hint: 'gemini-2.0-flash, gemini-1.5-pro…', defaultModel: 'gemini-2.0-flash-exp', env: 'GEMINI_API_KEY' },
];

// Video engines the studio can generate through. MiniMax is the built-in
// (points-priced) engine; Runway and Replicate are external providers the user
// plugs a key into. Each lists selectable models for the UI.
const STUDIO_VIDEO_PROVIDERS = [
  {
    id: 'minimax', label: 'MiniMax (Hailuo / S2V-01)', env: 'MINIMAX_API_KEY', builtin: true,
    note: 'Motore integrato · costo a video points · S2V-01 mantiene lo stesso personaggio.',
  },
  {
    id: 'runway', label: 'Runway (Gen-3)', env: 'RUNWAY_API_KEY',
    models: [{ id: 'gen3a_turbo', label: 'Gen-3 Alpha Turbo' }],
    note: 'Image-to-video: usa la foto come primo fotogramma. Fatturato sul tuo account Runway.',
  },
  {
    id: 'replicate', label: 'Replicate', env: 'REPLICATE_API_TOKEN',
    models: [
      { id: 'minimax/video-01', label: 'MiniMax Video-01' },
      { id: 'minimax/video-01-live', label: 'MiniMax Video-01-Live' },
      { id: 'kwaivgi/kling-v1.6-standard', label: 'Kling v1.6 Standard' },
      { id: 'kwaivgi/kling-v1.6-pro', label: 'Kling v1.6 Pro' },
      { id: 'kwaivgi/kling-v2.1', label: 'Kling v2.1' },
      { id: 'luma/ray', label: 'Luma Ray' },
      { id: 'pika-labs/pika-2.2', label: 'Pika 2.2' },
      { id: 'wan-video/wan-2.2-i2v-fast', label: 'Wan 2.2 (image-to-video, fast)' },
      { id: 'tencent/hunyuan-video', label: 'Hunyuan Video' },
      { id: 'lightricks/ltx-video', label: 'LTX Video (fast)' },
    ],
    note: 'Centinaia di modelli video via Replicate (token REPLICATE_API_TOKEN). Fatturato su Replicate.',
  },
  {
    id: 'luma', label: 'Luma (Dream Machine)', env: 'LUMAAI_API_KEY',
    models: [
      { id: 'ray-2', label: 'Ray 2' },
      { id: 'ray-flash-2', label: 'Ray Flash 2 (veloce)' },
      { id: 'ray-1-6', label: 'Ray 1.6' },
    ],
    note: 'Dream Machine (LUMAAI_API_KEY). Con foto locale genera text-to-video; per image-to-video serve un URL pubblico. Fatturato su Luma.',
  },
  {
    id: 'veo', label: 'Google Veo', env: 'GEMINI_API_KEY', keyProvider: 'gemini',
    models: [
      { id: 'veo-3.0-generate-preview', label: 'Veo 3' },
      { id: 'veo-2.0-generate-001', label: 'Veo 2' },
    ],
    note: 'Veo via Gemini API — usa la stessa chiave Gemini (nessun campo extra). Fatturato su Google.',
  },
  {
    id: 'kling', label: 'Kling (diretto)', env: 'KLING_API_KEY',
    keyPlaceholder: 'AccessKey:SecretKey (da kling.ai/dev)',
    models: [
      { id: 'kling-v1', label: 'Kling v1' },
      { id: 'kling-v1-6', label: 'Kling v1.6' },
      { id: 'kling-v2', label: 'Kling v2' },
    ],
    note: 'Auth firmata: incolla le credenziali come "AccessKey:SecretKey" nel campo. Fatturato su Kling.',
  },
  {
    id: 'fal', label: 'fal.ai (Pika, Kling, Luma…)', env: 'FAL_KEY',
    keyPlaceholder: 'FAL_KEY',
    models: [
      { id: 'fal-ai/pika/v2.2/image-to-video', label: 'Pika 2.2 (image-to-video)' },
      { id: 'fal-ai/pika/v2.2/text-to-video', label: 'Pika 2.2 (text-to-video)' },
      { id: 'fal-ai/kling-video/v1.6/standard/image-to-video', label: 'Kling v1.6 (i2v)' },
      { id: 'fal-ai/luma-dream-machine', label: 'Luma Dream Machine' },
      { id: 'fal-ai/minimax/video-01', label: 'MiniMax Video-01' },
    ],
    note: 'Pika ufficiale gira su fal.ai. Un solo FAL_KEY → Pika, Kling, Luma, MiniMax… Fatturato su fal.ai.',
  },
];
const VIDEO_PROVIDER_IDS = new Set(STUDIO_VIDEO_PROVIDERS.map(p => p.id));

// Provider ids whose keys the studio will persist. Extra callers can't turn the
// on-disk store into a generic bucket.
function knownKeyProviders() {
  return new Set([
    'minimax', 'gemini',
    ...STUDIO_LLM_PROVIDERS.map(p => p.id),
    ...STUDIO_VIDEO_PROVIDERS.map(p => p.id),
  ]);
}

function providerHasEnvKey(env) {
  if (!env) return false;
  return !!process.env[env];
}

// The key the studio should actually use for a provider: an explicit override
// from the request wins, then a saved key, then the environment.
function effectiveKey(provider, override, envVar) {
  return (override && String(override).trim()) || getSecret(provider) || (envVar ? process.env[envVar] : null) || null;
}

// For the UI we expose: env-based presence (always non-secret) + saved (masked).
// `keys.openai` etc. means "usable right now" (env OR saved) — drives the green
// "✓ già configurata" badge in the page.
function studioKeyStatus() {
  const saved = listSecrets();
  const out = { saved };
  for (const p of STUDIO_LLM_PROVIDERS) {
    out[p.id] = providerHasEnvKey(p.env) || !!saved[p.id]?.hasKey;
  }
  // Legacy fields the existing frontend still reads.
  out.minimax = !!getMinimaxApiKey() || !!saved.minimax?.hasKey;
  out.gemini = providerHasEnvKey('GEMINI_API_KEY') || providerHasEnvKey('GOOGLE_API_KEY') || !!saved.gemini?.hasKey;
  // Video providers (Runway, Replicate, Veo, Kling, fal, …). Some reuse another
  // provider's key (e.g. Veo → gemini) via keyProvider.
  for (const p of STUDIO_VIDEO_PROVIDERS) {
    if (p.id === 'minimax') continue;
    const keyPid = p.keyProvider || p.id;
    out[p.id] = providerHasEnvKey(p.env) || !!saved[keyPid]?.hasKey;
  }
  return out;
}

function studioConfig() {
  const models = VIDEO_MODELS.map(m => ({
    id: m.id,
    label: m.label,
    hint: m.hint,
    resolutions: m.resolutions,
    prices: Object.fromEntries(m.resolutions.map(r => [r, estimateVideoCost({ model: m.id, resolution: r, count: 1 })])),
  }));
  return {
    models,
    points: VIDEO_POINT_COSTS,
    defaultModel: 'S2V-01',
    keys: studioKeyStatus(),
    llmProviders: STUDIO_LLM_PROVIDERS.map(p => ({
      id: p.id, label: p.label, hint: p.hint, defaultModel: p.defaultModel,
      envPresent: providerHasEnvKey(p.env),
      saved: !!listSecrets()[p.id]?.hasKey,
    })),
    videoProviders: STUDIO_VIDEO_PROVIDERS.map(p => ({
      id: p.id, label: p.label, note: p.note, builtin: !!p.builtin,
      models: p.models || null,
      keyProvider: p.keyProvider || null,
      keyPlaceholder: p.keyPlaceholder || null,
      envPresent: providerHasEnvKey(p.env),
      saved: !!listSecrets()[p.keyProvider || p.id]?.hasKey,
    })),
    activeModel: connectionManager.activeProvider
      ? `${connectionManager.activeProvider}/${connectionManager.activeModel}` : null,
  };
}

async function handleAnalyze(req, res) {
  const body = JSON.parse((await readBody(req)).toString('utf-8'));
  const audio = decodeDataUrl(body.audio);
  if (!audio) return sendJson(res, 400, { error: 'Missing or invalid audio upload.' });

  const clipLength = [6, 10].includes(Number(body.clipLength)) ? Number(body.clipLength) : 6;
  const jobId = randomUUID();
  const dir = join(STUDIO_ROOT, jobId);
  await mkdir(dir, { recursive: true });
  const ext = AUDIO_EXT[audio.mime] || 'mp3';
  const audioPath = join(dir, `song.${ext}`);
  await writeFile(audioPath, audio.bytes);

  const apiKeys = body.apiKeys || {};
  const job = {
    id: jobId, dir, audioPath, clipLength, lyrics: '', durationSeconds: 0,
    state: 'analyzing', log: [], analysis: null,
    geminiApiKey: apiKeys.gemini || null,
    llm: sanitizeLlmOverride(apiKeys.llm),
  };
  jobs.set(jobId, job);

  // Analysis runs in the background so the page can stream the activity log.
  runAnalysis(job).catch((e) => { job.state = 'error'; job.error = e.message; pushLog(job, `⚠ ${e.message}`); });
  sendJson(res, 200, { jobId });
}

// Trim and validate the LLM override coming from the UI. Anything missing
// or with the wrong shape becomes null so resolveStoryboardLlm can fall
// through to the next source in the priority chain.
function sanitizeLlmOverride(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!provider || !apiKey || !model) return null;
  return { provider, apiKey, model };
}

async function runAnalysis(job) {
  const log = (m) => pushLog(job, m);
  const audioOpts = { log, geminiApiKey: job.geminiApiKey || undefined };

  // Understand the song: describe (structure/mood/bpm) + transcribe (lyrics).
  let describeText = '';
  let lyrics = '';
  let durationSeconds = 0;

  pushLog(job, '🎧 Analizzo la canzone (genere, mood, BPM, struttura)…');
  try {
    const desc = await readAudio({ file_path: job.audioPath, mode: 'describe' }, audioOpts);
    describeText = renderAudioResult(desc);
    durationSeconds = Number(desc?.durationSeconds) || 0;
    pushLog(job, '✓ Analisi musicale completata.');
  } catch (e) {
    describeText = `(song description unavailable: ${e.message})`;
    pushLog(job, `⚠ Analisi musicale non disponibile: ${e.message}`);
  }

  pushLog(job, '📝 Trascrivo il testo (lyrics con timestamp)…');
  try {
    const tr = await readAudio({ file_path: job.audioPath, mode: 'transcribe' }, audioOpts);
    lyrics = renderAudioResult(tr);
    pushLog(job, '✓ Trascrizione completata.');
  } catch (e) {
    lyrics = '';
    pushLog(job, `⚠ Trascrizione non disponibile: ${e.message}`);
  }

  if (!durationSeconds) durationSeconds = await probeDuration(job.audioPath).catch(() => 0);
  const sceneCount = Math.max(2, Math.min(40, Math.ceil((durationSeconds || job.clipLength * 4) / job.clipLength)));
  pushLog(job, `⏱ Durata canzone ${Math.round(durationSeconds)}s → ${sceneCount} scene da ${job.clipLength}s.`);

  pushLog(job, '🎬 Scrivo lo storyboard con il modello attivo…');
  let storyboard = [];
  let storyboardError = null;
  try {
    storyboard = await draftStoryboard({ analysisText: describeText, lyrics, durationSeconds, clipLength: job.clipLength, sceneCount, llm: job.llm });
    pushLog(job, `✓ Storyboard pronto: ${storyboard.length} scene.`);
  } catch (e) {
    storyboardError = e.message;
    pushLog(job, `⚠ Storyboard automatico non riuscito: ${e.message} — potrai scrivere le scene a mano.`);
  }

  job.lyrics = lyrics;
  job.durationSeconds = durationSeconds;
  job.analysis = {
    analysis: describeText,
    lyrics,
    durationSeconds,
    clipLength: job.clipLength,
    sceneCount,
    storyboard,
    storyboardError,
    costEstimate: estimateVideoCost({ model: 'S2V-01', count: storyboard.length || sceneCount }),
  };
  job.state = 'analyzed';
  pushLog(job, '✅ Pronto! Rivedi lo storyboard.');
}

function probeDuration(audioPath) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => {
      const n = Number(String(out).trim());
      Number.isFinite(n) && n > 0 ? resolve(n) : reject(new Error('no duration'));
    });
  });
}

async function handleGenerate(req, res) {
  const body = JSON.parse((await readBody(req)).toString('utf-8'));
  const job = jobs.get(body.jobId);
  if (!job) return sendJson(res, 404, { error: 'Unknown job. Re-run the analysis step.' });

  const provider = VIDEO_PROVIDER_IDS.has(body.provider) ? body.provider : 'minimax';
  const providerDef = STUDIO_VIDEO_PROVIDERS.find(p => p.id === provider);
  const keyPid = providerDef.keyProvider || provider;
  const override = (body.apiKeys && (body.apiKeys[keyPid] || body.apiKeys[provider])) || null;
  const videoKey = provider === 'minimax'
    ? (override || getSecret('minimax') || null)
    : effectiveKey(keyPid, override, providerDef.env);

  if (provider === 'minimax') {
    if (!getMinimaxApiKey({ apiKey: videoKey })) {
      return sendJson(res, 400, { error: 'Nessuna MiniMax API key: inseriscila nel pannello “API keys” o impostala in MINIMAX_API_KEY.' });
    }
  } else if (!videoKey) {
    return sendJson(res, 400, { error: `Nessuna API key per ${providerDef.label}: salvala nel pannello “API keys”.` });
  }

  const photo = decodeDataUrl(body.photo);
  if (!photo) return sendJson(res, 400, { error: 'Missing character photo.' });
  const storyboard = Array.isArray(body.storyboard) ? body.storyboard.filter(s => s && s.prompt) : [];
  if (storyboard.length === 0) return sendJson(res, 400, { error: 'Storyboard is empty.' });

  const ext = IMAGE_EXT[photo.mime] || 'png';
  const photoPath = join(job.dir, `character.${ext}`);
  await writeFile(photoPath, photo.bytes);

  job.provider = provider;
  job.videoKey = videoKey;
  job.minimaxApiKey = provider === 'minimax' ? videoKey : null;
  // For external providers videoModel is the provider's model id; MiniMax keeps
  // its own model/resolution selection.
  job.videoModel = providerDef.models?.some(m => m.id === body.videoModel)
    ? body.videoModel
    : (providerDef.models?.[0]?.id || null);
  job.model = VIDEO_MODEL_IDS.has(body.model) ? body.model : 'S2V-01';
  job.resolution = VIDEO_RESOLUTIONS.has(body.resolution) ? body.resolution : '768P';
  job.state = 'running';
  job.photoPath = photoPath;
  job.storyboard = storyboard;
  job.total = storyboard.length;
  job.done = 0;
  job.log = [];
  job.videoUrl = null;
  job.error = null;
  job.startedAt = Date.now();

  runJob(job).catch((e) => { job.state = 'error'; job.error = e.message; });
  sendJson(res, 200, { jobId: job.id, total: job.total });
}

function pushLog(job, msg) {
  job.log.push({ t: Date.now(), msg });
  if (job.log.length > 200) job.log.shift();
}

// Find the cheapest video engine/resolution by MiniMax video points for the
// given clip duration. Returns null if nothing priced in points is cheaper.
function cheaperOption(model, resolution, duration = 6) {
  const current = estimateVideoPoints({ model, resolution, duration, count: 1 });
  const currentPer = current ? current.perClip : Infinity; // legacy S2V-01 → treat as "anything is cheaper"
  let best = null;
  for (const m of VIDEO_MODELS) {
    for (const r of m.resolutions) {
      if (m.id === model && r === resolution) continue;
      const p = estimateVideoPoints({ model: m.id, resolution: r, duration, count: 1 });
      if (p && p.perClip < currentPer && (!best || p.perClip < best.perClip)) {
        best = { model: m.id, label: m.label, resolution: r, perClip: p.perClip };
      }
    }
  }
  return best;
}

async function runJob(job) {
  const clipPaths = [];
  const resolution = job.resolution || '768P';
  const model = job.model || 'S2V-01';
  const provider = job.provider || 'minimax';
  const duration = job.clipLength || 6;

  // Pre-flight cost estimate. MiniMax bills in video points (the real unit); for
  // external providers we just name the engine — cost lives on their account.
  if (provider === 'minimax') {
    const pts = estimateVideoPoints({ model, resolution, duration, count: job.total });
    if (pts) {
      pushLog(job, `🎟 Preventivo: ${job.total} clip × ${pts.perClip} = ~${pts.total} video points (${model} ${resolution}, ${duration}s).`);
    } else {
      const usd = estimateVideoCost({ model, resolution, count: job.total });
      pushLog(job, `🎟 Preventivo: ${job.total} clip (${model} ${resolution}) — costo a punti non listato${usd != null ? `, stima ~$${usd.toFixed(2)}` : ''}.`);
    }
    const balance = await getMinimaxBalance({ apiKey: job.minimaxApiKey || undefined }).catch(() => null);
    if (balance) pushLog(job, `ℹ Saldo piano (best-effort, non riflette i Credits video): ${JSON.stringify(balance).slice(0, 200)}`);
  } else {
    pushLog(job, `🎬 Motore: ${provider}${job.videoModel ? ` · ${job.videoModel}` : ''}. Costo fatturato sul tuo account ${provider}.`);
  }

  for (let i = 0; i < job.storyboard.length; i++) {
    const scene = job.storyboard[i];
    pushLog(job, `Scene ${i + 1}/${job.total}: “${scene.title || 'scene'}” — starting…`);
    const clipPath = join(job.dir, `clip_${String(i + 1).padStart(2, '0')}.mp4`);
    const onProgress = (m) => pushLog(job, `Scene ${i + 1}/${job.total}: ${m}`);
    try {
      if (provider === 'minimax') {
        await generateClipWith('minimax', {
          prompt: scene.prompt,
          outputPath: clipPath,
          characterImage: job.photoPath,
          duration: scene.duration || job.clipLength,
          resolution,
          model,
        }, { apiKey: job.minimaxApiKey || undefined, onProgress });
      } else {
        await generateClipWith(provider, {
          prompt: scene.prompt,
          outputPath: clipPath,
          firstFrameImage: job.photoPath,
          duration: scene.duration || job.clipLength,
          model: job.videoModel,
        }, { apiKey: job.videoKey, onProgress });
      }
    } catch (e) {
      // A billing/quota rejection (esp. on the very first clip) means the batch
      // cannot proceed — stop now instead of hammering the API for every scene.
      // A rejected submit is not charged, so no credits were wasted.
      if (isMinimaxBillingError(e.message)) {
        const needCur = estimateVideoPoints({ model, resolution, duration, count: job.total });
        const alt = cheaperOption(model, resolution, duration);
        const altPts = alt ? estimateVideoPoints({ model: alt.model, resolution: alt.resolution, duration, count: job.total }) : null;
        const lines = [
          `Crediti/punti MiniMax insufficienti per il video. ${e.message}`,
          '',
          needCur
            ? `📊 Ti servono ~${needCur.total} video points: ${job.total} clip × ${needCur.perClip} (${model} ${resolution}, ${duration}s).`
            : `📊 ${model} ${resolution} non è tariffato a punti (modello legacy).`,
        ];
        if (alt && altPts) {
          lines.push(`💡 Soluzione più economica: «${alt.label}» a ${alt.resolution} → ~${altPts.total} video points (${altPts.perClip}/clip). Selezionala nel menù “Motore” e rilancia.`);
        }
        lines.push('', '👉 Ricarica i punti/Credits su platform.minimax.io → Billing, poi rilancia.');
        job.state = 'error';
        job.error = lines.join('\n');
        pushLog(job, `⛔ Fermato prima di sprecare crediti: servono ~${needCur ? needCur.total : '?'} video points.`);
        return;
      }
      throw e;
    }
    clipPaths.push(clipPath);
    job.done = i + 1;
    pushLog(job, `Scene ${i + 1}/${job.total}: clip ready.`);
  }

  // Subtitles from the transcribed lyrics (best-effort).
  let subtitlesPath = null;
  if (job.lyrics) {
    const srt = lyricsToSrt(job.lyrics);
    if (srt) {
      subtitlesPath = join(job.dir, 'lyrics.srt');
      await writeFile(subtitlesPath, srt, 'utf-8');
    }
  }

  pushLog(job, 'Assembling clips, audio and subtitles…');
  const outputPath = join(job.dir, 'music-video.mp4');
  await assembleMusicVideo({ audioPath: job.audioPath, clipPaths, outputPath, subtitlesPath, width: 1280 });

  job.outputPath = outputPath;
  job.videoUrl = `/media/${job.id}/music-video.mp4`;
  job.state = 'done';
  pushLog(job, 'Done! 🎬');
}

async function serveMedia(req, res, url) {
  const m = /^\/media\/([0-9a-f-]+)\/([\w.-]+)$/i.exec(url.pathname);
  if (!m) { res.writeHead(404); return res.end('Not found'); }
  const job = jobs.get(m[1]);
  if (!job) { res.writeHead(404); return res.end('Unknown job'); }
  const path = join(job.dir, m[2]);
  if (!path.startsWith(job.dir)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const bytes = await readFile(path);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes' });
    res.end(bytes);
  } catch {
    res.writeHead(404); res.end('File not found');
  }
}

async function handleKeysList(_req, res) {
  // Always returns masked values only — the actual key never leaves the server
  // unless the user explicitly posted it back in the same session.
  sendJson(res, 200, { keys: studioKeyStatus() });
}

async function handleKeysSave(req, res) {
  const body = JSON.parse((await readBody(req)).toString('utf-8'));
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
  // Only accept provider ids the studio knows about — keeps the on-disk store
  // from becoming a generic key/value bucket for arbitrary callers.
  const known = knownKeyProviders();
  if (!known.has(provider)) return sendJson(res, 400, { error: `provider sconosciuto: ${provider}` });
  if (!secret) return sendJson(res, 400, { error: 'secret vuoto' });
  try {
    const res2 = saveSecret(provider, secret);
    sendJson(res, 200, res2);
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

async function handleKeysDelete(req, res, url) {
  const provider = decodeURIComponent(url.pathname.split('/').pop() || '');
  const known = knownKeyProviders();
  if (!known.has(provider)) return sendJson(res, 400, { error: `provider sconosciuto: ${provider}` });
  const removed = deleteSecret(provider);
  sendJson(res, 200, { provider, removed });
}

function requestHandler(req, res) {
  const url = new URL(req.url, baseUrl);
  const done = (p) => p.catch((e) => { try { sendJson(res, 500, { error: e.message }); } catch { /* headers sent */ } });

  if (req.method === 'GET' && url.pathname === '/') {
    const html = PAGE;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  if (req.method === 'GET' && url.pathname === '/api/config') return sendJson(res, 200, studioConfig());
  if (req.method === 'GET' && url.pathname === '/api/keys') return done(handleKeysList(req, res));
  if (req.method === 'POST' && url.pathname === '/api/keys') return done(handleKeysSave(req, res));
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/keys/')) return done(handleKeysDelete(req, res, url));
  if (req.method === 'POST' && url.pathname === '/api/analyze') return done(handleAnalyze(req, res));
  if (req.method === 'POST' && url.pathname === '/api/generate') return done(handleGenerate(req, res));
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const job = jobs.get(url.searchParams.get('job'));
    if (!job) return sendJson(res, 404, { error: 'unknown job' });
    return sendJson(res, 200, {
      state: job.state, done: job.done || 0, total: job.total || 0,
      log: job.log || [], videoUrl: job.videoUrl || null, error: job.error || null,
      analysis: job.analysis || null,
    });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/media/')) return done(serveMedia(req, res, url));

  res.writeHead(404); res.end('Not found');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* ignore — the URL is printed anyway */ }
}

export function startMusicVideoStudio({ open = true } = {}) {
  if (server && baseUrl) {
    if (open) openBrowser(baseUrl);
    return Promise.resolve({ url: baseUrl, reused: true });
  }
  return new Promise((resolve, reject) => {
    server = createServer(requestHandler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      if (open) openBrowser(baseUrl);
      resolve({ url: baseUrl, reused: false });
    });
  });
}

export function stopMusicVideoStudio() {
  if (server) { server.close(); server = null; baseUrl = null; }
}

// Exported for tests.
export const _internal = { decodeDataUrl, extractJsonArray, cheaperOption, jobs, resolveStoryboardLlm, sanitizeLlmOverride, friendlyLlmError };

const PAGE = /* html */ `<!doctype html>
<html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>🎬 Music Video Studio</title>
<style>
  :root{--bg:#0b0d17;--bg2:#141830;--card:#181c34;--line:#2a3055;--txt:#eef0ff;--dim:#9aa0c8;--acc:#7c5cff;--acc2:#ff5ca8;--ok:#39d98a;--warn:#ffcc66}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;background:radial-gradient(1200px 600px at 80% -10%,#241b4d 0,var(--bg) 55%),var(--bg);color:var(--txt);min-height:100vh}
  .wrap{max-width:900px;margin:0 auto;padding:32px 20px 80px}
  header{text-align:center;margin-bottom:28px}
  header h1{font-size:30px;margin:0 0 6px;background:linear-gradient(90deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
  header p{color:var(--dim);margin:0}
  .steps{display:flex;justify-content:center;gap:8px;margin:18px 0 26px}
  .steps span{font-size:12px;color:var(--dim);padding:5px 12px;border:1px solid var(--line);border-radius:999px}
  .steps span.active{color:#fff;border-color:var(--acc);background:rgba(124,92,255,.15)}
  .card{background:linear-gradient(180deg,var(--card),var(--bg2));border:1px solid var(--line);border-radius:18px;padding:22px;margin-bottom:18px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
  .drops{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:640px){.drops{grid-template-columns:1fr}}
  .drop{border:2px dashed var(--line);border-radius:14px;padding:22px;text-align:center;cursor:pointer;transition:.2s;position:relative;min-height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px}
  .drop:hover,.drop.hot{border-color:var(--acc);background:rgba(124,92,255,.08)}
  .drop .ico{font-size:34px}
  .drop .lbl{font-weight:600}
  .drop .sub{font-size:12px;color:var(--dim)}
  .drop img{max-width:120px;max-height:120px;border-radius:10px;object-fit:cover}
  .drop.filled{border-style:solid;border-color:var(--ok)}
  .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:16px}
  label.opt{font-size:13px;color:var(--dim)}
  select,button{font:inherit}
  select{background:var(--bg2);color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
  button{cursor:pointer;border:none;border-radius:12px;padding:12px 20px;font-weight:600;color:#fff;background:linear-gradient(90deg,var(--acc),var(--acc2));transition:.15s}
  button:hover{filter:brightness(1.1)}button:disabled{opacity:.45;cursor:not-allowed;filter:none}
  button.ghost{background:transparent;border:1px solid var(--line);color:var(--txt)}
  .keys{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px}
  @media(max-width:640px){.keys{grid-template-columns:1fr}}
  .klbl{display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--dim)}
  .klbl input{background:var(--bg2);border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:8px 10px;font:inherit}
  .badge-ok{color:var(--ok)} .badge-no{color:var(--warn)}
  .keygrp{margin-top:14px;padding:14px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.02)}
  .keygrp h4{margin:0 0 4px;font-size:14px;color:#fff;display:flex;align-items:center;gap:8px}
  .keygrp .grpdesc{font-size:12px;color:var(--dim);margin-bottom:10px}
  .keyrow{display:grid;grid-template-columns:1fr 2fr auto;gap:10px;align-items:end;margin-top:8px}
  .keyrow.full{grid-template-columns:1fr}
  .keyrow label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dim)}
  .keyrow input,.keyrow select{background:var(--bg2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:7px 9px;font:inherit}
  .keyrow .acts{display:flex;flex-direction:column;gap:4px;align-items:flex-end;font-size:11.5px;color:var(--dim)}
  .keyrow .acts button{background:transparent;border:1px solid var(--line);color:var(--txt);padding:5px 10px;border-radius:7px;font-size:11.5px;font-weight:500;cursor:pointer}
  .keyrow .acts button:hover{border-color:var(--acc);color:var(--acc)}
  .keyrow .savedhint{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ok)}
  .keyrow .savetog{display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none}
  .keyrow .savetog input{cursor:pointer}
  .keymsg{font-size:12px;color:var(--warn);margin-top:4px;min-height:14px}
  .costbig{font-size:18px;font-weight:700;color:#fff}
  .hidden{display:none}
  h3{margin:0 0 12px;font-size:15px;letter-spacing:.3px;color:var(--dim);text-transform:uppercase}
  pre.analysis{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:14px;max-height:220px;overflow:auto;font-size:12.5px;color:#cfd3f2}
  .scene{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px}
  .scene .st{display:flex;gap:8px;align-items:center;margin-bottom:8px}
  .scene .st b{color:var(--acc2)}
  .scene input{width:100%;background:var(--bg2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:7px 9px;font:inherit}
  .scene textarea{width:100%;background:var(--bg2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:8px 10px;font:inherit;resize:vertical;min-height:52px;margin-top:6px}
  .cost{background:rgba(255,204,102,.1);border:1px solid rgba(255,204,102,.35);color:var(--warn);border-radius:12px;padding:12px 14px;font-size:13.5px;margin:6px 0 16px}
  .bar{height:12px;background:var(--bg);border:1px solid var(--line);border-radius:999px;overflow:hidden;margin:12px 0}
  .bar > i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--acc),var(--acc2));transition:width .4s}
  .logbox{background:#05060d;border:1px solid var(--line);border-radius:12px;padding:12px;max-height:240px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#b9c0ea}
  .logbox div{padding:1px 0}
  video{width:100%;border-radius:14px;border:1px solid var(--line);background:#000;margin-top:8px}
  .err{background:rgba(255,92,92,.12);border:1px solid rgba(255,92,92,.4);color:#ff9a9a;border-radius:12px;padding:12px 14px;font-size:13.5px;margin-top:12px;white-space:pre-wrap}
  .sterr{background:rgba(255,204,102,.1);border:1px solid rgba(255,204,102,.4);color:var(--warn);border-radius:12px;padding:14px 16px;font-size:13.5px;margin:10px 0 16px;white-space:pre-wrap}
  .sterr b{color:#fff}
  .sterr .acts{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
  .sterr .acts button{background:transparent;border:1px solid var(--line);color:var(--txt);padding:6px 12px;border-radius:8px;font-size:12.5px;font-weight:500;cursor:pointer}
  .sterr .acts button:hover{border-color:var(--acc);color:var(--acc)}
  .spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:sp 1s linear infinite;vertical-align:-2px;margin-right:6px}
  @keyframes sp{to{transform:rotate(360deg)}}
  a.dl{color:var(--ok);font-weight:600;text-decoration:none}
</style></head>
<body><div class="wrap">
<header>
  <h1>🎬 Music Video Studio</h1>
  <p>Carica una canzone e una foto del personaggio — genero il video musicale.</p>
</header>
<div class="steps">
  <span id="s1" class="active">1 · Carica</span>
  <span id="s2">2 · Storyboard</span>
  <span id="s3">3 · Genera</span>
</div>

<!-- STEP 1 -->
<div class="card" id="step1">
  <div class="drops">
    <div class="drop" id="dropAudio">
      <div class="ico">🎵</div><div class="lbl" id="audioLbl">Trascina l'MP3</div>
      <div class="sub">o clicca per scegliere · mp3 / wav / m4a</div>
      <input type="file" id="audioInput" accept="audio/*" class="hidden">
    </div>
    <div class="drop" id="dropPhoto">
      <div class="ico">🧑‍🎤</div><div class="lbl" id="photoLbl">Trascina la foto</div>
      <div class="sub">volto ben visibile · png / jpg</div>
      <input type="file" id="photoInput" accept="image/*" class="hidden">
    </div>
  </div>
  <div style="margin-top:18px">
    <h3 style="margin-bottom:6px">🔑 API keys</h3>
    <div id="keysPanel"></div>
    <div class="opt" id="activeModelInfo" style="margin-top:8px"></div>
  </div>
  <div class="row">
    <label class="opt">Durata clip:
      <select id="clipLen"><option value="6">6s (più scene)</option><option value="10">10s (meno scene)</option></select>
    </label>
    <button id="analyzeBtn" disabled>Analizza la canzone →</button>
    <span id="analyzeMsg" class="opt"></span>
  </div>
  <div class="logbox hidden" id="analyzeLog" style="margin-top:16px"></div>
</div>

<!-- STEP 2 -->
<div class="card hidden" id="step2">
  <h3>Analisi della canzone</h3>
  <pre class="analysis" id="analysisOut"></pre>
  <h3>Motore video & costo</h3>
  <div class="row" style="margin-top:0">
    <label class="opt">Provider: <select id="videoProvSel"></select></label>
    <label class="opt" id="mmModelWrap">Motore: <select id="modelSel"></select></label>
    <label class="opt" id="mmResWrap">Risoluzione: <select id="resSel"></select></label>
    <label class="opt hidden" id="extModelWrap">Modello: <select id="videoModelSel"></select></label>
  </div>
  <div class="cost" id="costBox"></div>
  <div class="err hidden" id="storyboardErr"></div>
  <h3>Storyboard — modifica pure le scene</h3>
  <div id="scenes"></div>
  <div class="row">
    <button class="ghost" id="backBtn">← Indietro</button>
    <button id="genBtn">Genera il video 🎬</button>
  </div>
</div>

<!-- STEP 3 -->
<div class="card hidden" id="step3">
  <h3 id="genTitle">Generazione in corso…</h3>
  <div class="bar"><i id="barFill"></i></div>
  <div class="opt" id="genStatus"></div>
  <div class="logbox" id="logBox"></div>
  <div id="videoWrap" class="hidden">
    <video id="finalVideo" controls></video>
    <div class="row"><a class="dl" id="dlLink" download="music-video.mp4">⬇ Scarica il video</a></div>
  </div>
  <div class="err hidden" id="genErr"></div>
</div>

<script>
const $=id=>document.getElementById(id);
let audioData=null, photoData=null, state={}, config=null;

// --- Keys panel -----------------------------------------------------------
// The HTML ships empty; this builder fills it from the live /api/config
// (which already knows the registered providers and which env vars are set).
const PANEL_MODEL = {
  llm:    { label: '🧠 LLM per lo storyboard', desc: 'Scegli un provider e inserisci la chiave. Viene usata solo se la CLI non ha un modello attivo (/use).' },
  video:  { label: '🎬 Video engine',          desc: 'Servono per generare le clip (MiniMax S2V-01 / Hailuo).' },
  audio:  { label: '🎵 Audio / lyrics',         desc: 'Servono per analizzare la canzone e trascrivere il testo (Gemini).' },
};

function renderKeysPanel(){
  const panel = $('keysPanel');
  panel.innerHTML = '';

  // --- LLM section ---
  const llmGrp = document.createElement('div');
  llmGrp.className = 'keygrp';
  llmGrp.innerHTML = '<h4>' + PANEL_MODEL.llm.label + '</h4><div class="grpdesc">' + PANEL_MODEL.llm.desc + '</div>';
  const llmProviders = (config && config.llmProviders) || [];
  const llmOptions = llmProviders.map(p =>
    '<option value="' + p.id + '" data-default="' + p.defaultModel + '">' + p.label + '</option>'
  ).join('');
  const llmRow = document.createElement('div');
  llmRow.className = 'keyrow full';
  llmRow.innerHTML = ''
    + '<label>Provider & modello'
    + '  <div style="display:flex;gap:8px">'
    + '    <select id="llmProviderSel" style="flex:1">' + llmOptions + '</select>'
    + '    <input id="llmModelInp" placeholder="modello (es. gpt-4o-mini)" style="flex:1">'
    + '  </div>'
    + '</label>'
    + '<label style="margin-top:8px">API key'
    + '  <input id="llmKeyInp" type="password" autocomplete="off" placeholder="Incolla qui la chiave — resta sul tuo PC">'
    + '</label>'
    + '<div class="acts" style="margin-top:8px;align-items:flex-start">'
    + '  <label class="savetog"><input type="checkbox" id="llmSaveTog"> Ricorda cifrata sul disco</label>'
    + '  <span id="llmStatus" class="savedhint"></span>'
    + '  <button id="llmForgetBtn" type="button" style="display:none">Dimentica</button>'
    + '  <span id="llmMsg" class="keymsg"></span>'
    + '</div>';
  llmGrp.appendChild(llmRow);
  panel.appendChild(llmGrp);

  // --- Video + Audio sections ---
  const fixed = [
    { kind: 'video', provider: 'minimax', label: PANEL_MODEL.video.label, desc: PANEL_MODEL.video.desc, placeholder: 'MINIMAX_API_KEY — genera le clip (S2V-01 e Hailuo)' },
    { kind: 'audio', provider: 'gemini',  label: PANEL_MODEL.audio.label, desc: PANEL_MODEL.audio.desc, placeholder: 'GEMINI_API_KEY — analisi canzone & lyrics (opzionale)' },
  ];
  // External video providers (Runway, Replicate…) from the config, so each gets
  // a save/forget key field like the built-ins.
  (config.videoProviders || []).forEach(p => {
    if (p.id === 'minimax') return;
    if (p.keyProvider) return; // reuses another provider's key field (e.g. Veo → Gemini)
    fixed.push({ kind: 'video', provider: p.id, label: '🎥 ' + p.label, desc: p.note || '', placeholder: p.keyPlaceholder || ('API key ' + p.label) });
  });
  for (const f of fixed) {
    const grp = document.createElement('div');
    grp.className = 'keygrp';
    const savedEntry = config.keys.saved[f.provider];
    const hasKey = config.keys[f.provider];
    const statusHtml = hasKey
      ? '<span class="savedhint">✓ ' + (savedEntry && savedEntry.masked ? savedEntry.masked + ' · salvata' : 'da ambiente') + '</span>'
      : '<span style="color:var(--warn)">non configurata</span>';
    grp.innerHTML = '<h4>' + f.label + '</h4><div class="grpdesc">' + f.desc + '</div>';
    grp.innerHTML += ''
      + '<div class="keyrow full">'
      + '  <label>API key'
      + '    <input id="key_' + f.provider + '" type="password" autocomplete="off" placeholder="' + f.placeholder + '">'
      + '  </label>'
      + '  <div class="acts" style="margin-top:8px;align-items:flex-start">'
      + '    <label class="savetog"><input type="checkbox" id="save_' + f.provider + '"> Ricorda cifrata sul disco</label>'
      + '    ' + statusHtml
      + '    <button id="forget_' + f.provider + '" type="button" style="display:' + (savedEntry && savedEntry.hasKey ? 'inline-block' : 'none') + '">Dimentica</button>'
      + '    <span id="msg_' + f.provider + '" class="keymsg"></span>'
      + '  </div>'
      + '</div>';
    panel.appendChild(grp);
  }

  // --- Wire up handlers ----------------------------------------------------
  // LLM select → prefill default model + check if a saved key exists for that provider.
  const provSel = $('llmProviderSel');
  const modelInp = $('llmModelInp');
  const keyInp = $('llmKeyInp');
  const saveTog = $('llmSaveTog');
  const status = $('llmStatus');
  const forgetBtn = $('llmForgetBtn');
  const msg = $('llmMsg');

  function refreshLlmStatus(){
    const p = llmProviders.find(x => x.id === provSel.value);
    if (!p) return;
    modelInp.value = modelInp.value || p.defaultModel;
    if (p.saved) {
      const masked = config.keys.saved[p.id] && config.keys.saved[p.id].masked;
      status.textContent = masked ? '✓ salvata · ' + masked : '✓ salvata';
      forgetBtn.style.display = 'inline-block';
    } else if (p.envPresent) {
      status.textContent = "✓ da variabile d'ambiente";
      forgetBtn.style.display = 'none';
    } else {
      status.textContent = '';
      forgetBtn.style.display = 'none';
    }
  }
  provSel.addEventListener('change', () => {
    const p = llmProviders.find(x => x.id === provSel.value);
    modelInp.value = p?.defaultModel || '';
    keyInp.value = '';
    saveTog.checked = false;
    msg.textContent = '';
    refreshLlmStatus();
  });
  modelInp.addEventListener('focus', () => { if (!modelInp.value) {
    const p = llmProviders.find(x => x.id === provSel.value);
    if (p) modelInp.value = p.defaultModel;
  }});
  refreshLlmStatus();

  // Forget buttons for LLM + fixed providers.
  forgetBtn.addEventListener('click', () => forgetKey(provSel.value, msg));
  for (const f of fixed) {
    $('forget_' + f.provider).addEventListener('click', () => forgetKey(f.provider, $('msg_' + f.provider)));
  }
}

async function forgetKey(provider, msgEl){
  try{
    const r = await fetch('/api/keys/' + encodeURIComponent(provider), { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'cancellazione fallita');
    msgEl.textContent = '✓ chiave rimossa';
    await reloadConfig();
  }catch(e){ msgEl.textContent = '⚠ ' + e.message; }
}

async function reloadConfig(){
  try{
    config = await (await fetch('/api/config')).json();
    renderKeysPanel();
  }catch{}
}

async function saveKeyIfNeeded(provider, secret, shouldSave, msgEl){
  if (!shouldSave) { msgEl.textContent = ''; return; }
  try{
    const r = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, secret }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'salvataggio fallito');
    msgEl.textContent = '✓ salvata cifrata (' + d.masked + ')';
    await reloadConfig();
  }catch(e){ msgEl.textContent = '⚠ ' + e.message; }
}

async function loadConfig(){
  try{
    config = await (await fetch('/api/config')).json();
    renderKeysPanel();
    $('activeModelInfo').innerHTML = config.activeModel
      ? ('Modello CLI per lo storyboard: <b>' + config.activeModel + '</b>')
      : '⚠ Nessun modello CLI attivo — lo storyboard automatico userà una chiave dal pannello "API keys" (LLM per lo storyboard).';
  }catch(e){/* studio still usable with defaults */}
}
loadConfig();

// Collect everything the user typed in the keys panel. Values are sent only
// for the current request — the server does NOT echo secrets back.
function readKeys(){
  const llmKey = ($('llmKeyInp')?.value || '').trim();
  const llmProvider = $('llmProviderSel')?.value || '';
  const llmModel = ($('llmModelInp')?.value || '').trim();
  // Persist fixed providers if the user checked the toggle (best-effort,
  // fire-and-forget so the actual request isn't blocked).
  const fixedPairs = [
    { provider: 'minimax', input: 'key_minimax', save: 'save_minimax', msg: 'msg_minimax' },
    { provider: 'gemini',  input: 'key_gemini',  save: 'save_gemini',  msg: 'msg_gemini'  },
  ];
  // External video providers get the same save-on-toggle treatment (skip those
  // reusing another provider's field, e.g. Veo → Gemini).
  (config && config.videoProviders || []).forEach(p => {
    if (p.id !== 'minimax' && !p.keyProvider) fixedPairs.push({ provider: p.id, input: 'key_' + p.id, save: 'save_' + p.id, msg: 'msg_' + p.id });
  });
  for (const f of fixedPairs) {
    const v = ($(f.input)?.value || '').trim();
    const want = !!$(f.save)?.checked;
    if (v && want) saveKeyIfNeeded(f.provider, v, true, $(f.msg));
  }
  // Persist LLM key if requested.
  const llmSaveTog = $('llmSaveTog');
  if (llmKey && llmSaveTog?.checked) {
    saveKeyIfNeeded(llmProvider, llmKey, true, $('llmMsg'));
  }
  const out = {
    minimax: ($( 'key_minimax')?.value || '').trim(),
    gemini:  ($('key_gemini')?.value  || '').trim(),
    llm: llmKey && llmProvider && llmModel ? { provider: llmProvider, apiKey: llmKey, model: llmModel } : null,
  };
  (config && config.videoProviders || []).forEach(p => {
    if (p.id !== 'minimax' && !p.keyProvider) out[p.id] = ($('key_' + p.id)?.value || '').trim();
  });
  return out;
}
function dur(){return (state&&state.clipLength)||6;}
function pointsPerClip(model,res){
  const t=config&&config.points&&config.points[model]&&config.points[model][res];
  return t?t[dur()]:null; // null = costo a punti non listato (es. S2V-01)
}
function usdPerClip(model,res){
  if(!config)return null;
  const m=config.models.find(x=>x.id===model);
  if(!m)return null;
  const p=m.prices[res];
  return p!=null?p:m.prices[m.resolutions[0]];
}
function cheapestByPoints(){
  if(!config)return null;
  let best=null;
  config.models.forEach(m=>m.resolutions.forEach(r=>{
    const pp=pointsPerClip(m.id,r);
    if(pp!=null&&(!best||pp<best.pp))best={id:m.id,label:m.label,res:r,pp};
  }));
  return best;
}
function sceneCountNow(){return [...document.querySelectorAll('[data-p]')].filter(t=>t.value.trim()).length;}
function currentVideoProvider(){return $('videoProvSel')?.value||'minimax';}
function videoProviderDef(id){return (config&&config.videoProviders||[]).find(p=>p.id===id)||null;}
function updateCost(){
  const provider=currentVideoProvider();
  const n=sceneCountNow();
  if(provider!=='minimax'){
    const def=videoProviderDef(provider);
    const modelId=$('videoModelSel')?.value||'';
    const keyOk=(config&&config.keys[provider])||(readKeys()[provider]||'');
    let h='🎬 <b>'+n+'</b> clip · <span class="opt">'+(def?def.label:provider)+(modelId?(' · '+modelId):'')+'</span><br>';
    h+='<span class="opt">'+(def&&def.note?def.note:'Costo fatturato sul tuo account '+provider)+'</span>';
    if(!keyOk)h+='<br><span class="badge-no">⚠ Inserisci la API key '+(def?def.label:provider)+' nel pannello “API keys”.</span>';
    $('costBox').innerHTML=h;
    return;
  }
  const model=$('modelSel').value, res=$('resSel').value;
  const pp=pointsPerClip(model,res), usd=usdPerClip(model,res);
  const keyOk=(config&&config.keys.minimax)||readKeys().minimax;
  let html='🎬 <b>'+n+'</b> clip · <span class="opt">'+model+' '+res+' · '+dur()+'s</span><br>';
  if(pp!=null){
    html+='Ti servono: <span class="costbig">'+(pp*n).toFixed(1)+' video points</span> <span class="opt">('+pp+'/clip'+(usd!=null?(' · ~$'+(usd*n).toFixed(2)):'')+')</span>';
  }else{
    html+='<span class="costbig">'+(usd!=null?('~$'+(usd*n).toFixed(2)):'costo n/d')+'</span> <span class="opt">(modello non tariffato a punti)</span>';
  }
  const cheap=cheapestByPoints();
  if(cheap&&!(cheap.id===model&&cheap.res===res)){
    html+='<br>💡 Più economico: <b>'+cheap.label+'</b> a '+cheap.res+' → <b>'+(cheap.pp*n).toFixed(1)+' video points</b> ('+cheap.pp+'/clip). '+
      '<a href="#" id="useCheap" style="color:var(--acc2)">usa questo</a>';
  }
  if(!keyOk)html+='<br><span class="badge-no">⚠ Inserisci la MiniMax API key per poter generare.</span>';
  $('costBox').innerHTML=html;
  const uc=$('useCheap');
  if(uc)uc.onclick=(e)=>{e.preventDefault();$('modelSel').value=cheap.id;populateResolutions();$('resSel').value=cheap.res;updateCost();};
}
function applyVideoProviderUI(){
  const provider=currentVideoProvider();
  const isMinimax=provider==='minimax';
  $('mmModelWrap').classList.toggle('hidden',!isMinimax);
  $('mmResWrap').classList.toggle('hidden',!isMinimax);
  $('extModelWrap').classList.toggle('hidden',isMinimax);
  if(!isMinimax){
    const def=videoProviderDef(provider);
    const vm=$('videoModelSel');vm.innerHTML='';
    (def&&def.models||[]).forEach(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=m.label;vm.appendChild(o);});
  }
  updateCost();
}
function populateModelSelectors(){
  if(!config)return;
  const vp=$('videoProvSel');
  if(vp){
    vp.innerHTML='';
    (config.videoProviders||[]).forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.label;vp.appendChild(o);});
    vp.value='minimax';
    vp.onchange=applyVideoProviderUI;
    const vm=$('videoModelSel');if(vm)vm.onchange=updateCost;
  }
  const ms=$('modelSel');ms.innerHTML='';
  config.models.forEach(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=m.label;ms.appendChild(o);});
  ms.value=config.defaultModel||config.models[0].id;
  populateResolutions();
  ms.onchange=()=>{populateResolutions();updateCost();};
  $('resSel').onchange=updateCost;
  applyVideoProviderUI();
}
function populateResolutions(){
  const m=config.models.find(x=>x.id===$('modelSel').value)||config.models[0];
  const rs=$('resSel');rs.innerHTML='';
  m.resolutions.forEach(r=>{const o=document.createElement('option');o.value=r;o.textContent=r;rs.appendChild(o);});
  rs.value=m.resolutions[0];
}

function fileToDataUrl(f){return new Promise(r=>{const rd=new FileReader();rd.onload=()=>r(rd.result);rd.readAsDataURL(f);});}
function setStep(n){[1,2,3].forEach(i=>{$('s'+i).classList.toggle('active',i<=n);$('step'+i).classList.toggle('hidden',i!==n);});window.scrollTo({top:0,behavior:'smooth'});}

function wireDrop(dropId,inputId,onFile,kind){
  const drop=$(dropId),input=$(inputId);
  drop.onclick=()=>input.click();
  input.onchange=e=>{if(e.target.files[0])onFile(e.target.files[0]);};
  drop.ondragover=e=>{e.preventDefault();drop.classList.add('hot');};
  drop.ondragleave=()=>drop.classList.remove('hot');
  drop.ondrop=e=>{e.preventDefault();drop.classList.remove('hot');if(e.dataTransfer.files[0])onFile(e.dataTransfer.files[0]);};
}
wireDrop('dropAudio','audioInput',async f=>{audioData=await fileToDataUrl(f);$('audioLbl').textContent=f.name;$('dropAudio').classList.add('filled');checkReady();},'audio');
wireDrop('dropPhoto','photoInput',async f=>{photoData=await fileToDataUrl(f);$('photoLbl').textContent=f.name;const d=$('dropPhoto');d.classList.add('filled');d.querySelector('.ico').innerHTML='<img src="'+photoData+'">';checkReady();},'photo');
function checkReady(){$('analyzeBtn').disabled=!(audioData&&photoData);}

$('analyzeBtn').onclick=async()=>{
  $('analyzeBtn').disabled=true;$('analyzeMsg').innerHTML='<span class="spin"></span>Analisi in corso…';
  const box=$('analyzeLog');box.classList.remove('hidden');box.innerHTML='<div>Avvio analisi…</div>';
  try{
    const keys = readKeys();
    const r=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audio:audioData,clipLength:+$('clipLen').value,apiKeys:{gemini:keys.gemini, llm:keys.llm}})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Analisi fallita');
    pollAnalysis(d.jobId);
  }catch(e){$('analyzeMsg').textContent='⚠ '+e.message;$('analyzeBtn').disabled=false;}
};

async function pollAnalysis(jobId){
  try{
    const r=await fetch('/api/status?job='+encodeURIComponent(jobId));
    const d=await r.json();
    const box=$('analyzeLog');
    box.innerHTML=(d.log||[]).slice(-40).map(l=>'<div>'+l.msg.replace(/</g,'&lt;')+'</div>').join('');
    box.scrollTop=box.scrollHeight;
    if(d.state==='error'){$('analyzeMsg').textContent='⚠ '+(d.error||'Analisi fallita');$('analyzeBtn').disabled=false;return;}
    if(d.state==='analyzed'&&d.analysis){
      state=Object.assign({jobId},d.analysis);
      $('analyzeMsg').innerHTML='';$('analyzeBtn').disabled=false;
      renderStep2(d.analysis);setStep(2);
      return;
    }
    setTimeout(()=>pollAnalysis(jobId),1500);
  }catch(e){setTimeout(()=>pollAnalysis(jobId),2500);}
}

function renderStep2(d){
  $('analysisOut').textContent=(d.analysis||'')+(d.lyrics?'\\n\\n— Lyrics —\\n'+d.lyrics.slice(0,1200):'');
  populateModelSelectors();
  const box=$('scenes');box.innerHTML='';
  const list=d.storyboard.length?d.storyboard:Array.from({length:d.sceneCount},(_,i)=>({title:'Scene '+(i+1),prompt:'',duration:d.clipLength}));
  list.forEach((s,i)=>{
    const el=document.createElement('div');el.className='scene';
    el.innerHTML='<div class="st"><b>#'+(i+1)+'</b><input data-t="'+i+'" value="'+(s.title||'').replace(/"/g,'&quot;')+'"></div><textarea data-p="'+i+'" placeholder="Descrizione scena + movimento camera">'+(s.prompt||'')+'</textarea>';
    box.appendChild(el);
  });
  document.querySelectorAll('[data-p]').forEach(t=>t.addEventListener('input',updateCost));
  // Show a prominent storyboard-error banner (instead of burying it inside
  // the analysisOut <pre>). Includes retry + back-to-step-1 actions.
  const errEl = $('storyboardErr');
  if (d.storyboardError) {
    errEl.classList.remove('hidden');
    errEl.innerHTML = ''
      + '<b>⚠ Storyboard automatico non riuscito</b><br>'
      + '<span style="white-space:pre-wrap">' + (d.storyboardError || '').replace(/</g,'&lt;') + '</span>'
      + '<div style="font-size:12.5px;color:var(--dim);margin-top:6px">'
      +   'Compila le scene sotto a mano, oppure aggiungi una chiave per un altro LLM nel pannello "API keys" e riprova.'
      + '</div>'
      + '<div class="acts">'
      +   '<button id="retryStoryboardBtn" type="button">↻ Riprova con un altro LLM</button>'
      +   '<button id="backStep1Btn" type="button">← Torna allo step 1</button>'
      + '</div>';
    $('retryStoryboardBtn').onclick = () => rerunAnalysis();
    $('backStep1Btn').onclick = () => setStep(1);
  } else {
    errEl.classList.add('hidden');
    errEl.innerHTML = '';
  }
  updateCost();
}

// Re-run /api/analyze with the same audio + photo. Used by the "retry with
// another LLM" button so the user can plug in a new key and retry without
// re-uploading the song.
async function rerunAnalysis(){
  if (!state.jobId) { setStep(1); return; }
  // Easiest path: just send the analyze request again. readKeys() will pick
  // up any newly typed/saved key.
  $('storyboardErr').classList.add('hidden');
  const keys = readKeys();
  // We need a fresh jobId because /api/analyze is per-call. The studio's
  // state object still has jobId, but a new request creates a new one.
  const r = await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audio:audioData,clipLength:state.clipLength,apiKeys:{gemini:keys.gemini, llm:keys.llm}})});
  const d = await r.json();
  if (!r.ok) { alert(d.error || 'Riprova fallita'); return; }
  state.jobId = d.jobId;
  setStep(3);
  $('genTitle').textContent='Riprovo…';
  poll();
}

$('backBtn').onclick=()=>setStep(1);

$('genBtn').onclick=async()=>{
  const titles=[...document.querySelectorAll('[data-t]')];
  const proms=[...document.querySelectorAll('[data-p]')];
  const storyboard=proms.map((p,i)=>({title:titles[i].value,prompt:p.value,duration:state.clipLength})).filter(s=>s.prompt.trim());
  if(!storyboard.length){alert('Aggiungi almeno una scena con descrizione.');return;}
  const keys=readKeys();
  const provider=currentVideoProvider();
  const def=videoProviderDef(provider);
  const keyPid=(def&&def.keyProvider)||provider;
  const provKeyOk=(config&&config.keys[provider])||keys[provider]||keys[keyPid];
  if(!provKeyOk){
    alert('Inserisci la API key '+(def?def.label:provider)+' nel pannello “API keys” dello step 1.');setStep(1);return;
  }
  const apiKeys={minimax:keys.minimax, gemini:keys.gemini, llm:keys.llm};
  (config&&config.videoProviders||[]).forEach(p=>{if(p.id!=='minimax'&&!p.keyProvider)apiKeys[p.id]=keys[p.id]||'';});
  setStep(3);$('genErr').classList.add('hidden');$('videoWrap').classList.add('hidden');
  try{
    const r=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:state.jobId,photo:photoData,storyboard,provider,videoModel:$('videoModelSel')?.value||null,model:$('modelSel').value,resolution:$('resSel').value,apiKeys})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Avvio fallito');
    poll();
  }catch(e){showErr(e.message);}
};

function showErr(m){$('genErr').textContent='⚠ '+m;$('genErr').classList.remove('hidden');$('genTitle').textContent='Generazione interrotta';}

async function poll(){
  try{
    const r=await fetch('/api/status?job='+encodeURIComponent(state.jobId));
    const d=await r.json();
    const pct=d.total?Math.round(d.done/d.total*100):0;
    $('barFill').style.width=(d.state==='done'?100:pct)+'%';
    $('genStatus').innerHTML=(d.state==='running'?'<span class="spin"></span>':'')+'Clip '+d.done+'/'+d.total+(d.state==='done'?' · montaggio completato':'');
    $('logBox').innerHTML=(d.log||[]).slice(-40).map(l=>'<div>'+l.msg.replace(/</g,'&lt;')+'</div>').join('');
    $('logBox').scrollTop=$('logBox').scrollHeight;
    if(d.error){showErr(d.error);return;}
    if(d.state==='done'&&d.videoUrl){
      $('genTitle').textContent='🎉 Video pronto!';
      $('finalVideo').src=d.videoUrl;$('dlLink').href=d.videoUrl;$('videoWrap').classList.remove('hidden');
      return;
    }
    setTimeout(poll,2000);
  }catch(e){setTimeout(poll,3000);}
}
</script>
</div></body></html>`;
