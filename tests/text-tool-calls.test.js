import { test } from 'node:test';
import assert from 'node:assert';
import { parseTextToolCalls } from '../src/agents/text-tool-calls.js';
import {
  stripProviderFraming,
  stripToolCallTags,
  filterToolCallStream,
  PARTIAL_TOOL_TAG_RE,
  PARTIAL_FRAMING_RE,
} from '../src/agents/stream-parser.js';

// The exact shape observed in the wild: MiniMax printed its tool-call protocol
// as assistant text, brackets and all, and the turn ended with no tool run.
const REAL_LEAK = [
  ']<]minimax[>[',
  '- ]<]minimax[>[<invoke name="bash">]<]minimax[>[<command>grep -n "google_trends" /home/re77/Scrivania/zp/app.py | head -10]<]minimax[>[</command>]<]minimax[>[</invoke>',
  ']<]minimax[>[]<]minimax[>[<invoke name="read">]<]minimax[>[<file_path>/home/re77/Scrivania/zp/static/style.css]<]minimax[>[</file_path>]<]minimax[>[<offset>1400.0]<]minimax[>[</offset>]<]minimax[>[<limit>100.0]<]minimax[>[</limit>]<]minimax[>[</invoke>',
  ']<]minimax[>[</tool_call>',
].join('\n');

function argsOf(call) {
  return JSON.parse(call.function.arguments);
}

test('parseTextToolCalls recovers the real MiniMax leak', () => {
  const { calls, detected } = parseTextToolCalls(REAL_LEAK);
  assert.equal(detected, true);
  assert.equal(calls.length, 2, `expected 2 calls, got ${JSON.stringify(calls, null, 2)}`);

  assert.equal(calls[0].function.name, 'bash');
  assert.equal(argsOf(calls[0]).command, 'grep -n "google_trends" /home/re77/Scrivania/zp/app.py | head -10');

  assert.equal(calls[1].function.name, 'read');
  const readArgs = argsOf(calls[1]);
  assert.equal(readArgs.file_path, '/home/re77/Scrivania/zp/static/style.css');
  // `1400.0` must land as an integer or the read tool's schema check rejects it.
  assert.strictEqual(readArgs.offset, 1400);
  assert.strictEqual(readArgs.limit, 100);
});

test('parseTextToolCalls emits OpenAI-shaped calls with unique ids', () => {
  const { calls } = parseTextToolCalls(REAL_LEAK);
  const ids = new Set(calls.map(c => c.id));
  assert.equal(ids.size, calls.length);
  for (const call of calls) {
    assert.equal(call.type, 'function');
    assert.equal(typeof call.function.name, 'string');
    assert.equal(typeof call.function.arguments, 'string');
    assert.doesNotThrow(() => JSON.parse(call.function.arguments));
  }
  // Ids must not repeat across recoveries either — the ledger keys tool
  // results by id and a collision orphans a result.
  const second = parseTextToolCalls(REAL_LEAK);
  for (const call of second.calls) assert.ok(!ids.has(call.id), `id reused: ${call.id}`);
});

test('parseTextToolCalls handles <parameter name="…"> bodies', () => {
  const input = '<minimax:tool_call>\n<invoke name="write">\n<parameter name="file_path">/tmp/a.txt</parameter>\n<parameter name="content">hello</parameter>\n</invoke>\n</minimax:tool_call>';
  const { calls } = parseTextToolCalls(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'write');
  assert.deepEqual(argsOf(calls[0]), { file_path: '/tmp/a.txt', content: 'hello' });
});

test('parseTextToolCalls handles the JSON-in-tool_call shape', () => {
  const input = 'sure\n<tool_call>\n{"name": "grep", "arguments": {"pattern": "foo", "path": "src"}}\n</tool_call>';
  const { calls } = parseTextToolCalls(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'grep');
  assert.deepEqual(argsOf(calls[0]), { pattern: 'foo', path: 'src' });
});

