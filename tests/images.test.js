import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildVisionContent,
  extractImageReferences,
  loadImageAttachments,
} from '../src/utils/images.js';
import {
  normalizeMessagesForAnthropic,
  normalizeMessagesForOpenAICompat,
} from '../src/llm/client.js';
import { estimateTokens } from '../src/agents/compressor.js';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('extractImageReferences supports plain and quoted image paths', () => {
  assert.deepEqual(
    extractImageReferences('compare @one.png with @"screens/two image.webp" and keep @notes.txt'),
    {
      text: 'compare with and keep @notes.txt',
      paths: ['one.png', 'screens/two image.webp'],
    },
  );
});

test('loadImageAttachments validates and encodes local images', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-images-'));
  try {
    await writeFile(join(dir, 'shot.png'), PNG_HEADER);
    const [image] = await loadImageAttachments(['shot.png'], { cwd: dir });
    assert.equal(image.name, 'shot.png');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.data, PNG_HEADER.toString('base64'));

    await assert.rejects(
      loadImageAttachments(['shot.png'], { cwd: dir, maxBytes: 4 }),
      /Image too large/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('vision messages convert between OpenAI and Anthropic formats', () => {
  const content = buildVisionContent('What is wrong?', [{
    name: 'shot.png',
    mimeType: 'image/png',
    data: PNG_HEADER.toString('base64'),
  }]);

  const anthropic = normalizeMessagesForAnthropic([{ role: 'user', content }]);
  assert.equal(anthropic[0].content[0].type, 'text');
  assert.deepEqual(anthropic[0].content[1], {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: PNG_HEADER.toString('base64'),
    },
  });

  const openai = normalizeMessagesForOpenAICompat(anthropic);
  assert.equal(openai[0].content[1].type, 'image_url');
  assert.match(openai[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('image base64 does not inflate text token estimates', () => {
  const hugeData = 'A'.repeat(1_000_000);
  const content = buildVisionContent('inspect', [{ name: 'x.png', mimeType: 'image/png', data: hugeData }]);
  const tokens = estimateTokens([{ role: 'user', content }]);
  assert.ok(tokens >= 1200);
  assert.ok(tokens < 2000);
});
