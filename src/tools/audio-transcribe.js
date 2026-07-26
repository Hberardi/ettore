// Phase-2 transcription paths used when YouTube captions are absent:
//   - Level 2: local yt-dlp + whisper (truly free, runs on the user's machine)
//   - Level 3: Google Gemini API free tier (no local install, needs API key)
// Both are best-effort: if a level is not configured/installed, the orchestrator
// in video-transcript.js falls through to the next one.

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, basename } from 'path';

const execFileAsync = promisify(execFile);

// Short-lived cache: avoids re-running `which` for repeated video_transcript
// calls in the same session, but expires fast enough that installing a tool
// mid-session is picked up automatically (no need to restart the CLI).
let detectionCache = null;
let detectionCacheExpiresAt = 0;
const DETECTION_CACHE_TTL_MS = 30_000;

// Candidate absolute paths to probe when `which` comes up empty — typical
// install locations across pipx (~/.local/bin), apt (/usr/bin), brew
// (/usr/local/bin, /opt/homebrew/bin), and pyenv-style installs. Lets the
// cascade find binaries even when the CLI process was launched with a
// stripped PATH that misses ~/.local/bin.
function commonBinPaths(name) {
  const home = process.env.HOME || '';
  return [
    home && `${home}/.local/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/opt/local/bin/${name}`,
    home && `${home}/.cargo/bin/${name}`,
  ].filter(Boolean);
}

