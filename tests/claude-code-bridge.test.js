import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeCodeClient,
  buildClaudeCodeArgs,
  buildClaudeCodeSystemPrompt,
  parseClaudeCodeToolCalls,
  sanitizeClaudeEnv,
  serializeTranscriptForClaudeCode,
  usesClaudeCodeTransport,
} from '../src/llm/client.js';
import {
  CLAUDE_CODE_MODELS,
  describeAccount,
  detectClaudeAuth,
  parseAuthStatus,
} from '../src/providers/claude-code.js';
import { isKeylessProvider } from '../src/providers/index.js';

// ── routing ─────────────────────────────────────────────────────────────────

test('claude-code routes through its own transport and needs no key', () => {
  assert.equal(usesClaudeCodeTransport('claude-code'), true);
  assert.equal(usesClaudeCodeTransport('anthropic'), false);
  assert.equal(isKeylessProvider('claude-code'), true);
  assert.equal(isKeylessProvider('ollama'), true);
  assert.equal(isKeylessProvider('anthropic'), false);
});

// ── auth detection ──────────────────────────────────────────────────────────

test('detectClaudeAuth prefers an explicit token, then the on-disk login', () => {
  const home = mkdtempSync(join(tmpdir(), 'ettore-cc-'));

  assert.deepEqual(
    detectClaudeAuth({ CLAUDE_CODE_OAUTH_TOKEN: 't' }, home, 'linux'),
    { ok: true, source: 'CLAUDE_CODE_OAUTH_TOKEN' },
  );
  assert.equal(detectClaudeAuth({ ANTHROPIC_API_KEY: 'sk-ant-x' }, home, 'linux').source, 'ANTHROPIC_API_KEY');
  // No token, no key, no credentials file yet.
  assert.equal(detectClaudeAuth({}, home, 'linux').ok, false);

  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
  assert.equal(detectClaudeAuth({}, home, 'linux').source, 'claude login');
});

test('detectClaudeAuth assumes the macOS keychain holds the login', () => {
  const home = mkdtempSync(join(tmpdir(), 'ettore-cc-'));
  assert.equal(detectClaudeAuth({}, home, 'darwin').ok, true);
});

test('parseAuthStatus reads the account out of `claude auth status --json`', () => {
  const account = parseAuthStatus(JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    email: 'user@example.com',
    subscriptionType: 'pro',
  }));
  assert.deepEqual(account, {
    loggedIn: true,
    email: 'user@example.com',
    plan: 'pro',
    method: 'claude.ai',
  });
  assert.equal(parseAuthStatus('{"loggedIn":false}').loggedIn, false);
  assert.equal(parseAuthStatus('not json'), null);
  assert.equal(parseAuthStatus('"a string"'), null);
});

test('describeAccount names the account so the user sees what is being spent', () => {
  assert.match(
    describeAccount({ loggedIn: true, email: 'user@example.com', plan: 'max' }),
    /user@example\.com · max plan/,
  );
  // An environment credential has no email attached to it.
  assert.match(describeAccount({ source: 'CLAUDE_CODE_OAUTH_TOKEN' }), /via CLAUDE_CODE_OAUTH_TOKEN/);
  assert.equal(describeAccount(null), null);
});

// ── model catalog ───────────────────────────────────────────────────────────

test('the model catalog leads with aliases and keeps ids unique', () => {
  const ids = CLAUDE_CODE_MODELS.map(m => m.id);
  assert.deepEqual(ids.slice(0, 3), ['sonnet', 'opus', 'haiku']);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('claude-opus-5'));
  assert.ok(ids.includes('claude-sonnet-4-6'));
  assert.ok(CLAUDE_CODE_MODELS.every(m => typeof m.description === 'string' && m.description));
});

test('models a subscription cannot reach carry a visible note', () => {
  // Probed against the real CLI: both are refused on a plain Pro plan.
  for (const id of ['claude-fable-5', 'sonnet[1m]']) {
    const model = CLAUDE_CODE_MODELS.find(m => m.id === id);
    assert.ok(model, id);
    assert.match(model.note, /usage credits/);
  }
});

// ── subprocess isolation ────────────────────────────────────────────────────

