// Multi-provider video clip generation for the Music Video Studio.
//
// A thin registry so the studio can generate a clip through MiniMax, Runway, or
// Replicate behind one interface: generateClipWith(provider, params, opts).
// Each provider follows its own async submit→poll→download flow. MiniMax reuses
// the existing tool; Runway and Replicate are implemented per their documented
// REST APIs. Image inputs (character reference / first frame) are accepted as a
// local path or public URL — providers that need a data URI get one.

import { writeFile, mkdir, readFile } from 'fs/promises';
import { dirname, extname } from 'path';
import { createHmac } from 'crypto';
import { generateSceneClip } from './music-video.js';

const IMAGE_MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

async function toDataUri(pathOrUrl) {
  const v = String(pathOrUrl || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const bytes = await readFile(v);
  const mime = IMAGE_MIME_BY_EXT[extname(v).toLowerCase()] || 'image/png';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

async function download(url, outputPath, doFetch, signal) {
  const res = await doFetch(url, { signal });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
  return bytes.length;
}

// ── Runway (dev.runwayml.com) ────────────────────────────────────────────────
// image_to_video: POST /v1/image_to_video → { id } ; poll GET /v1/tasks/{id}
// until status SUCCEEDED/FAILED ; output is an array of asset URLs.
export async function generateRunwayClip(params, opts = {}) {
  const { prompt, firstFrameImage, outputPath, duration = 5, model = 'gen3a_turbo', ratio = '1280:768' } = params;
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('Runway richiede una API key (RUNWAY_API_KEY o salvata nello studio).');
  if (!firstFrameImage) throw new Error('Runway image_to_video richiede un fotogramma iniziale (foto).');
  const doFetch = opts._fetch || ((u, o) => fetch(u, o));
  const base = process.env.RUNWAY_BASE_URL || 'https://api.dev.runwayml.com';
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Runway-Version': '2024-11-06' };
  const onProgress = opts.onProgress || (() => {});

  onProgress('Runway: invio task…');
  const submit = await doFetch(`${base}/v1/image_to_video`, {
    method: 'POST', headers, signal: opts.signal,
    body: JSON.stringify({ model, promptImage: await toDataUri(firstFrameImage), promptText: String(prompt || ''), duration: Number(duration) || 5, ratio }),
  });
  if (!submit.ok) throw new Error(`Runway submit HTTP ${submit.status}: ${(await submit.text().catch(() => '')).slice(0, 200)}`);
  const { id } = await submit.json();
  if (!id) throw new Error('Runway: nessun task id nella risposta.');

  const started = Date.now();
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
  while (true) {
    if (Date.now() - started > maxWaitMs) throw new Error(`Runway timeout (task ${id}).`);
    await sleep(opts.pollIntervalMs ?? 5000, opts.signal);
    const q = await doFetch(`${base}/v1/tasks/${id}`, { headers, signal: opts.signal });
    if (!q.ok) continue;
    const data = await q.json();
    if (data.status === 'SUCCEEDED') {
      const url = Array.isArray(data.output) ? data.output[0] : data.output;
      if (!url) throw new Error('Runway: task riuscito ma senza output.');
      const bytes = await download(url, outputPath, doFetch, opts.signal);
      return { path: outputPath, bytes, provider: 'runway', model, taskId: id };
    }
    if (data.status === 'FAILED') throw new Error(`Runway task fallito: ${data.failure || data.failureCode || 'unknown'}`);
    onProgress(`Runway: ${data.status || 'processing'}… (${Math.round((Date.now() - started) / 1000)}s)`);
  }
}

// ── Replicate (api.replicate.com) ────────────────────────────────────────────
// model-based predictions: POST /v1/models/{owner}/{name}/predictions →
// { id, urls.get } ; poll until status succeeded/failed ; output is a URL or
// array of URLs.
export async function generateReplicateClip(params, opts = {}) {
  const { prompt, firstFrameImage, outputPath, model = 'minimax/video-01', input = {} } = params;
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('Replicate richiede un token (REPLICATE_API_TOKEN o salvato nello studio).');
  const doFetch = opts._fetch || ((u, o) => fetch(u, o));
  const base = process.env.REPLICATE_BASE_URL || 'https://api.replicate.com';
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const onProgress = opts.onProgress || (() => {});

  const body = { input: { prompt: String(prompt || ''), ...input } };
  if (firstFrameImage) body.input.first_frame_image = await toDataUri(firstFrameImage);

  onProgress('Replicate: invio prediction…');
  const submit = await doFetch(`${base}/v1/models/${model}/predictions`, {
    method: 'POST', headers, signal: opts.signal, body: JSON.stringify(body),
  });
  if (!submit.ok) throw new Error(`Replicate submit HTTP ${submit.status}: ${(await submit.text().catch(() => '')).slice(0, 200)}`);
  const created = await submit.json();
  const getUrl = created?.urls?.get;
  if (!getUrl) throw new Error('Replicate: nessun polling URL nella risposta.');

  const started = Date.now();
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
  while (true) {
    if (Date.now() - started > maxWaitMs) throw new Error('Replicate timeout.');
    await sleep(opts.pollIntervalMs ?? 4000, opts.signal);
    const q = await doFetch(getUrl, { headers, signal: opts.signal });
    if (!q.ok) continue;
    const data = await q.json();
    if (data.status === 'succeeded') {
      const url = Array.isArray(data.output) ? data.output[data.output.length - 1] : data.output;
      if (!url) throw new Error('Replicate: prediction riuscita ma senza output.');
      const bytes = await download(url, outputPath, doFetch, opts.signal);
      return { path: outputPath, bytes, provider: 'replicate', model, taskId: data.id };
    }
    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(`Replicate ${data.status}: ${data.error || 'unknown'}`);
    }
    onProgress(`Replicate: ${data.status || 'processing'}… (${Math.round((Date.now() - started) / 1000)}s)`);
  }
}

// ── Luma Dream Machine (api.lumalabs.ai) ─────────────────────────────────────
// POST /dream-machine/v1/generations → { id } ; poll GET .../generations/{id}
// until state completed/failed ; asset at assets.video. NOTE: Luma keyframes
// take a public image URL, not base64 — a local photo path can't be used as the
// first frame, so we fall back to text-to-video for local files (no character
// lock). Pass a public http(s) URL to drive image-to-video.
export async function generateLumaClip(params, opts = {}) {
  const { prompt, firstFrameImage, outputPath, model = 'ray-2', resolution = '720p', duration } = params;
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('Luma richiede una API key (LUMAAI_API_KEY o salvata nello studio).');
  const doFetch = opts._fetch || ((u, o) => fetch(u, o));
  const base = process.env.LUMA_BASE_URL || 'https://api.lumalabs.ai';
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', accept: 'application/json' };
  const onProgress = opts.onProgress || (() => {});

  const body = { model, prompt: String(prompt || ''), resolution };
  if (duration) body.duration = `${Number(duration)}s`;
  const frameUrl = /^https?:\/\//i.test(String(firstFrameImage || '')) ? firstFrameImage : null;
  if (frameUrl) body.keyframes = { frame0: { type: 'image', url: frameUrl } };

  onProgress('Luma: invio generazione…');
  const submit = await doFetch(`${base}/dream-machine/v1/generations`, {
    method: 'POST', headers, signal: opts.signal, body: JSON.stringify(body),
  });
  if (!submit.ok) throw new Error(`Luma submit HTTP ${submit.status}: ${(await submit.text().catch(() => '')).slice(0, 200)}`);
  const { id } = await submit.json();
  if (!id) throw new Error('Luma: nessun id nella risposta.');

  const started = Date.now();
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
  while (true) {
    if (Date.now() - started > maxWaitMs) throw new Error(`Luma timeout (gen ${id}).`);
    await sleep(opts.pollIntervalMs ?? 5000, opts.signal);
    const q = await doFetch(`${base}/dream-machine/v1/generations/${id}`, { headers, signal: opts.signal });
    if (!q.ok) continue;
    const data = await q.json();
    if (data.state === 'completed') {
      const url = data?.assets?.video;
      if (!url) throw new Error('Luma: completato ma senza video.');
      const bytes = await download(url, outputPath, doFetch, opts.signal);
      return { path: outputPath, bytes, provider: 'luma', model, taskId: id };
    }
    if (data.state === 'failed') throw new Error(`Luma fallito: ${data.failure_reason || 'unknown'}`);
    onProgress(`Luma: ${data.state || 'dreaming'}… (${Math.round((Date.now() - started) / 1000)}s)`);
  }
}

// ── Google Veo (Gemini API) ──────────────────────────────────────────────────
// POST /v1beta/models/{model}:predictLongRunning → { name: operation } ; poll
// GET /v1beta/{operation} until done ; video at
// response.generateVideoResponse.generatedSamples[0].video.uri (download needs
// the same API key). Uses the Gemini API key.
export async function generateVeoClip(params, opts = {}) {
  const { prompt, firstFrameImage, outputPath, model = 'veo-3.0-generate-preview', aspectRatio = '16:9' } = params;
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('Veo richiede la chiave Gemini (GEMINI_API_KEY o salvata nello studio).');
  const doFetch = opts._fetch || ((u, o) => fetch(u, o));
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const headers = { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };
  const onProgress = opts.onProgress || (() => {});

  const instance = { prompt: String(prompt || '') };
  // Local photo → inline bytes for image-to-video; public URL isn't accepted here.
  if (firstFrameImage && !/^https?:\/\//i.test(String(firstFrameImage))) {
    const uri = await toDataUri(firstFrameImage);
    const m = /^data:([^;]+);base64,(.*)$/s.exec(uri || '');
    if (m) instance.image = { imageBytes: m[2], mimeType: m[1] };
  }

  onProgress('Veo: invio richiesta…');
  const submit = await doFetch(`${base}/v1beta/models/${model}:predictLongRunning`, {
    method: 'POST', headers, signal: opts.signal,
    body: JSON.stringify({ instances: [instance], parameters: { aspectRatio, sampleCount: 1 } }),
  });
  if (!submit.ok) throw new Error(`Veo submit HTTP ${submit.status}: ${(await submit.text().catch(() => '')).slice(0, 200)}`);
  const op = await submit.json();
  const name = op?.name;
  if (!name) throw new Error('Veo: nessuna operation nella risposta.');

  const started = Date.now();
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
  while (true) {
    if (Date.now() - started > maxWaitMs) throw new Error(`Veo timeout (${name}).`);
    await sleep(opts.pollIntervalMs ?? 8000, opts.signal);
    const q = await doFetch(`${base}/v1beta/${name}`, { headers, signal: opts.signal });
    if (!q.ok) continue;
    const data = await q.json();
    if (data.done) {
      if (data.error) throw new Error(`Veo fallito: ${data.error.message || 'unknown'}`);
      const uri = data?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new Error('Veo: completato ma senza video.');
      const sep = uri.includes('?') ? '&' : '?';
      const bytes = await download(`${uri}${sep}key=${encodeURIComponent(apiKey)}`, outputPath, doFetch, opts.signal);
      return { path: outputPath, bytes, provider: 'veo', model, taskId: name };
    }
    onProgress(`Veo: rendering… (${Math.round((Date.now() - started) / 1000)}s)`);
  }
}

// ── Kling (api.klingai.com, direct) ──────────────────────────────────────────
// JWT (HS256) signed from AccessKey:SecretKey, valid 30m. POST
// /v1/videos/image2video (or text2video) → { data: { task_id } } ; poll
// /v1/videos/{kind}/{task_id} until task_status succeed/failed ; video at
// data.task_result.videos[0].url.
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
export function klingJwt(accessKey, secretKey, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 }));
  const sig = createHmac('sha256', secretKey).update(`${header}.${payload}`).digest('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${payload}.${sig}`;
}
export async function generateKlingClip(params, opts = {}) {
  const { prompt, firstFrameImage, outputPath, model = 'kling-v1', duration = 5, mode = 'std' } = params;
  const cred = String(opts.apiKey || '');
  const colon = cred.indexOf(':');
  if (colon < 1) throw new Error('Kling richiede le credenziali nel formato "AccessKey:SecretKey" (da kling.ai/dev).');
  const accessKey = cred.slice(0, colon);
  const secretKey = cred.slice(colon + 1);
  const doFetch = opts._fetch || ((u, o) => fetch(u, o));
  const baseUrl = process.env.KLING_BASE_URL || 'https://api.klingai.com';
  const onProgress = opts.onProgress || (() => {});

  // Image: base64 without the data: prefix, or a public URL passthrough.
  let image = null;
  if (firstFrameImage) {
    const uri = await toDataUri(firstFrameImage);
    image = /^https?:\/\//i.test(uri) ? uri : String(uri).replace(/^data:[^;]+;base64,/, '');
  }
  const kind = image ? 'image2video' : 'text2video';
  const body = image
    ? { model_name: model, image, prompt: String(prompt || ''), duration: String(duration), mode }
    : { model_name: model, prompt: String(prompt || ''), duration: String(duration), mode };

  onProgress('Kling: invio task…');
  const submit = await doFetch(`${baseUrl}/v1/videos/${kind}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${klingJwt(accessKey, secretKey)}`, 'Content-Type': 'application/json' },
    signal: opts.signal, body: JSON.stringify(body),
  });
  if (!submit.ok) throw new Error(`Kling submit HTTP ${submit.status}: ${(await submit.text().catch(() => '')).slice(0, 200)}`);
  const sd = await submit.json();
  if (sd.code && sd.code !== 0) throw new Error(`Kling error ${sd.code}: ${sd.message || 'unknown'}`);
  const taskId = sd?.data?.task_id;
  if (!taskId) throw new Error('Kling: nessun task_id nella risposta.');

  const started = Date.now();
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
  while (true) {
    if (Date.now() - started > maxWaitMs) throw new Error(`Kling timeout (task ${taskId}).`);
    await sleep(opts.pollIntervalMs ?? 6000, opts.signal);
    const q = await doFetch(`${baseUrl}/v1/videos/${kind}/${taskId}`, {
      headers: { Authorization: `Bearer ${klingJwt(accessKey, secretKey)}` }, signal: opts.signal,
    });
    if (!q.ok) continue;
    const data = (await q.json())?.data || {};
    if (data.task_status === 'succeed') {
      const url = data?.task_result?.videos?.[0]?.url;
      if (!url) throw new Error('Kling: riuscito ma senza video.');
      const bytes = await download(url, outputPath, doFetch, opts.signal);
      return { path: outputPath, bytes, provider: 'kling', model, taskId };
    }
    if (data.task_status === 'failed') throw new Error(`Kling fallito: ${data.task_status_msg || 'unknown'}`);
    onProgress(`Kling: ${data.task_status || 'processing'}… (${Math.round((Date.now() - started) / 1000)}s)`);
  }
}

