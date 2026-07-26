import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ETTORE_CONFIG_DIR is read at call time (lazy), so the env var can be set
// before any function is invoked.
const dir = mkdtempSync(join(tmpdir(), 'ettore-secrets-'));
process.env.ETTORE_CONFIG_DIR = dir;

const { saveSecret, getSecret, deleteSecret, listSecrets, _internal } = await import('../src/utils/secret-store.js');

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('isValidProviderId accepts sane ids and rejects junk', () => {
  assert.equal(_internal.isValidProviderId('openai'), true);
  assert.equal(_internal.isValidProviderId('gemini'), true);
  assert.equal(_internal.isValidProviderId('minimax'), true);
  assert.equal(_internal.isValidProviderId('open-router'), true);
  assert.equal(_internal.isValidProviderId('a_b'), true);
  assert.equal(_internal.isValidProviderId(''), false);
  assert.equal(_internal.isValidProviderId('OpenAI'), false);
  assert.equal(_internal.isValidProviderId('1openai'), false);
  assert.equal(_internal.isValidProviderId('a/b'), false);
  assert.equal(_internal.isValidProviderId('a'.repeat(80)), false);
});

test('maskSecret keeps only first and last 4 chars', () => {
  assert.equal(_internal.maskSecret('sk-test-1234567890'), 'sk-t...7890');
  assert.equal(_internal.maskSecret('short'), '***');
  assert.equal(_internal.maskSecret(''), '');
  assert.equal(_internal.maskSecret(null), '');
});

test('round-trip: saveSecret + getSecret returns the original value', () => {
  const saved = saveSecret('openai', 'sk-test-secret-1234567890ABCDEF');
  assert.equal(saved.provider, 'openai');
  assert.equal(saved.masked, 'sk-t...CDEF');
  assert.equal(getSecret('openai'), 'sk-test-secret-1234567890ABCDEF');
});

test('multiple providers coexist independently', () => {
  saveSecret('anthropic', 'sk-ant-AAA-11111');
  saveSecret('gemini', 'AIzaSyDUMMY');
  assert.equal(getSecret('openai'), 'sk-test-secret-1234567890ABCDEF');
  assert.equal(getSecret('anthropic'), 'sk-ant-AAA-11111');
  assert.equal(getSecret('gemini'), 'AIzaSyDUMMY');
});

test('listSecrets returns all saved entries with masked values', () => {
  const list = listSecrets();
  assert.equal(list.openai.masked, 'sk-t...CDEF');
  assert.equal(list.anthropic.masked, 'sk-a...1111');
  // 'AIzaSyDUMMY' → first 4 = 'AIza', last 4 = 'UMMY'
  assert.equal(list.gemini.masked, 'AIza...UMMY');
  for (const v of Object.values(list)) {
    assert.equal(v.hasKey, true);
    assert.equal(typeof v.masked, 'string');
  }
});

test('on-disk file does NOT contain the plaintext secret', () => {
  const file = _internal.STORE_FILE();
  assert.ok(existsSync(file), 'store file should exist');
  const text = readFileSync(file, 'utf-8');
  assert.doesNotMatch(text, /sk-test-secret-1234567890ABCDEF/);
  assert.doesNotMatch(text, /sk-ant-AAA-11111/);
  assert.doesNotMatch(text, /AIzaSyDUMMY/);
  // IVs, ciphertexts, tags are hex — check the file shape.
  assert.match(text, /"salt":\s*"[0-9a-f]+"/);
  assert.match(text, /"iv":\s*"[0-9a-f]+"/);
  assert.match(text, /"ct":\s*"[0-9a-f]+"/);
  assert.match(text, /"tag":\s*"[0-9a-f]+"/);
});

test('store file is owner-only (0600)', () => {
  const file = _internal.STORE_FILE();
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('config dir is owner-only (0700)', () => {
  const d = _internal.CONFIG_DIR();
  const mode = statSync(d).mode & 0o777;
  assert.equal(mode, 0o700, `expected 0700, got ${mode.toString(8)}`);
});

test('deleteSecret removes the entry and is idempotent', () => {
  assert.equal(deleteSecret('openai'), true);
  assert.equal(getSecret('openai'), null);
  assert.equal(deleteSecret('openai'), false);
});

test('saveSecret rejects empty or invalid input', () => {
  assert.throws(() => saveSecret('openai', ''), /empty secret/);
  assert.throws(() => saveSecret('OpenAI', 'sk-x'), /invalid provider id/);
  assert.throws(() => saveSecret('a/b', 'sk-x'), /invalid provider id/);
  assert.throws(() => saveSecret('a'.repeat(80), 'sk-x'), /invalid provider id/);
});

test('saveSecret rejects non-string secrets', () => {
  assert.throws(() => saveSecret('gemini', null), /empty secret/);
  assert.throws(() => saveSecret('gemini', 12345), /empty secret/);
  assert.throws(() => saveSecret('gemini', '   '), /empty secret/);
});

test('getSecret returns null for unknown providers', () => {
  assert.equal(getSecret('does-not-exist'), null);
  assert.equal(getSecret(''), null);
});

test('AES-GCM integrity: tampering with ciphertext makes the entry unreadable', () => {
  saveSecret('tamper-test', 'sk-original-secret');
  const file = _internal.STORE_FILE();
  const text = readFileSync(file, 'utf-8');
  // Flip one hex digit inside the tamper-test entry's "ct" value (anchor on
  // the provider name so other entries aren't hit by the regex).
  const tampered = text.replace(
    /("tamper-test"[\s\S]*?"ct":\s*")[0-9a-f]{2}/,
    (m) => m.slice(0, -2) + (m.endsWith('00') ? 'ff' : '00'),
  );
  assert.notEqual(tampered, text, 'tampering regex did not match — file shape changed?');
  writeFileSync(file, tampered, 'utf-8');
  assert.equal(getSecret('tamper-test'), null, 'tampered entry should be unreadable');
  // listSecrets should flag it as corrupted (no plaintext leaks).
  const list = listSecrets();
  assert.equal(list['tamper-test']?.corrupted, true);
});