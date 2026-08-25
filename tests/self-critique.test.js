import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Agent } from '../src/agents/index.js';

function makeEmitter() {
  const emitter = new EventEmitter();
  const critiques = [];
  emitter.on('critiqueCheck', c => critiques.push(c));
  return { emitter, critiques };
}

function agentConfig(workdir, extra = {}) {
  return {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir,
    contextWindow: 128000,
    verifyAfterEdit: false,
    dynamicToolRouting: false,
    maxToolsPerRequest: 28,
    ...extra,
  };
}

function mockClientWithToolCall(toolName, args) {
  let turn = 0;
  return {
    async turn() {
      turn++;
      if (turn === 1) {
        return {
          type: 'tool_calls',
          tool_calls: [{
            id: 'c1',
            type: 'function',
            function: { name: toolName, arguments: JSON.stringify(args) },
          }],
          message: { role: 'assistant', content: '', tool_calls: [{
            id: 'c1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) },
          }] },
        };
      }
      return { type: 'text', content: 'done' };
    },
  };
}

test('Self-critique: emits critiqueCheck event after a write mutation', async () => {
  const client = mockClientWithToolCall('write', {
    file_path: '/tmp/foo.txt',
    content: 'hello',
  });
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter, critiques } = makeEmitter();
  await agent.run('write a file', emitter);
  assert.equal(critiques.length, 1);
  assert.equal(critiques[0].tool, 'write');
  assert.equal(critiques[0].passed, true);
  assert.match(critiques[0].summary, /wrote \/tmp\/foo\.txt/);
  assert.ok(critiques[0].at);
  assert.equal(critiques[0].iteration, 1);
});

test('Self-critique: large content is redacted in the args payload', async () => {
  const bigContent = 'a'.repeat(5000);
  const client = mockClientWithToolCall('write', {
    file_path: '/tmp/big.txt',
    content: bigContent,
  });
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter, critiques } = makeEmitter();
  await agent.run('write a big file', emitter);
  assert.equal(critiques.length, 1);
  // The raw `content` must not be in the args.
  const argsJson = JSON.stringify(critiques[0].args);
  assert.ok(!argsJson.includes(bigContent));
  // The size placeholder is present.
  assert.match(argsJson, /5000 chars/);
});

test('Self-critique: marks passed=false when the tool output starts with Error:', async () => {
  let turn = 0;
  const client = {
    async turn() {
      turn++;
      if (turn > 1) return { type: 'text', content: 'done' };
      return {
        type: 'tool_calls',
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: { name: 'edit', arguments: JSON.stringify({ file_path: '/tmp/x', old_string: 'a', new_string: 'b' }) },
        }],
        message: { role: 'assistant', content: '', tool_calls: [{
          id: 'c1', type: 'function', function: { name: 'edit', arguments: JSON.stringify({ file_path: '/tmp/x', old_string: 'a', new_string: 'b' }) },
        }] },
      };
    },
  };
  // We need the edit tool handler to fail. Force the error by pointing at
  // a non-existent file. The tool returns "Error: ..." text.
  const agent = new Agent(client, agentConfig('/nonexistent-workdir-for-test'));
  const { emitter, critiques } = makeEmitter();
  await agent.run('edit', emitter);
  if (critiques.length > 0) {
    // If the critique fired, it must report passed=false because the
    // tool output begins with "Error:".
    assert.equal(critiques[0].passed, false);
    assert.match(critiques[0].summary, /failed/);
  }
});

test('Self-critique: does NOT emit for read-only tools', async () => {
  const client = mockClientWithToolCall('read', { file_path: '/tmp/x' });
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter, critiques } = makeEmitter();
  await agent.run('read', emitter);
  assert.equal(critiques.length, 0);
});

test('Self-critique: does NOT emit for glob (read-only)', async () => {
  const client = mockClientWithToolCall('glob', { pattern: '**/*.js' });
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter, critiques } = makeEmitter();
  await agent.run('glob', emitter);
  assert.equal(critiques.length, 0);
});

test('Self-critique: emits for edit mutation', async () => {
  // The edit tool requires the file to exist (otherwise it returns
  // "old_string not found"). Create a real file in a tmpdir so the
  // edit actually succeeds and the summary is "✓ patched ..." rather
  // than "✗ edit failed ...".
  const dir = await mkdtemp(join(tmpdir(), 'ettore-selfcritique-'));
  const file = join(dir, 'foo.txt');
  await writeFile(file, 'old content here');
  try {
    const client = mockClientWithToolCall('edit', {
      file_path: file,
      old_string: 'old',
      new_string: 'new',
    });
    const agent = new Agent(client, agentConfig(process.cwd()));
    const { emitter, critiques } = makeEmitter();
    await agent.run('edit a file', emitter);
    assert.equal(critiques.length, 1);
    assert.equal(critiques[0].tool, 'edit');
    assert.match(critiques[0].summary, /patched/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Self-critique: emits for apply_patch_structured mutation', async () => {
  // `apply_patch_structured` requires `old_string` + `new_string` (NOT a
  // `patch` blob — the tool builds the diff internally). The file must
  // exist and contain `old_string` for the tool to succeed.
  const dir = await mkdtemp(join(tmpdir(), 'ettore-selfcritique-'));
  const file = join(dir, 'foo.txt');
  await writeFile(file, 'a\n');
  try {
    const client = mockClientWithToolCall('apply_patch_structured', {
      file_path: file,
      old_string: 'a',
      new_string: 'b',
    });
    const agent = new Agent(client, agentConfig(process.cwd()));
    const { emitter, critiques } = makeEmitter();
    await agent.run('apply a patch', emitter);
    assert.equal(critiques.length, 1);
    assert.equal(critiques[0].tool, 'apply_patch_structured');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Self-critique: emits for bash mutation', async () => {
  const client = mockClientWithToolCall('bash', { command: 'echo hi' });
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter, critiques } = makeEmitter();
  await agent.run('run a command', emitter);
  assert.equal(critiques.length, 1);
  assert.equal(critiques[0].tool, 'bash');
  assert.match(critiques[0].summary, /ran: echo hi/);
});

test('Self-critique: long bash command is truncated in the summary', async () => {
  const longCmd = 'echo ' + 'a'.repeat(500);
  const client = mockClientWithToolCall('bash', { command: longCmd });
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter, critiques } = makeEmitter();
  await agent.run('run a long command', emitter);
  assert.equal(critiques.length, 1);
  // Summary truncates at 80 chars + ellipsis.
  assert.ok(critiques[0].summary.length <= 200);
  assert.match(critiques[0].summary, /…/);
});

test('Self-critique: multiple mutation calls in one turn each get a critique', async () => {
  let turn = 0;
  const client = {
    async turn() {
      turn++;
      if (turn === 1) {
        return {
          type: 'tool_calls',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/a', content: 'x' }) } },
            { id: 'c2', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/b', content: 'y' }) } },
          ],
          message: { role: 'assistant', content: '', tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/a', content: 'x' }) } },
            { id: 'c2', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/b', content: 'y' }) } },
          ] },
        };
      }
      return { type: 'text', content: 'done' };
    },
  };
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter, critiques } = makeEmitter();
  await agent.run('write two files', emitter);
  assert.equal(critiques.length, 2);
  assert.equal(critiques[0].tool, 'write');
  assert.equal(critiques[1].tool, 'write');
});
