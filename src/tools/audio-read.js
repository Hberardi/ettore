// Read a local music/audio file so the model can understand it. Two modes:
//   - transcribe: extract the sung/spoken words (lyrics) with timestamps.
//       Prefers local whisper (free, offline); falls back to Gemini free tier
//       when whisper is not installed but a GEMINI_API_KEY is available.
//   - describe: analyze the audio itself — genre, instruments, tempo/BPM,
//       mood, structure. Needs a multimodal model, so this always uses Gemini.
//
// Both modes read the file straight from disk. Gemini calls pass the audio
// inline as base64 (the model's inlineData part), which caps request size at
// ~20MB — plenty for a typical song, and far simpler than the resumable
// Files API. Oversized files are rejected up front with a whisper hint.

import { stat, readFile } from 'fs/promises';
import { extname, basename, resolve } from 'path';
import {
  detectLocalTools,
  whisperTranscribeFile,
  getGeminiApiKey,
  geminiEndpoint,
  parseTimestampedText,
} from './audio-transcribe.js';

// Inline audio must fit in the ~20MB total request budget; leave headroom for
// the base64 inflation (~33%) and the JSON envelope.
const MAX_INLINE_BYTES = 14 * 1024 * 1024;

// Extension -> Gemini-accepted audio MIME type. Keys double as the allow-list.
const AUDIO_MIME = {
  '.mp3': 'audio/mp3',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.webm': 'audio/webm',
};

const TRANSCRIBE_PROMPT =
  'Transcribe the lyrics / spoken words in this audio file word-for-word in ' +
  'their original language. Insert a [MM:SS] timestamp roughly every 20 ' +
  'seconds at natural line breaks. If the track is purely instrumental, say ' +
  'so. Output ONLY the transcript — no preamble, no summary.';

const DESCRIBE_PROMPT =
  'Analyze this audio file as a piece of music. Cover, as concretely as you ' +
  'can: overall genre and sub-genre; mood/energy; approximate tempo in BPM ' +
  'and time signature; key or tonality if identifiable; instruments and ' +
  'voices you hear; song structure with rough timestamps (intro, verse, ' +
  'chorus, bridge, outro); production/mix character; and anything distinctive. ' +
  'If it is speech rather than music, describe it as such instead.';

