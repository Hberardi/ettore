import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes,
  formatDuration,
  parseModelString,
  redactSecrets,
  sanitizeInput,
  validateFilePath,
} from '../src/utils/index.js';

test('formatBytes: scales B/KB/MB/GB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1024 * 1024), '1 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1 GB');
});

test('formatDuration: ms / s / m', () => {
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(120_000), '2.0m');
});

test('parseModelString: provider:model[:version]', () => {
  assert.deepEqual(parseModelString('anthropic:claude-opus-4-7'), {
    provider: 'anthropic', model: 'claude-opus-4-7', version: undefined,
  });
  assert.deepEqual(parseModelString('openai:gpt-4o:2024-08-06'), {
    provider: 'openai', model: 'gpt-4o', version: '2024-08-06',
  });
});

test('sanitizeInput: strips control chars and caps length', () => {
  assert.equal(sanitizeInput('hello\x00\x07world'), 'helloworld');
  assert.equal(sanitizeInput(123), '');
  assert.equal(sanitizeInput('a'.repeat(200_000)).length, 100_000);
});

test('redactSecrets: masks explicit and known API key formats', () => {
  const key = 'sk-test-secret-1234567890';
  assert.equal(
    redactSecrets(`provider rejected ${key}`, [key]),
    'provider rejected sk-t...7890'
  );
  assert.equal(
    redactSecrets('bad key sk-ant-secretvalue1234567890 in error'),
    'bad key sk-a...7890 in error'
  );
  assert.equal(redactSecrets('short abc', ['abc']), 'short abc');
});

test('validateFilePath: rejects shell metacharacters', () => {
  assert.throws(() => validateFilePath('../etc/passwd'), /Dangerous/);
  assert.throws(() => validateFilePath('file;rm -rf'), /Dangerous/);
  assert.throws(() => validateFilePath('file`whoami`'), /Dangerous/);
  assert.equal(validateFilePath('/safe/path/file.txt'), true);
});
