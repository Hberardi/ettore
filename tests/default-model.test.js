import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDefaultModel } from '../src/providers/default-model.js';
import { ConnectionManager } from '../src/providers/index.js';

test('the first id in the alphabet is not the default when it is a preview', () => {
  // The catalog a Google key returns, as it came back: this used to start a
  // new user on the first entry, which answered "400 status code (no body)".
  const google = [
    'models/antigravity-preview-05-2026', 'models/aqa', 'models/embedding-001',
    'models/gemini-1.5-flash', 'models/gemini-2.0-flash', 'models/gemini-2.0-flash-lite',
    'models/gemini-2.5-flash-image', 'models/gemini-2.5-flash-preview-tts',
    'models/gemini-2.5-pro-preview-06-05', 'models/imagen-4.0-generate-001',
    'models/veo-3.0-generate-001', 'models/gemini-live-2.5-flash-preview', 'models/text-embedding-004',
  ];
  assert.equal(pickDefaultModel(google), 'models/gemini-2.0-flash');
});

test('models that cannot hold a conversation are never the default', () => {
  const openai = [
    'babbage-002', 'dall-e-3', 'gpt-4o', 'gpt-4o-audio-preview', 'gpt-4o-mini',
    'gpt-4o-realtime-preview', 'omni-moderation-latest', 'text-embedding-3-large', 'tts-1', 'whisper-1',
  ];
  assert.equal(pickDefaultModel(openai), 'gpt-4o');
  assert.equal(pickDefaultModel(['whisper-large-v3', 'llama-guard-4-12b', 'llama-3.3-70b-versatile']), 'llama-3.3-70b-versatile');
});

test('a larger local model wins over a tiny one', () => {
  assert.equal(pickDefaultModel(['qwen2.5:0.5b-instruct', 'nomic-embed-text:latest', 'qwen2.5-coder:32b']), 'qwen2.5-coder:32b');
});

test('between equals, the newer version wins', () => {
  assert.equal(pickDefaultModel(['acme-chat-1.5', 'acme-chat-3', 'acme-chat-2.5']), 'acme-chat-3');
});

test("a provider's own list decides when it has one", () => {
  const offered = ['a-model', 'claude-haiku-4-5', 'claude-sonnet-5-5'];
  assert.equal(pickDefaultModel(offered, { curated: ['claude-opus-9', 'claude-sonnet-5-5', 'claude-haiku-4-5'] }), 'claude-sonnet-5-5');
  assert.equal(pickDefaultModel(offered, { curated: [{ id: 'claude-haiku-4-5' }] }), 'claude-haiku-4-5');
});

test('one model is the default, none is null, and objects work like ids', () => {
  assert.equal(pickDefaultModel(['only-model']), 'only-model');
  assert.equal(pickDefaultModel([]), null);
  assert.equal(pickDefaultModel([{ id: 'text-embedding-3-small' }, { id: 'gpt-4o' }]), 'gpt-4o');
});

test('a provider made active without a model starts on the picked default', () => {
  const manager = new ConnectionManager();
  manager.connections.set('google', {
    provider: {}, key: null, valid: true,
    models: ['models/antigravity-preview-05-2026', 'models/embedding-001', 'models/gemini-2.0-flash'],
  });
  assert.equal(manager.defaultModelFor('google'), 'models/gemini-2.0-flash');
});
