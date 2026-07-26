import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agents/index.js';
import { ContextCompressor, estimateTokens } from '../src/agents/compressor.js';
import { normalizeMessagesForAnthropic } from '../src/llm/client.js';

// ── Intervento A: tool output truncation tightened ─────────────────────────
test('_summarizeToolOutputForContext truncates well below the old 14k cap', () => {
  const client = { turn: async () => ({ type: 'text', content: '' }) };
  const agent = new Agent(client, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  });
  const huge = 'a'.repeat(20_000);
  const out = agent._summarizeToolOutputForContext('bash', { command: 'ls' }, huge);
  // Old threshold was 14_000 — anything over 6000 now gets summarized.
  assert.ok(out.length < huge.length, 'output must be shortened');
  assert.ok(out.length < 6500, 'output must stay under the new ~6k cap');
  assert.match(out, /\[TOOL OUTPUT SUMMARY\]/);
  assert.match(out, /\[BEGIN FIRST CHUNK\]/);
  assert.match(out, /\[BEGIN LAST CHUNK\]/);
  // Sanity: original bytes are NOT all present (otherwise no elision happened).
  assert.ok(!out.includes('a'.repeat(10_000)));
});

test('_summarizeToolOutputForContext preserves read-file head/tail shape', () => {
  const client = { turn: async () => ({ type: 'text', content: '' }) };
  const agent = new Agent(client, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  });
  const lines = Array.from({ length: 1500 }, (_, i) => `line ${i} payload ${'x'.repeat(20)}`).join('\n');
  const out = agent._summarizeToolOutputForContext('read', { file_path: 'a.js' }, lines);
  assert.match(out, /\[BEGIN FIRST 60 LINES\]/);
  assert.match(out, /\[BEGIN LAST 30 LINES\]/);
  assert.match(out, /file: a\.js/);
});

test('_summarizeToolOutputForContext returns short output verbatim', () => {
  const client = { turn: async () => ({ type: 'text', content: '' }) };
  const agent = new Agent(client, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  });
  const short = 'small payload';
  assert.equal(agent._summarizeToolOutputForContext('bash', {}, short), short);
});

// ── Intervento B: auto-compact threshold proportional to context window ─────
test('auto-compact threshold scales with context window at ~30%', () => {
  // 128k context → threshold should be ~38k, not the old ~89k
  const c = new ContextCompressor(null, { contextWindow: 128000 });
  assert.ok(c.threshold < 40_000, `expected threshold < 40k, got ${c.threshold}`);
  assert.ok(c.threshold >= 4000, `expected floor of 4000, got ${c.threshold}`);
});

test('per-session compression cap raised from 5 to 8', () => {
  const c = new ContextCompressor(null, {});
  c._sessionCount = 7;
  // 7 compressions should still trigger (cap is 8 now)
  const messages = [
    { role: 'system', content: 'sys' },
    ...Array.from({ length: 20 }, () => ({ role: 'user', content: 'x'.repeat(5000) })),
  ];
  // Bump threshold so messages exceed it (default is 8k, 20 × 5000 ≈ 25k chars → ~6k tokens, below threshold).
  c.threshold = 4000;
  assert.equal(c.needsCompression(messages), true);
  c._sessionCount = 8;
  assert.equal(c.needsCompression(messages), false);
});

// ── Intervento C: Anthropic cache_control on compressed summary ─────────────
test('compressor stamps _cacheControl on the summary message', async () => {
  const fakeClient = {
    turn: async (_msgs, _tools, onTok) => {
      onTok?.('summary text');
      return { type: 'text', content: 'summary text' };
    },
  };
  const c = new ContextCompressor(fakeClient, {});
  c.keepLast = 2;
  const out = await c.compress(
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old user prompt 1' },
      { role: 'assistant', content: 'old assistant 1' },
      { role: 'user', content: 'old user prompt 2' },
      { role: 'assistant', content: 'old assistant 2' },
      { role: 'user', content: 'recent' },
    ],
    null,
  );
  const summary = out.find(m => m._cacheControl);
  assert.ok(summary, 'summary message must carry _cacheControl');
  assert.deepEqual(summary._cacheControl, { type: 'ephemeral' });
});

