import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readAudio,
  renderAudioResult,
  analyzeAudioWithGemini,
} from '../src/tools/audio-read.js';
import { _setDetectionCache } from '../src/tools/audio-transcribe.js';
import { toolHandlers, toolDefinitions } from '../src/tools/index.js';

async function withAudioFile(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-audio-'));
  const file = join(dir, name);
  await writeFile(file, Buffer.from('fake-audio-bytes'));
  try { return await fn(file); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function geminiResponse(text) {
  const payload = { candidates: [{ content: { parts: [{ text }] } }] };
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

test('readAudio rejects a missing file', async () => {
  const res = await readAudio({ file_path: '/no/such/song.mp3' });
  assert.match(res.error, /File not found/);
});

test('readAudio rejects an unsupported extension', async () => {
  await withAudioFile('notes.txt', async (file) => {
    const res = await readAudio({ file_path: file });
    assert.match(res.error, /Unsupported audio extension/);
  });
});

test('readAudio transcribe uses local whisper when installed', async () => {
  _setDetectionCache({ ytdlp: null, whisper: '/usr/bin/whisper', whisperFlavor: 'openai-whisper' });
  try {
    await withAudioFile('song.mp3', async (file) => {
      // Stub the whisper subprocess: write the JSON whisper would produce.
      const { writeFile: wf } = await import('node:fs/promises');
      const _runner = async (_cmd, args) => {
        const outDir = args[args.indexOf('--output_dir') + 1];
        await wf(join(outDir, 'song.json'), JSON.stringify({
          language: 'it',
          segments: [{ start: 0, text: 'ciao' }, { start: 5.4, text: 'mondo' }],
        }));
        return { stdout: '', stderr: '' };
      };
      // readAudio calls whisperTranscribeFile without _runner injection, so
      // exercise the whisper path directly through the exported helper.
      const { whisperTranscribeFile } = await import('../src/tools/audio-transcribe.js');
      const res = await whisperTranscribeFile({ audioPath: file, _runner });
      assert.equal(res.error, undefined);
      assert.equal(res.source, 'whisper-local');
      assert.deepEqual(res.segments.map(s => s.text), ['ciao', 'mondo']);
      assert.equal(res.language, 'it');
    });
  } finally {
    _setDetectionCache(null);
  }
});

test('readAudio transcribe falls back to Gemini when whisper is absent', async () => {
  _setDetectionCache({ ytdlp: null, whisper: null, whisperFlavor: null });
  try {
    await withAudioFile('song.mp3', async (file) => {
      let capturedBody;
      const res = await readAudio(
        { file_path: file, mode: 'transcribe' },
        {
          geminiApiKey: 'k',
          _fetch: async (_url, opts) => { capturedBody = JSON.parse(opts.body); return geminiResponse('[00:03] hello there'); },
        },
      );
      assert.equal(res.error, undefined);
      assert.equal(res.mode, 'transcribe');
      assert.equal(res.source, 'gemini-flash');
      assert.equal(capturedBody.contents[0].parts[1].inlineData.mimeType, 'audio/mp3');
      assert.ok(capturedBody.contents[0].parts[1].inlineData.data, 'audio bytes are inlined as base64');
      assert.equal(res.segments[0].start, 3);
    });
  } finally {
    _setDetectionCache(null);
  }
});

test('readAudio describe requires a Gemini key', async () => {
  await withAudioFile('song.mp3', async (file) => {
    const res = await readAudio({ file_path: file, mode: 'describe' }, { /* no key */ });
    assert.match(res.error, /GEMINI_API_KEY/);
  });
});

test('readAudio describe returns an analysis from Gemini', async () => {
  await withAudioFile('song.flac', async (file) => {
    let capturedBody;
    const res = await readAudio(
      { file_path: file, mode: 'describe' },
      { geminiApiKey: 'k', _fetch: async (_u, opts) => { capturedBody = JSON.parse(opts.body); return geminiResponse('Upbeat synthpop, ~120 BPM, C minor.'); } },
    );
    assert.equal(res.error, undefined);
    assert.equal(res.mode, 'describe');
    assert.match(res.description, /synthpop/);
    assert.equal(capturedBody.contents[0].parts[1].inlineData.mimeType, 'audio/flac');
  });
});

test('analyzeAudioWithGemini rejects oversized files before calling the API', async () => {
  let called = false;
  const res = await analyzeAudioWithGemini({
    filePath: '/whatever.mp3',
    mimeType: 'audio/mp3',
    apiKey: 'k',
    _readFile: async () => Buffer.alloc(20 * 1024 * 1024),
    _fetch: async () => { called = true; return geminiResponse('x'); },
  });
  assert.match(res.error, /inline limit/);
  assert.equal(called, false);
});

test('renderAudioResult formats lyrics with timestamps and a source header', () => {
  const out = renderAudioResult({
    mode: 'transcribe', file: 'song.mp3', language: 'it', source: 'whisper-local',
    segments: [{ start: 0, text: 'ciao' }, { start: 65, text: 'mondo' }],
  });
  assert.match(out, /\[WHISPER \(LOCAL\) — LYRICS\]/);
  assert.match(out, /file: song\.mp3/);
  assert.match(out, /\[00:00\] ciao/);
  assert.match(out, /\[01:05\] mondo/);
});

test('renderAudioResult formats a description block', () => {
  const out = renderAudioResult({ mode: 'describe', file: 'x.wav', source: 'gemini-flash', description: 'Jazzy.' });
  assert.match(out, /\[GEMINI FLASH — ANALYSIS\]/);
  assert.match(out, /Jazzy\./);
});

test('audio_read tool handler validates the file_path argument', async () => {
  const out = await toolHandlers.audio_read({});
  assert.match(out, /requires a "file_path" argument/);
});

test('audio_read tool definition is registered with both modes', () => {
  const def = toolDefinitions.find(d => d.function?.name === 'audio_read');
  assert.ok(def, 'audio_read must be registered');
  assert.deepEqual(def.function.parameters.required, ['file_path']);
  assert.deepEqual(def.function.parameters.properties.mode.enum, ['transcribe', 'describe']);
  assert.match(def.function.description, /local/i);
});
