// Helpers for cleaning up output that gets written to the terminal or fed
// back into a chat client. The goals:
//   1. Strip stray ANSI escape sequences that can render as garbage
//      characters (`Ù`, `[?25h`, etc.) when the destination terminal
//      doesn't speak the same protocol as the source.
//   2. Cap length so a runaway command doesn't blow the downstream buffer
//      (chat clients in particular truncate silently with a "previous run
//      was likely truncated" message that confuses users).
//   3. Preserve the FIRST and LAST chunks so the user sees what the
//      command produced AND the most recent lines (errors usually surface
//      at the bottom).

// Matches well-formed ANSI escape sequences: CSI, OSC, DCS, single-char
// ESC sequences. We deliberately keep this conservative — anything that
// isn't recognisable as an escape is left alone (printing `Ù` is more
// honest than silently deleting it).
const ANSI_RE = /(?:\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]|\x1B[=>]|\x1B\][^\x07\x1B]*(?:\x1B\\))/g;
// Lone high-bit bytes that some terminals echo when an escape sequence is
// partially decoded. We can't reliably reconstruct them, so we just drop
// leading/trailing junk that looks like a partial sequence.
const LONE_ESC_RE = /\x1B$/;
const LONE_BRACKET_RE = /^\[?\?25[hl]/;

const DEFAULT_MAX_BYTES = 50_000; // ~50KB keeps responses snappy
const HEAD_RATIO = 0.6;           // keep first 60% of the cap as head
const TAIL_RATIO = 0.3;           // keep last 30% as tail

function stripAnsi(text) {
  // Replace well-formed escapes with empty string. Anything that doesn't
  // match is preserved so debugging info isn't lost.
  return String(text || '').replace(ANSI_RE, '');
}

function stripStrayControl(text) {
  let s = String(text || '');
  // Trailing partial ESC: terminal will echo this back as garbage.
  s = s.replace(LONE_ESC_RE, '');
  // Leading "[?25h" or "?25h" without ESC — happens when an upstream
  // filter stripped the ESC byte. Harmless to drop.
  s = s.replace(LONE_BRACKET_RE, '');
  return s;
}

// Clean and cap `text`. Returns { output, truncated, originalBytes, keptBytes }.
// `maxBytes` defaults to 50KB which is large enough for any reasonable tool
// output and small enough to fit comfortably in a chat client message.
export function sanitizeOutput(text, {
  maxBytes = DEFAULT_MAX_BYTES,
  marker = '... [truncated, run the command directly to see full output] ...',
} = {}) {
  const cleaned = stripStrayControl(stripAnsi(text));
  const originalBytes = Buffer.byteLength(cleaned, 'utf8');
  if (originalBytes <= maxBytes) {
    return { output: cleaned, truncated: false, originalBytes, keptBytes: Buffer.byteLength(cleaned, 'utf8') };
  }

  // Convert to bytes for accurate slicing (the byte count, not the char
  // count, is what blows the buffer downstream).
  const buf = Buffer.from(cleaned, 'utf8');
  const headBytes = Math.floor(maxBytes * HEAD_RATIO);
  const tailBytes = Math.floor(maxBytes * TAIL_RATIO);
  const head = buf.subarray(0, headBytes).toString('utf8');
  const tail = buf.subarray(buf.length - tailBytes).toString('utf8');

  const truncationNote =
    `[${originalBytes - maxBytes} bytes truncated; ${headBytes} head + ${tailBytes} tail kept]\n` +
    `${marker}\n\n`;
  const output = head + '\n\n' + truncationNote + tail;
  return {
    output,
    truncated: true,
    originalBytes,
    keptBytes: Buffer.byteLength(output, 'utf8'),
  };
}

// Convenience: returns just the cleaned string, for callers that don't
// care about the truncation metadata.
export function cleanOutput(text, opts) {
  return sanitizeOutput(text, opts).output;
}
