import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { toolHandlers } from '../src/tools/index.js';

// Regression: MiniMax M2.x/M3 sometimes print their XML tool-call protocol as
// assistant *content* instead of emitting structured tool_calls deltas. The
// turn used to end right there — no tool run, no error — so the CLI looked
// frozen mid-task while the model believed the tool had already run.
const LEAKED_TURN = [
  'Piano: Capire il codice rilevante',
  ']<]minimax[>[<minimax:tool_call>',
  ']<]minimax[>[<invoke name="read">]<]minimax[>[<file_path>/tmp/style.css]<]minimax[>[</file_path>]<]minimax[>[<offset>1400.0]<]minimax[>[</offset>]<]minimax[>[</invoke>',
  ']<]minimax[>[</minimax:tool_call>',
].join('\n');

function config(extra = {}) {
  return {
    provider: 'minimax',
    model: 'MiniMax-M3',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    verifyAfterEdit: false,
    ...extra,
  };
}

test('a tool call leaked as text is executed instead of stalling the turn', async () => {
  const original = toolHandlers.read;
  const seen = [];
  toolHandlers.read = async (args) => {
    seen.push(args);
    return 'body { color: red }';
  };
  try {
    let turn = 0;
    const client = {
      async turn(_messages, _tools, onToken) {
        turn++;
        if (turn === 1) {
          for (const chunk of LEAKED_TURN.split(/(?=]<])/)) onToken?.(chunk);
          return { type: 'text', content: LEAKED_TURN };
        }
        return { type: 'text', content: 'Il file usa color: red.' };
      },
    };
    const emitter = new EventEmitter();
    const tokens = [];
    const recoveries = [];
    emitter.on('token', t => tokens.push(t));
    emitter.on('loopRecovery', e => recoveries.push(e));

    const answer = await agentRun(client, emitter);

    assert.equal(answer, 'Il file usa color: red.');
    assert.equal(turn, 2, 'the recovered call must produce a follow-up turn');
    assert.equal(seen.length, 1, 'the leaked read call must actually run');
    assert.equal(seen[0].file_path, '/tmp/style.css');
    assert.strictEqual(seen[0].offset, 1400, '1400.0 must be coerced to an integer');
    assert.equal(recoveries[0]?.reason, 'text_tool_call_recovery');

    // Nothing from the leaked protocol may reach the screen.
    const shown = tokens.join('');
    assert.ok(!shown.includes('<invoke'), `protocol leaked to the UI: ${JSON.stringify(shown)}`);
    assert.ok(!shown.includes('minimax[>['), `framing leaked to the UI: ${JSON.stringify(shown)}`);
    assert.ok(!shown.includes('file_path'), `parameter tags leaked to the UI: ${JSON.stringify(shown)}`);
    assert.ok(shown.includes('Piano'), `real prose must still be shown: ${JSON.stringify(shown)}`);
  } finally {
    toolHandlers.read = original;
  }
});

test('an unparseable tool-call blob nudges the model back to the native API', async () => {
  let turn = 0;
  const systemsSeen = [];
  const client = {
    async turn(messages) {
      turn++;
      systemsSeen.push(String(messages[0]?.content || ''));
      if (turn === 1) return { type: 'text', content: 'Ora leggo il file <tool_call> ...' };
      return { type: 'text', content: 'Fatto.' };
    },
  };
  const answer = await agentRun(client, new EventEmitter());
  assert.equal(answer, 'Fatto.');
  assert.equal(turn, 2, 'the malformed blob must trigger exactly one retry');
  assert.match(systemsSeen[1], /native tool-calling API/i);
});

test('a half-parsed blob is never replayed as an empty-args tool call', async () => {
  // `read` without file_path fails the schema. Replaying it would trip the
  // invalid-tool-call circuit breaker and blame the model for a parse failure.
  const original = toolHandlers.read;
  let ran = 0;
  toolHandlers.read = async () => { ran++; return ''; };
  try {
    let turn = 0;
    const systemsSeen = [];
    const client = {
      async turn(messages) {
        turn++;
        systemsSeen.push(String(messages[0]?.content || ''));
        if (turn === 1) return { type: 'text', content: '<invoke name="read"></invoke>' };
        return { type: 'text', content: 'Non riesco, mi serve il percorso.' };
      },
    };
    const answer = await agentRun(client, new EventEmitter());
    assert.equal(ran, 0, 'a call with invalid args must not be executed');
    assert.equal(answer, 'Non riesco, mi serve il percorso.');
    assert.match(systemsSeen[1], /native tool-calling API/i);
  } finally {
    toolHandlers.read = original;
  }
});

async function agentRun(client, emitter) {
  const agent = new Agent(client, config());
  return agent.run('leggi lo stile della pagina', emitter);
}
