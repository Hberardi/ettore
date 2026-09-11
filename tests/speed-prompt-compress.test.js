import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSystemPrompt, pruneToolGuidance } from '../src/agents/prompts.js';
import { selectToolDefinitions, selectedToolNames } from '../src/agents/tool-router.js';
import { toolDefinitions } from '../src/tools/index.js';
import { compressionModelFor } from '../src/llm/client.js';
import { ContextCompressor, estimateTokens } from '../src/agents/compressor.js';

// ── System prompt: tool rules only for routed tools ──────────────────────────

const FULL = renderSystemPrompt('build', '/work');

test('rules for tools that were not routed are dropped', () => {
  const out = pruneToolGuidance(FULL, ['read', 'write', 'edit', 'grep']);
  assert.doesNotMatch(out, /RUN THE APP TO FIND THE BUG \(desktop\)/);
  assert.doesNotMatch(out, /RUN THE APP TO FIND THE BUG \(web\)/);
  assert.doesNotMatch(out, /MUSIC VIDEO GENERATION/);
  // Continuation lines of a dropped bullet go with it.
  assert.doesNotMatch(out, /Understand the song with/);
  assert.doesNotMatch(out, /Use websearch for/);
  assert.doesNotMatch(out, /Always stop what you started/);
  assert.ok(out.length < FULL.length * 0.75, `expected a real cut, got ${out.length}/${FULL.length}`);
});

test('the rules that always apply survive the cut', () => {
  const out = pruneToolGuidance(FULL, ['read']);
  for (const kept of ['## TOOL CALL PROTOCOL', 'Batch independent calls', 'When editing files, read them first',
    'The working directory is: /work', 'MEMORY RULES', 'TASK PROGRESS']) {
    assert.ok(out.includes(kept), `missing: ${kept}`);
  }
});

test('a routed tool keeps its rule', () => {
  const out = pruneToolGuidance(FULL, ['desktop_app']);
  assert.match(out, /RUN THE APP TO FIND THE BUG \(desktop\)/);
  assert.match(out, /Always stop what you started/);
  assert.doesNotMatch(out, /RUN THE APP TO FIND THE BUG \(web\)/);
  const music = pruneToolGuidance(FULL, ['generate_scene_clip']);
  assert.match(music, /MUSIC VIDEO GENERATION/);
  assert.match(music, /Assemble everything with/);
});

test('an unknown tool set leaves the prompt whole', () => {
  assert.equal(pruneToolGuidance(FULL, null), FULL);
  assert.equal(pruneToolGuidance(FULL, undefined), FULL);
});

