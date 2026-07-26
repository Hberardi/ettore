import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripMarkers,
  stripThinkTags,
  stripToolCallTags,
  parseTodoBlock,
  extractMarkdownTodoList,
  TODO_CAPTURE_RE,
  DONE_MARKER_RE,
  THINK_OPEN_RE,
  THINK_CLOSE_RE,
  PARTIAL_TAG_OPEN_RE,
  PARTIAL_TAG_CLOSE_RE,
} from '../src/agents/stream-parser.js';

test('stripMarkers removes think blocks, todo blocks, and done markers', () => {
  const input = 'before <think>secret</think> mid <todo>\n1. a\n2. b\n</todo>\nafter <done:1>\ntail';
  const out = stripMarkers(input);
  assert.ok(!out.includes('<think>'));
  assert.ok(!out.includes('<todo>'));
  assert.ok(!out.includes('<done:'));
  assert.ok(out.includes('before'));
  assert.ok(out.includes('mid'));
  assert.ok(out.includes('after'));
  assert.ok(out.includes('tail'));
});

test('stripMarkers tolerates whitespace and case variants', () => {
  const input = '<THINKING >x</thinking> <TODO>\n1. a\n2. b\n3. c</TODO> <DONE : 2 />';
  const out = stripMarkers(input);
  assert.equal(out.trim(), '');
});

test('stripMarkers removes standalone reasoning tags', () => {
  assert.equal(stripMarkers('answer</think>'), 'answer');
  assert.equal(stripMarkers('</reasoning>answer'), 'answer');
});

test('stripThinkTags removes tags without removing their surrounding text', () => {
  assert.equal(stripThinkTags('before</think>after'), 'beforeafter');
  assert.equal(stripThinkTags('<Think attr="x">text'), 'text');
});

test('stripMarkers returns input unchanged when no markers', () => {
  assert.equal(stripMarkers('plain text'), 'plain text');
  assert.equal(stripMarkers(''), '');
  assert.equal(stripMarkers(null), null);
});

test('parseTodoBlock strips numbering and blank lines', () => {
  const items = parseTodoBlock('\n1. First step\n2.  Second\n\n3. Third\n');
  assert.deepEqual(items, ['First step', 'Second', 'Third']);
});

test('extractMarkdownTodoList detects sequential list >=3', () => {
  const md = '1. one\n2. two\n3. three\n\nprose after';
  assert.deepEqual(extractMarkdownTodoList(md), ['one', 'two', 'three']);
});

test('extractMarkdownTodoList rejects broken sequence', () => {
  assert.equal(extractMarkdownTodoList('1. a\n3. c\n'), null);
});

test('extractMarkdownTodoList rejects <3 items', () => {
  assert.equal(extractMarkdownTodoList('1. a\n2. b\n'), null);
});

test('TODO_CAPTURE_RE captures content', () => {
  const m = '<todo>\n1. x\n</todo>'.match(TODO_CAPTURE_RE);
  assert.ok(m);
  assert.ok(m[1].includes('1. x'));
});

test('DONE_MARKER_RE finds all done markers', () => {
  const matches = [...'<done:1>\n<done:2>\n<done:3>'.matchAll(DONE_MARKER_RE)];
  assert.equal(matches.length, 3);
});

test('THINK_OPEN_RE / THINK_CLOSE_RE match all variants', () => {
  assert.ok('<think>'.match(THINK_OPEN_RE));
  assert.ok('<thinking>'.match(THINK_OPEN_RE));
  assert.ok('<reasoning>'.match(THINK_OPEN_RE));
  assert.ok('</think>'.match(THINK_CLOSE_RE));
  assert.ok('</REASONING>'.match(THINK_CLOSE_RE));
});

test('PARTIAL_TAG regexes detect incomplete tags at buffer end', () => {
  assert.ok(PARTIAL_TAG_OPEN_RE.test('text <todo'));
  assert.ok(PARTIAL_TAG_CLOSE_RE.test('text </tod'));
  assert.ok(!PARTIAL_TAG_OPEN_RE.test('text <todo>'));
});

test('stripToolCallTags removes Qwen/Mistral-style <tool_call>…</tool_call> with nested <invoke>', () => {
  const input = 'before <tool_call>\n<invoke name="read">\n<file_path>x</file_path>\n</invoke>\n</tool_call> after';
  const out = stripToolCallTags(input);
  assert.ok(!out.includes('tool_call'), `tool_call should be gone, got: ${out}`);
  assert.ok(!out.includes('<invoke'), `nested invoke should be gone, got: ${out}`);
  assert.ok(out.includes('before'));
  assert.ok(out.includes('after'));
});

