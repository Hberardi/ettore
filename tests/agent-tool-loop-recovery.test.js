import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { toolHandlers } from '../src/tools/index.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function toolTurn(id, url) {
  const call = {
    id,
    type: 'function',
    function: { name: 'webfetch', arguments: JSON.stringify({ url }) },
  };
  return {
    type: 'tool_calls',
    tool_calls: [call],
    message: { role: 'assistant', content: '', tool_calls: [call] },
  };
}

function config(extra = {}) {
  return {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    verifyAfterEdit: false,
    ...extra,
  };
}

test('duplicate-only tool batch forces a final text-only turn', async () => {
  const original = toolHandlers.webfetch;
  toolHandlers.webfetch = async () => 'page content';
  try {
    let turn = 0;
    const routedTools = [];
    const client = {
      async turn(_messages, tools) {
        turn++;
        routedTools.push(tools.map(tool => tool.function.name));
        if (turn <= 2) return toolTurn(`call_${turn}`, 'https://example.com/page');
        assert.equal(tools.length, 0);
        return { type: 'text', content: 'Final answer from earlier result.' };
      },
    };
    const emitter = new EventEmitter();
    const recoveries = [];
    emitter.on('loopRecovery', event => recoveries.push(event));
    const agent = new Agent(client, config());
    const answer = await agent.run('read this online page', emitter);
    assert.equal(answer, 'Final answer from earlier result.');
    assert.equal(turn, 3);
    assert.equal(routedTools[2].length, 0);
    assert.equal(recoveries[0].reason, 'duplicate_tools');
  } finally {
    toolHandlers.webfetch = original;
  }
});

test('read-only batch budget prevents endlessly varied web calls', async () => {
  const original = toolHandlers.webfetch;
  toolHandlers.webfetch = async ({ url }) => `content from ${url}`;
  try {
    let turn = 0;
    const client = {
      async turn(_messages, tools) {
        turn++;
        if (turn <= 2) return toolTurn(`call_${turn}`, `https://example.com/page-${turn}`);
        assert.equal(tools.length, 0);
        return { type: 'text', content: 'Research summary.' };
      },
    };
    const agent = new Agent(client, config({ maxReadOnlyToolBatches: 2 }));
    assert.equal(await agent.run('research online', new EventEmitter()), 'Research summary.');
    assert.equal(turn, 3);
  } finally {
    toolHandlers.webfetch = original;
  }
});

test('last iteration is reserved for a final answer without tools', async () => {
  const original = toolHandlers.webfetch;
  toolHandlers.webfetch = async ({ url }) => `content from ${url}`;
  try {
    let turn = 0;
    const client = {
      async turn(_messages, tools) {
        turn++;
        if (turn < 3) return toolTurn(`call_${turn}`, `https://example.com/${turn}`);
        assert.equal(tools.length, 0);
        return { type: 'text', content: 'Budget-safe final answer.' };
      },
    };
    const agent = new Agent(client, config({ maxReadOnlyToolBatches: 20 }));
    agent.maxIterations = 3;
    assert.equal(await agent.run('research online', new EventEmitter()), 'Budget-safe final answer.');
    assert.equal(turn, 3);
  } finally {
    toolHandlers.webfetch = original;
  }
});

test('provider tool call on final recovery turn completes instead of failing', async () => {
  const original = toolHandlers.webfetch;
  toolHandlers.webfetch = async ({ url }) => `content from ${url}`;
  try {
    let turn = 0;
    const client = {
      async turn(_messages, tools) {
        turn++;
        if (turn === 3) assert.equal(tools.length, 0);
        return toolTurn(`call_${turn}`, `https://example.com/${turn}`);
      },
    };
    const emitter = new EventEmitter();
    const errors = [];
    const completed = [];
    emitter.on('error', message => errors.push(message));
    emitter.on('complete', message => completed.push(message));
    const agent = new Agent(client, config({ maxIterations: 3, maxReadOnlyToolBatches: 20 }));

    const answer = await agent.run('research online', emitter);

    assert.match(answer, /limite di 3 passaggi/);
    assert.equal(errors.length, 0);
    assert.equal(completed.at(-1), answer);
  } finally {
    toolHandlers.webfetch = original;
  }
});


test('identical reads of an unchanged file are refused after their budget', async () => {
  // `read` is deliberately outside the strict duplicate guard (re-reading a
  // different range is normal), so it needs a budget of its own — otherwise a
  // stuck model spends the whole per-turn tool-call allowance on one file.
  const dir = await mkdtemp(join(tmpdir(), 'ettore-read-budget-'));
  const file = join(dir, 'app.js');
  await writeFile(file, 'const a = 1;\n');
  const agent = new Agent({ async turn() { return { type: 'text', content: 'ok' }; } }, config());
  const args = { file_path: file, offset: 0, limit: 200 };

  assert.equal(await agent._shouldSkipDuplicateTool('read', args), null);
  await agent._recordToolExecution('read', args, 'const a = 1;');
  // Second identical read still goes through (the cache makes it cheap).
  assert.equal(await agent._shouldSkipDuplicateTool('read', args), null);
  await agent._recordToolExecution('read', args, 'const a = 1;');

  const blocked = await agent._shouldSkipDuplicateTool('read', args);
  assert.ok(blocked, 'the third identical read must be refused');
  assert.match(blocked.reason, /already ran 2 times/);
  assert.match(blocked.reason, /read a different range, or act on it/);

  // A different range is different work, not a loop.
  assert.equal(await agent._shouldSkipDuplicateTool('read', { ...args, offset: 200 }), null);

  // The file changing out from under us (a shell command, an external editor)
  // makes the same read legitimate again, even though workspaceRevision only
  // tracks write/edit/apply_patch.
  await writeFile(file, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  assert.equal(await agent._shouldSkipDuplicateTool('read', args), null);
});

test('strictly guarded tools still dedupe on the second identical call', async () => {
  const agent = new Agent({ async turn() { return { type: 'text', content: 'ok' }; } }, config());
  const args = { pattern: 'TODO', path: '.' };
  assert.equal(await agent._shouldSkipDuplicateTool('grep', args), null);
  await agent._recordToolExecution('grep', args, 'no matches');
  const blocked = await agent._shouldSkipDuplicateTool('grep', args);
  assert.match(blocked.reason, /Skipped duplicate grep call/);
});
