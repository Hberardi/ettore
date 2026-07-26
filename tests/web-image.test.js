import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { normalizeMessagesForAnthropic } from '../src/llm/client.js';
import { toolHandlers } from '../src/tools/index.js';
import { fetchWebImage, isPrivateAddress } from '../src/tools/web-image.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function response({ status = 200, type = 'image/png', body = PNG, location, url } = {}) {
  const headers = new Map();
  if (type) headers.set('content-type', type);
  if (location) headers.set('location', location);
  headers.set('content-length', String(body.length));
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: name => headers.get(String(name).toLowerCase()) || null },
    arrayBuffer: async () => body,
  };
}

test('fetchWebImage returns a validated multimodal attachment', async () => {
  const result = await fetchWebImage('https://example.com/picture.png', {
    lookupFn: publicLookup,
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      return response();
    },
  });
  assert.equal(result.__ettoreType, 'web_image');
  assert.equal(result.attachment.mimeType, 'image/png');
  assert.equal(result.attachment.data, PNG.toString('base64'));
});

test('fetchWebImage blocks private destinations and redirect pivots', async () => {
  await assert.rejects(fetchWebImage('http://127.0.0.1/a.png', {
    lookupFn: publicLookup,
    fetchImpl: async () => response(),
  }), /private\/loopback/);

  await assert.rejects(fetchWebImage('https://example.com/a.png', {
    lookupFn: publicLookup,
    fetchImpl: async () => response({ status: 302, location: 'http://[::ffff:127.0.0.1]/secret.png' }),
  }), /private\/loopback/);
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true);
});

test('fetchWebImage rejects oversized and spoofed responses', async () => {
  await assert.rejects(fetchWebImage('https://example.com/a.png', {
    lookupFn: publicLookup,
    maxBytes: 4,
    fetchImpl: async () => response(),
  }), /exceeds/);

  await assert.rejects(fetchWebImage('https://example.com/a.png', {
    lookupFn: publicLookup,
    fetchImpl: async () => response({ type: 'image/jpeg' }),
  }), /content type mismatch/);
});

test('Agent appends fetched web images after ordered tool results', async () => {
  const original = toolHandlers.web_image;
  toolHandlers.web_image = async () => ({
    __ettoreType: 'web_image',
    sourceUrl: 'https://example.com/a.png',
    byteLength: PNG.length,
    attachment: { name: 'a.png', mimeType: 'image/png', data: PNG.toString('base64') },
    message: 'Image fetched: a.png',
  });
  try {
    let turn = 0;
    const client = {
      async turn(messages) {
        turn++;
        if (turn === 1) {
          const call = { id: 'img_1', type: 'function', function: { name: 'web_image', arguments: '{"url":"https://example.com/a.png"}' } };
          return { type: 'tool_calls', tool_calls: [call], message: { role: 'assistant', content: '', tool_calls: [call] } };
        }
        const tail = messages.slice(-2);
        assert.equal(tail[0].role, 'tool');
        assert.equal(tail[0].tool_call_id, 'img_1');
        assert.equal(tail[1].role, 'user');
        assert.equal(tail[1].content[1].type, 'image_url');

        const anthropic = normalizeMessagesForAnthropic(messages);
        const last = anthropic.at(-1);
        assert.equal(last.role, 'user');
        assert.deepEqual(last.content.map(block => block.type), ['tool_result', 'text', 'image']);
        return { type: 'text', content: 'I can see the image.' };
      },
    };
    const agent = new Agent(client, {
      provider: 'test', model: 'gpt-4o', modelCapability: 'full',
      workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
    });
    assert.equal(await agent.run('analyze this online image', new EventEmitter()), 'I can see the image.');
  } finally {
    toolHandlers.web_image = original;
  }
});