test('buildClaudeCodeArgs runs the CLI as a bare model, not as a second agent', () => {
  const args = buildClaudeCodeArgs('opus', 'SYSTEM');
  const pairs = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) pairs.set(args[i], args[i + 1]);
  }
  assert.equal(pairs.get('--tools'), '');              // no built-in tools
  assert.equal(pairs.get('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(pairs.get('--setting-sources'), '');    // no user/project settings
  assert.equal(pairs.get('--model'), 'opus');
  assert.equal(pairs.get('--system-prompt'), 'SYSTEM');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--no-session-persistence'));
  // stream-json output is rejected without --verbose under --print.
  assert.ok(args.includes('--print') && args.includes('--verbose'));
  assert.equal(pairs.get('--output-format'), 'stream-json');
});

test('sanitizeClaudeEnv drops inherited session state but keeps the credential', () => {
  const env = sanitizeClaudeEnv({
    PATH: '/usr/bin',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    ANTHROPIC_API_KEY: 'sk-ant-x',
  });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    ANTHROPIC_API_KEY: 'sk-ant-x',
  });
});

// ── prompt construction ─────────────────────────────────────────────────────

test('buildClaudeCodeSystemPrompt declares the textual tool protocol and schemas', () => {
  const prompt = buildClaudeCodeSystemPrompt('You are Ettore.', [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  }]);
  assert.match(prompt, /You are Ettore\./);
  assert.match(prompt, /<tool_call>/);
  assert.match(prompt, /### read_file/);
  assert.match(prompt, /"properties":\{"path":\{"type":"string"\}\}/);
});

test('buildClaudeCodeSystemPrompt omits the protocol when there are no tools', () => {
  assert.equal(buildClaudeCodeSystemPrompt('Just chat.', []), 'Just chat.');
});

test('serializeTranscriptForClaudeCode replays tool calls and results', () => {
  const prompt = serializeTranscriptForClaudeCode([
    { role: 'system', content: 'ignored — sent via --system-prompt' },
    { role: 'user', content: 'read package.json' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"name":"ettore"}' },
  ]);

  assert.ok(!prompt.includes('ignored'));
  assert.match(prompt, /<user>\nread package\.json\n<\/user>/);
  assert.match(prompt, /<tool_call>\{"id":"call_1","name":"read_file","arguments":\{"path":"package\.json"\}\}<\/tool_call>/);
  assert.match(prompt, /<tool_result id="call_1">\n\{"name":"ettore"\}\n<\/tool_result>/);
});

test('serializeTranscriptForClaudeCode flags images it cannot forward', () => {
  const prompt = serializeTranscriptForClaudeCode([{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ],
  }]);
  assert.match(prompt, /what is this\?/);
  assert.match(prompt, /image attachment omitted/);
  assert.ok(!prompt.includes('base64,AAA'));
});

// ── textual tool-call parsing ───────────────────────────────────────────────

test('parseClaudeCodeToolCalls extracts calls and strips them from the visible text', () => {
  const { calls, content } = parseClaudeCodeToolCalls(
    'Sure.\n<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
  assert.equal(calls[0].function.arguments, '{"path":"a.txt"}');
  assert.equal(content, 'Sure.');
});

test('parseClaudeCodeToolCalls handles several calls, fences and alternate arg keys', () => {
  const { calls } = parseClaudeCodeToolCalls([
    '<tool_call>```json\n{"name":"a","parameters":{"x":1}}\n```</tool_call>',
    '<tool_use>{"name":"b","input":{"y":2}}</tool_use>',
  ].join('\n'));
  assert.deepEqual(calls.map(c => c.function.name), ['a', 'b']);
  assert.equal(calls[0].function.arguments, '{"x":1}');
  assert.equal(calls[1].function.arguments, '{"y":2}');
  assert.notEqual(calls[0].id, calls[1].id);
});

test('parseClaudeCodeToolCalls ignores malformed blocks instead of inventing a call', () => {
  const { calls, content } = parseClaudeCodeToolCalls('<tool_call>not json</tool_call>plain answer');
  assert.equal(calls.length, 0);
  assert.equal(content, 'plain answer');
});

// ── the client itself, against a fake CLI process ───────────────────────────

function fakeClaude(lines, { exitCode = 0, stderr = '' } = {}) {
  const calls = [];
  const spawn = (bin, args, options) => {
    calls.push({ bin, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = prompt => { calls[calls.length - 1].prompt = prompt; };
    child.kill = () => { calls[calls.length - 1].killed = true; };
    setImmediate(() => {
      for (const line of lines) child.stdout.emit('data', `${JSON.stringify(line)}\n`);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', exitCode);
    });
    return child;
  };
  return { spawn, calls };
}

const textDelta = text => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});
const thinkingDelta = thinking => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking } },
});
const resultEvent = (extra = {}) => ({
  type: 'result',
  is_error: false,
  usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 1 },
  ...extra,
});