// Call Gemini with the audio inlined as base64. Returns { text, source } or
// { error }. `kind` only tweaks the error wording (transcribe vs describe).
export async function analyzeAudioWithGemini({ filePath, mimeType, prompt, apiKey, signal, log, _fetch, _readFile } = {}) {
  if (!apiKey) {
    return { error: 'gemini: no API key. Set GEMINI_API_KEY (free tier at aistudio.google.com).', tried: 'gemini', installed: false };
  }

  let bytes;
  try {
    bytes = await (_readFile || readFile)(filePath);
  } catch (e) {
    return { error: `gemini: could not read file: ${e.message}`, tried: 'gemini', installed: true };
  }
  if (bytes.length > MAX_INLINE_BYTES) {
    const mb = (bytes.length / (1024 * 1024)).toFixed(1);
    return {
      error: `gemini: file is ${mb}MB, over the ~${Math.round(MAX_INLINE_BYTES / (1024 * 1024))}MB inline limit. For transcription install whisper (\`pip install openai-whisper\`) to run offline on files of any size.`,
      tried: 'gemini',
      installed: true,
    };
  }

  log?.('Invio l\'audio a Gemini…');
  const body = {
    contents: [{
      parts: [
        { text: String(prompt || '') },
        { inlineData: { mimeType, data: bytes.toString('base64') } },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
  };

  const doFetch = _fetch || ((u, opts) => fetch(u, opts));
  let response;
  try {
    response = await doFetch(
      `${geminiEndpoint()}?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      },
    );
  } catch (e) {
    return { error: `gemini: network error: ${e.message}`, tried: 'gemini', installed: true };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const snippet = errText ? `: ${errText.slice(0, 200)}` : '';
    return { error: `gemini: HTTP ${response.status}${snippet}`, tried: 'gemini', installed: true };
  }

  let data;
  try { data = await response.json(); }
  catch (e) { return { error: `gemini: invalid JSON response: ${e.message}`, tried: 'gemini', installed: true }; }

  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n').trim();
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    return {
      error: blockReason
        ? `gemini: response blocked (${blockReason}).`
        : 'gemini: empty response (model may not have been able to process the audio).',
      tried: 'gemini',
      installed: true,
    };
  }
  return { text, source: 'gemini-flash' };
}

// Entry point used by the audio_read tool handler.
export async function readAudio({ file_path, mode = 'transcribe', language = 'auto', prompt } = {}, opts = {}) {
  if (!file_path) return { error: 'audio_read requires a "file_path" argument.' };

  const absPath = resolve(String(file_path));
  let info;
  try { info = await stat(absPath); }
  catch { return { error: `File not found: ${file_path}` }; }
  if (!info.isFile()) return { error: `Not a file: ${file_path}` };

  const ext = extname(absPath).toLowerCase();
  const mimeType = AUDIO_MIME[ext];
  if (!mimeType) {
    return { error: `Unsupported audio extension "${ext || '(none)'}". Supported: ${Object.keys(AUDIO_MIME).join(', ')}.` };
  }

  const normalizedMode = mode === 'describe' ? 'describe' : 'transcribe';
  const name = basename(absPath);

  if (normalizedMode === 'describe') {
    const apiKey = getGeminiApiKey(opts);
    if (!apiKey) {
      return { error: 'audio_read mode="describe" needs GEMINI_API_KEY (free tier at aistudio.google.com) — audio analysis requires a multimodal model.' };
    }
    const res = await analyzeAudioWithGemini({
      filePath: absPath, mimeType, prompt: prompt || DESCRIBE_PROMPT,
      apiKey, signal: opts.signal, log: opts.log, _fetch: opts._fetch, _readFile: opts._readFile,
    });
    if (res.error) return res;
    return { mode: 'describe', file: name, description: res.text, source: res.source };
  }

  // transcribe — prefer local whisper (free, offline, any file size).
  const tools = await detectLocalTools();
  const hasGemini = !!getGeminiApiKey(opts);

  if (tools.whisper) {
    // whisper (PyTorch build) pays a fixed ~5-10s cost every call to import
    // torch and load the model — independent of clip length. Say so up front
    // so a short clip doesn't look frozen.
    opts.log?.('Avvio whisper: import di torch + caricamento modello (~qualche secondo, indipendente dalla durata)…');
    const res = await whisperTranscribeFile({
      audioPath: absPath, preferLang: language, signal: opts.signal, log: opts.log,
    });
    if (!res.error) {
      return { mode: 'transcribe', file: name, segments: res.segments, language: res.language, source: res.source };
    }
    // whisper ran but produced nothing usable (e.g. instrumental/silent).
    // Only try Gemini if a key exists; otherwise surface whisper's REAL
    // error — never the misleading "whisper not installed" fallthrough.
    if (!hasGemini) return res;
  }

  if (hasGemini) {
    const res = await analyzeAudioWithGemini({
      filePath: absPath, mimeType, prompt: prompt || TRANSCRIBE_PROMPT,
      apiKey: getGeminiApiKey(opts), signal: opts.signal, log: opts.log, _fetch: opts._fetch, _readFile: opts._readFile,
    });
    if (res.error) return res;
    return {
      mode: 'transcribe', file: name,
      segments: parseTimestampedText(res.text),
      language: language && language !== 'auto' ? language : 'unknown',
      source: res.source,
    };
  }

  return {
    error: 'transcribe needs either whisper installed (`pip install openai-whisper`, free & offline) or GEMINI_API_KEY set (free tier at aistudio.google.com).',
  };
}

function formatTimestamp(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  const hh = Math.floor(mm / 60);
  if (hh > 0) return `${hh}:${String(mm % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

const SOURCE_LABEL = {
  'whisper-local': 'WHISPER (LOCAL)',
  'gemini-flash': 'GEMINI FLASH',
};

// Render a readAudio() result into the plain-text block the model receives.
export function renderAudioResult(result, { maxChars = 18000 } = {}) {
  if (!result || result.error) return `Error: ${result?.error || 'unknown audio error'}`;

  const label = SOURCE_LABEL[result.source] || 'AUDIO';

  if (result.mode === 'describe') {
    const header = [`[${label} — ANALYSIS]`, `file: ${result.file}`, ''].join('\n');
    const body = String(result.description || '');
    return header + (body.length > maxChars ? body.slice(0, maxChars) + `\n... truncated at ${maxChars} chars.` : body);
  }

  const segments = Array.isArray(result.segments) ? result.segments : [];
  const header = [
    `[${label} — LYRICS]`,
    `file: ${result.file}`,
    `language: ${result.language}`,
    `segments: ${segments.length}`,
    '',
  ].join('\n');
  const body = segments.map(s => `[${formatTimestamp(s.start)}] ${s.text}`).join('\n');
  if (body.length > maxChars) {
    return header + body.slice(0, maxChars) + `\n... truncated at ${maxChars} chars (full transcript: ${body.length} chars).`;
  }
  return header + body;
}
