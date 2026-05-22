import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';

test('Agent retries with tools when a build request gets code-only text first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-agent-'));
  try {
    const target = join(dir, 'hello.txt');
    let turns = 0;
    const client = {
      async turn(messages) {
        turns++;
        if (turns === 1) {
          return {
            type: 'text',
            content: '```txt\nok\n```',
          };
        }
        if (turns === 2) {
          const last = messages[messages.length - 1]?.content || '';
          assert.match(String(last), /real workspace changes/i);
          const toolCall = {
            id: 'call_write_1',
            function: {
              name: 'write',
              arguments: JSON.stringify({ file_path: target, content: 'ok\n' }),
            },
          };
          return {
            type: 'tool_calls',
            tool_calls: [toolCall],
            message: { role: 'assistant', content: '', tool_calls: [toolCall] },
          };
        }
        return {
          type: 'text',
          content: 'File creato.',
        };
      },
    };

    const agent = new Agent(client, {
      provider: 'test',
      model: 'gpt-4o',
      modelCapability: 'full',
      workdir: dir,
      contextWindow: 128000,
    }, 'build');
    const emitter = new EventEmitter();

    const result = await agent.run('crea il file hello.txt con contenuto ok', emitter);
    assert.equal(await readFile(target, 'utf-8'), 'ok\n');
    assert.equal(turns, 3);
    assert.match(String(result), /File creato/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
