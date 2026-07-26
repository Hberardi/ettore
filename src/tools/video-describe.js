// Video visual understanding via Google Gemini free tier.
//
// Why a separate tool from video_transcript:
//   - video_transcript extracts the spoken audio track (what people SAY).
//   - video_describe extracts the visual track (what people SHOW: slides,
//     demos, on-screen text, charts, code, UI, gestures, scene changes).
//
// Gemini can ingest a YouTube URL directly as fileData, sampling frames
// server-side. For non-YouTube URLs we fall back to video_transcript's
// local-whisper path for the audio track — full frame extraction from
// arbitrary video hosts would require yt-dlp + ffmpeg, which is out of
// scope here. Non-YouTube callers should chain video_transcript for audio
// and use this tool only when the source is YouTube.

import { getGeminiApiKey, geminiEndpoint } from './audio-transcribe.js';
import { extractYouTubeVideoId } from './video-transcript.js';

const DEFAULT_PROMPT =
  'Watch this video carefully and describe its visual content in detail. ' +
  'Cover: scene changes with approximate timestamps [MM:SS]; on-screen text, ' +
  'slides, code, formulas, diagrams, charts and UI shown; what people are ' +
  'doing (gestures, demonstrations, whiteboard work); and any visual context ' +
  'that would not be obvious from the audio alone. Be concrete and specific — ' +
  'quote visible text verbatim. If nothing visually notable happens, say so.';

export async function describeVideoWithGemini({ url, prompt, apiKey, signal, _fetch } = {}) {
  if (!url) {
    return { error: 'gemini: missing url argument.', tried: 'gemini' };
  }
  if (!apiKey) {
    return {
      error: 'gemini: no API key. Set GEMINI_API_KEY env var (free tier at aistudio.google.com).',
      tried: 'gemini',
      installed: false,
    };
  }
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return {
      error: 'gemini: video_describe currently supports YouTube URLs only (Gemini accepts YouTube fileData natively). For other hosts, use video_transcript for the audio track.',
      tried: 'gemini',
      installed: true,
    };
  }

  const body = {
    contents: [{
      parts: [
        { text: String(prompt || DEFAULT_PROMPT) },
        { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` } },
      ],
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
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
  catch (e) {
    return { error: `gemini: invalid JSON response: ${e.message}`, tried: 'gemini', installed: true };
  }

  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n').trim();
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    return {
      error: blockReason
        ? `gemini: response blocked (${blockReason}).`
        : 'gemini: empty response (model may not have been able to process the video).',
      tried: 'gemini',
      installed: true,
    };
  }

  return {
    videoId,
    description: text,
    source: 'gemini-flash-visual',
  };
}

// Public entry point used by the tool handler. Resolves the API key,
// delegates to describeVideoWithGemini, and shapes the result for the agent.
export async function describeVideo({ url, prompt }, opts = {}) {
  const apiKey = getGeminiApiKey(opts);
  if (!apiKey) {
    return {
      error: 'video_describe needs GEMINI_API_KEY (free tier at aistudio.google.com). Set it in the environment or via /connect. For audio-only understanding of any video, use video_transcript instead.',
    };
  }
  const result = await describeVideoWithGemini({
    url,
    prompt,
    apiKey,
    signal: opts.signal,
    _fetch: opts._fetch,
  });
  if (result.error) return result;
  return {
    videoId: result.videoId,
    description: result.description,
    source: result.source,
  };
}

export const VIDEO_DESCRIBE_DEFAULT_PROMPT = DEFAULT_PROMPT;
