import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { isGarbageOutput } from '../src/agents/lite.js';
import { Agent } from '../src/agents/index.js';

// The shape that cost a MiniMax-M3 answer: one Chinese word (a model that
// thinks in Chinese leaves them behind) plus a quoted "Human:" — 20 + 40 = the
// exact 60 the user was shown, on an answer that was perfectly fine.
const MINIMAX_SHAPED_ANSWER = [
  'Ho letto message-ledger.js. Il formato della trascrizione usa i ruoli',
  'user / assistant, e il modello 好的 li rimappa prima di inviarli.',
  '',
  'Human: ciao',
  'Assistant: ecco la risposta',
  '',
  'Questo è solo un esempio di formato citato dal codice, non un vero turno.',
].join('\n');

test('an ordinary answer about chat roles is not called garbage', () => {
  const result = isGarbageOutput(MINIMAX_SHAPED_ANSWER);
  assert.equal(result.isGarbage, false, result.reason);
  assert.ok(result.confidence < 0.4, `scored ${result.confidence * 100}: ${result.reason}`);
});

test('formatting and code are not evidence of degeneration', () => {
  const samples = [
    'Ecco cosa stampa /compress stats:\n\nContext Stats\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  Tokens used : ~3043 / 8000\n\nIl calcolo sta in compressor.js.',
    'Ho aggiornato il parser.\n\n----------\n\n`const hdrs = mkdtmp(tmpdir());`\n`const nghbrs = grepFallback(cwd);`',
    'Esempi:\n\n```bash\nnpm test\n```\n```js\nconst a = 1;\n```\n```json\n{}\n```\n```yaml\na: 1\n```',
    'Il prompt di sistema contiene `<|im_end|>` come esempio di token di fine testo.',
    'Ho letto compressor.js: la soglia di compressione è al 30% della finestra di contesto.',
  ];
  for (const sample of samples) {
    const result = isGarbageOutput(sample);
    assert.equal(result.isGarbage, false, `flagged (${result.confidence * 100}%): ${result.reason}\n${sample}`);
  }
});

test('output that really has degenerated is still caught', () => {
  const garbage = '好的好的好的好的 система система система система система система система <|im_end|>';
  const result = isGarbageOutput(garbage);
  assert.equal(result.isGarbage, true, result.reason);
  assert.ok(result.confidence >= 0.6);

  const salad = 'The xyzwq nghbrs strngs blrgh mkzptl frtzk appear.... everywhere.... in this.... reply';
  assert.equal(isGarbageOutput(salad).isGarbage, true);
});

function makeAgent(client, config) {
  return new Agent(client, {
    provider: 'minimax', workdir: tmpdir(), contextWindow: 128000, verifyAfterEdit: false, ...config,
  }, 'build');
}

test('a capable model keeps its answer even if the detector would fire', async () => {
  const content = '好的好的好的好的 система система система система система система система <|im_end|>';
  const agent = makeAgent({ async turn() { return { type: 'text', content }; } },
    { model: 'MiniMax-M3', modelCapability: 'full' });
  const errors = [];
  const emitter = new EventEmitter();
  emitter.on('error', e => errors.push(e));

  const answer = await agent.run('spiegami il ledger', emitter);
  assert.equal(answer, content, 'the answer of a full-capability model must reach the user');
  assert.deepEqual(errors, []);
});

test('a lite model is still protected from its own garbage', async () => {
  const content = '好的好的好的好的 система система система система система система система <|im_end|>';
  const agent = makeAgent({ async turn() { return { type: 'text', content }; } },
    { provider: 'openrouter', model: 'microsoft/phi-3-mini-128k-instruct:free', modelCapability: 'lite' });
  const errors = [];
  const emitter = new EventEmitter();
  emitter.on('error', e => errors.push(e));

  await agent.run('spiegami il ledger', emitter);
  assert.equal(errors.length, 1, 'the fallback message must still be shown');
  assert.match(errors[0], /output incoerente/);
});
