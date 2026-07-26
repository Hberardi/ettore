import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachVerboseTokenLogger } from '../src/cli/index.js';
import { connectionManager } from '../src/providers/index.js';

// Capture every stderr.write call without polluting the real stream.
function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  let result;
  try { result = fn(chunks); } finally { process.stderr.write = original; }
  return result ?? chunks;
}

function withActiveProvider(provider, model, fn) {
  const prevProvider = connectionManager.activeProvider;
  const prevModel = connectionManager.activeModel;
  connectionManager.activeProvider = provider;
  connectionManager.activeModel = model;
  try { return fn(); } finally {
    connectionManager.activeProvider = prevProvider;
    connectionManager.activeModel = prevModel;
  }
}

test('attachVerboseTokenLogger prints per-turn and cumulative tokens on stderr', () => {
  withActiveProvider('openai', 'gpt-4o', () => {
    const em = new EventEmitter();
    const lines = captureStderr(() => {
      attachVerboseTokenLogger(em);
      em.emit('usage', { inputTokens: 1200, outputTokens: 300 });
      em.emit('usage', { inputTokens: 800,  outputTokens: 150 });
    });
    const out = lines.join('');
    assert.match(out, /📊 turn 1: in=1200 out=300/);
    assert.match(out, /session in=1200 out=300/);
    assert.match(out, /📊 turn 2: in=800 out=150/);
    assert.match(out, /session in=2000 out=450/);
    // Sanity: cost line format with $ prefix.
    assert.match(out, /cost=\$\d+\.\d{4}/);
  });
});

test('attachVerboseTokenLogger labels non-metered providers with n/a', () => {
  withActiveProvider('ollama', 'llama3', () => {
    const em = new EventEmitter();
    const lines = captureStderr(() => {
      attachVerboseTokenLogger(em);
      em.emit('usage', { inputTokens: 500, outputTokens: 100 });
    });
    const out = lines.join('');
    assert.match(out, /this turn: n\/a/);
  });
});

test('attachVerboseTokenLogger handles zero/NaN tokens gracefully', () => {
  withActiveProvider('openai', 'gpt-4o', () => {
    const em = new EventEmitter();
    const lines = captureStderr(() => {
      attachVerboseTokenLogger(em);
      em.emit('usage', {}); // missing fields
      em.emit('usage', { inputTokens: 'not-a-number', outputTokens: null });
    });
    const out = lines.join('');
    assert.match(out, /in=0 out=0/);
    assert.match(out, /turn 2: in=0 out=0/);
  });
});

test('cli exposes --verbose-tokens flag in bin/cli.js', async () => {
  const { Command } = await import('commander');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '..', 'bin', 'cli.js'), 'utf-8');
  assert.match(src, /--verbose-tokens/);
  assert.match(src, /verboseTokens:\s*options\.verboseTokens === true/);
  // Sanity: the flag is wired to the option name consumed by runPrompt.
  const program = new Command();
  program.option('--verbose-tokens', 'trace');
  program.parse(['node', 'cli', '--verbose-tokens'], { from: 'node' });
  assert.equal(program.opts().verboseTokens, true);
});
