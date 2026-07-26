import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRunwayClip, generateReplicateClip, generateLumaClip, generateVeoClip, generateKlingClip, generateFalClip, klingJwt, generateClipWith, VIDEO_PROVIDERS } from '../src/tools/video-providers.js';
import { createHmac } from 'node:crypto';

const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]);
function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test('generateRunwayClip submits image_to_video, polls, downloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runway-'));
  const frame = join(dir, 'frame.png');
  await writeFile(frame, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const out = join(dir, 'clip.mp4');
  let polls = 0;
  const _fetch = async (url, opts = {}) => {
    if (url.endsWith('/v1/image_to_video')) {
      const b = JSON.parse(opts.body);
      assert.equal(opts.headers['X-Runway-Version'], '2024-11-06');
      assert.ok(b.promptImage.startsWith('data:image/png;base64,'));
      return json({ id: 'task_r' });
    }
    if (url.includes('/v1/tasks/task_r')) {
      polls++;
      return polls < 2 ? json({ status: 'RUNNING' }) : json({ status: 'SUCCEEDED', output: ['https://cdn/clip.mp4'] });
    }
    if (url === 'https://cdn/clip.mp4') return { ok: true, status: 200, arrayBuffer: async () => MP4 };
    throw new Error('unexpected ' + url);
  };
  const r = await generateRunwayClip(
    { prompt: 'dance', firstFrameImage: frame, outputPath: out },
    { apiKey: 'k', _fetch, pollIntervalMs: 1 },
  );
  assert.equal(r.provider, 'runway');
  assert.deepEqual(await readFile(out), MP4);
});

test('generateReplicateClip submits prediction, polls urls.get, downloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replicate-'));
  const out = join(dir, 'clip.mp4');
  let polls = 0;
  const _fetch = async (url, opts = {}) => {
    if (url.endsWith('/predictions') && opts.method === 'POST') {
      assert.match(url, /\/v1\/models\/minimax\/video-01\/predictions$/);
      return json({ id: 'p1', urls: { get: 'https://api.replicate.com/v1/predictions/p1' } });
    }
    if (url.endsWith('/predictions/p1')) {
      polls++;
      return polls < 2 ? json({ status: 'processing' }) : json({ status: 'succeeded', id: 'p1', output: 'https://cdn/out.mp4' });
    }
    if (url === 'https://cdn/out.mp4') return { ok: true, status: 200, arrayBuffer: async () => MP4 };
    throw new Error('unexpected ' + url);
  };
  const r = await generateReplicateClip(
    { prompt: 'city', outputPath: out },
    { apiKey: 'tok', _fetch, pollIntervalMs: 1 },
  );
  assert.equal(r.provider, 'replicate');
  assert.deepEqual(await readFile(out), MP4);
});

test('generateReplicateClip surfaces failed predictions', async () => {
  const _fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') return json({ id: 'p', urls: { get: 'https://x/p' } });
    return json({ status: 'failed', error: 'nsfw' });
  };
  await assert.rejects(
    generateReplicateClip({ prompt: 'x', outputPath: '/tmp/none.mp4' }, { apiKey: 't', _fetch, pollIntervalMs: 1 }),
    /failed: nsfw/,
  );
});

test('generateLumaClip submits, polls state, downloads assets.video', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'luma-'));
  const out = join(dir, 'clip.mp4');
  let polls = 0;
  const _fetch = async (url, opts = {}) => {
    if (url.endsWith('/dream-machine/v1/generations') && opts.method === 'POST') {
      const b = JSON.parse(opts.body);
      // a public URL frame drives image-to-video via keyframes
      assert.equal(b.keyframes.frame0.url, 'https://img/host.png');
      return json({ id: 'g1' });
    }
    if (url.endsWith('/generations/g1')) {
      polls++;
      return polls < 2 ? json({ state: 'dreaming' }) : json({ state: 'completed', assets: { video: 'https://cdn/luma.mp4' } });
    }
    if (url === 'https://cdn/luma.mp4') return { ok: true, status: 200, arrayBuffer: async () => MP4 };
    throw new Error('unexpected ' + url);
  };
  const r = await generateLumaClip(
    { prompt: 'sunset', firstFrameImage: 'https://img/host.png', outputPath: out },
    { apiKey: 'luma-k', _fetch, pollIntervalMs: 1 },
  );
  assert.equal(r.provider, 'luma');
  assert.deepEqual(await readFile(out), MP4);
});

test('generateLumaClip falls back to text-to-video for a local frame (no public URL)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'luma2-'));
  const out = join(dir, 'clip.mp4');
  const _fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      assert.equal(JSON.parse(opts.body).keyframes, undefined); // no local image sent
      return json({ id: 'g2' });
    }
    if (url.endsWith('/generations/g2')) return json({ state: 'completed', assets: { video: 'https://cdn/x.mp4' } });
    return { ok: true, status: 200, arrayBuffer: async () => MP4 };
  };
  const r = await generateLumaClip({ prompt: 'x', firstFrameImage: '/local/photo.png', outputPath: out }, { apiKey: 'k', _fetch, pollIntervalMs: 1 });
  assert.equal(r.provider, 'luma');
});

