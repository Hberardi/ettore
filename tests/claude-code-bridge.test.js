import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync as realExists, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  resolveClaudeCommand,
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

const messageStart = (model) => ({
  type: 'stream_event',
  event: { type: 'message_start', message: { model } },
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
  assert.deepEqual(result.usage, {
    inputTokens: 10, outputTokens: 3, cacheCreate: 1, cacheRead: 7,
    // Reported by the CLI when present; null on a result event that omits them.
    costUsd: null, resolvedModel: null, contextWindow: null,
  });
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


test('ClaudeCodeClient reports the resolved model and its real context window', async () => {
  // `--model opus` resolves to a pinned id whose window is nothing like the
  // fallback the pricing table guesses for the alias.
  const { spawn } = fakeClaude([
    messageStart('claude-opus-4-7'),
    textDelta('ok'),
    resultEvent({
      stop_reason: 'end_turn',
      total_cost_usd: 0.0042,
      modelUsage: { 'claude-opus-4-7': { contextWindow: 1000000, maxOutputTokens: 64000 } },
    }),
  ]);
  const client = new ClaudeCodeClient('opus', { spawn });
  const result = await client.turn([{ role: 'user', content: 'q' }], [], () => {}, null);

  assert.equal(result.usage.resolvedModel, 'claude-opus-4-7');
  assert.equal(result.usage.contextWindow, 1000000);
  assert.equal(result.usage.costUsd, 0.0042);
  assert.equal(result.finishReason, 'end_turn');
});

test('ClaudeCodeClient ignores side-model usage when picking the turn model', async () => {
  // The CLI runs models of its own for background work, so `modelUsage` can
  // list a model that never answered this turn — and list it first.
  const { spawn } = fakeClaude([
    messageStart('claude-opus-4-7'),
    textDelta('ok'),
    resultEvent({
      modelUsage: {
        'claude-haiku-4-5-20251001': { contextWindow: 200000 },
        'claude-opus-4-7': { contextWindow: 1000000 },
      },
    }),
  ]);
  const client = new ClaudeCodeClient('opus', { spawn });
  const result = await client.turn([{ role: 'user', content: 'q' }], [], () => {}, null);

  assert.equal(result.usage.resolvedModel, 'claude-opus-4-7');
  assert.equal(result.usage.contextWindow, 1000000);
});

test('ClaudeCodeClient maps a truncated turn onto the shared finish reason', async () => {
  const { spawn } = fakeClaude([textDelta('half a sen'), resultEvent({ stop_reason: 'max_tokens' })]);
  const client = new ClaudeCodeClient('opus', { spawn });
  const result = await client.turn([{ role: 'user', content: 'q' }], [], () => {}, null);
  assert.equal(result.finishReason, 'length');
});

test('ClaudeCodeClient carries the API error status onto the thrown error', async () => {
  const { spawn } = fakeClaude([
    resultEvent({ is_error: true, result: 'Claude AI usage limit reached', api_error_status: 429 }),
  ]);
  const client = new ClaudeCodeClient('opus', { spawn });
  await assert.rejects(
    () => client.turn([{ role: 'user', content: 'q' }], [], () => {}, null),
    (err) => {
      assert.equal(err.status, 429);
      assert.match(err.message, /usage limit reached/);
      return true;
    },
  );
});

// ── Windows: the program behind npm's claude.cmd ─────────────────────────────
//
// `execFile('claude')` failed with ENOENT on every Windows machine: npm installs
// the CLI as a .cmd shim, which Node will not spawn without a shell. These run
// on Linux against real files for the PATH lookup and a fake filesystem for the
// Windows paths behind it.

const madeDirs = [];
after(() => { for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true }); });

function windowsPathWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ettore-claude-bin-'));
  madeDirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
const slashes = p => String(p).replace(/\\/g, '/');

test('Windows: a native claude.exe on PATH is used as it is', () => {
  const dir = windowsPathWith({ 'claude.exe': '' });
  const cmd = resolveClaudeCommand({ os: 'win32', env: { PATH: dir, PATHEXT: '.EXE;.CMD' } });
  assert.equal(cmd.file, join(dir, 'claude.exe'));
  assert.deepEqual(cmd.args, []);
  assert.ok(!cmd.shell);
});

