// Canonical ANSI sanitization. Two functions:
//
//   stripAllAnsi(text)   - removes EVERY ANSI/orphan sequence. Use for
//                          storage (messages, tool args, intent labels).
//   stripOrphans(text)   - preserves well-formed ESC[...m, removes only
//                          orphan/malformed fragments. Use as the final
//                          defensive pass before stdout.write.

const ORPHAN_PASSES = [
  // Truncated 256-color prefix with no color index. This can appear when
  // streamed model text drops the ESC/[ prefix and the numeric color suffix.
  /\[?(?:38|48);5;(?=\s|\/|$)/g,
  // 256/truecolor SGR with optional `[` and optional trailing `m`:
  //   38;5;NNN(m)   48;5;NNN(m)   38;2;R;G;B(m)   48;2;R;G;B(m)
  /\[?(?:38|48);(?:5;\d{1,3}|2;\d{1,3};\d{1,3};\d{1,3})m?/g,
  // SGR fragment with leading `[` and 1-4 numeric params:
  //   [0m  [1m  [31m  [1;33m  [38;5;NNNm
  /\[(?:\d{1,3};){0,3}\d{1,3}m/g,
  // Multi-number SGR without `[` (e.g. broken streaming chunk):
  //   1;31m   38;5;100m   0;31m
  /(?:\d{1,3};){1,5}\d{1,3}m/g,
  // Stand-alone reset/style SGR (0m, 1m, 22m, ...) immediately followed
  // by a letter — clearly an orphan, not a measurement. The lookbehind
  // protects "100m sprint", "300mg", "v1m" etc.
  /(?<![A-Za-z0-9])(?:0|1|2|3|4|5|7|9|21|22|23|24|25|27|28|29|39|49)m(?=[A-Za-z]|$)/g,
];

const ESCAPED_FORMS = [
  /\\x1b\[[0-9;:]*[A-Za-z@]/gi,
  /\\u001b\[[0-9;:]*[A-Za-z@]/gi,
  /(?:^|[^A-Za-z0-9])u001b\[[0-9;:]*[A-Za-z@]/gi,
];

// Invisible chars: soft hyphen, CGJ, ZWSP/ZWNJ/ZWJ, LRM/RLM,
// line/paragraph separators, isolate/embedding marks, word joiner, BOM.
const INVISIBLE_UNICODE = new RegExp(
  '\\u034F|[\\u00AD\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]',
  'g'
);

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function passOrphans(input) {
  let s = input;
  let prev;
  let guard = 0;
  do {
    prev = s;
    for (const re of ORPHAN_PASSES) s = s.replace(re, '');
    guard++;
  } while (s !== prev && guard < 5);
  return s;
}

export function stripAllAnsi(text) {
  if (text == null) return '';
  if (typeof text !== 'string') return String(text);
  let s = text;
  // OSC (must run before generic ESC catchers - its `]` looks like Fe).
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  // CSI (any final byte, includes color, cursor, mode set, etc.)
  s = s.replace(/\x1b\[[0-9;:?]*[ -/]*[A-Za-z@]/g, '');
  // Other Fe escapes (single-char like ESC + letter).
  s = s.replace(/\x1b[@-Z\\^_]/g, '');
  // Any leftover ESC + any following char.
  s = s.replace(/\x1b./g, '');
  // Bare ESC.
  s = s.replace(/\x1b/g, '');
  // Literal escaped forms.
  for (const re of ESCAPED_FORMS) s = s.replace(re, '');
  // Orphan SGR.
  s = passOrphans(s);
  // Invisible Unicode + control chars (skip \n, \t, \r).
  s = s.replace(INVISIBLE_UNICODE, '');
  s = s.replace(CONTROL_CHARS, '');
  return s;
}

export function stripOrphans(text) {
  if (text == null) return '';
  if (typeof text !== 'string') return String(text);
  // Protect well-formed CSI sequences (real ESC + `[` + params + final byte).
  const saved = [];
  let s = text.replace(/\x1b\[[0-9;:?]*[ -/]*[A-Za-z@]/g, (m) => {
    saved.push(m);
    return `\x00@${saved.length - 1}@\x00`;
  });
  // Strip any remaining ESC (orphan).
  s = s.replace(/\x1b/g, '');
  // Strip orphan SGR patterns.
  s = passOrphans(s);
  // Restore placeholders.
  s = s.replace(/\x00@(\d+)@\x00/g, (_, i) => saved[parseInt(i, 10)] || '');
  return s;
}
