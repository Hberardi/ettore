import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MiniMaxProvider } from '../src/providers/minimax.js';

const SAVED_BASE = process.env.MINIMAX_BASE_URL;
const SAVED_MODEL = process.env.MINIMAX_MODEL;

afterEach(() => {
  if (SAVED_BASE === undefined) delete process.env.MINIMAX_BASE_URL;
  else process.env.MINIMAX_BASE_URL = SAVED_BASE;
  if (SAVED_MODEL === undefined) delete process.env.MINIMAX_MODEL;
  else process.env.MINIMAX_MODEL = SAVED_MODEL;
});

test('MiniMaxProvider: uses default baseURL when MINIMAX_BASE_URL is unset', () => {
  delete process.env.MINIMAX_BASE_URL;
  const p = new MiniMaxProvider('sk-test');
  assert.equal(p.client.baseURL, 'https://api.minimax.io/v1');
  assert.equal(p.name, 'minimax');
});

test('MiniMaxProvider: respects MINIMAX_BASE_URL env override', () => {
  // User has a private deployment / proxy. The provider must point the SDK
  // at the overridden endpoint, not the hard-coded default.
  process.env.MINIMAX_BASE_URL = 'https://api.example.com/minimax/v1';
  const p = new MiniMaxProvider('sk-test');
  assert.equal(p.client.baseURL, 'https://api.example.com/minimax/v1');
});

test('MiniMaxProvider: listModels exposes MiniMax-M3 as the recommended first entry', async () => {
  const p = new MiniMaxProvider('sk-test');
  const res = await p.listModels();
  assert.equal(res.success, true);
  assert.equal(res.models[0].id, 'MiniMax-M3');
  assert.equal(res.models[0].capability, 'full');
  assert.match(res.models[0].description, /recommended/i);
});

test('MiniMaxProvider: validateKey probes with M3 by default', async () => {
  delete process.env.MINIMAX_MODEL;
  const calls = [];
  const fakeProvider = {
    name: 'minimax',
    client: {
      chat: {
        completions: {
          create: async (params) => {
            calls.push(params);
            return { id: 'test', choices: [{ message: { content: 'hi' } }] };
          },
        },
      },
    },
    getClient: function () { return this.client; },
  };
  // Mock the inner client by replacing it post-construction.
  const p = new MiniMaxProvider('sk-test');
  p.client = fakeProvider.client;
  const result = await p.validateKey();
  assert.equal(result.valid, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'MiniMax-M3');
});

test('MiniMaxProvider: validateKey falls back when M3 is unavailable', async () => {
  delete process.env.MINIMAX_MODEL;
  const calls = [];
  const p = new MiniMaxProvider('sk-test');
  p.client = {
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          if (params.model === 'MiniMax-M3') {
            const e = new Error('403 model not available for this tier');
            e.status = 403;
            throw e;
          }
          return { id: 'test', choices: [{ message: { content: 'hi' } }] };
        },
      },
    },
  };

  const result = await p.validateKey();
  assert.equal(result.valid, true);
  assert.deepEqual(calls.map(c => c.model), ['MiniMax-M3', 'MiniMax-M2.7']);
});

test('MiniMaxProvider: validateKey respects MINIMAX_MODEL env override', async () => {
  process.env.MINIMAX_MODEL = 'MiniMax-M2.7';
  const calls = [];
  const p = new MiniMaxProvider('sk-test');
  p.client = {
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          return { id: 'test', choices: [{ message: { content: 'hi' } }] };
        },
      },
    },
  };
  const result = await p.validateKey();
  assert.equal(result.valid, true);
  assert.equal(calls[0].model, 'MiniMax-M2.7');
});

test('MiniMaxProvider: validateKey surfaces error message on failure', async () => {
  const p = new MiniMaxProvider('sk-test');
  p.client = {
    chat: {
      completions: {
        create: async () => {
          const e = new Error('401 Unauthorized');
          e.status = 401;
          throw e;
        },
      },
    },
  };
  const result = await p.validateKey();
  assert.equal(result.valid, false);
  assert.match(result.error, /401/);
});