test('Windows: npm\'s claude.cmd is unwrapped to the executable it runs', () => {
  const shim = '@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n'
    + '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  const dir = windowsPathWith({ 'claude.cmd': shim });
  // Both sides normalised: on a real Windows runner `dir` comes back with
  // backslashes, and a half-normalised comparison never matches there.
  const target = slashes(join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  const cmd = resolveClaudeCommand({
    os: 'win32',
    env: { PATH: dir, PATHEXT: '.EXE;.CMD' },
    exists: p => slashes(p) === target || realExists(p),
  });
  assert.equal(slashes(cmd.file), target);
  assert.ok(!cmd.shell, 'never through cmd.exe, which mangles the arguments');
});

test('Windows: an older JS entry point is run with node, not the shell', () => {
  const shim = 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  '
    + '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  const dir = windowsPathWith({ 'claude.cmd': shim });
  const target = slashes(join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
  const cmd = resolveClaudeCommand({
    os: 'win32',
    env: { PATH: dir, PATHEXT: '.EXE;.CMD' },
    exists: p => slashes(p) === target,
    readFile: p => readFileSync(p, 'utf8'),
    nodePath: 'C:\\node\\node.exe',
  });
  assert.equal(cmd.file, 'C:\\node\\node.exe');
  assert.deepEqual(cmd.args.map(slashes), [target]);
});

test('Windows: a shim it cannot read falls back to the shell rather than ENOENT', () => {
  const dir = windowsPathWith({ 'claude.cmd': '@echo off\r\nsomething else %*\r\n' });
  const cmd = resolveClaudeCommand({ os: 'win32', env: { PATH: dir, PATHEXT: '.EXE;.CMD' }, exists: () => false });
  assert.equal(cmd.file, join(dir, 'claude.cmd'));
  assert.equal(cmd.shell, true);
});

test('Windows: the native installer location is found when PATH has nothing', () => {
  const cmd = resolveClaudeCommand({
    os: 'win32',
    env: { PATH: '', PATHEXT: '.EXE', USERPROFILE: 'C:\\Users\\me' },
    exists: p => p === 'C:\\Users\\me\\.local\\bin\\claude.exe',
  });
  assert.equal(cmd.file, 'C:\\Users\\me\\.local\\bin\\claude.exe');
});

test('elsewhere it is simply `claude`, and ETTORE_CLAUDE_BIN always wins', () => {
  assert.deepEqual(resolveClaudeCommand({ os: 'linux', env: {} }), { file: 'claude', args: [] });
  assert.deepEqual(resolveClaudeCommand({ os: 'darwin', env: { ETTORE_CLAUDE_BIN: '/opt/c' } }), { file: '/opt/c', args: [] });
  const dir = windowsPathWith({ 'claude.exe': '' });
  assert.equal(resolveClaudeCommand({ os: 'win32', env: { ETTORE_CLAUDE_BIN: 'D:\\c\\claude.exe', PATH: dir } }).file, 'D:\\c\\claude.exe');
});

// ── the system prompt travels in a file ─────────────────────────────────────

test('the system prompt goes in a file, not on the command line', () => {
  const args = buildClaudeCodeArgs('opus', 'SYSTEM', null, { systemPromptFile: '/tmp/x/system-prompt.txt' });
  const at = args.indexOf('--system-prompt-file');
  assert.equal(args[at + 1], '/tmp/x/system-prompt.txt');
  assert.ok(!args.includes('--system-prompt'), 'Windows caps a command line at 32,767 characters');
  assert.ok(!args.includes('SYSTEM'));
});

test('ClaudeCodeClient hands the CLI a prompt file with the system prompt, and removes it after', async () => {
  let seenPath = null;
  let seenContent = null;
  const { spawn } = fakeClaude([textDelta('ok'), resultEvent()]);
  const spying = (bin, args, options) => {
    seenPath = args[args.indexOf('--system-prompt-file') + 1];
    seenContent = readFileSync(seenPath, 'utf8');
    assert.equal(options.windowsHide, true);
    return spawn(bin, args, options);
  };
  const client = new ClaudeCodeClient('sonnet', { spawn: spying, bin: '/usr/bin/claude' });
  const system = `regole di sistema ${'x'.repeat(40_000)}`;
  await client.turn([{ role: 'system', content: system }, { role: 'user', content: 'hi' }], [], () => {}, null);

  assert.ok(seenContent.startsWith('regole di sistema'), 'the whole prompt, however long, reaches the CLI');
  assert.equal(realExists(seenPath), false, 'nothing is left behind in the temp dir');
});

test('the prompt file is removed even when the turn is cancelled', async () => {
  let seenPath = null;
  const spawn = (bin, args) => {
    seenPath = args[args.indexOf('--system-prompt-file') + 1];
    // A child that never reports back: only the abort ends this turn.
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = () => {};
    return child;
  };
  const controller = new AbortController();
  const client = new ClaudeCodeClient('sonnet', { spawn, bin: '/usr/bin/claude' });
  const turn = client.turn([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], [], () => {}, controller.signal);
  setImmediate(() => controller.abort());
  await assert.rejects(turn, /Aborted/);
  assert.equal(realExists(seenPath), false);
});

// ── a model the CLI refuses, and a model that thinks before it writes ───────

test('a request the CLI refuses reports the CLI\'s own reason, not "exited with code 1"', async () => {
  const { spawn } = fakeClaude([{
    type: 'result',
    is_error: true,
    api_error_status: 400,
    result: 'API Error: 400 Claude Code 2.1.152 does not support this model; version 2.1.280 or newer is required. Run \'claude update\'',
    usage: {},
  }], { exitCode: 1 });
  const client = new ClaudeCodeClient('claude-opus-5-5', { spawn, bin: '/usr/bin/claude' });
  await assert.rejects(
    client.turn([{ role: 'user', content: 'ciao' }], [], () => {}, null),
    (error) => {
      assert.match(error.message, /version 2\.1\.280 or newer is required/);
      assert.match(error.message, /claude update/);
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test('a model thinking without streaming text still shows it is alive', async () => {
  const phases = [];
  const { spawn } = fakeClaude([
    { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-opus-5-5' } } },
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'x' } } },
    { type: 'stream_event', event: { type: 'ping' } },
    textDelta('fatto'),
    resultEvent(),
  ]);
  const client = new ClaudeCodeClient('claude-opus-5-5', { spawn, bin: '/usr/bin/claude' });
  const result = await client.turn([{ role: 'user', content: 'q' }], [], () => {}, null, {
    onActivity: phase => phases.push(phase),
  });
  assert.equal(result.content, 'fatto');
  assert.ok(phases.includes('thinking'), 'the start of a thinking block is reported');
  assert.ok(phases.filter(p => p === 'stream').length >= 2, 'signatures and pings count as life too');
  assert.equal(phases.length, 4, 'text is reported as tokens, not as activity');
});
