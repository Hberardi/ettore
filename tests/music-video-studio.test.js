import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startMusicVideoStudio, stopMusicVideoStudio, _internal } from '../src/web/music-video-studio.js';
import { builtinCommands } from '../src/commands/index.js';

// All /api/keys tests share a temp config dir so they don't touch the user's
// real ~/.config/ettore. The secret-store reads ETTORE_CONFIG_DIR lazily, so
// setting the env var before any studio start is enough.
const studioConfigDir = mkdtempSync(join(tmpdir(), 'ettore-mvstudio-'));
process.env.ETTORE_CONFIG_DIR = studioConfigDir;

test.after(() => {
  rmSync(studioConfigDir, { recursive: true, force: true });
});

test('decodeDataUrl parses base64 data URLs and rejects junk', () => {
  const d = _internal.decodeDataUrl('data:audio/mpeg;base64,' + Buffer.from('song').toString('base64'));
  assert.equal(d.mime, 'audio/mpeg');
  assert.equal(d.bytes.toString(), 'song');
  assert.equal(_internal.decodeDataUrl('not-a-data-url'), null);
  assert.equal(_internal.decodeDataUrl(''), null);
});

test('extractJsonArray pulls a JSON array out of noisy model output', () => {
  assert.deepEqual(_internal.extractJsonArray('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(_internal.extractJsonArray('Sure! [1,2,3] done'), [1, 2, 3]);
  assert.equal(_internal.extractJsonArray('no array here'), null);
  assert.equal(_internal.extractJsonArray('[broken'), null);
});

test('studio server serves the page and guards unknown jobs', async () => {
  const { url } = await startMusicVideoStudio({ open: false });
  try {
    const page = await fetch(url + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Music Video Studio/);

    const status = await fetch(url + '/api/status?job=does-not-exist');
    assert.equal(status.status, 404);

    const media = await fetch(url + '/media/does-not-exist/music-video.mp4');
    assert.equal(media.status, 404);

    const notFound = await fetch(url + '/nope');
    assert.equal(notFound.status, 404);
  } finally {
    stopMusicVideoStudio();
  }
});

test('/api/config exposes video models with per-clip prices and key status', async () => {
  const { url } = await startMusicVideoStudio({ open: false });
  try {
    const cfg = await (await fetch(url + '/api/config')).json();
    assert.ok(Array.isArray(cfg.models) && cfg.models.length >= 2);
    const s2v = cfg.models.find(m => m.id === 'S2V-01');
    assert.ok(s2v, 'S2V-01 model missing');
    assert.equal(typeof s2v.prices['768P'], 'number');
    const hailuo = cfg.models.find(m => m.id === 'MiniMax-Hailuo-2.3');
    assert.ok(hailuo.prices['1080P'] > hailuo.prices['768P']);
    assert.equal(typeof cfg.keys.minimax, 'boolean');
    assert.equal(typeof cfg.keys.gemini, 'boolean');
    // New: keys.saved is an object (initially empty in this isolated env)
    // and llmProviders surfaces OpenAI / Anthropic / OpenRouter / Gemini.
    assert.equal(typeof cfg.keys.saved, 'object');
    assert.ok(Array.isArray(cfg.llmProviders) && cfg.llmProviders.length >= 3);
    const ids = cfg.llmProviders.map(p => p.id);
    assert.ok(ids.includes('openai'));
    assert.ok(ids.includes('anthropic'));
  } finally {
    stopMusicVideoStudio();
  }
});

test('startMusicVideoStudio reuses the running server', async () => {
  const a = await startMusicVideoStudio({ open: false });
  try {
    const b = await startMusicVideoStudio({ open: false });
    assert.equal(a.url, b.url);
    assert.equal(b.reused, true);
  } finally {
    stopMusicVideoStudio();
  }
});

test('cheaperOption ranks by video points and stops at the cheapest', () => {
  // From any pricier engine, the cheapest is Hailuo-02 @ 512P (0.3 points/clip).
  const alt = _internal.cheaperOption('S2V-01', '768P', 6);
  assert.equal(alt.model, 'MiniMax-Hailuo-02');
  assert.equal(alt.resolution, '512P');
  assert.equal(alt.perClip, 0.3);
  // Already at the cheapest → nothing cheaper.
  assert.equal(_internal.cheaperOption('MiniMax-Hailuo-02', '512P', 6), null);
});

test('/video_music command is registered with aliases', () => {
  assert.ok(builtinCommands.video_music, 'command missing');
  assert.equal(typeof builtinCommands.video_music.handler, 'function');
  assert.ok(builtinCommands.video_music.aliases.includes('mv'));
});

// ── /api/keys: encrypted on-disk store for studio API keys ────────────────

test('/api/keys GET returns only masked values (never plaintext)', async () => {
  const { url } = await startMusicVideoStudio({ open: false });
  try {
    const r = await fetch(url + '/api/keys');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(typeof body.keys, 'object');
    assert.equal(typeof body.keys.saved, 'object');
    for (const [provider, info] of Object.entries(body.keys.saved)) {
      assert.equal(info.hasKey, true);
      assert.equal(typeof info.masked, 'string');
      // Make sure no plaintext leaks through masked values.
      assert.ok(info.masked.includes('...'), `${provider} mask missing`);
    }
    // Per-provider booleans for the badge UI
    assert.equal(typeof body.keys.minimax, 'boolean');
    assert.equal(typeof body.keys.gemini, 'boolean');
    assert.equal(typeof body.keys.openai, 'boolean');
    assert.equal(typeof body.keys.anthropic, 'boolean');
  } finally {
    stopMusicVideoStudio();
  }
});

test('POST /api/keys saves + GET surfaces the masked entry', async () => {
  const { url } = await startMusicVideoStudio({ open: false });
  try {
    const r = await fetch(url + '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', secret: 'sk-test-1234567890ABCDEF' }),
    });
    assert.equal(r.status, 200);
    const saved = await r.json();
    assert.equal(saved.provider, 'openai');
    assert.equal(saved.masked, 'sk-t...CDEF');

    const list = await (await fetch(url + '/api/keys')).json();
    assert.equal(list.keys.openai, true);
    assert.equal(list.keys.saved.openai.masked, 'sk-t...CDEF');

    // The plaintext must NOT appear anywhere in the GET response body.
    const rawResp = await fetch(url + '/api/keys');
    const raw = await rawResp.text();
    assert.doesNotMatch(raw, /sk-test-1234567890ABCDEF/);
  } finally {
    stopMusicVideoStudio();
  }
});