test('ClaudeCodeClient streams text and reports usage', async () => {
  const { spawn, calls } = fakeClaude([textDelta('Ciao'), textDelta(' Ettore'), resultEvent()]);
  const client = new ClaudeCodeClient('sonnet', { spawn, bin: '/usr/bin/claude' });

  const tokens = [];
  const result = await client.turn(
    [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    [],
    t => tokens.push(t),
    null,
  );

  assert.equal(result.type, 'text');
  assert.equal(result.content, 'Ciao Ettore');
  assert.deepEqual(tokens, ['Ciao', ' Ettore']);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 3, cacheCreate: 1, cacheRead: 7 });
  assert.equal(calls[0].bin, '/usr/bin/claude');
  // The transcript goes over stdin — an argv prompt would hit ARGV limits.
  assert.match(calls[0].prompt, /<user>\nhi\n<\/user>/);
});

test('ClaudeCodeClient wraps extended thinking in <think> tags for the stream parser', async () => {
  const { spawn } = fakeClaude([thinkingDelta('hmm'), textDelta('answer'), resultEvent()]);
  const client = new ClaudeCodeClient('sonnet', { spawn });

  const tokens = [];
  const result = await client.turn([{ role: 'user', content: 'q' }], [], t => tokens.push(t), null);

  assert.deepEqual(tokens, ['<think>', 'hmm', '</think>', 'answer']);
  // Reasoning never leaks into the stored assistant message.
  assert.equal(result.content, 'answer');
});

test('ClaudeCodeClient turns a textual tool call into a canonical tool_calls turn', async () => {
  const { spawn } = fakeClaude([
    textDelta('<tool_call>{"name":"read_file",'),
    textDelta('"arguments":{"path":"a.txt"}}</tool_call>'),
    resultEvent(),
  ]);
  const client = new ClaudeCodeClient('sonnet', { spawn });

  const result = await client.turn([{ role: 'user', content: 'read a.txt' }], [], () => {}, null);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.tool_calls.length, 1);
  assert.equal(result.tool_calls[0].function.name, 'read_file');
  assert.equal(result.message.role, 'assistant');
  assert.deepEqual(result.message.tool_calls, result.tool_calls);
});

test('ClaudeCodeClient surfaces a CLI error result', async () => {
  const { spawn } = fakeClaude([resultEvent({ is_error: true, result: 'Credit balance is too low' })]);
  const client = new ClaudeCodeClient('sonnet', { spawn });
  await assert.rejects(
    client.turn([{ role: 'user', content: 'hi' }], [], () => {}, null),
    /Credit balance is too low/,
  );
});

test('ClaudeCodeClient surfaces a non-zero exit with the stderr tail', async () => {
  const { spawn } = fakeClaude([], { exitCode: 1, stderr: 'Invalid API key' });
  const client = new ClaudeCodeClient('sonnet', { spawn });
  await assert.rejects(
    client.turn([{ role: 'user', content: 'hi' }], [], () => {}, null),
    /exited with code 1: Invalid API key/,
  );
});

test('ClaudeCodeClient aborts the child process when the turn is cancelled', async () => {
  const controller = new AbortController();
  const calls = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = () => calls.push('killed');
    setImmediate(() => controller.abort());
    return child;
  };
  const client = new ClaudeCodeClient('sonnet', { spawn });

  await assert.rejects(
    client.turn([{ role: 'user', content: 'hi' }], [], () => {}, controller.signal),
    err => err.name === 'AbortError',
  );
  assert.deepEqual(calls, ['killed']);
});
