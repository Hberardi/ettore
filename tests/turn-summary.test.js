import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  buildTurnSummary, formatDuration, parseTestCounts, testOutcomeFromTool, turnSummaryText,
} from '../src/app/turn-summary.js';
import { TUI } from '../src/app/tui-native.js';
import { stripAllAnsi } from '../src/utils/ansi.js';

test('test counts are read from the runners people actually use', () => {
  assert.deepEqual(parseTestCounts('# tests 12\n# pass 11\n# fail 1\n'), { passed: 11, failed: 1 });
  assert.deepEqual(parseTestCounts('ℹ tests 3\nℹ pass 3\nℹ fail 0\n'), { passed: 3, failed: 0 });
  assert.deepEqual(parseTestCounts('Tests:       2 failed, 10 passed, 12 total\n'), { passed: 10, failed: 2 });
  assert.deepEqual(parseTestCounts(' Tests  10 passed (10)\n'), { passed: 10, failed: 0 });
  assert.deepEqual(parseTestCounts('===== 3 failed, 12 passed in 0.52s =====\n'), { passed: 12, failed: 3 });
  assert.deepEqual(parseTestCounts('5 passed in 0.10s\n'), { passed: 5, failed: 0 });
  assert.deepEqual(parseTestCounts('  12 passing (40ms)\n  1 failing\n'), { passed: 12, failed: 1 });
  assert.deepEqual(
    parseTestCounts('test result: ok. 5 passed; 0 failed; 0 ignored\ntest result: FAILED. 2 passed; 1 failed; 0 ignored\n'),
    { passed: 7, failed: 1 },
  );
  assert.equal(parseTestCounts('hello world'), null);
});

test('a run_tests result and a shell test command are both recognised', () => {
  assert.deepEqual(
    testOutcomeFromTool('run_tests', { suite: 'auto' }, 'Runner: npm\nResult: PASS\n# pass 4\n# fail 0\n'),
    { passed: true, counts: { passed: 4, failed: 0 } },
  );
  assert.deepEqual(
    testOutcomeFromTool('run_tests', {}, 'Runner: npm\nResult: FAIL\n# pass 3\n# fail 1\n'),
    { passed: false, counts: { passed: 3, failed: 1 } },
  );
  assert.deepEqual(
    testOutcomeFromTool('bash', { command: 'npm test' }, '# pass 3\n# fail 1\n[exit code 1]'),
    { passed: false, counts: { passed: 3, failed: 1 } },
  );
  assert.deepEqual(
    testOutcomeFromTool('bash_session', { command: 'cd api && pytest -q' }, '7 passed in 1.20s'),
    { passed: true, counts: { passed: 7, failed: 0 } },
  );
  // A test command that printed no result is not a test run.
  assert.equal(testOutcomeFromTool('bash', { command: 'npm test -- --help' }, 'Usage: node --test'), null);
  // Counts in the output of something that is not a test command are a coincidence.
  assert.equal(testOutcomeFromTool('bash', { command: 'cat log.txt' }, '# pass 3\n# fail 0'), null);
  assert.equal(testOutcomeFromTool('read', { file_path: 'x' }, '# pass 3'), null);
});

test('durations read the way a person would say them', () => {
  assert.equal(formatDuration(4200), '4s');
  assert.equal(formatDuration(134_000), '2m 14s');
  assert.equal(formatDuration(3_723_000), '1h 02m');
});

const cwd = join('/', 'work', 'project');
const change = (name, status, added, removed, extra = {}) => ({ path: join(cwd, name), status, added, removed, binary: false, ...extra });

test('a request that changed nothing gets no card', () => {
  assert.equal(buildTurnSummary({ changes: [], cwd }), null);
});