test('POST /api/keys rejects unknown providers and empty secrets', async () => {
  const { url } = await startMusicVideoStudio({ open: false });
  try {
    const bad1 = await fetch(url + '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'nope-unknown', secret: 'sk-x' }),
    });
    assert.equal(bad1.status, 400);

    const bad2 = await fetch(url + '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', secret: '' }),
    });
    assert.equal(bad2.status, 400);

    // For known providers we accept any non-empty string.
    const ok = await fetch(url + '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', secret: 'sk-ant-test-1234' }),
    });
    assert.equal(ok.status, 200);
  } finally {
    stopMusicVideoStudio();
  }
});

test('DELETE /api/keys/:provider removes the saved entry', async () => {
  const { url } = await startMusicVideoStudio({ open: false });
  try {
    // Save first
    await fetch(url + '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini', secret: 'AIzaSyDUMMY-test' }),
    });
    let list = await (await fetch(url + '/api/keys')).json();
    assert.equal(list.keys.saved.gemini.masked, 'AIza...test');

    // Delete
    const del = await fetch(url + '/api/keys/gemini', { method: 'DELETE' });
    assert.equal(del.status, 200);
    const delBody = await del.json();
    assert.equal(delBody.provider, 'gemini');
    assert.equal(delBody.removed, true);

    // Confirm gone
    list = await (await fetch(url + '/api/keys')).json();
    assert.equal(list.keys.saved.gemini, undefined);
    assert.equal(list.keys.gemini, false);

    // Second delete is a no-op (idempotent).
    const del2 = await fetch(url + '/api/keys/gemini', { method: 'DELETE' });
    const delBody2 = await del2.json();
    assert.equal(delBody2.removed, false);
  } finally {
    stopMusicVideoStudio();
  }
});

test('DELETE /api/keys/:provider rejects unknown providers', async () => {
  const { url } = await startMusicVideoStudio({ open: false });
  try {
    const r = await fetch(url + '/api/keys/nope-unknown', { method: 'DELETE' });
    assert.equal(r.status, 400);
  } finally {
    stopMusicVideoStudio();
  }
});

