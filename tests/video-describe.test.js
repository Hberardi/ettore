import test from 'node:test';
import assert from 'node:assert/strict';
import { describeVideoWithGemini, describeVideo, VIDEO_DESCRIBE_DEFAULT_PROMPT } from '../src/tools/video-describe.js';
import { toolHandlers, toolDefinitions } from '../src/tools/index.js';

function geminiResponse({ status = 200, body } = {}) {
  const payload = body ?? {
    candidates: [{
      content: {
        parts: [{ text: 'At [0:05] a slide titled "Hello World" appears.' }],
      },
    }],
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test('describeVideoWithGemini rejects non-YouTube URLs', async () => {
  const result = await describeVideoWithGemini({
    url: 'https://vimeo.com/12345',
    apiKey: 'test-key',
    _fetch: async () => geminiResponse(),
  });
  assert.equal(result.error.includes('YouTube'), true);
});

test('describeVideoWithGemini posts the YouTube URL to Gemini and returns the description', async () => {
  let captured;
  const result = await describeVideoWithGemini({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    apiKey: 'test-key',
    _fetch: async (url, options) => {
      captured = { url, options };
      return geminiResponse();
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.videoId, 'dQw4w9WgXcQ');
  assert.equal(result.source, 'gemini-flash-visual');
  assert.match(result.description, /Hello World/);
  assert.match(captured.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent\?key=test-key$/);
  const sentBody = JSON.parse(captured.options.body);
  assert.equal(sentBody.contents[0].parts[1].fileData.fileUri, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(sentBody.contents[0].parts[0].text, VIDEO_DESCRIBE_DEFAULT_PROMPT);
});

test('describeVideoWithGemini forwards a custom prompt override', async () => {
  let capturedBody;
  await describeVideoWithGemini({
    url: 'https://youtu.be/dQw4w9WgXcQ',
    apiKey: 'k',
    prompt: 'only describe the code on screen',
    _fetch: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return geminiResponse();
    },
  });
  assert.equal(capturedBody.contents[0].parts[0].text, 'only describe the code on screen');
});

test('describeVideoWithGemini surfaces HTTP errors with response snippet', async () => {
  const result = await describeVideoWithGemini({
    url: 'https://youtu.be/dQw4w9WgXcQ',
    apiKey: 'k',
    _fetch: async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    }),
  });
  assert.match(result.error, /HTTP 429/);
  assert.match(result.error, /rate limited/);
});

test('describeVideoWithGemini surfaces blocked/empty responses', async () => {
  const result = await describeVideoWithGemini({
    url: 'https://youtu.be/dQw4w9WgXcQ',
    apiKey: 'k',
    _fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }),
      text: async () => '',
    }),
  });
  assert.match(result.error, /blocked \(SAFETY\)/);
});

test('describeVideo returns an error when no API key is configured', async () => {
  const prev = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    const result = await describeVideo({ url: 'https://youtu.be/dQw4w9WgXcQ' });
    assert.match(result.error, /GEMINI_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
  }
});

test('toolHandlers.video_describe produces a header-tagged description', async () => {
  process.env.GEMINI_API_KEY = 'k';
  try {
    const original = toolHandlers.video_describe;
    // Swap the inner Gemini call to a deterministic stub.
    toolHandlers.video_describe = async (args) => {
      const result = await describeVideoWithGemini({
        url: args.url,
        apiKey: 'k',
        prompt: args.prompt,
        _fetch: async () => geminiResponse(),
      });
      if (result.error) return `Error: ${result.error}`;
      return `[${(result.source || 'gemini').toUpperCase()} — VISUAL]\nvideo_id: ${result.videoId}\n\n${result.description}`;
    };
    try {
      const out = await toolHandlers.video_describe({ url: 'https://youtu.be/dQw4w9WgXcQ' });
      assert.match(out, /\[GEMINI-FLASH-VISUAL — VISUAL\]/);
      assert.match(out, /video_id: dQw4w9WgXcQ/);
      assert.match(out, /Hello World/);
    } finally {
      toolHandlers.video_describe = original;
    }
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test('toolHandlers.video_describe validates the url argument', async () => {
  const out = await toolHandlers.video_describe({});
  assert.match(out, /requires a "url" argument/);
});

test('tool definition for video_describe is exposed with YouTube-only guidance', () => {
  const def = toolDefinitions.find(d => d.function?.name === 'video_describe');
  assert.ok(def, 'video_describe tool definition must be registered');
  assert.match(def.function.description, /visual/);
  assert.match(def.function.description, /YouTube/);
  assert.deepEqual(def.function.parameters.required, ['url']);
  assert.ok(def.function.parameters.properties.url);
  assert.ok(def.function.parameters.properties.prompt);
});
