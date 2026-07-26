import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSceneClip,
  resolveImageInput,
  lyricsToSrt,
  getMinimaxApiKey,
} from '../src/tools/music-video.js';
import { toolDefinitions, toolHandlers } from '../src/tools/index.js';
import { estimateVideoCost } from '../src/utils/pricing.js';

const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test('generateSceneClip runs submit -> poll -> retrieve and writes the clip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mv-test-'));
  const out = join(dir, 'clip.mp4');
  const calls = [];
  let polls = 0;

  const _fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    if (url.endsWith('/video_generation') && opts.method === 'POST') {
      const payload = JSON.parse(opts.body);
      // subject reference should select S2V-01 and carry the character image
      assert.equal(payload.model, 'S2V-01');
      assert.equal(payload.subject_reference[0].type, 'character');
      assert.ok(payload.subject_reference[0].image[0].startsWith('data:image/png;base64,'));
      return jsonResponse({ task_id: 'task_123', base_resp: { status_code: 0 } });
    }
    if (url.includes('/query/video_generation')) {
      polls++;
      if (polls < 2) return jsonResponse({ status: 'Processing', base_resp: { status_code: 0 } });
      return jsonResponse({ status: 'Success', file_id: 'file_9', base_resp: { status_code: 0 } });
    }
    if (url.includes('/files/retrieve')) {
      return jsonResponse({ file: { download_url: 'https://cdn.example/clip.mp4' }, base_resp: { status_code: 0 } });
    }
    if (url === 'https://cdn.example/clip.mp4') {
      return { ok: true, status: 200, arrayBuffer: async () => MP4 };
    }
    throw new Error(`unexpected url ${url}`);
  };

  const refImage = join(dir, 'face.png');
  await writeFile(refImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const r = await generateSceneClip(
    { prompt: 'character dances on a neon stage', outputPath: out, subjectReferenceImage: refImage },
    { apiKey: 'k', _fetch, pollIntervalMs: 1, maxWaitMs: 5000 },
  );

  assert.equal(r.path, out);
  assert.equal(r.model, 'S2V-01');
  assert.equal(r.taskId, 'task_123');
  assert.deepEqual(await readFile(out), MP4);
  assert.ok(polls >= 2);
});

test('generateSceneClip surfaces a Fail status as an error', async () => {
  const _fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') return jsonResponse({ task_id: 't', base_resp: { status_code: 0 } });
    if (url.includes('/query/')) return jsonResponse({ status: 'Fail', base_resp: { status_code: 1008, status_msg: 'insufficient balance' } });
    throw new Error('unexpected');
  };
  await assert.rejects(
    generateSceneClip({ prompt: 'x', outputPath: '/tmp/none.mp4' }, { apiKey: 'k', _fetch, pollIntervalMs: 1 }),
    /insufficient balance/,
  );
});

test('generateSceneClip explains MiniMax 2056 (Credits vs Token Plan)', async () => {
  const _fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      return jsonResponse({ base_resp: { status_code: 2056, status_msg: 'Token Plan usage limit reached' } });
    }
    throw new Error('unexpected');
  };
  await assert.rejects(
    generateSceneClip({ prompt: 'x', outputPath: '/tmp/none.mp4' }, { apiKey: 'k', _fetch }),
    /Credits/,
  );
});

test('billing-error helpers classify MiniMax codes', async () => {
  const mv = await import('../src/tools/music-video.js');
  assert.equal(mv.minimaxErrorCode('MiniMax error 2056: nope'), 2056);
  assert.equal(mv.minimaxErrorCode('some other error'), null);
  assert.equal(mv.isMinimaxBillingError('MiniMax error 2056: x'), true);
  assert.equal(mv.isMinimaxBillingError('MiniMax error 1008: x'), true);
  assert.equal(mv.isMinimaxBillingError('MiniMax error 1004: x'), false);
});

test('getMinimaxBalance is best-effort and null-safe', async () => {
  const mv = await import('../src/tools/music-video.js');
  assert.equal(await mv.getMinimaxBalance({ env: {} }), null);
  const ok = await mv.getMinimaxBalance({
    apiKey: 'k',
    _fetch: async () => jsonResponse({ base_resp: { status_code: 0 }, remains: 42 }),
  });
  assert.equal(ok.remains, 42);
  const failed = await mv.getMinimaxBalance({
    apiKey: 'k',
    _fetch: async () => jsonResponse({ base_resp: { status_code: 1004 } }),
  });
  assert.equal(failed, null);
});

test('generateSceneClip requires an API key', async () => {
  await assert.rejects(
    generateSceneClip({ prompt: 'x', outputPath: '/tmp/x.mp4' }, { env: {} }),
    /MINIMAX_API_KEY/,
  );
});

test('resolveImageInput passes URLs through and encodes local files', async () => {
  assert.equal(await resolveImageInput('https://x/y.png'), 'https://x/y.png');
  const dir = await mkdtemp(join(tmpdir(), 'mv-img-'));
  const p = join(dir, 'a.jpg');
  await writeFile(p, Buffer.from([1, 2, 3]));
  const uri = await resolveImageInput(p);
  assert.ok(uri.startsWith('data:image/jpeg;base64,'));
});

test('getMinimaxApiKey reads MINIMAX_API_KEY from env', () => {
  assert.equal(getMinimaxApiKey({ env: { MINIMAX_API_KEY: 'abc' } }), 'abc');
  assert.equal(getMinimaxApiKey({ env: {} }), null);
});

test('lyricsToSrt converts timestamped lyrics to SRT cues', () => {
  const srt = lyricsToSrt('[00:00] first line\n[00:05] second line\n[01:10] third');
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:05,000\nfirst line/);
  assert.match(srt, /2\n00:00:05,000 --> 00:01:10,000\nsecond line/);
  assert.match(srt, /3\n00:01:10,000 --> 00:01:13,000\nthird/);
});

test('lyricsToSrt returns empty string when no timestamps present', () => {
  assert.equal(lyricsToSrt('just some prose without timestamps'), '');
});

test('estimateVideoCost scales with clip count', () => {
  assert.equal(estimateVideoCost({ model: 'S2V-01', count: 10 }), 6.5);
  assert.ok(estimateVideoCost({ model: 'MiniMax-Hailuo-2.3', resolution: '1080P', count: 1 }) > 0);
});

test('estimateVideoPoints uses the official per-clip point table', async () => {
  const { estimateVideoPoints } = await import('../src/utils/pricing.js');
  assert.deepEqual(estimateVideoPoints({ model: 'MiniMax-Hailuo-2.3', resolution: '768P', duration: 6, count: 10 }), { perClip: 1, total: 10 });
  assert.deepEqual(estimateVideoPoints({ model: 'MiniMax-Hailuo-02', resolution: '512P', duration: 6, count: 10 }), { perClip: 0.3, total: 3 });
  assert.equal(estimateVideoPoints({ model: 'S2V-01', resolution: '768P', duration: 6, count: 10 }), null);
});

test('music-video tools are registered with matching handlers', () => {
  for (const name of ['generate_scene_image', 'generate_scene_clip', 'assemble_music_video', 'lyrics_to_srt']) {
    assert.ok(toolDefinitions.find(t => t.function?.name === name), `definition missing: ${name}`);
    assert.equal(typeof toolHandlers[name], 'function', `handler missing: ${name}`);
  }
});
