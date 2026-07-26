import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';

function writeCall(id, path, content) {
  return {
    id,
    type: 'function',
    function: { name: 'write', arguments: JSON.stringify({ file_path: path, content }) },
  };
}

function bashCall(id, command) {
  return {
    id,
    type: 'function',
    function: { name: 'bash', arguments: JSON.stringify({ command }) },
  };
}

function makeAgent(client, dir, { verifyAfterEdit = true } = {}) {
  return new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: dir,
    contextWindow: 128000,
    verifyAfterEdit,
  }, 'build');
}

test('Agent forces a verify retry when write happens but no verifier runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-verify-'));
  try {
    const target = join(dir, 'hello.js');
    let turns = 0;
    let sawVerifyNudge = false;
    const client = {
      async turn(messages) {
        turns++;
        if (turns === 1) {
          const tc = writeCall('w1', target, 'console.log(1)\n');
          return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
        }
        if (turns === 2) {
          // Model would normally just say "done" — verify guard must kick in.
          return { type: 'text', content: 'File creato.' };
        }
        if (turns === 3) {
          const system = messages[0]?.content || '';
          if (/did not verify/i.test(String(system))) sawVerifyNudge = true;
          const tc = bashCall('b1', `node -c ${target}`);
          return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
        }
        return { type: 'text', content: 'Verificato, tutto ok.' };
      },
    };

    const agent = makeAgent(client, dir);
    const emitter = new EventEmitter();
    const result = await agent.run('crea hello.js', emitter);
    assert.equal(turns, 4);
    assert.equal(sawVerifyNudge, true);
    assert.match(String(result), /Verificato/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

test('Agent does NOT force a verify retry when a verifier ran in the same turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-verify-'));
  try {
    const target = join(dir, 'hello.js');
    let turns = 0;
    const client = {
      async turn() {
        turns++;
        if (turns === 1) {
          // Single batch: write + verifier together.
          const w = writeCall('w1', target, 'console.log(1)\n');
          const b = bashCall('b1', `node --check ${target}`);
          return { type: 'tool_calls', tool_calls: [w, b], message: { role: 'assistant', content: '', tool_calls: [w, b] } };
        }
        return { type: 'text', content: 'Fatto e verificato.' };
      },
    };

    const agent = makeAgent(client, dir);
    const emitter = new EventEmitter();
    await agent.run('crea hello.js', emitter);
    // write+verify (turn 1) → final text (turn 2). No extra retry.
    assert.equal(turns, 2);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

test('Agent still forces a verify retry when the model only re-reads the touched file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-verify-'));
  try {
    const target = join(dir, 'hello.txt');
    let turns = 0;
    const client = {
      async turn() {
        turns++;
        if (turns === 1) {
          const tc = writeCall('w1', target, 'ciao\n');
          return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
        }
        if (turns === 2) {
          // Re-reading the touched file is inspection, not verification.
          const tc = { id: 'r1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ file_path: target }) } };
          return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
        }
        if (turns === 3) {
          const tc = bashCall('b1', `node -e "process.exit(0)"`);
          return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
        }
        return { type: 'text', content: 'Verificato davvero.' };
      },
    };

    const agent = makeAgent(client, dir);
    const emitter = new EventEmitter();
    const result = await agent.run('crea hello.txt', emitter);
    assert.equal(turns, 4);
    assert.match(String(result), /Verificato davvero/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

test('Verify retry is capped at one — model that still skips verify still ends the turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-verify-'));
  try {
    const target = join(dir, 'hello.js');
    let turns = 0;
    const client = {
      async turn() {
        turns++;
        if (turns === 1) {
          const tc = writeCall('w1', target, 'console.log(1)\n');
          return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
        }
        if (turns === 2) return { type: 'text', content: 'Fatto.' };
        // After the verify nudge, model still ignores it — should end anyway.
        return { type: 'text', content: 'Ancora fatto.' };
      },
    };

    const agent = makeAgent(client, dir);
    const emitter = new EventEmitter();
    const result = await agent.run('crea hello.js', emitter);
    // turn 1 (write) + turn 2 (text → triggers verify retry) + turn 3 (text → ends)
    assert.equal(turns, 3);
    assert.match(String(result), /Ancora fatto/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

test('verifyAfterEdit=false disables the verify retry entirely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-verify-'));
  try {
    const target = join(dir, 'hello.js');
    let turns = 0;
    const client = {
      async turn() {
        turns++;
        if (turns === 1) {
          const tc = writeCall('w1', target, 'console.log(1)\n');
          return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
        }
        return { type: 'text', content: 'Fatto.' };
      },
    };

    const agent = makeAgent(client, dir, { verifyAfterEdit: false });
    const emitter = new EventEmitter();
    await agent.run('crea hello.js', emitter);
    assert.equal(turns, 2);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});