test('parseTextToolCalls recovers a truncated final invoke', () => {
  const input = '<tool_call><invoke name="read"><file_path>/tmp/x.js</file_path>';
  const { calls } = parseTextToolCalls(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read');
  assert.deepEqual(argsOf(calls[0]), { file_path: '/tmp/x.js' });
});

test('parseTextToolCalls does not let one unclosed invoke swallow the next', () => {
  const input = '<invoke name="read"><file_path>/a</file_path>\n<invoke name="bash"><command>ls</command></invoke>';
  const { calls } = parseTextToolCalls(input);
  assert.equal(calls.length, 2, `got ${JSON.stringify(calls)}`);
  assert.equal(calls[0].function.name, 'read');
  assert.deepEqual(argsOf(calls[0]), { file_path: '/a' });
  assert.equal(calls[1].function.name, 'bash');
  assert.deepEqual(argsOf(calls[1]), { command: 'ls' });
});

test('parseTextToolCalls decodes XML entities in parameter values', () => {
  const input = '<invoke name="bash"><command>grep &quot;a&amp;b&quot; &lt;file&gt;</command></invoke>';
  const { calls } = parseTextToolCalls(input);
  assert.equal(argsOf(calls[0]).command, 'grep "a&b" <file>');
});

test('parseTextToolCalls preserves indentation inside a value', () => {
  const input = '<invoke name="write">\n<parameter name="content">\n    indented\n      more\n</parameter>\n</invoke>';
  const { calls } = parseTextToolCalls(input);
  assert.equal(argsOf(calls[0]).content, '    indented\n      more');
});

test('parseTextToolCalls reports detected without calls on an unparseable blob', () => {
  const { calls, detected } = parseTextToolCalls('I will now <tool_call> hmm actually never mind');
  assert.equal(calls.length, 0);
  assert.equal(detected, true, 'a bare protocol marker must still be flagged so the model gets nudged');
});

test('parseTextToolCalls ignores ordinary prose', () => {
  const { calls, detected } = parseTextToolCalls('Ho letto il file e la funzione usa <div> per il layout.');
  assert.equal(calls.length, 0);
  assert.equal(detected, false);
});

test('parseTextToolCalls ignores an invoke with an implausible tool name', () => {
  const { calls } = parseTextToolCalls('<invoke name="not a tool!!"><x>1</x></invoke>');
  assert.equal(calls.length, 0);
});

test('stripProviderFraming removes the MiniMax bracket framing', () => {
  const out = stripProviderFraming('prima ]<]minimax[>[ dopo');
  assert.equal(out, 'prima  dopo');
  assert.ok(!stripProviderFraming(REAL_LEAK).includes('minimax[>['));
});

test('stripToolCallTags removes namespaced wrappers and orphan closing tags', () => {
  const out = stripToolCallTags('A <minimax:tool_call>x</minimax:tool_call> B </invoke> C');
  assert.ok(!out.includes('tool_call'), `got: ${out}`);
  assert.ok(!out.includes('invoke'), `orphan close tag should be gone, got: ${out}`);
  assert.ok(out.includes('A') && out.includes('B') && out.includes('C'));
});

test('filterToolCallStream suppresses a block that spans several chunks', () => {
  // Chunk boundaries as the provider actually ships them: the parameter tags
  // arrive on their own, long after the <invoke> that explains them.
  const chunks = REAL_LEAK.split(/(?=\]<\])/);
  let state = false;
  const shown = chunks.map(chunk => {
    const out = filterToolCallStream(chunk, state);
    state = out.inLeak;
    return out.text;
  }).join('');

  assert.ok(shown.includes('- '), `prose before the block must survive: ${JSON.stringify(shown)}`);
  for (const leak of ['<invoke', 'file_path', 'command', 'offset', 'minimax[>[', 'tool_call']) {
    assert.ok(!shown.includes(leak), `${leak} leaked to the UI: ${JSON.stringify(shown)}`);
  }
});

test('filterToolCallStream resumes display after the block closes', () => {
  const first = filterToolCallStream('prima <invoke name="read">', false);
  assert.equal(first.text, 'prima ');
  assert.equal(first.inLeak, true);

  const second = filterToolCallStream('<file_path>/a</file_path>', first.inLeak);
  assert.equal(second.text, '');
  assert.equal(second.inLeak, true);

  const third = filterToolCallStream('</invoke> dopo', second.inLeak);
  assert.equal(third.text, ' dopo');
  assert.equal(third.inLeak, false);
});

test('filterToolCallStream leaves ordinary text alone', () => {
  const out = filterToolCallStream('il selettore <div> usa 3 > 2 ok', false);
  assert.equal(out.text, 'il selettore <div> usa 3 > 2 ok');
  assert.equal(out.inLeak, false);
});

test('filterToolCallStream does not get stuck on a self-closing tag', () => {
  const out = filterToolCallStream('a <tool_call/> b', false);
  assert.equal(out.inLeak, false, 'a self-closing tag opens nothing');
  assert.equal(out.text, 'a  b');
});

test('PARTIAL_FRAMING_RE holds back a split framing marker without eating prose', () => {
  for (const fragment of [']<', ']<]', ']<]minimax', ']<]minimax[', ']<]minimax[>']) {
    assert.ok(PARTIAL_FRAMING_RE.test(`x ${fragment}`), `should hold back ${JSON.stringify(fragment)}`);
  }
  for (const done of ['array[0]', 'lista ]', 'done ]<]minimax[>[']) {
    assert.ok(!PARTIAL_FRAMING_RE.test(done), `should not hold back ${JSON.stringify(done)}`);
  }
});

test('PARTIAL_TOOL_TAG_RE holds back a tool tag split across chunks', () => {
  for (const fragment of ['<', '</', '<inv', '<invoke', '<tool_c', '<minimax:tool_', '</too']) {
    assert.ok(PARTIAL_TOOL_TAG_RE.test(`text ${fragment}`), `should hold back ${JSON.stringify(fragment)}`);
  }
  for (const done of ['plain text', 'a < b comparison ok', '<invoke name="bash">']) {
    assert.ok(!PARTIAL_TOOL_TAG_RE.test(done), `should not hold back ${JSON.stringify(done)}`);
  }
});
