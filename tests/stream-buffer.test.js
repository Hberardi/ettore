// Verifies that streaming-buffer logic neutralizes orphan codes caused by
// ANSI sequences split across chunk boundaries.
//
// Run: node tests/stream-buffer.test.js

import { stripAllAnsi } from '../src/utils/ansi.js';

// Replicate splitStreamBuffer from native-ui.js (kept in sync).
const splitStreamBuffer = (buf) => {
  if (!buf) return { safe: '', held: '' };
  const N = buf.length;
  let holdFrom = N;
  const patterns = [
    /\x1b[^A-Za-z@]*$/,
    /\[[0-9;:?]*$/,
    /\\(?:u[0-9a-f]{0,4}|x[0-9a-f]{0,2})(?:\[[0-9;:]*)?$/i,
    /\d{1,3}(?:;\d{0,3})*;?$/,
  ];
  for (const re of patterns) {
    const m = buf.match(re);
    if (m && m.index < holdFrom) holdFrom = m.index;
  }
  if (N - holdFrom > 40) holdFrom = N - 40;
  return { safe: buf.slice(0, holdFrom), held: buf.slice(holdFrom) };
};

function runStream(chunks) {
  let buffer = '';
  let output = '';
  for (const c of chunks) {
    buffer += c;
    const { safe, held } = splitStreamBuffer(buffer);
    buffer = held;
    output += stripAllAnsi(safe);
  }
  output += stripAllAnsi(buffer); // final flush
  return output;
}

let passed = 0, failed = 0;
const failures = [];

function check(label, chunks, expected) {
  const got = runStream(chunks);
  if (got === expected) {
    passed++;
    process.stdout.write('.');
  } else {
    failed++;
    failures.push({ label, chunks, expected, got });
    process.stdout.write('F');
  }
}

// Whole-sequence chunks
check('whole-ansi', ['hello \x1b[31mworld\x1b[0m'], 'hello world');
check('whole-orphan', ['38;5;150mtext'], 'text');

// Split at ESC
check('split-at-esc',
  ['hello \x1b', '[31mworld\x1b[0m'],
  'hello world'
);

// Split inside CSI params
check('split-in-csi-params',
  ['hello \x1b[38;5;', '203mfrom backtest'],
  'hello from backtest'
);

// Split right after `[`
check('split-after-bracket',
  ['hello \x1b[', '38;5;203mfoo'],
  'hello foo'
);

// Split at `m` boundary
check('split-at-final-m',
  ['hello \x1b[38;5;203', 'mfoo'],
  'hello foo'
);

// Orphan split (no ESC) — the original bug
check('orphan-split-1',
  ['metodo ', '38;5;', '150m"vincente" garantito'],
  'metodo "vincente" garantito'
);

check('orphan-split-2',
  ['Punteggio = ', '38;5;150m(ritardo)', ' more text'],
  'Punteggio = (ritardo) more text'
);

// Many small chunks (1 char each, worst case)
check('one-char-chunks',
  '\x1b[38;5;150mhello\x1b[0m'.split(''),
  'hello'
);

check('one-char-chunks-orphan',
  '38;5;150mhello'.split(''),
  'hello'
);

// Legitimate text with digits and semicolons — must NOT be held forever
check('keep-legit-text',
  ['file.py:80-153 and more text'],
  'file.py:80-153 and more text'
);

check('keep-semicolons-not-sgr',
  ['list: 1; 2; 3; done'],
  'list: 1; 2; 3; done'
);

// Trailing digits that look like SGR start get held — but next chunk releases them
check('release-on-non-m',
  ['Iter 100;', ' and more'],
  'Iter 100; and more'
);

// Many sequences in a row
check('multi-orphans-split',
  ['38;5;1', '00m38;5;', '200mfoo'],
  'foo'
);

// Whole text without any ANSI
check('plain-text',
  ['hello ', 'world', ' how are you'],
  'hello world how are you'
);

// Backslash-escaped forms split
check('escaped-split',
  ['hello \\u001', 'b[31mworld'],
  'hello world'
);

console.log(`\n\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) {
    console.log(`\n  ${f.label}`);
    console.log(`    chunks  : ${JSON.stringify(f.chunks)}`);
    console.log(`    expected: ${JSON.stringify(f.expected)}`);
    console.log(`    got     : ${JSON.stringify(f.got)}`);
  }
  process.exit(1);
}