test('the card lists the files, the verified test result, the effort and the way back', () => {
  const summary = buildTurnSummary({
    changes: [change(join('src', 'a.js'), 'modified', 36, 4), change('new.md', 'added', 12, 0), change('old.js', 'deleted', 0, 80)],
    gate: 'open',
    test: { passed: true, counts: { passed: 1564, failed: 0 } },
    durationMs: 134_000,
    toolCalls: 18,
    cost: 0.0421,
    cwd,
  });
  assert.equal(turnSummaryText(summary), [
    '3 files changed  +48 −84',
    `  ${join('src', 'a.js')}  +36 −4`,
    '  new.md  new, +12',
    '  old.js  deleted',
    '✓ Tests green: 1564 passed, 0 failed',
    '2m 14s · 18 tool calls · $0.042',
    '/undo takes these changes back',
  ].join('\n'));
});

test('a green run the gate did not confirm is not presented as verified', () => {
  const summary = buildTurnSummary({
    changes: [change('a.js', 'modified', 1, 1)],
    gate: null,
    test: { passed: true, counts: { passed: 9, failed: 0 } },
    cwd,
  });
  assert.equal(summary.tests.state, 'passed_earlier');
  assert.doesNotMatch(turnSummaryText(summary), /✓/);
});

test('an exhausted gate reads as not verified, whatever ran before', () => {
  const summary = buildTurnSummary({
    changes: [change('a.js', 'modified', 1, 1)],
    gate: 'exhausted',
    test: { passed: false, counts: { passed: 8, failed: 1 } },
    cwd,
  });
  assert.match(turnSummaryText(summary), /⚠ NOT verified — tests still failing: 8 passed, 1 failed/);
});

test('a cancelled turn says what it left behind; unknown price falls back to tokens', () => {
  const summary = buildTurnSummary({
    changes: [change('a.js', 'modified', 2, 0), change('big.bin', 'unknown', 0, 0)],
    outcome: 'cancelled',
    durationMs: 9000,
    toolCalls: 1,
    cost: null,
    tokens: { input: 12_400, output: 800 },
    cwd,
  });
  const text = turnSummaryText(summary);
  assert.match(text, /^Cancelled — 2 files changed {2}\+2 so far/);
  assert.match(text, /9s · 1 tool call · 12\.4k in \/ 800 out/);
  assert.match(text, /\/undo takes back 1 of these 2 files/);
});

test('a long list of files is counted rather than printed', () => {
  const changes = Array.from({ length: 11 }, (_, i) => change(`f${String(i).padStart(2, '0')}.js`, 'modified', 1, 0));
  const summary = buildTurnSummary({ changes, cwd });
  assert.equal(summary.files.length, 8);
  assert.match(turnSummaryText(summary), /… and 3 more/);
  assert.match(turnSummaryText(summary), /^11 files changed {2}\+11/);
});

test('the card fits the width it is given, and keeps a long path readable by its file name', () => {
  const tui = new TUI();
  const long = join('src', 'a', 'very', 'long', 'path', 'that', 'goes', 'on', 'and', 'on', 'component-with-a-long-name.js');
  const summary = buildTurnSummary({
    changes: [change(long, 'modified', 3, 1), change('b.js', 'added', 120, 0), change('logo.png', 'modified', 0, 0, { binary: true })],
    gate: 'exhausted',
    test: { passed: false, counts: { passed: 8, failed: 1 } },
    durationMs: 61_000,
    toolCalls: 40,
    cost: 1.234,
    cwd,
  });
  for (const width of [44, 60, 80, 140]) {
    const lines = tui._renderMessageFull({ role: 'system', kind: 'turn-summary', summary, text: turnSummaryText(summary) }, width);
    for (const line of lines) {
      assert.ok(tui._visualLen(line) <= width, `width ${width}: "${stripAllAnsi(line)}" is ${tui._visualLen(line)} wide`);
    }
    const plain = lines.map(stripAllAnsi).join('\n');
    assert.match(plain, /TURN DONE/);
    assert.match(plain, /long-name\.js/, 'the end of the path survives');
    assert.match(plain, /\/undo/);
  }
});

test('the token totals start at zero, so adding usage to them gives a number', () => {
  const tui = new TUI();
  assert.equal(tui.inputTokensTotal, 0);
  assert.equal(tui.outputTokensTotal, 0);
  tui.inputTokensTotal += 1200;
  tui.outputTokensTotal += 40;
  assert.equal(stripAllAnsi(tui._statusCostText()).includes('NaN'), false);
});
