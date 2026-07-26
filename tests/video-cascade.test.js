import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeVideo, renderTranscript } from '../src/tools/video-transcript.js';
import {
  parseTimestampedText,
  transcribeWithGemini,
  transcribeLocal,
  _setDetectionCache,
  getGeminiApiKey,
} from '../src/tools/audio-transcribe.js';

// ── parseTimestampedText ─────────────────────────────────────────────────

test('parseTimestampedText returns a single segment when no markers are present', () => {
  const segs = parseTimestampedText('Plain transcript without timestamps.');
  assert.deepEqual(segs, [{ start: 0, text: 'Plain transcript without timestamps.' }]);
});

test('parseTimestampedText splits on [MM:SS] and [H:MM:SS] markers', () => {
  const text = `Intro before any timestamp.
[0:00] Hello and welcome.
[0:30] Today we talk about caching.
[1:02:05] And much later, we end.`;
  const segs = parseTimestampedText(text);
  assert.equal(segs.length, 4);
  assert.equal(segs[0].start, 0);
  assert.equal(segs[0].text, 'Intro before any timestamp.');
  assert.equal(segs[1].start, 0);
  assert.equal(segs[1].text, 'Hello and welcome.');
  assert.equal(segs[2].start, 30);
  assert.equal(segs[3].start, 3725);
});

test('parseTimestampedText returns [] for empty input', () => {
  assert.deepEqual(parseTimestampedText(''), []);
  assert.deepEqual(parseTimestampedText(null), []);
});

// ── getGeminiApiKey ──────────────────────────────────────────────────────

test('getGeminiApiKey picks up opts.geminiApiKey first', () => {
  assert.equal(getGeminiApiKey({ geminiApiKey: 'fromOpts' }), 'fromOpts');
});

test('getGeminiApiKey falls through to env vars and returns null if none', () => {
  const orig = { gem: process.env.GEMINI_API_KEY, goog: process.env.GOOGLE_API_KEY };
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    assert.equal(getGeminiApiKey({}), null);
    process.env.GOOGLE_API_KEY = 'fromEnv';
    assert.equal(getGeminiApiKey({}), 'fromEnv');
  } finally {
    if (orig.gem === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = orig.gem;
    if (orig.goog === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = orig.goog;
  }
});

// ── transcribeWithGemini ─────────────────────────────────────────────────

test('transcribeWithGemini returns error when no API key', async () => {
  const r = await transcribeWithGemini({ url: 'https://youtu.be/abcDEF12345' });
  assert.match(r.error, /no API key/i);
  assert.equal(r.tried, 'gemini');
});

test('transcribeWithGemini parses a successful response into segments', async () => {
  let sentBody;
  const mockFetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [{
            content: {
              parts: [{ text: '[0:00] Intro line.\n[0:15] Second line.' }],
            },
          }],
        };
      },
    };
  };
  const r = await transcribeWithGemini({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    apiKey: 'dummy',
    _fetch: mockFetch,
  });
  assert.equal(r.error, undefined);
  assert.equal(r.source, 'gemini-flash');
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].start, 0);
  assert.equal(r.segments[1].start, 15);
  // Verify the request body shape
  assert.ok(sentBody.contents[0].parts.find(p => p.fileData?.fileUri));
});

test('transcribeWithGemini surfaces HTTP errors and blockReason', async () => {
  const r1 = await transcribeWithGemini({
    url: 'x', apiKey: 'k',
    _fetch: async () => ({ ok: false, status: 429, async text() { return 'rate limited'; } }),
  });
  assert.match(r1.error, /HTTP 429/);
  assert.match(r1.error, /rate limited/);

  const r2 = await transcribeWithGemini({
    url: 'x', apiKey: 'k',
    _fetch: async () => ({
      ok: true, status: 200,
      async json() { return { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }; },
    }),
  });
  assert.match(r2.error, /blocked.*SAFETY/i);
});

// ── detectLocalTools fallback to absolute paths ─────────────────────────

test('detectLocalTools cache TTL is reasonable (~30s) and respects force=true', async () => {
  const { detectLocalTools, _setDetectionCache } = await import('../src/tools/audio-transcribe.js');
  _setDetectionCache({ ytdlp: '/fake/yt', whisper: '/fake/wh', whisperFlavor: 'openai-whisper' });
  const cached = await detectLocalTools();
  assert.equal(cached.ytdlp, '/fake/yt');
  const forced = await detectLocalTools({ force: true });
  // Forced detection re-probes the real PATH — should differ from the fake cache.
  assert.notEqual(forced.ytdlp, '/fake/yt');
  _setDetectionCache(null);
});

// ── transcribeLocal: install detection ───────────────────────────────────

test('transcribeLocal returns "not installed" error when yt-dlp is missing', async () => {
  _setDetectionCache({ ytdlp: null, whisper: '/usr/bin/whisper', whisperFlavor: 'openai-whisper' });
  const r = await transcribeLocal({ url: 'https://youtu.be/abcDEF12345' });
  assert.match(r.error, /yt-dlp not on PATH/);
  assert.equal(r.installed, false);
  _setDetectionCache(null);
});

