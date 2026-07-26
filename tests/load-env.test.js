import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../src/utils/load-env.js';

async function withEnvFile(contents, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-env-'));
  const file = join(dir, '.env');
  await writeFile(file, contents);
  try { return await fn(file); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('loadEnvFile parses KEY=VALUE, export prefix, quotes and comments', async () => {
  await withEnvFile(
    [
      '# a comment',
      '',
      'PLAIN=value1',
      'export EXPORTED=value2',
      'QUOTED="has spaces"',
      "SINGLE='single quoted'",
      'INLINE=value3 # trailing comment',
      'not a valid line',
      '123BAD=nope',
    ].join('\n'),
    async (file) => {
      const env = {};
      const res = loadEnvFile(file, { env });
      assert.equal(res.loaded, true);
      assert.equal(env.PLAIN, 'value1');
      assert.equal(env.EXPORTED, 'value2');
      assert.equal(env.QUOTED, 'has spaces');
      assert.equal(env.SINGLE, 'single quoted');
      assert.equal(env.INLINE, 'value3');
      assert.equal(env['123BAD'], undefined);
      assert.equal(res.count, 5);
    },
  );
});

test('loadEnvFile does not overwrite an already-set variable', async () => {
  await withEnvFile('GEMINI_API_KEY=from-file', async (file) => {
    const env = { GEMINI_API_KEY: 'from-real-env' };
    loadEnvFile(file, { env });
    assert.equal(env.GEMINI_API_KEY, 'from-real-env');
  });
});

test('loadEnvFile override=true replaces existing values', async () => {
  await withEnvFile('GEMINI_API_KEY=from-file', async (file) => {
    const env = { GEMINI_API_KEY: 'from-real-env' };
    loadEnvFile(file, { env, override: true });
    assert.equal(env.GEMINI_API_KEY, 'from-file');
  });
});

test('loadEnvFile returns loaded=false for a missing file', () => {
  const res = loadEnvFile('/no/such/.env', { env: {} });
  assert.equal(res.loaded, false);
  assert.equal(res.count, 0);
});
