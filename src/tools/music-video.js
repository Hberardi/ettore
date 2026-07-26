// Music video generation pipeline.
//
// Turns a single character photo + a full song into a finished music video:
//   1. Understand the song            -> audio_read (describe + transcribe)
//   2. Generate real animated clips   -> MiniMax Hailuo (this file)
//   3. Assemble clips + audio + subs  -> ffmpeg (this file)
//
// Two clip engines are supported:
//   - subject-reference (model S2V-01): keeps the SAME character across
//     different scenes/poses/settings — the default when a reference photo is
//     given, which is what you want for a "same person, different scenes" MV.
//   - image-to-video / text-to-video (model MiniMax-Hailuo-2.3): animates from
//     a first frame, or generates from a prompt alone.
//
// Still-frame generation (OpenAI gpt-image-1) is kept for art-directing a
// first frame when you want a precise starting image.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir, rm, mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname, extname } from 'path';
import { getProviderEnvKey } from '../providers/env.js';

const execFileAsync = promisify(execFile);

const OPENAI_IMAGES_ENDPOINT = 'https://api.openai.com/v1/images/generations';
const VALID_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024']);

// Video generation lives on the standard MiniMax platform API. It is billed
// from the account's prepaid Credits — NOT from a "Token Plan"/Coding Plan
// subscription (which only covers the chat models). Allow a video-specific base
// URL so a Coding-Plan chat proxy set in MINIMAX_BASE_URL doesn't hijack it.
const MINIMAX_BASE = () =>
  (process.env.MINIMAX_VIDEO_BASE_URL || process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1').replace(/\/$/, '');
const SUBMIT_PATH = '/video_generation';
const QUERY_PATH = '/query/video_generation';
const FILE_PATH = '/files/retrieve';

const VALID_DURATIONS = new Set([6, 10]);
const VALID_RESOLUTIONS = new Set(['512P', '768P', '1080P']);
const SUBJECT_MODEL = 'S2V-01';
const DEFAULT_IMAGE_MODEL = 'MiniMax-Hailuo-2.3';

const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function getOpenAiApiKey(opts = {}) {
  return opts.apiKey || getProviderEnvKey('openai', opts.env)?.value || null;
}

export function getMinimaxApiKey(opts = {}) {
  return opts.apiKey || getProviderEnvKey('minimax', opts.env)?.value || null;
}

// A clip/subject reference image can be a public URL (used as-is) or a local
// file (encoded to a base64 data URI). MiniMax accepts both forms.
export async function resolveImageInput(pathOrUrl, _opts = {}) {
  const value = String(pathOrUrl || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const bytes = await readFile(value);
  const mime = IMAGE_MIME_BY_EXT[extname(value).toLowerCase()] || 'image/png';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export async function generateSceneImage({ prompt, filePath, size }, opts = {}) {
  if (!prompt) throw new Error('generate_scene_image requires a "prompt" argument.');
  if (!filePath) throw new Error('generate_scene_image requires a "file_path" argument.');
  const apiKey = getOpenAiApiKey(opts);
  if (!apiKey) {
    throw new Error('generate_scene_image needs OPENAI_API_KEY. Set it in the environment or via /connect.');
  }
  const requestedSize = VALID_SIZES.has(size) ? size : '1024x1024';

  const doFetch = opts._fetch || ((u, o) => fetch(u, o));
  const response = await doFetch(OPENAI_IMAGES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: 'gpt-image-1', prompt: String(prompt), size: requestedSize, n: 1 }),
    signal: opts.signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI image generation failed: HTTP ${response.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`);
  }
  const data = await response.json();
  const item = data?.data?.[0];
  let bytes;
  if (item?.b64_json) {
    bytes = Buffer.from(item.b64_json, 'base64');
  } else if (item?.url) {
    const imgResponse = await doFetch(item.url, { signal: opts.signal });
    if (!imgResponse.ok) throw new Error(`Failed to download generated image: HTTP ${imgResponse.status}`);
    bytes = Buffer.from(await imgResponse.arrayBuffer());
  } else {
    throw new Error('OpenAI image generation returned no image data.');
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  return { path: filePath, bytes: bytes.length, size: requestedSize };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// Human, actionable explanations for the MiniMax billing/quota codes that are
// otherwise confusing (esp. 2056, whose raw text blames the "Token Plan" even
// though video generation is billed from a separate Credits balance).
const MINIMAX_CODE_HINTS = {
  // Known MiniMax routing issue: a Coding/Token Plan key routes ALL requests
  // through the Token Plan quota, where video/audio models are unprovisioned
  // (Hs_max 0/0) — so they fail even when the account has Credits. Ref:
  // github.com/MiniMax-AI/MiniMax-MCP/issues/80, MiniMax-AI/cli/issues/173.
  2056: 'La chiave sembra legata al Token Plan / Coding Plan: MiniMax instrada il video sulla quota del piano (dove i modelli video valgono 0/0) invece che sui tuoi Credits, quindi fallisce anche se hai Credits. Usa una API key che fatturi dai Credits (pay-as-you-go, senza subscription Coding Plan) e verifica che i Credits siano sullo stesso account/GroupId. Se non è separabile è un bug di routing MiniMax: apri un ticket citando "2056 Token Plan Hs_max 0/0 su video_generation".',
  1008: 'Saldo Credits insufficiente: ricarica su platform.minimax.io → Billing.',
  1004: 'Autenticazione fallita: la MINIMAX_API_KEY non è valida o è di un account/regione diversa dall\'endpoint.',
  1002: 'Rate limit raggiunto: riprova tra qualche istante.',
};

// Billing/quota codes that mean "the batch cannot proceed" (vs a transient
// error worth retrying). 2056 = plan/quota, 1008 = insufficient Credits.
export const MINIMAX_BILLING_CODES = new Set([2056, 1008]);

// Extract the numeric MiniMax code from a thrown error message like
// "MiniMax error 2056: ...". Returns null if not a coded MiniMax error.
export function minimaxErrorCode(message) {
  const m = /MiniMax error (\d+)/.exec(String(message || ''));
  return m ? Number(m[1]) : null;
}

export function isMinimaxBillingError(message) {
  return MINIMAX_BILLING_CODES.has(minimaxErrorCode(message));
}

// Best-effort read of the account's remaining plan quota. NOTE: this is the
// Token Plan pool and does NOT reliably reflect the pay-as-you-go Credits used
// for video — MiniMax exposes no dependable "video credits" endpoint. Returned
// only as informational context; never used as a hard gate. Resolves to null
// on any failure so callers can silently skip it.
export async function getMinimaxBalance(opts = {}) {
  const apiKey = getMinimaxApiKey(opts);
  if (!apiKey) return null;
  const doFetch = opts._fetch || ((u, o) => fetch(u, o));
  try {
    const res = await doFetch(`${MINIMAX_BASE()}/token_plan/remains`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: opts.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.base_resp && data.base_resp.status_code !== 0) return null;
    return data;
  } catch {
    return null;
  }
}

function minimaxError(data, fallback) {
  const base = data?.base_resp;
  if (base && base.status_code !== 0) {
    const hint = MINIMAX_CODE_HINTS[base.status_code];
    return `MiniMax error ${base.status_code}: ${base.status_msg || 'unknown error'}`
      + (hint ? `\n→ ${hint}` : '');
  }
  return fallback;
}

// Generate one real animated clip via MiniMax Hailuo. Async task API:
// submit -> poll every pollIntervalMs -> retrieve download URL -> download.
export async function generateSceneClip(params = {}, opts = {}) {
  const {
    prompt,
    subjectReferenceImage,
    firstFrameImage,
    outputPath,
    duration = 6,
    resolution = '768P',
    model,
  } = params;

  if (!prompt) throw new Error('generate_scene_clip requires a "prompt" argument.');
  if (!outputPath) throw new Error('generate_scene_clip requires an "output_path" argument.');

  const apiKey = getMinimaxApiKey(opts);
  if (!apiKey) {
    throw new Error('generate_scene_clip needs MINIMAX_API_KEY. Set it in the environment or via /connect.');
  }

  const dur = VALID_DURATIONS.has(Number(duration)) ? Number(duration) : 6;
  const res = VALID_RESOLUTIONS.has(String(resolution)) ? String(resolution) : '768P';

  // Default the model to the right engine for the given inputs.
  let chosenModel = model;
  if (!chosenModel) chosenModel = subjectReferenceImage ? SUBJECT_MODEL : DEFAULT_IMAGE_MODEL;

  const payload = { model: chosenModel, prompt: String(prompt), duration: dur, resolution: res };

  if (subjectReferenceImage) {
    const uri = await resolveImageInput(subjectReferenceImage, opts);
    payload.subject_reference = [{ type: 'character', image: [uri] }];
  } else if (firstFrameImage) {
    payload.first_frame_image = await resolveImageInput(firstFrameImage, opts);
  }

  const doFetch = opts._fetch || ((u, o) => fetch(u, o));
  const authHeaders = { Authorization: `Bearer ${apiKey}` };
  const signal = opts.signal;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;

  // 1) Submit
  onProgress('Submitting clip generation task…');
  const submitRes = await doFetch(MINIMAX_BASE() + SUBMIT_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(payload),
    signal,
  });
  if (!submitRes.ok) {
    const errText = await submitRes.text().catch(() => '');
    throw new Error(`MiniMax submit failed: HTTP ${submitRes.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`);
  }
  const submitData = await submitRes.json();
  const taskId = submitData?.task_id;
  if (!taskId) throw new Error(minimaxError(submitData, 'MiniMax submit returned no task_id.'));

  // 2) Poll
  const started = Date.now();
  let fileId = null;
  while (true) {
    if (Date.now() - started > maxWaitMs) {
      throw new Error(`MiniMax clip timed out after ${Math.round(maxWaitMs / 1000)}s (task ${taskId}).`);
    }
    await sleep(pollIntervalMs, signal);
    const queryRes = await doFetch(`${MINIMAX_BASE()}${QUERY_PATH}?task_id=${encodeURIComponent(taskId)}`, {
      headers: authHeaders,
      signal,
    });
    if (!queryRes.ok) {
      // transient — keep polling until maxWait
      continue;
    }
    const queryData = await queryRes.json();
    const status = queryData?.status;
    if (status === 'Success') {
      fileId = queryData?.file_id;
      if (!fileId) throw new Error(minimaxError(queryData, 'MiniMax reported Success but returned no file_id.'));
      break;
    }
    if (status === 'Fail') {
      throw new Error(minimaxError(queryData, `MiniMax clip generation failed (task ${taskId}).`));
    }
    onProgress(`Rendering clip… (${status || 'processing'}, ${Math.round((Date.now() - started) / 1000)}s)`);
  }

  // 3) Retrieve + download
  onProgress('Retrieving finished clip…');
  const fileRes = await doFetch(`${MINIMAX_BASE()}${FILE_PATH}?file_id=${encodeURIComponent(fileId)}`, {
    headers: authHeaders,
    signal,
  });
  if (!fileRes.ok) throw new Error(`MiniMax file retrieve failed: HTTP ${fileRes.status}`);
  const fileData = await fileRes.json();
  const downloadUrl = fileData?.file?.download_url;
  if (!downloadUrl) throw new Error(minimaxError(fileData, 'MiniMax file retrieve returned no download_url.'));

  const videoRes = await doFetch(downloadUrl, { signal });
  if (!videoRes.ok) throw new Error(`Failed to download clip: HTTP ${videoRes.status}`);
  const bytes = Buffer.from(await videoRes.arrayBuffer());

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);

  return { path: outputPath, bytes: bytes.length, model: chosenModel, duration: dur, resolution: res, taskId };
}

async function probeAudioDurationSeconds(audioPath, opts = {}) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath,
    ], { signal: opts.signal });
    const seconds = Number(String(stdout).trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('ffprobe returned an invalid duration');
    return seconds;
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('ffprobe not found. Install ffmpeg (which provides ffprobe) to assemble music videos.');
    throw new Error(`Could not read audio duration: ${e.message}`);
  }
}

// ffmpeg concat demuxer requires single quotes around each path, with any
// literal single quote in the path escaped as '\''.
function escapeConcatPath(path) {
  return String(path).replace(/'/g, `'\\''`);
}

// Assemble ordered animated clips + the user's audio track into the final
// music video. Clip audio is dropped in favor of the song; optional burned-in
// lyric subtitles.
export async function assembleMusicVideo({ audioPath, clipPaths, outputPath, subtitlesPath, width } = {}, opts = {}) {
  if (!audioPath) throw new Error('assemble_music_video requires "audio_path".');
  if (!Array.isArray(clipPaths) || clipPaths.length === 0) {
    throw new Error('assemble_music_video requires a non-empty "clip_paths" array.');
  }
  if (!outputPath) throw new Error('assemble_music_video requires "output_path".');

  const durationSeconds = await probeAudioDurationSeconds(audioPath, opts);

  const concatLines = clipPaths.map(clip => `file '${escapeConcatPath(clip)}'`);

  const workDir = await mkdtemp(join(tmpdir(), 'ettore-music-video-'));
  const concatFile = join(workDir, 'clips.txt');
  await writeFile(concatFile, concatLines.join('\n'), 'utf-8');

  await mkdir(dirname(outputPath), { recursive: true });

  const scaleWidth = Number(width) > 0 ? Math.round(Number(width) / 2) * 2 : 1280;
  const videoFilters = [`scale=${scaleWidth}:-2`, 'format=yuv420p'];
  if (subtitlesPath) {
    videoFilters.push(`subtitles=${String(subtitlesPath).replace(/:/g, '\\:')}`);
  }

  const args = [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', videoFilters.join(','),
    '-c:v', 'libx264', '-c:a', 'aac',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ];

  try {
    await execFileAsync('ffmpeg', args, { signal: opts.signal, maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('ffmpeg not found. Install ffmpeg to assemble music videos.');
    throw new Error(`ffmpeg failed: ${e.stderr ? String(e.stderr).slice(-500) : e.message}`);
  } finally {
    await rm(workDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }).catch(() => {});
  }

  return {
    path: outputPath,
    durationSeconds,
    clipCount: clipPaths.length,
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function srtTimestamp(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)},${pad3(ms)}`;
}

// Convert an audio_read transcribe result — lines tagged with [MM:SS] or
// [MM:SS.mmm] (or [HH:MM:SS]) timestamps — into an SRT subtitle file. Each cue
// runs until the next cue starts (last cue is held for `tailSeconds`).
export function lyricsToSrt(lyrics, { tailSeconds = 3 } = {}) {
  const text = String(lyrics || '');
  const re = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?\]\s*(.*)/g;
  const cues = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const [, a, b, c, frac, rest] = match;
    // [MM:SS] -> a=MM, b=SS ; [HH:MM:SS] -> a=HH, b=MM, c=SS
    let seconds;
    if (c !== undefined) {
      seconds = Number(a) * 3600 + Number(b) * 60 + Number(c);
    } else {
      seconds = Number(a) * 60 + Number(b);
    }
    if (frac) seconds += Number(`0.${frac}`);
    const line = String(rest || '').trim();
    if (line) cues.push({ start: seconds, text: line });
  }

  if (cues.length === 0) return '';

  const blocks = cues.map((cue, i) => {
    const end = i + 1 < cues.length ? cues[i + 1].start : cue.start + tailSeconds;
    return `${i + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(end)}\n${cue.text}`;
  });
  return blocks.join('\n\n') + '\n';
}
