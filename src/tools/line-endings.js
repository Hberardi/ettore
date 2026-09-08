// Line endings, so an edit works the same on a CRLF checkout as on an LF one.
//
// Git for Windows checks files out with CRLF by default (core.autocrlf=true).
// `read` hands the model those lines with their trailing \r; the model writes
// `old_string` back with plain \n, as models do; and `edit` matched literally
// with `content.split(old_string)`. The result was that every multi-line edit
// on Windows failed with "old_string not found" — not sometimes, always.
//
// Matching therefore compares with line endings normalised, while writing puts
// the file's own convention back. Rewriting a CRLF file as LF would otherwise
// turn a two-line change into a whole-file diff.

const CRLF = '\r\n';
const LF = '\n';

/** The dominant line ending in `text`. Empty or single-line text is LF. */
export function detectEol(text) {
  const body = String(text || '');
  const crlfCount = (body.match(/\r\n/g) || []).length;
  if (!crlfCount) return LF;
  const lfCount = (body.match(/\n/g) || []).length;
  // Mixed files exist; the majority convention is the one to preserve.
  return crlfCount * 2 >= lfCount ? CRLF : LF;
}

/** `text` with every CRLF reduced to LF. */
export function toLf(text) {
  return String(text ?? '').replace(/\r\n/g, LF);
}

/** `text` with every line ending set to `eol`. */
export function applyEol(text, eol) {
  const lf = toLf(text);
  return eol === CRLF ? lf.replace(/\n/g, CRLF) : lf;
}

/**
 * Locate `needle` in `haystack`, tolerating a line-ending mismatch.
 *
 * Returns the pieces `String.split` would have produced, plus how the match
 * was found. `exact` keeps the old fast path byte-for-byte; `normalized` is
 * the CRLF-vs-LF rescue, and reports its parts in LF so the caller can
 * re-apply the file's own ending once.
 *
 * @returns {{parts: string[], mode: 'exact'|'normalized'|'none', count: number}}
 */
export function splitTolerant(haystack, needle) {
  const body = String(haystack ?? '');
  const target = String(needle ?? '');
  if (!target) return { parts: [body], mode: 'none', count: 0 };

  const exact = body.split(target);
  if (exact.length > 1) return { parts: exact, mode: 'exact', count: exact.length - 1 };

  // Only worth a second pass when the two disagree about line endings at all.
  const bodyLf = toLf(body);
  const targetLf = toLf(target);
  if (bodyLf === body && targetLf === target) {
    return { parts: exact, mode: 'none', count: 0 };
  }

  const normalized = bodyLf.split(targetLf);
  if (normalized.length > 1) {
    return { parts: normalized, mode: 'normalized', count: normalized.length - 1 };
  }
  return { parts: exact, mode: 'none', count: 0 };
}