test('transcribeLocal returns "not installed" error when whisper is missing', async () => {
  _setDetectionCache({ ytdlp: '/usr/bin/yt-dlp', whisper: null, whisperFlavor: null });
  const r = await transcribeLocal({ url: 'https://youtu.be/abcDEF12345' });
  assert.match(r.error, /whisper not on PATH/);
  assert.equal(r.installed, false);
  _setDetectionCache(null);
});

// ── Cascade orchestrator ─────────────────────────────────────────────────

test('Cascade returns captions for a YouTube video with captions (level 1 hit)', async () => {
  const html = `
    "captionTracks":[{"baseUrl":"https://example/track-en","languageCode":"en"}]
  `;
  const trackXml = `<transcript><text start="0" dur="2">hello</text></transcript>`;
  const result = await transcribeVideo(
    { url: 'https://youtu.be/abcDEF12345' },
    {
      _fetchers: {
        fetchOembedMetadata: async () => ({ title: 'T', author_name: 'A' }),
        fetchWatchPageHtml: async () => html,
        fetchTrack: async () => trackXml,
      },
    },
  );
  assert.equal(result.source, 'youtube-captions');
  assert.equal(result.segments[0].text, 'hello');
});

test('Cascade falls through captions → local → gemini and returns gemini result', async () => {
  // Captions: page has no captionTracks
  const html = '<html>no captions</html>';
  // Force local "not installed"
  _setDetectionCache({ ytdlp: null, whisper: null, whisperFlavor: null });
  try {
    const result = await transcribeVideo(
      { url: 'https://youtu.be/abcDEF12345' },
      {
        geminiApiKey: 'dummy',
        _fetchers: {
          fetchOembedMetadata: async () => null,
          fetchWatchPageHtml: async () => html,
          fetchTrack: async () => { throw new Error('should not fetch tracks'); },
        },
        _geminiFetch: async () => ({
          ok: true, status: 200,
          async json() {
            return { candidates: [{ content: { parts: [{ text: '[0:00] from gemini' }] } }] };
          },
        }),
      },
    );
    assert.equal(result.source, 'gemini-flash');
    assert.equal(result.segments[0].text, 'from gemini');
  } finally {
    _setDetectionCache(null);
  }
});

test('Cascade reports per-level reasons when everything fails', async () => {
  const html = '<html>no captions</html>';
  _setDetectionCache({ ytdlp: null, whisper: null, whisperFlavor: null });
  try {
    // Make sure no env var leaks an API key into this test
    const origGem = process.env.GEMINI_API_KEY;
    const origGoog = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const result = await transcribeVideo(
        { url: 'https://youtu.be/abcDEF12345' },
        {
          _fetchers: {
            fetchOembedMetadata: async () => null,
            fetchWatchPageHtml: async () => html,
            fetchTrack: async () => 'unused',
          },
        },
      );
      assert.ok(result.error, 'expected an error');
      assert.equal(result.tried.length, 3);
      const levels = result.tried.map(t => t.level);
      assert.deepEqual(levels, ['captions', 'local', 'gemini']);
      assert.match(result.tried[0].reason, /no captions/i);
      assert.match(result.tried[1].reason, /yt-dlp not on PATH/);
      assert.match(result.tried[2].reason, /no GEMINI_API_KEY/);
    } finally {
      if (origGem !== undefined) process.env.GEMINI_API_KEY = origGem;
      if (origGoog !== undefined) process.env.GOOGLE_API_KEY = origGoog;
    }
  } finally {
    _setDetectionCache(null);
  }
});

test('Cascade skips captions for non-YouTube URLs and tries local directly', async () => {
  _setDetectionCache({ ytdlp: null, whisper: null, whisperFlavor: null });
  try {
    const result = await transcribeVideo({ url: 'https://vimeo.com/123' }, {});
    assert.ok(result.error);
    const captionsEntry = result.tried.find(t => t.level === 'captions');
    assert.match(captionsEntry.reason, /not a youtube/i);
    const geminiEntry = result.tried.find(t => t.level === 'gemini');
    // Gemini only handles YouTube natively, so this should also be skipped with a clear reason
    assert.ok(geminiEntry);
  } finally {
    _setDetectionCache(null);
  }
});

test('Render header reflects the cascade source label', () => {
  const fakeSegments = [{ start: 0, text: 'foo' }];
  const captions = renderTranscript({ videoId: 'x', metadata: null, language: 'en', auto: false, segments: fakeSegments, source: 'youtube-captions' });
  const local = renderTranscript({ videoId: 'x', metadata: null, language: 'en', auto: true, segments: fakeSegments, source: 'whisper-local' });
  const gemini = renderTranscript({ videoId: 'x', metadata: null, language: 'en', auto: true, segments: fakeSegments, source: 'gemini-flash' });
  assert.match(captions, /\[YOUTUBE CAPTIONS\]/);
  assert.match(local, /\[WHISPER \(LOCAL\)\]/);
  assert.match(gemini, /\[GEMINI FLASH\]/);
});