test('project memory is never pruned, even when it reads like a rule', () => {
  const withMemory = `${FULL}\n\n---\n## PROJECT MEMORY\n- Use websearch for release notes\n---`;
  const out = pruneToolGuidance(withMemory, ['read']);
  assert.match(out, /## PROJECT MEMORY\n- Use websearch for release notes/);
});

test('plan mode has no tool rules to prune and is left as is', () => {
  const plan = renderSystemPrompt('plan', '/work');
  assert.equal(pruneToolGuidance(plan, ['read']), plan);
});

// ── Router: the music-video pipeline can actually be reached ─────────────────

function route(prompt, mode = 'build') {
  return selectedToolNames(selectToolDefinitions(toolDefinitions, { mode, prompt, maxTools: 16 }));
}

test('a music-video request is given the pipeline tools', () => {
  const names = route('crea un video musicale dalla canzone song.mp3 con la mia foto');
  for (const tool of ['audio_read', 'generate_scene_clip', 'assemble_music_video', 'lyrics_to_srt']) {
    assert.ok(names.includes(tool), `missing ${tool}: ${names.join(', ')}`);
  }
});

test('the paid pipeline stays out of plan mode and out of unrelated turns', () => {
  assert.equal(route('crea un video musicale dalla canzone song.mp3', 'plan').includes('generate_scene_clip'), false);
  assert.equal(route('correggi il bug nel parser').includes('generate_scene_clip'), false);
});

// ── Which model writes summaries ────────────────────────────────────────────

test('summaries default to a fast model of the same provider', () => {
  assert.equal(compressionModelFor({ provider: 'anthropic', model: 'claude-opus-5' }), 'claude-haiku-4-5');
  assert.equal(compressionModelFor({ provider: 'claude-code', model: 'opus' }), 'haiku');
  assert.equal(compressionModelFor({ provider: 'deepseek', model: 'deepseek-reasoner' }), 'deepseek-chat');
});

test('no fast model where it would mean another vendor or is unknown', () => {
  assert.equal(compressionModelFor({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' }), null);
  assert.equal(compressionModelFor({ provider: 'minimax', model: 'MiniMax-M2.7' }), null);
  assert.equal(compressionModelFor({ provider: 'test', model: 'x' }), null);
});

test('an explicit choice wins, "main" opts out, and the main model is never duplicated', () => {
  assert.equal(compressionModelFor({ provider: 'openrouter', model: 'a', compressionModel: 'google/gemini-2.5-flash' }), 'google/gemini-2.5-flash');
  assert.equal(compressionModelFor({ provider: 'anthropic', model: 'claude-opus-5', compressionModel: 'main' }), null);
  assert.equal(compressionModelFor({ provider: 'anthropic', model: 'claude-opus-5', compressionModel: 'default' }), 'claude-haiku-4-5');
  assert.equal(compressionModelFor({ provider: 'anthropic', model: 'claude-haiku-4-5' }), null);
});

// ── Compressor: fast client, fallback, background prefetch ───────────────────

function fakeClient(content, { fail = null } = {}) {
  return {
    calls: 0,
    async turn() {
      this.calls++;
      if (fail) throw fail;
      return { type: 'text', content };
    },
  };
}

function transcript(pairs) {
  const messages = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: 'user', content: `question ${i} ${'x'.repeat(400)}` });
    messages.push({ role: 'assistant', content: `answer ${i} ${'y'.repeat(400)}` });
  }
  return messages;
}

function compressor(main, fast) {
  const c = new ContextCompressor(main, { summaryClientFactory: () => fast });
  c._privacyWarned = true; // keep the test off the user's config store
  c.autoEnabled = true;    // independent of the user's own /compress auto
  return c;
}

test('the summary is written by the fast client, not the session model', async () => {
  const main = fakeClient('MAIN SUMMARY');
  const fast = fakeClient('FAST SUMMARY');
  const out = await compressor(main, fast).compress(transcript(20), null);
  assert.equal(fast.calls, 1);
  assert.equal(main.calls, 0);
  assert.match(String(out[1].content), /FAST SUMMARY/);
});

test('a fast model the provider refuses falls back to the main model, once', async () => {
  const main = fakeClient('MAIN SUMMARY');
  const fast = fakeClient('', { fail: Object.assign(new Error('404 model not found'), { status: 404 }) });
  const c = compressor(main, fast);
  const out = await c.compress(transcript(20), null);
  assert.match(String(out[1].content), /MAIN SUMMARY/);
  await c.compress(transcript(20), null);
  assert.equal(fast.calls, 1, 'a refused model is not asked again this session');
  assert.equal(main.calls, 2);
  assert.equal(c.getStats().summaryModel, 'main model');
});

test('a summary prefetched near the threshold is used when compression comes', async () => {
  const main = fakeClient('MAIN SUMMARY');
  const fast = fakeClient('PREFETCHED SUMMARY');
  const c = compressor(main, fast);
  const messages = transcript(20);
  c.threshold = Math.ceil(estimateTokens(messages) / 0.8);

  assert.equal(c.prefetch(messages), true);
  assert.equal(c.prefetch(messages), false, 'one job at a time');

  // The loop moves on: new messages arrive after the prefetch started.
  const later = [...messages, { role: 'user', content: 'new question' }, { role: 'assistant', content: 'new answer' }];
  const out = await c.compress(later, null);
  assert.equal(fast.calls, 1, 'no second summary call');
  assert.equal(main.calls, 0);
  assert.match(String(out[1].content), /PREFETCHED SUMMARY/);
  assert.equal(out[out.length - 1].content, 'new answer', 'messages after the prefetch are kept');
});

test('a prefetched summary is discarded when the history under it changed', async () => {
  const fast = fakeClient('SUMMARY');
  const c = compressor(fakeClient('MAIN'), fast);
  const messages = transcript(20);
  c.threshold = Math.ceil(estimateTokens(messages) / 0.8);
  c.prefetch(messages);
  const rewritten = [messages[0], { ...messages[1], content: 'rewritten' }, ...messages.slice(2)];
  await c.compress(rewritten, null);
  assert.equal(fast.calls, 2, 'the stale prefetch is not trusted, a fresh summary is made');
});

test('no prefetch while the transcript is well below the threshold', () => {
  const c = compressor(fakeClient('MAIN'), fakeClient('FAST'));
  const messages = transcript(20);
  c.threshold = estimateTokens(messages) * 4;
  assert.equal(c.prefetch(messages), false);
});

// ── Lossy shrink: batched when a prompt cache is in play ─────────────────────

// One old result already elided, one big result that has just left the tail.
function steadyLoop() {
  return [
    { role: 'system', content: 'sys' },
    { role: 'tool', tool_call_id: 't0', content: '[elided — original 9000 chars] x…', __lossyShrunk: true },
    { role: 'assistant', content: 'ack 0' },
    { role: 'tool', tool_call_id: 't1', content: 'E'.repeat(20000) },
    { role: 'assistant', content: 'ack 1' },
    { role: 'tool', tool_call_id: 't2', content: 'F'.repeat(5000) },
    { role: 'assistant', content: 'ack 2' },
  ];
}

test('with a cache observed, a single new result does not rewrite the cached prefix', () => {
  const c = new ContextCompressor(null, {});
  const messages = steadyLoop();
  c.threshold = Math.ceil(estimateTokens(messages) / 0.8);
  c.noteCacheActivity({ cacheRead: 1200 });
  assert.equal(c.lossyShrink(messages, { keepLast: 2 }), messages);
});

test('without an observed cache, elision stays eager', () => {
  const c = new ContextCompressor(null, {});
  const messages = steadyLoop();
  c.threshold = Math.ceil(estimateTokens(messages) / 0.8);
  c.noteCacheActivity({ cacheRead: 0, cacheCreate: 0 });
  const out = c.lossyShrink(messages, { keepLast: 2 });
  assert.notEqual(out, messages);
  assert.match(String(out[3].content), /\[elided — original 20000 chars\]/);
});

test('near the threshold the batch is not waited for', () => {
  const c = new ContextCompressor(null, {});
  const messages = steadyLoop();
  c.threshold = Math.ceil(estimateTokens(messages) / 0.95);
  c.noteCacheActivity({ cacheCreate: 5000 });
  assert.match(String(c.lossyShrink(messages, { keepLast: 2 })[3].content), /\[elided/);
});

test('a full batch is elided in one go', () => {
  const c = new ContextCompressor(null, {});
  const messages = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 4; i++) {
    messages.push({ role: 'tool', tool_call_id: `t${i}`, content: 'Q'.repeat(3000) });
    messages.push({ role: 'assistant', content: `ack ${i}` });
  }
  messages.push({ role: 'tool', tool_call_id: 'tail', content: 'T'.repeat(3000) });
  messages.push({ role: 'assistant', content: 'last' });
  c.threshold = Math.ceil(estimateTokens(messages) / 0.8);
  c.noteCacheActivity({ cacheRead: 1 });
  const out = c.lossyShrink(messages, { keepLast: 2 });
  assert.equal(out.filter(m => m.__lossyShrunk).length, 4);
  assert.equal(out[out.length - 2].content, 'T'.repeat(3000), 'the tail is untouched');
});
