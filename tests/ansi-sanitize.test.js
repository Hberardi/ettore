// Comprehensive test for src/utils/ansi.js — covers every orphan/well-formed
// case we've seen leak into the TUI.
//
// Run:  node tests/ansi-sanitize.test.js

import { stripAllAnsi, stripOrphans } from '../src/utils/ansi.js';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, fn, input, expected) {
  const actual = fn(input);
  if (actual === expected) {
    passed++;
    process.stdout.write(`${GREEN}.${RESET}`);
  } else {
    failed++;
    failures.push({ label, input, expected, actual });
    process.stdout.write(`${RED}F${RESET}`);
  }
}

// ── stripAllAnsi ──────────────────────────────────────────────────────────
// Should remove ALL ANSI and orphans. Output must be plain text only.

// Well-formed SGR
check('all/well-formed-256', stripAllAnsi, '\x1b[38;5;150mhello\x1b[0m', 'hello');
check('all/well-formed-truecolor', stripAllAnsi, '\x1b[38;2;255;0;0mhi\x1b[0m', 'hi');
check('all/well-formed-bold', stripAllAnsi, '\x1b[1mbold\x1b[0m', 'bold');
check('all/well-formed-multi', stripAllAnsi, '\x1b[1;31mhi\x1b[0m', 'hi');
check('all/well-formed-cursor', stripAllAnsi, '\x1b[2J\x1b[Hclear', 'clear');
check('all/well-formed-osc', stripAllAnsi, '\x1b]0;title\x07rest', 'rest');

// Orphan no-bracket (model emits raw SGR text)
check('all/orphan-256', stripAllAnsi, '38;5;150mhello', 'hello');
check('all/orphan-203m-word', stripAllAnsi, '38;5;203mfrom backtest', 'from backtest');
check('all/orphan-quote', stripAllAnsi, 'metodo 38;5;150m"vincente" garantito', 'metodo "vincente" garantito');
check('all/orphan-paren', stripAllAnsi, 'finale = 38;5;150m(ritardo × 0.4)', 'finale = (ritardo × 0.4)');
check('all/orphan-backtick', stripAllAnsi, '38;5;150m`python', '`python');
check('all/orphan-truecolor', stripAllAnsi, '38;2;255;0;0mhi', 'hi');
check('all/orphan-truncated-256', stripAllAnsi, 'aggiunta a 38;5; /api/auth_router', 'aggiunta a  /api/auth_router');
check('all/orphan-reset', stripAllAnsi, '0mtext', 'text');
check('all/orphan-multi', stripAllAnsi, '1;31mhello', 'hello');

// Orphan with leading bracket
check('all/bracket-256', stripAllAnsi, '[38;5;150mhello', 'hello');
check('all/bracket-256-filename-sentence', stripAllAnsi,
  'Ho rifatto da zero il [38;5;150mbacktest_simulator.py per testare i metodi reali dell\'app (non metodi generici).',
  'Ho rifatto da zero il backtest_simulator.py per testare i metodi reali dell\'app (non metodi generici).');
check('all/bracket-reset', stripAllAnsi, '[0mtext', 'text');
check('all/bracket-multi', stripAllAnsi, '[1;31mtext', 'text');
check('all/bracket-residue', stripAllAnsi, '[150mhello', 'hello');

// Inside Italian/Python intent contexts (real cases from user reports)
check('all/intent-bash', stripAllAnsi,
  'eseguo cd /home/x && python3 -c " 38;5;203mfrom backtest_simulato',
  'eseguo cd /home/x && python3 -c " from backtest_simulato');
check('all/intent-quote', stripAllAnsi,
  'L\'estensione 38;5;150m.chm è un formato obsoleto',
  'L\'estensione .chm è un formato obsoleto');

// Escaped string forms (LLM types the literal escape)
check('all/escaped-x1b', stripAllAnsi, '\\x1b[38;5;150mhello', 'hello');
check('all/escaped-u001b', stripAllAnsi, '\\u001b[38;5;150mhello', 'hello');

// Chunk-boundary residues
check('all/chunk-leftover-bracket', stripAllAnsi, 'pre [150m post', 'pre  post');
check('all/chunk-leftover-semicolon', stripAllAnsi, 'pre 5;150m post', 'pre  post');

// Must NOT touch legitimate text
check('all/keep-line-ref', stripAllAnsi, 'lotto_analyzer_v2.py:80-153', 'lotto_analyzer_v2.py:80-153');
check('all/keep-port', stripAllAnsi, 'port 8080', 'port 8080');
check('all/keep-time', stripAllAnsi, 'duration 123ms', 'duration 123ms');
check('all/keep-measurement', stripAllAnsi, '300mg of caffeine', '300mg of caffeine');
check('all/keep-race', stripAllAnsi, 'the 100m sprint', 'the 100m sprint');
check('all/keep-newline', stripAllAnsi, 'line1\nline2', 'line1\nline2');
check('all/keep-tab', stripAllAnsi, 'a\tb', 'a\tb');
check('all/keep-quotes', stripAllAnsi, 'just "quoted" text', 'just "quoted" text');
check('all/keep-version', stripAllAnsi, 'v1.2.3', 'v1.2.3');

// Edge cases
check('all/empty', stripAllAnsi, '', '');
check('all/null', stripAllAnsi, null, '');
check('all/undefined', stripAllAnsi, undefined, '');
check('all/number', stripAllAnsi, 42, '42');
check('all/only-ansi', stripAllAnsi, '\x1b[38;5;150m\x1b[0m', '');
check('all/multiple-orphans', stripAllAnsi, '38;5;150m38;5;200m38;5;100m', '');
check('all/mixed-real-and-orphan', stripAllAnsi, '\x1b[31mreal\x1b[0m 38;5;150morphan', 'real orphan');

// ── stripOrphans ──────────────────────────────────────────────────────────
// Should preserve well-formed ESC[...m but kill orphans.

check('orph/keep-well-formed', stripOrphans, '\x1b[38;5;150mcolored\x1b[0m', '\x1b[38;5;150mcolored\x1b[0m');
check('orph/kill-orphan', stripOrphans, '38;5;150mfoo', 'foo');
check('orph/kill-bracket', stripOrphans, '[38;5;150mfoo', 'foo');
check('orph/mixed', stripOrphans,
  '\x1b[31m38;5;150m\x1b[0m',
  '\x1b[31m\x1b[0m'
);
check('orph/preserve-cursor', stripOrphans, '\x1b[2J\x1b[Hcontent', '\x1b[2J\x1b[Hcontent');
check('orph/preserve-tab-keep', stripOrphans, 'a\tb', 'a\tb');
check('orph/keep-line-ref', stripOrphans, 'file.py:80-153', 'file.py:80-153');
check('orph/kill-truncated-256', stripOrphans, 'a 38;5; /api b', 'a  /api b');
check('orph/kill-multi-orphan', stripOrphans, 'a 1;31m b 38;5;100m c', 'a  b  c');

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`\n${RED}Failures:${RESET}`);
  for (const f of failures) {
    console.log(`\n  ${DIM}${f.label}${RESET}`);
    console.log(`    in : ${JSON.stringify(f.input)}`);
    console.log(`    exp: ${JSON.stringify(f.expected)}`);
    console.log(`    got: ${JSON.stringify(f.actual)}`);
  }
  process.exit(1);
}
