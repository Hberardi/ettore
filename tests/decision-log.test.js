import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import {
  DECISION_BLOCK_RE,
  DECISION_CAPTURE_RE,
  PARTIAL_TAG_OPEN_RE,
  PARTIAL_TAG_CLOSE_RE,
  stripMarkers,
} from '../src/agents/stream-parser.js';

function makeEmitter() {
  const emitter = new EventEmitter();
  const decisions = [];
  emitter.on('decision', d => decisions.push(d));
  return { emitter, decisions };
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

test('DECISION_BLOCK_RE matches well-formed decision blocks', () => {
  // DECISION_BLOCK_RE has no `g` flag, so `.test()` is not stateful.
  // (If it did, lastIndex would carry across calls and the second
  // .test() on a shorter string would silently fail.)
  assert.ok(DECISION_BLOCK_RE.test('<decision>chose X</decision>'));
  assert.ok(DECISION_BLOCK_RE.test('<DECISION>chose X</DECISION>'));
  assert.ok(DECISION_BLOCK_RE.test('< decision >x</ decision >'));
});

test('DECISION_CAPTURE_RE captures the body', () => {
  // DECISION_CAPTURE_RE carries the `g` flag because it is consumed by
  // `String.prototype.matchAll` in agents/index.js. Use matchAll here
  // so the test matches the production usage; `.match()` with a
  // global regex would return full matches WITHOUT capture groups.
  const matches = [...'<decision>I went with X because Y</decision>'.matchAll(DECISION_CAPTURE_RE)];
  assert.equal(matches.length, 1);
  assert.match(matches[0][1], /I went with X/);
});

test('PARTIAL_TAG_OPEN_RE: holds back partial decision tags during streaming', () => {
  // All partial inputs end WITHOUT a closing `>` — the regex is anchored
  // to the end of the string, and `>` is not a word/colon/hyphen char
  // the attr suffix would consume. (See the test for <plan> in
  // stream-buffer.test.js for the same pattern.)
  assert.ok(PARTIAL_TAG_OPEN_RE.test('text <deci'));
  assert.ok(PARTIAL_TAG_OPEN_RE.test('text <decis'));
  assert.ok(PARTIAL_TAG_OPEN_RE.test('text <decisi'));
  assert.ok(PARTIAL_TAG_OPEN_RE.test('text <decisio'));
  // The full tag is complete; the holdback releases.
  assert.ok(!PARTIAL_TAG_OPEN_RE.test('text <decision>'));
});

test('PARTIAL_TAG_CLOSE_RE: holds back partial closing decision tags', () => {
  assert.ok(PARTIAL_TAG_CLOSE_RE.test('text <\\'));
  assert.ok(PARTIAL_TAG_CLOSE_RE.test('text <\\/'));
  assert.ok(PARTIAL_TAG_CLOSE_RE.test('text <\\/deci'));
  assert.ok(PARTIAL_TAG_CLOSE_RE.test('text <\\/decision'));
});

test('stripMarkers removes decision blocks', () => {
  const input = 'before <decision>x</decision> after';
  const out = stripMarkers(input);
  assert.ok(!out.includes('<decision>'));
  assert.ok(out.includes('before'));
  assert.ok(out.includes('after'));
});

test('Agent: emits decision event and populates workingMemory.decisions', async () => {
  const client = {
    async turn() {
      return {
        type: 'text',
        content: 'I went with PostgreSQL because it is what the team already knows.\n<decision>chose PostgreSQL over MySQL: team familiarity, mature tooling, and the migration scripts already exist in repo.</decision>',
      };
    },
  };
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter, decisions } = makeEmitter();
  await agent.run('pick a database', emitter);
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].text, /chose PostgreSQL/);
  assert.ok(decisions[0].at);
  // Working memory is populated.
  const wm = agent.getWorkingMemorySnapshot();
  assert.equal(wm.decisions.length, 1);
  assert.match(wm.decisions[0].text, /chose PostgreSQL/);
});

test('Agent: multiple decision blocks in one turn are all captured', async () => {
  const client = {
    async turn() {
      return {
        type: 'text',
        content: [
          'first <decision>picked X</decision>',
          'middle <decision>picked Y because Z</decision>',
          'tail <decision>picked W last</decision>',
        ].join('\n'),
      };
    },
  };
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter, decisions } = makeEmitter();
  await agent.run('do things', emitter);
  assert.equal(decisions.length, 3);
  assert.match(decisions[0].text, /picked X/);
  assert.match(decisions[1].text, /picked Y/);
  assert.match(decisions[2].text, /picked W/);
});

test('Agent: empty decision blocks are dropped', async () => {
  const client = {
    async turn() {
      return { type: 'text', content: 'a <decision>   </decision> b <decision>real one</decision> c' };
    },
  };
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter, decisions } = makeEmitter();
  await agent.run('hi', emitter);
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].text, /real one/);
});

test('Agent: decision list is capped at 32 entries (oldest dropped)', async () => {
  let turn = 0;
  const client = {
    async turn() {
      turn++;
      // Each turn emits one new decision, plus a fixed prefix.
      const body = Array.from({ length: 5 }, (_, i) => `<decision>turn ${turn} step ${i}</decision>`).join('\n');
      return { type: 'text', content: body };
    },
  };
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter } = makeEmitter();
  // Run enough turns to exceed the cap.
  for (let i = 0; i < 10; i++) {
    await agent.run('keep going', emitter);
  }
  const wm = agent.getWorkingMemorySnapshot();
  assert.ok(wm.decisions.length <= 32, `cap exceeded: ${wm.decisions.length}`);
  // The most recent entries are preserved (FIFO eviction).
  const last = wm.decisions[wm.decisions.length - 1];
  assert.match(last.text, /turn 10/);
});

test('Agent: decision text is truncated at 1000 chars', async () => {
  const longText = 'a'.repeat(2000);
  const client = {
    async turn() {
      return { type: 'text', content: `<decision>${longText}</decision>` };
    },
  };
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter, decisions } = makeEmitter();
  await agent.run('hi', emitter);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].text.length, 1000);
});

test('Agent: no decision event when no decision markers in output', async () => {
  const client = {
    async turn() {
      return { type: 'text', content: 'Just a normal reply without any markers.' };
    },
  };
  const agent = new Agent(client, agentConfig(process.cwd()));
  const { emitter, decisions } = makeEmitter();
  await agent.run('hi', emitter);
  assert.equal(decisions.length, 0);
});
