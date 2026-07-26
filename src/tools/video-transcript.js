// Video transcription with a 3-level cascade:
//   Level 1 — YouTube captions (free, no setup, this file)
//   Level 2 — local whisper + yt-dlp (free forever, requires one-time install)
//   Level 3 — Gemini API free tier (no install, requires API key)
// Levels 2 and 3 live in audio-transcribe.js; this file owns Level 1 and the
// orchestrator that wires the three together.

import { transcribeLocal, transcribeWithGemini, getGeminiApiKey } from './audio-transcribe.js';

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

export function extractYouTubeVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (YOUTUBE_ID_RE.test(s)) return s;

  let url;
  try { url = new URL(s); } catch { return null; }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return YOUTUBE_ID_RE.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') {
      const v = url.searchParams.get('v');
      return v && YOUTUBE_ID_RE.test(v) ? v : null;
    }
    const m = url.pathname.match(/^\/(shorts|embed|v|live)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[2];
  }
  return null;
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

export function parseTranscriptXml(xml) {
  const out = [];
  const re = /<text\s+start="([^"]+)"(?:\s+dur="([^"]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const start = parseFloat(m[1]);
    if (!Number.isFinite(start)) continue;
    const text = decodeXmlEntities(m[3])
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) out.push({ start, text });
  }
  return out;
}

export function pickBestTrack(tracks, preferLang = 'en') {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const lang = String(preferLang || '').toLowerCase();

  // Priority: human-made in preferred lang > human-made (any) > auto in preferred lang > anything.
  const human = tracks.filter(t => t.kind !== 'asr');
  const auto = tracks.filter(t => t.kind === 'asr');
  const matchLang = (list) => list.find(t => {
    const code = String(t.languageCode || '').toLowerCase();
    return code === lang || code.startsWith(lang + '-');
  });

  return matchLang(human) || human[0] || matchLang(auto) || auto[0] || tracks[0];
}

function extractCaptionTracks(html) {
  // ytInitialPlayerResponse can be very large; scan only what we need.
  // The captionTracks array sits inside playerCaptionsTracklistRenderer.
  const m = String(html || '').match(/"captionTracks":\s*(\[[\s\S]*?\])/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function fetchOembedMetadata(videoId, signal) {
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal, headers: BROWSER_HEADERS },
    );
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function fetchWatchPageHtml(videoId, signal) {
  const r = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: BROWSER_HEADERS,
    signal,
  });
  if (!r.ok) throw new Error(`watch page returned HTTP ${r.status}`);
  return await r.text();
}

export async function fetchYouTubeTranscript({ url, preferLang = 'en' }, { signal, _fetchers } = {}) {
  const id = extractYouTubeVideoId(url);
  if (!id) {
    return { error: 'Not a recognizable YouTube URL or video ID. Expected forms: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID.' };
  }

  // _fetchers is a test hook — production always uses the real fetchers.
  const fetchMeta = _fetchers?.fetchOembedMetadata || fetchOembedMetadata;
  const fetchPage = _fetchers?.fetchWatchPageHtml || fetchWatchPageHtml;
  const fetchTrack = _fetchers?.fetchTrack || (async (u) => {
    const r = await fetch(u, { signal, headers: BROWSER_HEADERS });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  });

  const [metaResult, pageResult] = await Promise.allSettled([
    fetchMeta(id, signal),
    fetchPage(id, signal),
  ]);

  if (pageResult.status === 'rejected') {
    return { error: `Failed to fetch the YouTube page: ${pageResult.reason?.message || pageResult.reason}`, videoId: id };
  }
  const html = pageResult.value;
  const meta = metaResult.status === 'fulfilled' ? metaResult.value : null;
  const metadata = meta ? { title: meta.title, author: meta.author_name } : null;

  // Detect playability problems before captions: deleted, private, age-gated, region-locked.
  if (/"status":\s*"ERROR"/.test(html) || /"reason":\s*"Video unavailable"/.test(html)) {
    return { error: 'Video unavailable (deleted, private, or region-locked).', videoId: id, metadata };
  }
  if (/"status":\s*"LOGIN_REQUIRED"/.test(html)) {
    return { error: 'Video requires sign-in (age-restricted or private).', videoId: id, metadata };
  }

  const tracks = extractCaptionTracks(html);
  if (!tracks || !tracks.length) {
    return {
      error: 'This video has no captions available (neither human-made nor auto-generated). Captions are required for Phase-1 transcription.',
      videoId: id,
      metadata,
    };
  }

  const track = pickBestTrack(tracks, preferLang);
  if (!track?.baseUrl) {
    return { error: 'No usable caption track found.', videoId: id, metadata };
  }

  let xml;
  try {
    xml = await fetchTrack(track.baseUrl);
  } catch (e) {
    return { error: `Failed to download captions: ${e.message}`, videoId: id, metadata };
  }

  const segments = parseTranscriptXml(xml);
  if (!segments.length) {
    return { error: 'Captions returned no parseable text.', videoId: id, metadata };
  }

  return {
    videoId: id,
    metadata,
    language: track.languageCode || 'unknown',
    auto: track.kind === 'asr',
    segments,
  };
}