test('generateVeoClip submits predictLongRunning, polls operation, downloads uri', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'veo-'));
  const out = join(dir, 'clip.mp4');
  let polls = 0;
  const _fetch = async (url, opts = {}) => {
    if (url.includes(':predictLongRunning')) {
      assert.equal(opts.headers['x-goog-api-key'], 'gk');
      return json({ name: 'models/veo/operations/op1' });
    }
    if (url.includes('/v1beta/models/veo/operations/op1')) {
      polls++;
      return polls < 2
        ? json({ done: false })
        : json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://gen/vid' } }] } } });
    }
    if (url.startsWith('https://gen/vid')) { assert.match(url, /key=gk/); return { ok: true, status: 200, arrayBuffer: async () => MP4 }; }
    throw new Error('unexpected ' + url);
  };
  const r = await generateVeoClip({ prompt: 'a', outputPath: out, model: 'veo' }, { apiKey: 'gk', _fetch, pollIntervalMs: 1 });
  assert.equal(r.provider, 'veo');
  assert.deepEqual(await readFile(out), MP4);
});

test('klingJwt builds a verifiable HS256 token from ak/sk', () => {
  const now = 1_000_000;
  const tok = klingJwt('ak123', 'sk456', now);
  const [h, p, sig] = tok.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64').toString());
  assert.equal(payload.iss, 'ak123');
  assert.equal(payload.exp, now + 1800);
  const expected = createHmac('sha256', 'sk456').update(`${h}.${p}`).digest('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(sig, expected);
});

test('generateKlingClip signs, submits image2video, polls, downloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kling-'));
  const frame = join(dir, 'f.png'); await writeFile(frame, Buffer.from([0x89, 0x50]));
  const out = join(dir, 'clip.mp4');
  let polls = 0;
  const _fetch = async (url, opts = {}) => {
    if (url.endsWith('/v1/videos/image2video') && opts.method === 'POST') {
      assert.match(opts.headers.Authorization, /^Bearer .+\..+\..+$/);
      assert.ok(!JSON.parse(opts.body).image.startsWith('data:')); // bare base64
      return json({ code: 0, data: { task_id: 'kt1' } });
    }
    if (url.endsWith('/v1/videos/image2video/kt1')) {
      polls++;
      return polls < 2 ? json({ data: { task_status: 'processing' } }) : json({ data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://cdn/k.mp4' }] } } });
    }
    if (url === 'https://cdn/k.mp4') return { ok: true, status: 200, arrayBuffer: async () => MP4 };
    throw new Error('unexpected ' + url);
  };
  const r = await generateKlingClip({ prompt: 'x', firstFrameImage: frame, outputPath: out }, { apiKey: 'ak123:sk456', _fetch, pollIntervalMs: 1 });
  assert.equal(r.provider, 'kling');
  assert.deepEqual(await readFile(out), MP4);
});

test('generateKlingClip rejects credentials without a colon', async () => {
  await assert.rejects(generateKlingClip({ prompt: 'x', outputPath: '/o.mp4' }, { apiKey: 'justonekey' }), /AccessKey:SecretKey/);
});

test('generateFalClip submits to queue, polls status, fetches response video', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fal-'));
  const out = join(dir, 'clip.mp4');
  let polls = 0;
  const _fetch = async (url, opts = {}) => {
    if (url.endsWith('/fal-ai/pika/v2.2/image-to-video') && opts.method === 'POST') {
      assert.equal(opts.headers.Authorization, 'Key fk');
      return json({ request_id: 'req1', status_url: 'https://q/status', response_url: 'https://q/resp' });
    }
    if (url === 'https://q/status') { polls++; return polls < 2 ? json({ status: 'IN_PROGRESS' }) : json({ status: 'COMPLETED' }); }
    if (url === 'https://q/resp') return json({ video: { url: 'https://cdn/fal.mp4' } });
    if (url === 'https://cdn/fal.mp4') return { ok: true, status: 200, arrayBuffer: async () => MP4 };
    throw new Error('unexpected ' + url);
  };
  const r = await generateFalClip({ prompt: 'x', outputPath: out }, { apiKey: 'fk', _fetch, pollIntervalMs: 1 });
  assert.equal(r.provider, 'fal');
  assert.deepEqual(await readFile(out), MP4);
});

test('providers require an API key', async () => {
  await assert.rejects(generateRunwayClip({ prompt: 'x', firstFrameImage: '/x.png', outputPath: '/o.mp4' }, {}), /API key/);
  await assert.rejects(generateReplicateClip({ prompt: 'x', outputPath: '/o.mp4' }, {}), /token/);
  await assert.rejects(generateLumaClip({ prompt: 'x', outputPath: '/o.mp4' }, {}), /API key/);
  await assert.rejects(generateVeoClip({ prompt: 'x', outputPath: '/o.mp4' }, {}), /Gemini/);
  await assert.rejects(generateFalClip({ prompt: 'x', outputPath: '/o.mp4' }, {}), /FAL_KEY/);
});

test('generateClipWith rejects unknown providers and lists known ones', () => {
  for (const id of ['minimax', 'runway', 'replicate', 'luma', 'veo', 'kling', 'fal']) {
    assert.ok(VIDEO_PROVIDERS[id], `missing ${id}`);
  }
  assert.throws(() => generateClipWith('nope', {}, {}), /sconosciuto/);
});
