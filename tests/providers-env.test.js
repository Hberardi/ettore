import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getProviderEnvKey,
  getProviderEnvVars,
  listConfiguredEnvProviders,
} from '../src/providers/env.js';

test('provider env helpers: resolve configured provider keys', () => {
  const env = {
    OPENAI_API_KEY: 'sk-test-openai',
    ANTHROPIC_API_KEY: 'sk-ant-test-anthropic',
  };

  assert.deepEqual(getProviderEnvVars('openai'), ['OPENAI_API_KEY']);
  assert.deepEqual(getProviderEnvKey('openai', env), {
    name: 'OPENAI_API_KEY',
    value: 'sk-test-openai',
  });
  assert.equal(getProviderEnvKey('ollama', env), null);
  assert.deepEqual(listConfiguredEnvProviders(env), ['anthropic', 'openai']);
});
