import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractYouTubeVideoId,
  parseTranscriptXml,
  pickBestTrack,
  fetchYouTubeTranscript,
  renderTranscript,
  formatTimestamp,
} from '../src/tools/video-transcript.js';

test('extractYouTubeVideoId accepts standard youtube.com/watch URL', () => {
  assert.equal(
    extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'dQw4w9WgXcQ',
  );
});

test('extractYouTubeVideoId accepts youtu.be short URL', () => {
  assert.equal(
    extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ'),
    'dQw4w9WgXcQ',
  );
});

test('extractYouTubeVideoId accepts youtube.com/shorts URL', () => {
  assert.equal(
    extractYouTubeVideoId('https://www.youtube.com/shorts/abcDEF12345'),
    'abcDEF12345',
  );
});

test('extractYouTubeVideoId accepts embed and v paths', () => {
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/embed/abcDEF12345'), 'abcDEF12345');
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/v/abcDEF12345'), 'abcDEF12345');
});

test('extractYouTubeVideoId accepts a bare 11-char video ID', () => {
  assert.equal(extractYouTubeVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('extractYouTubeVideoId tolerates extra query params and music subdomain', () => {
  assert.equal(
    extractYouTubeVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD&t=42'),
    'dQw4w9WgXcQ',
  );
});

test('extractYouTubeVideoId rejects non-YouTube hosts and malformed IDs', () => {
  assert.equal(extractYouTubeVideoId('https://vimeo.com/12345'), null);
  assert.equal(extractYouTubeVideoId('https://youtube.com/watch?v=short'), null);
  assert.equal(extractYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(extractYouTubeVideoId(''), null);
  assert.equal(extractYouTubeVideoId(null), null);
});

test('parseTranscriptXml extracts text + start, decoding entities and stripping inline tags', () => {
  const xml = `<?xml version="1.0"?><transcript>
    <text start="0" dur="2.5">Hello &amp; welcome</text>
    <text start="3.0" dur="2">It&#39;s a test</text>
    <text start="5.5" dur="1.2">Bold <b>here</b></text>
    <text start="7" dur="0.5"></text>
  </transcript>`;
  const segments = parseTranscriptXml(xml);
  assert.deepEqual(segments, [
    { start: 0,   text: 'Hello & welcome' },
    { start: 3.0, text: "It's a test" },
    { start: 5.5, text: 'Bold here' },
  ]);
});

test('pickBestTrack prefers human-made in target language, then any human, then auto', () => {
  const tracks = [
    { languageCode: 'en', kind: 'asr', baseUrl: 'A' },
    { languageCode: 'it', kind: 'asr', baseUrl: 'B' },
    { languageCode: 'fr',              baseUrl: 'C' }, // human-made french
    { languageCode: 'it',              baseUrl: 'D' }, // human-made italian
  ];
  assert.equal(pickBestTrack(tracks, 'it').baseUrl, 'D');
  assert.equal(pickBestTrack(tracks, 'en').baseUrl, 'C'); // no human EN → fall through to first human (fr)
  // Only auto tracks → pick by language match
  const onlyAuto = [
    { languageCode: 'en', kind: 'asr', baseUrl: 'A' },
    { languageCode: 'it', kind: 'asr', baseUrl: 'B' },
  ];
  assert.equal(pickBestTrack(onlyAuto, 'it').baseUrl, 'B');
});

test('pickBestTrack returns null on empty input', () => {
  assert.equal(pickBestTrack([], 'en'), null);
  assert.equal(pickBestTrack(null, 'en'), null);
});

test('formatTimestamp formats m:ss and h:mm:ss', () => {
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(42), '0:42');
  assert.equal(formatTimestamp(125), '2:05');
  assert.equal(formatTimestamp(3725), '1:02:05');
});

test('fetchYouTubeTranscript returns error for non-YouTube URL', async () => {
  const result = await fetchYouTubeTranscript({ url: 'https://example.com/foo' });
  assert.match(result.error, /not a recognizable youtube/i);
});

test('fetchYouTubeTranscript returns error when video has no captions', async () => {
  const html = `<html>... no captionTracks key here ...</html>`;
  const result = await fetchYouTubeTranscript(
    { url: 'https://youtu.be/abcDEF12345' },
    {
      _fetchers: {
        fetchOembedMetadata: async () => ({ title: 'Foo', author_name: 'Bar' }),
        fetchWatchPageHtml: async () => html,
        fetchTrack: async () => { throw new Error('should not fetch'); },
      },
    },
  );
  assert.match(result.error, /no captions available/i);
  assert.equal(result.metadata.title, 'Foo');
  assert.equal(result.videoId, 'abcDEF12345');
});

test('fetchYouTubeTranscript returns parsed segments on a successful flow', async () => {
  const html = `
    <html>...
    "captionTracks":[
      {"baseUrl":"https://example/track1","languageCode":"en","kind":"asr"},
      {"baseUrl":"https://example/track-it","languageCode":"it"}
    ]
    ...</html>
  `;
  const trackXml = `<transcript>
    <text start="0" dur="2">Ciao mondo</text>
    <text start="2" dur="2">Come stai</text>
  </transcript>`;

  let fetchedUrl = null;
  const result = await fetchYouTubeTranscript(
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', preferLang: 'it' },
    {
      _fetchers: {
        fetchOembedMetadata: async () => ({ title: 'Saluti', author_name: 'Canale' }),
        fetchWatchPageHtml: async () => html,
        fetchTrack: async (u) => { fetchedUrl = u; return trackXml; },
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(fetchedUrl, 'https://example/track-it');
  assert.equal(result.language, 'it');
  assert.equal(result.auto, false);
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.segments[0], { start: 0, text: 'Ciao mondo' });
  assert.equal(result.metadata.title, 'Saluti');
});

test('fetchYouTubeTranscript surfaces unavailable video', async () => {
  const html = `... "status":"ERROR" ... "reason":"Video unavailable" ...`;
  const result = await fetchYouTubeTranscript(
    { url: 'https://youtu.be/abcDEF12345' },
    {
      _fetchers: {
        fetchOembedMetadata: async () => null,
        fetchWatchPageHtml: async () => html,
        fetchTrack: async () => { throw new Error('nope'); },
      },
    },
  );
  assert.match(result.error, /video unavailable/i);
});

test('renderTranscript produces a header + body and truncates long bodies', () => {
  const segments = Array.from({ length: 5 }, (_, i) => ({ start: i * 10, text: `Riga ${i + 1}` }));
  const rendered = renderTranscript({
    videoId: 'abcDEF12345',
    metadata: { title: 'T', author: 'A' },
    language: 'it',
    auto: false,
    segments,
    source: 'youtube-captions',
  });
  assert.match(rendered, /\[YOUTUBE CAPTIONS\]/);
  assert.match(rendered, /title: T/);
  assert.match(rendered, /channel: A/);
  assert.match(rendered, /video_id: abcDEF12345/);
  assert.match(rendered, /\[0:00\] Riga 1/);
  assert.match(rendered, /\[0:40\] Riga 5/);

  // Truncation
  const longSegments = Array.from({ length: 2000 }, (_, i) => ({ start: i, text: 'lorem ipsum dolor sit amet'.repeat(2) }));
  const truncated = renderTranscript(
    { videoId: 'x', metadata: null, language: 'en', auto: false, segments: longSegments },
    { maxChars: 500 },
  );
  assert.match(truncated, /truncated at 500 chars/);
});

test('renderTranscript shows error path cleanly', () => {
  const out = renderTranscript({ error: 'No captions', videoId: 'abc', metadata: { title: 'Foo' } });
  assert.match(out, /^Error: No captions/);
  assert.match(out, /video_id: abc/);
  assert.match(out, /title: Foo/);
});