test('stripToolCallTags removes <invoke name="…"> blocks', () => {
  const input = 'noise <invoke name="bash">\nls -la\n</invoke> tail';
  const out = stripToolCallTags(input);
  assert.ok(!out.includes('<invoke'), `invoke should be gone, got: ${out}`);
  assert.ok(!out.includes('ls -la'), `inner content should be gone, got: ${out}`);
  assert.ok(out.startsWith('noise '), `should keep 'noise' prefix, got: ${out}`);
  assert.ok(out.endsWith('tail'), `should keep 'tail' suffix, got: ${out}`);
});

test('stripToolCallTags removes <function_calls> wrappers with nested invokes', () => {
  const input = 'pre <function_calls>\n<invoke name="read">\n</invoke>\n</function_calls> post';
  const out = stripToolCallTags(input);
  assert.ok(!out.includes('<function_calls'), `function_calls should be gone, got: ${out}`);
  assert.ok(!out.includes('<invoke'), `nested invoke should be gone, got: ${out}`);
  assert.ok(out.includes('pre'));
  assert.ok(out.includes('post'));
});

test('stripToolCallTags removes self-closing tool tags', () => {
  const out1 = stripToolCallTags('text <tool_call/> more');
  assert.equal(out1, 'text  more', `got: ${JSON.stringify(out1)}`);

  const out2 = stripToolCallTags('text <invoke name="bash"/> more');
  assert.equal(out2, 'text  more', `got: ${JSON.stringify(out2)}`);
});

test('stripToolCallTags handles the MiniMax M2.7 leak pattern with ZWJ/VS', () => {
  // Real leak shape seen in the wild:
  //   ]<]minimax[>[<tool_call>…</tool_call>
  // The regex strips the <tool_call>…</tool_call> portion. The leading
  // `]<]minimax[>[` prefix is part of the provider's framing and is left in
  // place — that's OK because the user can still see what came before/after.
  // Build the string explicitly with Unicode escapes so the test source
  // doesn't depend on invisible characters being preserved by editors.
  const zwj = '\u200D';
  const input = `answer  ${zwj}${zwj}<tool_call>\n<invoke name="read">x</invoke>\n${zwj}${zwj}</tool_call> end`;
  const out = stripToolCallTags(input);
  assert.ok(!out.includes('tool_call'), `tool_call should be gone, got: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('<invoke'), `nested invoke should be gone, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes('answer'), `answer prefix should remain, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes('end'), `end suffix should remain, got: ${JSON.stringify(out)}`);
  assert.ok(!/<\s*\/?\s*tool_call/i.test(out), `tool_call delimiters should be gone, got: ${JSON.stringify(out)}`);
});

test('stripToolCallTags handles ZWJ between every delimiter and tag name', () => {
  // Most aggressive version: ZWJ (U+200D) and variation selectors (U+FE0F)
  // between every delimiter and tag identifier. JS \s does NOT include
  // these, so a naive `<\s*…` regex would miss this. The real MiniMax
  // output ships with exactly this kind of padding.
  const zwj = '\u200D';
  const vs  = '\uFE0F';
  const input = `A<${zwj}tool_call${vs}>\nX\n</${vs}${zwj}tool_call> ZW<${vs}invoke${zwj} name="bash">Y</${zwj}${vs}invoke> B`;
  const out = stripToolCallTags(input);
  assert.ok(!out.includes('tool_call'), `tool_call should be gone, got: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('<invoke'), `invoke should be gone, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes('A'), `A prefix should remain, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes('B'), `B suffix should remain, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes('ZW'), `middle text should remain, got: ${JSON.stringify(out)}`);
});

test('stripToolCallTags is case- and whitespace-tolerant', () => {
  const out = stripToolCallTags('A <TOOL_CALL >\nx\n</TOOL_CALL > B');
  assert.equal(out, 'A  B', `got: ${JSON.stringify(out)}`);
});

test('stripToolCallTags does NOT touch the generic <tool> tag (intentional)', () => {
  // `<tool>` alone is intentionally excluded — it collides with normal prose
  // about tools and with the existing think-tag-streaming invariant.
  const out = stripToolCallTags('discussing <tool>frameworks</tool> here');
  assert.equal(out, 'discussing <tool>frameworks</tool> here',
    `generic <tool> must pass through unchanged, got: ${out}`);
});

test('stripToolCallTags handles multiple separate tool_call blocks', () => {
  const input = 'first <tool_call>\nA\n</tool_call> middle <tool_call>\nB\n</tool_call> end';
  const out = stripToolCallTags(input);
  assert.ok(!out.includes('tool_call'), `tool_call should be gone, got: ${out}`);
  assert.ok(out.includes('first'));
  assert.ok(out.includes('middle'));
  assert.ok(out.includes('end'));
});

test('stripToolCallTags is a no-op when there are no tool-call fragments', () => {
  assert.equal(stripToolCallTags('plain response with no leaks'), 'plain response with no leaks');
  assert.equal(stripToolCallTags(''), '');
  assert.equal(stripToolCallTags(null), null);
});