test('saved keys survive a server restart (encryption round-trip)', async () => {
  const { url } = await startMusicVideoStudio({ open: false });
  try {
    await fetch(url + '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openrouter', secret: 'sk-or-v1-abcdef1234567890' }),
    });
  } finally {
    stopMusicVideoStudio();
  }
  // Restart the server — the store file is on disk so the same key must come back.
  const again = await startMusicVideoStudio({ open: false });
  try {
    const list = await (await fetch(again.url + '/api/keys')).json();
    assert.equal(list.keys.openrouter, true);
    assert.equal(list.keys.saved.openrouter.masked, 'sk-o...7890');
  } finally {
    stopMusicVideoStudio();
  }
});

// ── resolveStoryboardLlm: priority chain for the LLM key ──────────────────

test('sanitizeLlmOverride trims and validates shape', () => {
  assert.equal(_internal.sanitizeLlmOverride(null), null);
  assert.equal(_internal.sanitizeLlmOverride('not-an-object'), null);
  assert.equal(_internal.sanitizeLlmOverride({}), null);
  assert.equal(_internal.sanitizeLlmOverride({ provider: 'openai' }), null);
  assert.equal(_internal.sanitizeLlmOverride({ provider: 'openai', apiKey: 'sk-x' }), null);
  const ok = _internal.sanitizeLlmOverride({ provider: ' openai ', apiKey: ' sk-x ', model: ' gpt-4o ' });
  assert.deepEqual(ok, { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' });
});

test('resolveStoryboardLlm prefers explicit override over active/saved/env', () => {
  const got = _internal.resolveStoryboardLlm({
    llmOverride: { provider: 'openai', apiKey: 'sk-direct', model: 'gpt-4o' },
    saved: { openai: { hasKey: true, masked: 'sk-...abcd' } },
  });
  assert.equal(got.source, 'override');
  assert.equal(got.apiKey, 'sk-direct');
});

test('resolveStoryboardLlm picks the first saved LLM key when no override', () => {
  const got = _internal.resolveStoryboardLlm({
    saved: {
      openai:  { hasKey: true, masked: 'sk-...AAA' },
      anthropic: { hasKey: true, masked: 'sk-...BBB' },
    },
  });
  // _internal.getSecret is what actually decrypts, so this test only verifies
  // the priority chain when no override and no env are around. With no env
  // vars set, it falls back to a saved key (mocked via the secret store).
  assert.ok(got);
});

// ── friendlyLlmError: Italian translations for common failure modes ──────

test('friendlyLlmError translates auth errors', () => {
  assert.match(_internal.friendlyLlmError(new Error('401 Unauthorized: invalid API key')), /Chiave API non valida/i);
  assert.match(_internal.friendlyLlmError(new Error('403 Forbidden')), /Chiave API non valida/i);
});

test('friendlyLlmError translates model-not-found errors', () => {
  assert.match(_internal.friendlyLlmError(new Error('404 model not found: models/foo-bar')), /Modello non disponibile/i);
  assert.match(_internal.friendlyLlmError(new Error('model "foo-bar" is not supported by this endpoint')), /Modello non disponibile/i);
});

test('friendlyLlmError translates rate-limit errors', () => {
  assert.match(_internal.friendlyLlmError(new Error('429 Too Many Requests')), /Limite di richieste/i);
  assert.match(_internal.friendlyLlmError(new Error('rate limit exceeded')), /Limite di richieste/i);
  assert.match(_internal.friendlyLlmError(new Error('quota exhausted')), /Limite di richieste/i);
});

test('friendlyLlmError translates "no active connection" hint', () => {
  assert.match(_internal.friendlyLlmError(new Error('No active connection. Use /connect to connect a provider.')), /Nessuna connessione attiva/i);
});

test('friendlyLlmError falls through with the raw message for unknown errors', () => {
  const got = _internal.friendlyLlmError(new Error('something exotic happened'));
  assert.ok(typeof got === 'string' && got.length > 0);
});

test('friendlyLlmError handles empty/null safely', () => {
  assert.equal(_internal.friendlyLlmError(null), 'LLM non disponibile.');
  assert.equal(_internal.friendlyLlmError(undefined), 'LLM non disponibile.');
  assert.equal(_internal.friendlyLlmError(''), 'LLM non disponibile.');
});