test('Anthropic normalizer tags the summary text block with cache_control', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: '[COMPRESSED CONTEXT — previous conversation]\nstuff\n[END COMPRESSED CONTEXT]',
      _cacheControl: { type: 'ephemeral' },
    },
    { role: 'assistant', content: 'ack' },
    { role: 'user', content: 'continue' },
  ];
  const norm = normalizeMessagesForAnthropic(messages);
  const summaryUser = norm.find(m => Array.isArray(m.content) && m.content.some(b => b.text?.includes('COMPRESSED CONTEXT')));
  assert.ok(summaryUser, 'compressed-context user message must survive normalization');
  const summaryBlock = summaryUser.content.find(b => b.text?.includes('COMPRESSED CONTEXT'));
  assert.deepEqual(summaryBlock.cache_control, { type: 'ephemeral' });
});

test('Anthropic normalizer does NOT tag messages without _cacheControl', () => {
  const messages = [
    { role: 'user', content: 'plain prompt' },
  ];
  const norm = normalizeMessagesForAnthropic(messages);
  const textBlock = norm[0].content[0];
  assert.equal(textBlock.cache_control, undefined);
});

// ── Intervento D: zero-cost lossy shrink on old tool results ───────────────
test('lossyShrink elides old tool results without LLM calls', () => {
  const c = new ContextCompressor(null, {});
  c.threshold = 8000;
  const messages = [
    { role: 'system', content: 'sys' },
    // 5 old tool messages with huge content → ~25k chars ≈ 6.25k tokens, above half-threshold (4000)
    { role: 'tool', tool_call_id: 't1', content: 'A'.repeat(5000) },
    { role: 'assistant', content: 'ack 1' },
    { role: 'tool', tool_call_id: 't2', content: 'B'.repeat(5000) },
    { role: 'assistant', content: 'ack 2' },
    { role: 'tool', tool_call_id: 't3', content: 'C'.repeat(5000) },
    { role: 'assistant', content: 'ack 3' },
    { role: 'tool', tool_call_id: 't4', content: 'D'.repeat(5000) },
    { role: 'assistant', content: 'ack 4' },
    // recent messages
    { role: 'tool', tool_call_id: 't5', content: 'E'.repeat(5000) },
    { role: 'assistant', content: 'ack 5' },
  ];
  const before = estimateTokens(messages);
  const after = c.lossyShrink(messages, { keepLast: 2 });
  const afterTokens = estimateTokens(after);

  assert.ok(afterTokens < before, `expected token reduction, got ${before} → ${afterTokens}`);
  // The two recent tool/assistant messages must be untouched.
  const tailTool = after[after.length - 2];
  assert.equal(tailTool.content, 'E'.repeat(5000));
  // The old tool messages must be elided with the marker.
  const oldTool = after[1];
  assert.match(oldTool.content, /\[elided — original 5000 chars\]/);
  assert.equal(oldTool.__lossyShrunk, true);
});

test('lossyShrink is a no-op when context is below half threshold', () => {
  const c = new ContextCompressor(null, {});
  c.threshold = 100_000; // huge threshold so half > current
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'tool', tool_call_id: 't1', content: 'x'.repeat(5000) },
    { role: 'assistant', content: 'a' },
  ];
  assert.equal(c.lossyShrink(messages), messages, 'must return the same array reference');
});

test('lossyShrink leaves recent tool results untouched', () => {
  const c = new ContextCompressor(null, {});
  c.threshold = 4000;
  const big = 'Z'.repeat(2000);
  const messages = [
    { role: 'system', content: 'sys' },
    // many old tool messages to push past half threshold
    ...Array.from({ length: 15 }, (_, i) => ({
      role: 'tool', tool_call_id: `old_${i}`, content: 'Q'.repeat(2000),
    })),
    { role: 'assistant', content: 'mid' },
    // 3 most-recent (within keepLast) must be untouched
    { role: 'tool', tool_call_id: 'recent1', content: big },
    { role: 'assistant', content: 'a' },
    { role: 'tool', tool_call_id: 'recent2', content: big },
  ];
  const after = c.lossyShrink(messages, { keepLast: 4 });
  const recent = after.filter(m => ['recent1', 'recent2'].includes(m.tool_call_id));
  assert.equal(recent.length, 2);
  assert.ok(recent.every(m => m.content === big), 'recent tool bodies must stay intact');
});
