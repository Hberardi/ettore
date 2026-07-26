import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { toolHandlers } from '../src/tools/index.js';

// ── Sanitisation of bad tool-call arguments ────────────────────────────────
test('Agent sanitises a tool_call with malformed JSON arguments after a 400 from the provider', async () => {
  let turns = 0;
  const client = {
    async turn(messages) {
      turns++;
      if (turns === 1) {
        // Model produces a tool_call with arguments that won't parse as
        // strict JSON (unterminated string). Provider rejects on replay.
        const badArgs = '{"file_path": "/tmp/x", "content": "unterminated';
        const tc = {
          id: 'call_function_hsv1dygu4f3t_2',
          type: 'function',
          function: { name: 'write', arguments: badArgs },
        };
        return {
          type: 'tool_calls',
          tool_calls: [tc],
          message: { role: 'assistant', content: '', tool_calls: [tc] },
        };
      }
      // After retry path: the tool_call arguments were coerced to '{}' so
      // the provider accepted the replay. Model answers directly.
      return { type: 'text', content: 'OK, recovered.' };
    },
  };

  const agent = new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    verifyAfterEdit: false,
  });

  // Stub write so the (sanitised) tool execution doesn't touch the disk.
  const originalWrite = toolHandlers.write;
  toolHandlers.write = async () => 'Error: stubbed out for this test';
  // Make the second client.turn throw the provider error so we exercise
  // the sanitisation branch (the actual provider rejection happens on
  // replay, not on the original tool_call arrival).
  const realTurn = client.turn;
  client.turn = async function rejectedOnce(messages) {
    const result = await realTurn.call(this, messages);
    if (turns === 2) {
      const err = new Error(
        'Provider rejected mismatched tool-call history: 400 invalid params, invalid function arguments json string, tool_call_id: call_function_hsv1dygu4f3t_2 (2013)',
      );
      err.status = 400;
      throw err;
    }
    return result;
  };

  const emitter = new EventEmitter();
  const errors = [];
  emitter.on('error', (e) => errors.push(e));

  try {
    const result = await agent.run('scrivi qualcosa', emitter);
    // The retry path returns true from _retryAfterInvalidToolArgs, so the
    // original error is suppressed. The turn ends with no assistant text
    // because the retry hands control back without re-invoking the model.
    assert.equal(errors.length, 0, `expected no error events, got: ${JSON.stringify(errors)}`);
    // The bad tool_call in messages[1] should now have empty arguments
    // so the next provider call won't reject.
    const assistantMsg = agent.messages.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
    assert.ok(assistantMsg, 'assistant tool_call message should still exist after retry');
    const tc = assistantMsg.tool_calls[0];
    assert.equal(tc.function.arguments, '{}', 'malformed arguments must be coerced to "{}"');
    assert.equal(tc.__invalidArgs, true, 'tool_call should be flagged as having had invalid args');
  } finally {
    toolHandlers.write = originalWrite;
  }
});

test('Agent surfaces the original error when retry path also throws', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      // Always emit a bad tool_call so the retry path also fails.
      const badArgs = '{"unterminated';
      const tc = {
        id: `call_bad_${turns}`,
        type: 'function',
        function: { name: 'read', arguments: badArgs },
      };
      return {
        type: 'tool_calls',
        tool_calls: [tc],
        message: { role: 'assistant', content: '', tool_calls: [tc] },
      };
    },
  };

  const agent = new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    verifyAfterEdit: false,
  });

  const emitter = new EventEmitter();
  const errors = [];
  emitter.on('error', (e) => errors.push(e));

  // Force the second invocation to throw the provider rejection.
  const realTurn = client.turn;
  let throwOnce = true;
  client.turn = async function (messages) {
    if (throwOnce) {
      throwOnce = false;
      const err = new Error(
        'Provider rejected mismatched tool-call history: 400 invalid params, invalid function arguments json string, tool_call_id: call_bad_1 (2013)',
      );
      err.status = 400;
      throw err;
    }
    return realTurn.call(this, messages);
  };

  await agent.run('leggi file', emitter);
  // After sanitisation the message is rewritten; we expect a single
  // error event from the second client.turn call, surfaced cleanly.
  // Either path (surfaces the sanitised second-pass error or no error
  // because the sanitisation succeeded) is acceptable; what MUST NOT
  // happen is the original 400 leaking through with the raw message.
  for (const e of errors) {
    assert.ok(
      !/Provider rejected mismatched tool-call history/.test(String(e)),
      `raw provider 400 must not surface to the user: ${e}`,
    );
  }
});

test('Non-tool-args errors are NOT intercepted (401 still surfaces as auth failure)', async () => {
  let turns = 0;
  const client = {
    async turn() {
      turns++;
      const err = new Error('Authentication failed (HTTP 401)');
      err.status = 401;
      throw err;
    },
  };
  const agent = new Agent(client, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: process.cwd(), contextWindow: 128000, verifyAfterEdit: false,
  });
  const emitter = new EventEmitter();
  const errors = [];
  emitter.on('error', (e) => errors.push(e));
  await agent.run('ciao', emitter);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Authentication failed/);
});

test('string-typed numeric args from the provider no longer abort the run', async () => {
  // Exactly the batch from the failing session: MiniMax sent
  // {"file_path":"…/app.py","offset":"5020","limit":"90"} three turns running,
  // and the invalid-tool-call breaker killed the turn.
  const original = toolHandlers.read;
  const seen = [];
  toolHandlers.read = async (args) => {
    seen.push(args);
    return 'file body';
  };
  try {
    let turn = 0;
    const client = {
      async turn() {
        turn++;
        if (turn === 1) {
          const call = {
            id: 'call_read_1',
            type: 'function',
            function: {
              name: 'read',
              arguments: '{"file_path":"/tmp/app.py","offset":"5020","limit":"90"}',
            },
          };
          return { type: 'tool_calls', tool_calls: [call], message: { role: 'assistant', content: '', tool_calls: [call] } };
        }
        return { type: 'text', content: 'Ecco le righe.' };
      },
    };
    const emitter = new EventEmitter();
    const errors = [];
    emitter.on('error', e => errors.push(String(e)));

    const agent = new Agent(client, {
      provider: 'minimax',
      model: 'MiniMax-M3',
      modelCapability: 'full',
      workdir: process.cwd(),
      contextWindow: 128000,
      verifyAfterEdit: false,
    }, 'build');
    const answer = await agent.run('leggi il file', emitter);

    assert.deepEqual(errors, [], `no error expected, got: ${errors.join(' | ')}`);
    assert.equal(answer, 'Ecco le righe.');
    assert.equal(seen.length, 1, 'the call must actually run');
    assert.strictEqual(seen[0].offset, 5020, 'coerced to a number before the handler sees it');
    assert.strictEqual(seen[0].limit, 90);
  } finally {
    toolHandlers.read = original;
  }
});