export function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Orchestrates the 3-level cascade. Each level is best-effort; an explicit
// fall-through reason is collected per level for the final error message
// when nothing succeeds.
export async function transcribeVideo({ url, preferLang = 'en' }, opts = {}) {
  const tried = [];
  const videoId = extractYouTubeVideoId(url);
  const isYouTube = !!videoId;

  // Level 1: YouTube captions (free, instant, no setup).
  if (isYouTube) {
    const captions = await fetchYouTubeTranscript({ url, preferLang }, opts);
    if (!captions.error) {
      return { ...captions, source: 'youtube-captions' };
    }
    tried.push({ level: 'captions', reason: captions.error });
  } else {
    tried.push({ level: 'captions', reason: 'not a YouTube URL' });
  }

  // Level 2: local whisper (free forever, needs yt-dlp + whisper installed).
  if (opts.allowLocal !== false) {
    const local = await transcribeLocal({
      url,
      preferLang,
      signal: opts.signal,
      log: opts.log,
      _runner: opts._runner,
    });
    if (!local.error) {
      return {
        videoId,
        metadata: null,
        language: local.language,
        auto: true,
        segments: local.segments,
        source: local.source,
      };
    }
    tried.push({ level: 'local', reason: local.error });
  } else {
    tried.push({ level: 'local', reason: 'disabled by config' });
  }

  // Level 3: Gemini free tier. Only natively understands YouTube URLs — for
  // arbitrary video URLs the user needs Level 2.
  const apiKey = getGeminiApiKey(opts);
  if (apiKey && isYouTube) {
    const gemini = await transcribeWithGemini({
      url,
      apiKey,
      signal: opts.signal,
      _fetch: opts._geminiFetch,
    });
    if (!gemini.error) {
      return {
        videoId,
        metadata: null,
        language: gemini.language,
        auto: true,
        segments: gemini.segments,
        source: gemini.source,
      };
    }
    tried.push({ level: 'gemini', reason: gemini.error });
  } else if (!apiKey) {
    tried.push({ level: 'gemini', reason: 'no GEMINI_API_KEY configured' });
  } else {
    tried.push({ level: 'gemini', reason: 'Gemini direct URL support is YouTube-only' });
  }

  return {
    videoId,
    error: 'Transcription failed at every level. ' + tried.map(t => `[${t.level}] ${t.reason}`).join(' | '),
    tried,
  };
}

export function renderTranscript(result, { maxChars = 18000 } = {}) {
  if (result.error) {
    const parts = [`Error: ${result.error}`];
    if (result.videoId) parts.push(`video_id: ${result.videoId}`);
    if (result.metadata?.title) parts.push(`title: ${result.metadata.title}`);
    return parts.join('\n');
  }

  const { metadata, videoId, language, auto, segments, source } = result;
  const sourceLabel = {
    'youtube-captions': 'YOUTUBE CAPTIONS',
    'whisper-local': 'WHISPER (LOCAL)',
    'gemini-flash': 'GEMINI FLASH',
  }[source] || 'TRANSCRIPT';
  const header = [
    `[${sourceLabel}]`,
    metadata?.title ? `title: ${metadata.title}` : null,
    metadata?.author ? `channel: ${metadata.author}` : null,
    videoId ? `video_id: ${videoId}` : null,
    `language: ${language}${auto ? ' (auto-generated)' : ''}`,
    `segments: ${segments.length}`,
    ``,
  ].filter(Boolean).join('\n');

  const lines = segments.map(s => `[${formatTimestamp(s.start)}] ${s.text}`);
  const body = lines.join('\n');
  if (body.length > maxChars) {
    return header + body.slice(0, maxChars) + `\n... truncated at ${maxChars} chars (full transcript: ${body.length} chars).`;
  }
  return header + body;
}
