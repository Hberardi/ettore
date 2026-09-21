// Every toolStart gets a toolEnd.
//
// The UI matches ends to starts by id, so a missing end leaves that tool
// marked 'running' for the rest of the session: a `file_info` its own 20s
// timeout had already killed kept counting past 36s on screen, and the wait
// kind stayed 'tool' with it. A sub-agent cancelled mid-tool is one way to
// lose the event; the guarantee makes the cause irrelevant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { toolHandlers } from '../src/tools/index.js';

function agentFor(client) {
  return new Agent(client, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  }, 'build');
}

function trackTools(emitter) {
  const started = [];
  const ended = [];
  emitter.on('toolStart', e => started.push(e.id));
  emitter.on('toolEnd', e => ended.push(e.id));
  return { started, ended };
}

test('a batch that unwinds mid-flight still ends every tool it announced', async () => {
  const originalInfo = toolHandlers.file_info;
  const originalRead = toolHandlers.read;
  // One tool never settles; the turn is cancelled underneath it.
  toolHandlers.file_info = () => new Promise(() => {});
  toolHandlers.read = async () => { throw new Error('boom'); };
  try {
    const agent = agentFor({
      async turn() {
        const calls = [
          { id: 't1', type: 'function', function: { name: 'file_info', arguments: JSON.stringify({ path: 'a.png' }) } },
          { id: 't2', type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: 'b.js' }) } },
        ];
        return { type: 'tool_calls', tool_calls: calls, message: { role: 'assistant', content: '', tool_calls: calls } };
      },
    });
    const emitter = new EventEmitter();
    const { started, ended } = trackTools(emitter);
    const run = agent.run('guarda i file', emitter);
    // Cancel while file_info is still hanging.
    await new Promise(r => { setTimeout(r, 120); });
    agent.cancel();
    await run.catch(() => {});

    assert.ok(started.length >= 1, 'the batch announced at least one tool');
    for (const id of started) {
      assert.ok(ended.includes(id), `tool ${id} was announced but never ended`);
    }
  } finally {
    toolHandlers.file_info = originalInfo;
    toolHandlers.read = originalRead;
  }
});

test('a normal batch still ends each tool exactly once', async () => {
  const original = toolHandlers.file_info;
  toolHandlers.file_info = async () => 'Path: a.png\nType: file';
  try {
    let turns = 0;
    const agent = agentFor({
      async turn() {
        turns++;
        if (turns === 1) {
          const calls = [
            { id: 'a1', type: 'function', function: { name: 'file_info', arguments: JSON.stringify({ path: 'a.png' }) } },
            { id: 'a2', type: 'function', function: { name: 'file_info', arguments: JSON.stringify({ path: 'b.png' }) } },
          ];
          return { type: 'tool_calls', tool_calls: calls, message: { role: 'assistant', content: '', tool_calls: calls } };
        }
        return { type: 'text', content: 'Visti.' };
      },
    });
    const emitter = new EventEmitter();
    const { started, ended } = trackTools(emitter);
    await agent.run('guarda i file', emitter);
    assert.deepEqual(ended.slice().sort(), started.slice().sort());
    assert.equal(new Set(ended).size, ended.length, 'no tool is ended twice');
  } finally {
    toolHandlers.file_info = original;
  }
});