// ── fal.ai (queue API — powers Pika, plus Kling/Luma/MiniMax/…) ───────────────
// POST https://queue.fal.run/{model} → { request_id, status_url, response_url } ;
// poll status_url until COMPLETED ; GET response_url → { video: { url } }.
export async function generateFalClip(params, opts = {}) {
  const { prompt, firstFrameImage, outputPath, model = 'fal-ai/pika/v2.2/image-to-video', input = {} } = params;
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('fal.ai richiede un FAL_KEY (o salvato nello studio).');
  const doFetch = opts._fetch || ((u, o) => fetch(u, o));
  const base = process.env.FAL_BASE_URL || 'https://queue.fal.run';
  const headers = { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' };
  const onProgress = opts.onProgress || (() => {});

  const payload = { prompt: String(prompt || ''), ...input };
  if (firstFrameImage) payload.image_url = await toDataUri(firstFrameImage);

  onProgress('fal.ai: invio richiesta…');
  const submit = await doFetch(`${base}/${model}`, { method: 'POST', headers, signal: opts.signal, body: JSON.stringify(payload) });
  if (!submit.ok) throw new Error(`fal submit HTTP ${submit.status}: ${(await submit.text().catch(() => '')).slice(0, 200)}`);
  const created = await submit.json();
  const statusUrl = created.status_url;
  const responseUrl = created.response_url;
  if (!statusUrl || !responseUrl) throw new Error('fal.ai: risposta senza status/response URL.');

  const started = Date.now();
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
  while (true) {
    if (Date.now() - started > maxWaitMs) throw new Error('fal.ai timeout.');
    await sleep(opts.pollIntervalMs ?? 4000, opts.signal);
    const q = await doFetch(statusUrl, { headers, signal: opts.signal });
    if (!q.ok) continue;
    const st = await q.json();
    if (st.status === 'COMPLETED') {
      const out = await (await doFetch(responseUrl, { headers, signal: opts.signal })).json();
      const url = out?.video?.url || (Array.isArray(out?.videos) ? out.videos[0]?.url : null);
      if (!url) throw new Error('fal.ai: completato ma senza video.');
      const bytes = await download(url, outputPath, doFetch, opts.signal);
      return { path: outputPath, bytes, provider: 'fal', model, taskId: created.request_id };
    }
    if (st.status === 'FAILED' || st.status === 'ERROR') throw new Error(`fal.ai ${st.status}: ${st.error || 'unknown'}`);
    onProgress(`fal.ai: ${st.status || 'IN_PROGRESS'}… (${Math.round((Date.now() - started) / 1000)}s)`);
  }
}

// ── MiniMax (reuse existing tool) ────────────────────────────────────────────
async function generateMinimaxClip(params, opts = {}) {
  const photoParam = params.model === 'S2V-01'
    ? { subjectReferenceImage: params.characterImage }
    : { firstFrameImage: params.characterImage };
  const r = await generateSceneClip(
    {
      prompt: params.prompt,
      outputPath: params.outputPath,
      ...photoParam,
      duration: params.duration,
      resolution: params.resolution,
      model: params.model,
    },
    opts,
  );
  return { ...r, provider: 'minimax' };
}

// Provider registry surfaced to the studio. `keyProvider` is the secret-store id
// whose key this engine consumes.
export const VIDEO_PROVIDERS = {
  minimax:   { label: 'MiniMax',   keyProvider: 'minimax' },
  runway:    { label: 'Runway',    keyProvider: 'runway' },
  replicate: { label: 'Replicate', keyProvider: 'replicate' },
  luma:      { label: 'Luma',      keyProvider: 'luma' },
  veo:       { label: 'Google Veo', keyProvider: 'gemini' },
  kling:     { label: 'Kling',     keyProvider: 'kling' },
  fal:       { label: 'fal.ai',    keyProvider: 'fal' },
};

export function generateClipWith(provider, params, opts = {}) {
  switch (provider) {
    case 'minimax':   return generateMinimaxClip(params, opts);
    case 'runway':    return generateRunwayClip(params, opts);
    case 'replicate': return generateReplicateClip(params, opts);
    case 'luma':      return generateLumaClip(params, opts);
    case 'veo':       return generateVeoClip(params, opts);
    case 'kling':     return generateKlingClip(params, opts);
    case 'fal':       return generateFalClip(params, opts);
    default: throw new Error(`Provider video sconosciuto: ${provider}`);
  }
}
