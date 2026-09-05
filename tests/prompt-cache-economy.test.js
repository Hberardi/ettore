import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  applyRollingCacheBreakpoint,
  anthropicOutputCap,
  normalizeMessagesForAnthropic,
} from '../src/llm/client.js';
import { getModelPricing, calcCost } from '../src/utils/pricing.js';
import { attachVerboseTokenLogger } from '../src/cli/index.js';
import { connectionManager } from '../src/providers/index.js';
import { selectToolDefinitions } from '../src/agents/tool-router.js';
import { toolDefinitions, setAutoApprove } from '../src/tools/index.js';
import { Agent } from '../src/agents/index.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Rolling transcript cache breakpoint ──────────────────────────────────────

test('applyRollingCacheBreakpoint tags the end of the transcript', () => {
  const messages = normalizeMessagesForAnthropic([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    { role: 'user', content: 'second' },
  ]);

  const used = applyRollingCacheBreakpoint(messages, 2);
  assert.equal(used, 1);
  const last = messages[messages.length - 1];
  assert.deepEqual(last.content[last.content.length - 1].cache_control, { type: 'ephemeral' });
  // Nothing else is tagged: one rolling breakpoint, not one per message.
  const tagged = messages.flatMap(m => m.content).filter(b => b.cache_control);
  assert.equal(tagged.length, 1);
});

test('applyRollingCacheBreakpoint respects the remaining budget', () => {
  // The compressor already spent the budget on its summary.
  const messages = normalizeMessagesForAnthropic([
    { role: 'user', content: 'summary', _cacheControl: { type: 'ephemeral' } },
    { role: 'user', content: 'question' },
  ]);
  const used = applyRollingCacheBreakpoint(messages, 1);
  assert.equal(used, 1);
  assert.equal(messages[1].content[0].cache_control, undefined);
});

test('applyRollingCacheBreakpoint is a no-op on an empty transcript', () => {
  assert.equal(applyRollingCacheBreakpoint([], 4), 0);
});

// ── Legacy output cap ────────────────────────────────────────────────────────

test('anthropicOutputCap clamps Claude 3 models to their 4096 ceiling', () => {
  assert.equal(anthropicOutputCap('claude-3-opus-20240229'), 4096);
  assert.equal(anthropicOutputCap('claude-3-haiku-20240307', 8192), 4096);
  // A user-set ceiling below the legacy cap is left alone.
  assert.equal(anthropicOutputCap('claude-3-opus-20240229', 1000), 1000);
});

test('anthropicOutputCap leaves current models untouched', () => {
  assert.equal(anthropicOutputCap('claude-opus-5', 8192), 8192);
  assert.equal(anthropicOutputCap('claude-3-5-sonnet-20241022', 8192), 8192);
});

// ── Pricing lookup ───────────────────────────────────────────────────────────

test('getModelPricing prefers the longest matching key', () => {
  // Would otherwise fall onto the `claude-opus-4` row at 3x the real rate.
  assert.deepEqual(getModelPricing('claude-opus-4-8'), { in: 5, out: 25, ctx: 1000000 });
  assert.deepEqual(getModelPricing('claude-opus-5'), { in: 5, out: 25, ctx: 1000000 });
  assert.equal(getModelPricing('claude-opus-4-20250514').in, 15);
  assert.equal(getModelPricing('gpt-4o-2024-11-20').in, 2.5);
});

test('calcCost bills cache writes at 1.25x and cache reads at 0.1x', () => {
  const cost = calcCost(1000, 0, 'claude-opus-5', 1000, 1000);
  // (1000 + 1250 + 100) / 1e6 * $5
  assert.equal(Math.round(cost * 1e6), Math.round((1000 + 1250 + 100) / 1e6 * 5 * 1e6));
});

test('calcCost without cache arguments matches the pre-cache behaviour', () => {
  assert.equal(calcCost(1000, 500, 'claude-opus-5'), (1000 / 1e6) * 5 + (500 / 1e6) * 25);
});

// ── Usage reporting ──────────────────────────────────────────────────────────

test('verbose token logger counts cached input instead of reporting six tokens', () => {
  const prevProvider = connectionManager.activeProvider;
  const prevModel = connectionManager.activeModel;
  connectionManager.activeProvider = 'anthropic';
  connectionManager.activeModel = 'claude-opus-5';
  const originalWrite = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    const em = new EventEmitter();
    const stats = attachVerboseTokenLogger(em);
    // Shape measured off a warm claude-code turn: the request carried 7233
    // prompt tokens, of which input_tokens reported 6.
    em.emit('usage', { inputTokens: 6, outputTokens: 6, cacheCreate: 0, cacheRead: 7227 });
    assert.equal(stats.inputTotal(), 7233);
    assert.equal(stats.cachedTotal(), 7227);
    assert.match(chunks.join(''), /in=7233 \(cache w=0 r=7227\)/);
  } finally {
    process.stderr.write = originalWrite;
    connectionManager.activeProvider = prevProvider;
    connectionManager.activeModel = prevModel;
  }
});

// ── Tool route stability ─────────────────────────────────────────────────────

test('the routed tool list stays byte-identical across an edit turn', async () => {
  // The tool list is the head of the provider's prompt-cache prefix: if it
  // moves between iterations the cached system prompt goes with it. Drive a
  // real edit turn (write, then a follow-up) and assert the model saw exactly
  // the same schemas every time.
  const dir = await mkdtemp(join(tmpdir(), 'ettore-cache-'));
  const target = join(dir, 'note.txt');
  const writeCall = {
    id: 'call_w',
    type: 'function',
    function: { name: 'write', arguments: JSON.stringify({ file_path: target, content: 'hello' }) },
  };
  const readCall = {
    id: 'call_r',
    type: 'function',
    function: { name: 'read', arguments: JSON.stringify({ file_path: target }) },
  };

  const seen = [];
  let turn = 0;
  const client = {
    async turn(_messages, tools) {
      turn++;
      seen.push(JSON.stringify(tools));
      if (turn === 1) {
        return { type: 'tool_calls', tool_calls: [writeCall], message: { role: 'assistant', content: '', tool_calls: [writeCall] } };
      }
      if (turn === 2) {
        return { type: 'tool_calls', tool_calls: [readCall], message: { role: 'assistant', content: '', tool_calls: [readCall] } };
      }
      return { type: 'text', content: 'done' };
    },
  };

  const agent = new Agent(client, {
    provider: 'anthropic',
    model: 'claude-opus-5',
    modelCapability: 'full',
    workdir: dir,
    contextWindow: 200000,
    verifyAfterEdit: false,
    autoApproveEdits: true,
  });
  setAutoApprove({ edits: true, installs: false });
  await agent.run('modifica il file note.txt', new EventEmitter());

  assert.ok(seen.length >= 3, `expected at least 3 iterations, got ${seen.length}`);
  for (let i = 1; i < seen.length; i++) {
    assert.equal(seen[i], seen[0], `tool list changed at iteration ${i + 1} — cache prefix lost`);
  }
});

test('an anticipated edit route is a superset of the narrow one', () => {
  const shared = { mode: 'build', prompt: 'modifica il file x', maxTools: 16 };
  const narrow = selectToolDefinitions(toolDefinitions, shared);
  const wide = new Set(
    selectToolDefinitions(toolDefinitions, {
      ...shared, mutationToolUsed: true, touchedFiles: 1, verificationNeeded: true,
    }).map(t => t.function.name),
  );
  for (const name of narrow.map(t => t.function.name)) assert.ok(wide.has(name), `lost ${name}`);
  assert.ok(wide.has('run_checks') && wide.has('run_tests'));
});
