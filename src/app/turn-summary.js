// The card shown when a request is over: what changed, whether the tests
// passed, what it took.
//
// A request ends with the model's own account of what it did. That account is
// prose, and it is the model's — "updated the handler and all tests pass" is
// a sentence whether or not either half is true. The card is the harness's
// account of the same turn, from things it measured: the files as they are
// now against the files as they were (src/agents/checkpoints.js), the output
// of the test run, the clock and the token meter.
//
// Everything here is plain data and plain text so it can be tested without a
// terminal; src/app/tui-native.js gives it colour.

import { displayPath } from '../agents/checkpoints.js';

// Commands that run a project's test suite, when the model does it through
// the shell rather than through run_tests.
const TEST_COMMAND_RE = /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|npx\s+(?:jest|vitest|mocha)\b|(?:jest|vitest|mocha|pytest)\b|python3?\s+-m\s+(?:pytest|unittest)\b|go\s+test\b|cargo\s+test\b|node\s+--test\b)/;

const lastMatch = (text, re) => {
  let found = null;
  for (const match of text.matchAll(re)) found = match;
  return found;
};

/** Passed and failed counts as the runner printed them, or null. */
export function parseTestCounts(output) {
  const text = String(output || '');
  const number = (re) => {
    const match = lastMatch(text, re);
    return match ? Number(match[1]) : null;
  };
  const pair = (passed, failed) => (passed === null && failed === null
    ? null
    : { passed: passed ?? 0, failed: failed ?? 0 });

  // node --test: TAP (`# pass 12`) or the spec reporter (`ℹ pass 12`).
  const node = pair(number(/^[#ℹ] pass (\d+)\s*$/gm), number(/^[#ℹ] fail (\d+)\s*$/gm));
  if (node) return node;

  // cargo prints one result line per test binary.
  const cargo = [...text.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed/gm)];
  if (cargo.length) {
    return cargo.reduce((sum, m) => ({ passed: sum.passed + Number(m[1]), failed: sum.failed + Number(m[2]) }), { passed: 0, failed: 0 });
  }

  // jest and vitest: `Tests:  2 failed, 10 passed, 12 total` / `Tests  10 passed (10)`.
  const summary = lastMatch(text, /^\s*Tests:?\s+(.+)$/gm);
  if (summary) {
    const passed = /(\d+) passed/.exec(summary[1]);
    const failed = /(\d+) failed/.exec(summary[1]);
    if (passed || failed) return { passed: Number(passed?.[1] || 0), failed: Number(failed?.[1] || 0) };
  }

  // pytest: `=== 3 failed, 12 passed in 0.52s ===`.
  const pytest = lastMatch(text, /^=*\s*((?:\d+ \w+,? ?)+) in [\d.]+s/gm);
  if (pytest) {
    const passed = /(\d+) passed/.exec(pytest[1]);
    const failed = /(\d+) failed/.exec(pytest[1]);
    const errors = /(\d+) errors?/.exec(pytest[1]);
    if (passed || failed || errors) {
      return { passed: Number(passed?.[1] || 0), failed: Number(failed?.[1] || 0) + Number(errors?.[1] || 0) };
    }
  }

  // mocha: `12 passing`, `1 failing`.
  const mocha = pair(number(/^\s*(\d+) passing\b/gm), number(/^\s*(\d+) failing\b/gm));
  if (mocha) return mocha;

  return null;
}

/**
 * What a finished tool call says about the project's tests, or null when it
 * was not a test run.
 *
 * @returns {null | {passed: boolean, counts: null | {passed: number, failed: number}}}
 */
export function testOutcomeFromTool(name, args = {}, output = '') {
  const text = String(output || '');
  if (name === 'run_tests') {
    const result = /^Result:\s*(PASS|FAIL|TIMEOUT)/m.exec(text)?.[1];
    if (!result) return null;
    return { passed: result === 'PASS', counts: parseTestCounts(text) };
  }
  if (name === 'bash' || name === 'bash_session') {
    if (!TEST_COMMAND_RE.test(String(args?.command || ''))) return null;
    const counts = parseTestCounts(text);
    // No counts, no claim: `npm test --help` and a suite that never started
    // both match the command and neither is a test run.
    if (!counts) return null;
    const failedExit = /\[exit code:? [1-9]\d*\]|\[timeout\b|\[killed by signal/.test(text);
    return { passed: !failedExit && counts.failed === 0, counts };
  }
  return null;
}

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatCost(cost) {
  if (!Number.isFinite(cost)) return '';
  if (cost < 0.0005) return '$0.000';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// More files than this are counted, not listed: the card is a summary.
const MAX_FILES_SHOWN = 8;

/**
 * @param {object} input
 * @param {Array} input.changes from CheckpointStore.changes()
 * @param {'completed'|'cancelled'|'failed'} input.outcome
 * @param {null|'open'|'exhausted'} input.gate the release gate's last word
 * @param {null|{passed: boolean, counts: object|null}} input.test the last test run seen
 * @param {number} input.durationMs
 * @param {number} input.toolCalls
 * @param {number|null} input.cost null when the provider's price is not known
 * @param {{input: number, output: number}} input.tokens
 * @returns {null | object} null when the request changed no file: a question
 *   answered needs no receipt.
 */
export function buildTurnSummary({
  changes = [],
  outcome = 'completed',
  gate = null,
  test = null,
  durationMs = 0,
  toolCalls = 0,
  cost = null,
  tokens = { input: 0, output: 0 },
  cwd = process.cwd(),
} = {}) {
  if (!changes.length) return null;
  const files = changes.map(change => ({ ...change, path: displayPath(change.path, cwd) }));
  const undoable = files.filter(file => file.status !== 'unknown').length;

  let tests = null;
  if (gate === 'exhausted') {
    tests = { state: 'unverified', counts: test?.counts || null };
  } else if (test) {
    // The gate opening is what makes a green run a statement about the code
    // as it is now; without it the run may predate the last edit.
    tests = { state: test.passed ? (gate === 'open' ? 'passed' : 'passed_earlier') : 'failed', counts: test.counts };
  }

  return {
    outcome,
    files: files.slice(0, MAX_FILES_SHOWN),
    hiddenFiles: Math.max(0, files.length - MAX_FILES_SHOWN),
    totals: {
      files: files.length,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
    },
    tests,
    durationMs,
    toolCalls,
    cost,
    tokens,
    undoable,
    notUndoable: files.length - undoable,
  };
}

export function fileNote(file) {
  if (file.status === 'unknown') return 'changed';
  if (file.binary) return file.status === 'added' ? 'new, binary' : file.status === 'deleted' ? 'deleted' : 'binary';
  if (file.status === 'deleted') return 'deleted';
  const counts = [file.added ? `+${file.added}` : '', file.removed ? `−${file.removed}` : ''].filter(Boolean).join(' ');
  return file.status === 'added' ? `new${counts ? `, ${counts}` : ''}` : counts || 'changed';
}

export function testsLine(tests) {
  if (!tests) return null;
  const counts = tests.counts
    ? `${tests.counts.passed} passed, ${tests.counts.failed} failed`
    : '';
  switch (tests.state) {
    case 'passed':
      return { tone: 'ok', text: `✓ Tests green${counts ? `: ${counts}` : ''}` };
    case 'passed_earlier':
      return { tone: 'dim', text: `Tests ran${counts ? `: ${counts}` : ' and passed'}` };
    case 'failed':
      return { tone: 'err', text: `✗ Tests failing${counts ? `: ${counts}` : ''}` };
    default:
      return { tone: 'warn', text: `⚠ NOT verified — tests still failing${counts ? `: ${counts}` : ''}` };
  }
}

export function headline(summary) {
  const { files, added, removed } = summary.totals;
  const counts = [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' ');
  const what = `${files} file${files === 1 ? '' : 's'} changed${counts ? `  ${counts}` : ''}`;
  if (summary.outcome === 'cancelled') return `Cancelled — ${what} so far`;
  if (summary.outcome === 'failed') return `Stopped by an error — ${what} so far`;
  return what;
}

export function effortLine(summary) {
  const parts = [formatDuration(summary.durationMs)];
  if (summary.toolCalls) parts.push(`${summary.toolCalls} tool call${summary.toolCalls === 1 ? '' : 's'}`);
  if (Number.isFinite(summary.cost)) parts.push(formatCost(summary.cost));
  else if (summary.tokens?.input || summary.tokens?.output) {
    parts.push(`${formatTokens(summary.tokens.input || 0)} in / ${formatTokens(summary.tokens.output || 0)} out`);
  }
  return parts.join(' · ');
}

export function undoLine(summary) {
  if (!summary.undoable) return 'These changes cannot be taken back with /undo';
  return summary.notUndoable
    ? `/undo takes back ${summary.undoable} of these ${summary.totals.files} files`
    : '/undo takes these changes back';
}

/** The card as plain lines, for logs and for anything that reads `msg.text`. */
export function turnSummaryText(summary) {
  const lines = [headline(summary)];
  for (const file of summary.files) lines.push(`  ${file.path}  ${fileNote(file)}`);
  if (summary.hiddenFiles) lines.push(`  … and ${summary.hiddenFiles} more`);
  const tests = testsLine(summary.tests);
  if (tests) lines.push(tests.text);
  lines.push(effortLine(summary));
  lines.push(undoLine(summary));
  return lines.join('\n');
}