async function whichOne(name) {
  // If the caller already passed an absolute path, just check it.
  if (name && name.startsWith('/')) {
    try {
      await execFileAsync('test', ['-x', name]);
      return name;
    } catch { return null; }
  }
  // First try PATH.
  try {
    const { stdout } = await execFileAsync('which', [name]);
    const found = stdout.trim();
    if (found) return found;
  } catch { /* fall through */ }
  // Fallback: scan known install locations directly.
  for (const candidate of commonBinPaths(name)) {
    try {
      await execFileAsync('test', ['-x', candidate]);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

export async function detectLocalTools({ force = false } = {}) {
  const now = Date.now();
  if (!force && detectionCache && now < detectionCacheExpiresAt) {
    return detectionCache;
  }
  // Probe every supported whisper flavor in parallel. All of them accept the
  // same CLI flags (--model/--output_format/--output_dir/--language), so the
  // transcription code is flavor-agnostic — we only pick which binary to run.
  // Preference order: explicit WHISPER_CMD override > faster-whisper
  // (whisper-ctranslate2: near-instant load + much faster inference) >
  // openai-whisper > whisper.cpp.
  const [ytdlp, override, faster, openai, whisperCli] = await Promise.all([
    whichOne(process.env.YTDLP_CMD || 'yt-dlp'),
    process.env.WHISPER_CMD ? whichOne(process.env.WHISPER_CMD) : Promise.resolve(null),
    whichOne('whisper-ctranslate2'),
    whichOne('whisper'),
    whichOne('whisper-cli'),
  ]);
  let whisper = null;
  let whisperFlavor = null;
  if (override)         { whisper = override;    whisperFlavor = 'custom'; }
  else if (faster)      { whisper = faster;      whisperFlavor = 'faster-whisper'; }
  else if (openai)      { whisper = openai;      whisperFlavor = 'openai-whisper'; }
  else if (whisperCli)  { whisper = whisperCli;  whisperFlavor = 'whisper.cpp'; }
  detectionCache = { ytdlp, whisper, whisperFlavor };
  detectionCacheExpiresAt = now + DETECTION_CACHE_TTL_MS;
  return detectionCache;
}

// Hook for tests — never used in production.
export function _setDetectionCache(value) {
  detectionCache = value;
  detectionCacheExpiresAt = value ? Number.MAX_SAFE_INTEGER : 0;
}

function runStreaming(command, args, { signal, timeoutMs = 600_000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    // Buffer stdout/stderr line-by-line so onLine receives complete lines
    // (yt-dlp/whisper both emit progress one line at a time, sometimes
    // padded with \r for in-place updates).
    const buf = { stdout: '', stderr: '' };
    const feed = (which, chunk) => {
      const text = chunk.toString();
      if (which === 'stdout') stdout += text; else stderr += text;
      buf[which] += text;
      // Treat both \n and \r as line separators (yt-dlp uses \r for progress).
      const parts = buf[which].split(/[\r\n]/);
      buf[which] = parts.pop() ?? '';
      if (onLine) {
        for (const line of parts) {
          const trimmed = line.trim();
          if (trimmed) onLine(trimmed, which);
        }
      }
    };
    proc.stdout.on('data', (b) => feed('stdout', b));
    proc.stderr.on('data', (b) => feed('stderr', b));

    const onAbort = () => { try { proc.kill('SIGTERM'); } catch {} };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Exit code ${code}: ${stderr.split('\n').slice(-3).join(' ').trim() || 'unknown error'}`));
    });
  });
}

// Wraps a `log` callback with two guarantees the stall watchdog needs:
//   - forwards interesting subprocess lines (yt-dlp download %, whisper
//     timestamps) as progress messages
//   - emits a heartbeat every `heartbeatMs` if the subprocess goes quiet,
//     so a slow whisper pass on a long video doesn't trip the stall guard
function makeProgressReporter({ log, phase, heartbeatMs = 25_000 }) {
  let lastEmit = Date.now();
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - lastEmit < heartbeatMs) return;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    log?.(`${phase} (in corso da ${elapsed}s)`);
    lastEmit = Date.now();
  }, Math.min(heartbeatMs, 5_000));

  const onLine = (line) => {
    // Filter out noisy lines; keep things that look like progress.
    const compact = line.replace(/\s+/g, ' ').slice(0, 140);
    log?.(`${phase}: ${compact}`);
    lastEmit = Date.now();
  };

  const stop = () => clearInterval(heartbeat);
  return { onLine, stop };
}

// Which whisper models to try, in order. If the user pinned WHISPER_MODEL we
// respect it exactly (single rung, no escalation). Otherwise we start at
// `base` — `tiny` is fast but frequently returns NO words on sung lyrics or
// non-English speech, which shows up to the user as an empty/"instrumental"
// result — and escalate to `small` only when a model comes back with nothing.
// The fast common case still finishes on the first rung; escalation only pays
// its cost on tracks the smaller model failed to transcribe.
function getWhisperModelLadder() {
  const pinned = process.env.WHISPER_MODEL;
  return pinned ? [pinned] : ['base', 'small'];
}

// Run one whisper pass for a specific model and return its trimmed segments.
// Throws if whisper produced no readable JSON (a genuine failure, distinct
// from "ran fine but found no words" which yields an empty segments array).
async function runWhisperToSegments({ tools, inputPath, model, outDir, preferLang, runner, signal, log }) {
  log?.(`Trascrivo con ${tools.whisperFlavor || 'whisper'} (modello: ${model})…`);
  const langArg = preferLang && preferLang !== 'auto' ? ['--language', preferLang] : [];
  const wsReporter = makeProgressReporter({ log, phase: 'whisper' });
  try {
    await runner(tools.whisper, [
      inputPath,
      '--model', model,
      '--output_format', 'json',
      '--output_dir', outDir,
      '--verbose', 'True', // print segment lines to stdout — keeps the heartbeat alive
      ...langArg,
    ], { signal, onLine: wsReporter.onLine });
  } finally { wsReporter.stop(); }

  const jsonFile = join(outDir, `${basename(inputPath).replace(/\.[^.]+$/, '')}.json`);
  const raw = await readFile(jsonFile, 'utf-8');
  const parsed = JSON.parse(raw);
  const segments = Array.isArray(parsed?.segments)
    ? parsed.segments
        .map(s => ({ start: Number(s.start) || 0, text: String(s.text || '').trim() }))
        .filter(s => s.text)
    : [];
  return { segments, language: String(parsed?.language || preferLang || 'unknown') };
}

// Run whisper against a file, escalating through the model ladder while a
// model returns no words. Returns a transcribe-result object (either segments
// or an error) ready to hand back to callers.
async function whisperWithEscalation({ tools, inputPath, outDir, preferLang, runner, signal, log }) {
  const models = getWhisperModelLadder();
  let lastModel = models[models.length - 1];
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    let out;
    try {
      out = await runWhisperToSegments({ tools, inputPath, model, outDir, preferLang, runner, signal, log });
    } catch (e) {
      return { error: `local: failed to read whisper output: ${e.message}`, tried: 'local', installed: true };
    }
    if (out.segments.length) {
      return { tried: 'local', installed: true, segments: out.segments, language: out.language, source: 'whisper-local' };
    }
    lastModel = model;
    if (i < models.length - 1) {
      log?.(`Il modello ${model} non ha rilevato parole; riprovo con un modello più grande…`);
    }
  }
  const hint = process.env.WHISPER_MODEL
    ? 'Se la traccia contiene voce, prova un modello più grande (es. WHISPER_MODEL=medium) o specifica la lingua (es. language:"it").'
    : `Se la traccia contiene voce, prova WHISPER_MODEL=medium o specifica la lingua (es. language:"it").`;
  return {
    error: `local: whisper non ha rilevato parole (col modello ${lastModel}); l'audio potrebbe essere strumentale o silenzioso. ${hint}`,
    tried: 'local',
    installed: true,
  };
}

export async function transcribeLocal({ url, preferLang = 'en', signal, log, _runner } = {}) {
  const tools = await detectLocalTools();
  if (!tools.ytdlp) {
    return { error: 'local: yt-dlp not on PATH. Install via `pip install yt-dlp` or your package manager.', tried: 'local', installed: false };
  }
  if (!tools.whisper) {
    return { error: 'local: whisper not on PATH. Install via `pip install openai-whisper` (Python 3.8+), or whisper.cpp `whisper-cli`. Set WHISPER_CMD to override.', tried: 'local', installed: false };
  }

  const runner = _runner || runStreaming;
  const workDir = await mkdtemp(join(tmpdir(), 'ettore-transcribe-'));
  try {
    const audioBase = join(workDir, 'audio');
    log?.('Scarico l\'audio con yt-dlp…');
    const dlReporter = makeProgressReporter({ log, phase: 'yt-dlp' });
    try {
      // Keep yt-dlp's default progress output so we can stream it as
      // heartbeat lines (% downloaded, ETA). Without this the stall watchdog
      // killed the run on long videos.
      await runner(tools.ytdlp, [
        '-x', '--audio-format', 'mp3',
        '--newline',
        '-o', `${audioBase}.%(ext)s`,
        String(url || ''),
      ], { signal, onLine: dlReporter.onLine });
    } finally { dlReporter.stop(); }

    const files = await readdir(workDir);
    const audioFile = files.find(f => f.startsWith('audio.') && /\.(mp3|m4a|wav|opus|webm)$/i.test(f));
    if (!audioFile) {
      return { error: 'local: yt-dlp completed but produced no audio file.', tried: 'local', installed: true };
    }
    const audioPath = join(workDir, audioFile);

    // openai-whisper CLI flags, shared by every flavor. whisper.cpp users
    // typically alias or wrap the binary to match; the error message above
    // documents this. Escalates the model when a smaller one finds no words.
    return await whisperWithEscalation({
      tools, inputPath: audioPath, outDir: workDir, preferLang, runner, signal, log,
    });
  } catch (e) {
    return { error: `local: ${e.message}`, tried: 'local', installed: true };
  } finally {
    await rm(workDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }).catch(() => {});
  }
}

// Transcribe an audio file that already exists on disk — skips the yt-dlp
// download step that transcribeLocal needs for remote URLs. Used by the
// audio_read tool so the user can point whisper straight at a local song.
// whisper writes its JSON output named after the input basename, so we send
// it to a throwaway dir and read `<basename>.json` back out.
export async function whisperTranscribeFile({ audioPath, preferLang = 'auto', signal, log, _runner } = {}) {
  const tools = await detectLocalTools();
  if (!tools.whisper) {
    return { error: 'local: whisper not on PATH. Install via `pip install openai-whisper` (Python 3.8+), or whisper.cpp `whisper-cli`. Set WHISPER_CMD to override.', tried: 'local', installed: false };
  }

  const runner = _runner || runStreaming;
  const outDir = await mkdtemp(join(tmpdir(), 'ettore-whisper-'));
  try {
    return await whisperWithEscalation({
      tools, inputPath: audioPath, outDir, preferLang, runner, signal, log,
    });
  } catch (e) {
    return { error: `local: ${e.message}`, tried: 'local', installed: true };
  } finally {
    await rm(outDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }).catch(() => {});
  }
}

export function getGeminiApiKey(opts = {}) {
  return (
    opts.geminiApiKey ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    null
  );
}

// Shared across every Gemini caller (audio_read, video_transcript,
// video_describe). gemini-1.5-flash was retired by Google — default to
// 2.5-flash and let GEMINI_MODEL override, read at call time so a value set
// after module load (e.g. from a freshly loaded .env) still applies.
export function getGeminiModel() {
  return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
}

export function geminiEndpoint(model = getGeminiModel()) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export async function transcribeWithGemini({ url, apiKey, signal, _fetch } = {}) {
  if (!apiKey) {
    return { error: 'gemini: no API key. Set GEMINI_API_KEY env var or pass --gemini-key (free tier at aistudio.google.com).', tried: 'gemini', installed: false };
  }

  const body = {
    contents: [{
      parts: [
        { text: 'Transcribe this video word-for-word in its original language. Include a [MM:SS] timestamp roughly every 20 seconds at natural sentence breaks. Output ONLY the transcript — no preamble, no summary, no commentary.' },
        { fileData: { fileUri: String(url || '') } },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
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
  catch (e) { return { error: `gemini: invalid JSON response: ${e.message}`, tried: 'gemini', installed: true }; }

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

  // Gemini returns prose with inline [MM:SS] markers — split into pseudo-segments.
  return {
    tried: 'gemini',
    installed: true,
    segments: parseTimestampedText(text),
    language: 'unknown',
    source: 'gemini-flash',
  };
}

// Split prose with inline [MM:SS] or [H:MM:SS] markers into segments.
// Falls back to one big segment at start=0 if no markers found.
export function parseTimestampedText(text) {
  const body = String(text || '').trim();
  if (!body) return [];
  const re = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g;
  const matches = [...body.matchAll(re)];
  if (!matches.length) return [{ start: 0, text: body }];

  const out = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const next = matches[i + 1];
    const h = m[3] ? Number(m[1]) : 0;
    const mm = m[3] ? Number(m[2]) : Number(m[1]);
    const ss = m[3] ? Number(m[3]) : Number(m[2]);
    const start = h * 3600 + mm * 60 + ss;
    const chunkStart = m.index + m[0].length;
    const chunkEnd = next ? next.index : body.length;
    const chunk = body.slice(chunkStart, chunkEnd).trim();
    if (chunk) out.push({ start, text: chunk });
  }
  // Capture any prefix text before the first timestamp.
  const prefix = body.slice(0, matches[0].index).trim();
  if (prefix) out.unshift({ start: 0, text: prefix });
  return out;
}
