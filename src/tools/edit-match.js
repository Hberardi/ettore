// Planning an `edit`: where old_string is, what the file becomes, and — when
// it is nowhere — what the model should look at instead.
//
// A bare "old_string not found" was the most common way a coding turn fell
// apart. The model had copied the right lines with one indentation level less,
// or with a trailing space the `read` output does not show, and with nothing to
// go on it re-read the whole file, guessed again, or gave up and rewrote the
// file with `write`. Two things fix that: a whitespace-tolerant second pass
// that still demands a unique whole-line match, and a failure message that
// quotes the closest region of the file with its line numbers.

import { toLf } from './line-endings.js';

const SNIPPET_CONTEXT = 3;
const SNIPPET_MAX_LINES = 40;
const MAX_LISTED_LOCATIONS = 10;

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function indentOf(line) {
  return /^[ \t]*/.exec(line)[0];
}

function firstNonBlank(lines) {
  return lines.findIndex(l => l.trim() !== '');
}

/** Numbered lines `from`..`to` (1-based, inclusive), clamped and capped. */
export function numberedSnippet(lines, from, to, max = SNIPPET_MAX_LINES) {
  const start = Math.max(1, from);
  const end = Math.min(lines.length, to);
  const out = [];
  for (let n = start; n <= end; n++) {
    if (out.length >= max) {
      out.push(`… (${end - n + 1} more lines)`);
      break;
    }
    out.push(`${n}\t${lines[n - 1]}`);
  }
  return out.join('\n');
}

// Whole-line windows of `hay` equal to `needle` under `same`, non-overlapping.
function findLineWindows(hay, needle, same) {
  const hits = [];
  const last = hay.length - needle.length;
  for (let i = 0; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (!same(hay[i + j], needle[j])) { ok = false; break; }
    }
    if (ok) {
      hits.push(i);
      i += needle.length - 1;
    }
  }
  return hits;
}

// Cheap similarity in [0, 1]: shared prefix plus shared suffix over the longer.
function lineSimilarity(a, b) {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return (p + s) / max;
}

function describeClosest(fileLines, needleLines) {
  const needle = needleLines.map(l => l.trim());
  if (!needle.some(Boolean)) return '';
  const span = needle.length;
  let best = { score: 0, at: -1 };
  const last = Math.max(0, fileLines.length - span);
  for (let i = 0; i <= last; i++) {
    let score = 0;
    for (let j = 0; j < span && i + j < fileLines.length; j++) {
      score += lineSimilarity(fileLines[i + j].trim(), needle[j]);
    }
    if (score > best.score) best = { score, at: i };
  }
  // Below half the lines' worth of resemblance the "closest" region is noise,
  // and quoting it would send the model after the wrong code.
  if (best.at < 0 || best.score < span * 0.5) return '';

  let differing = -1;
  for (let j = 0; j < span; j++) {
    if (fileLines[best.at + j] !== needleLines[j]) { differing = j; break; }
  }
  const from = best.at + 1;
  const to = best.at + span;
  const parts = [
    `Closest region is lines ${from}-${to}:`,
    numberedSnippet(fileLines, from, to),
  ];
  if (differing >= 0) {
    parts.push(
      `First difference at line ${from + differing}: the file has ${JSON.stringify(fileLines[best.at + differing] ?? '')} `
      + `but old_string has ${JSON.stringify(needleLines[differing])}.`,
    );
  }
  return parts.join('\n');
}

/**
 * Work out what `edit` would do, without touching the disk.
 *
 * Everything is computed in LF; the caller applies the file's own line ending.
 *
 * @returns {{ok: true, updated: string, count: number, mode: 'exact'|'whitespace',
 *            matchedOld: string, replacement: string, firstLine: number, lastLine: number}
 *         | {ok: false, error: string}}
 */
export function planEdit(content, oldString, newString, { replaceAll = false, filePath = 'file' } = {}) {
  const body = toLf(content);
  const target = toLf(oldString);
  const replacement = toLf(newString);

  if (!target) {
    return { ok: false, error: `Error: old_string is empty. To create or fully rewrite ${filePath} use write.` };
  }
  if (target === replacement) {
    return { ok: false, error: 'Error: old_string and new_string are identical — the edit would change nothing.' };
  }

  const exact = body.split(target);
  if (exact.length > 1) {
    const count = exact.length - 1;
    if (count > 1 && !replaceAll) {
      return { ok: false, error: ambiguous(filePath, body, exact, target, count) };
    }
    const firstLine = lineOf(body, exact[0].length);
    return {
      ok: true,
      updated: exact.join(replacement),
      count,
      mode: 'exact',
      matchedOld: target,
      replacement,
      firstLine,
      lastLine: firstLine + replacement.split('\n').length - 1,
    };
  }

  const fileLines = body.split('\n');
  const needleLines = target.split('\n');
  // A trailing newline in old_string is a line terminator, not an empty line
  // the file has to contain.
  const newLines = replacement.split('\n');
  if (needleLines.length > 1 && needleLines[needleLines.length - 1] === '') {
    needleLines.pop();
    if (newLines.length > 1 && newLines[newLines.length - 1] === '') newLines.pop();
  }

  // Trailing whitespace first: nothing about the replacement has to change.
  // Then indentation: the block is right, its nesting level is not.
  const passes = [
    { same: (a, b) => a.trimEnd() === b.trimEnd(), reindent: false },
    { same: (a, b) => a.trim() === b.trim(), reindent: true },
  ];
  for (const pass of passes) {
    const hits = findLineWindows(fileLines, needleLines, pass.same);
    if (!hits.length) continue;
    if (hits.length > 1 && !replaceAll) {
      const where = hits.slice(0, MAX_LISTED_LOCATIONS).map(i => i + 1).join(', ');
      return {
        ok: false,
        error: `Error: old_string matches ${hits.length} locations in ${filePath} (ignoring whitespace; starting at lines ${where}). `
          + 'Provide more surrounding context to make it unique, or pass replace_all=true.',
      };
    }
    const out = fileLines.slice();
    let matchedOld = '';
    let placed = [];
    for (const at of [...hits].reverse()) {
      const original = fileLines.slice(at, at + needleLines.length);
      const lines = pass.reindent ? reindent(newLines, needleLines, original) : newLines;
      out.splice(at, needleLines.length, ...lines);
      matchedOld = original.join('\n');
      placed = lines;
    }
    const firstLine = hits[0] + 1;
    return {
      ok: true,
      updated: out.join('\n'),
      count: hits.length,
      mode: 'whitespace',
      matchedOld,
      replacement: placed.join('\n'),
      firstLine,
      lastLine: firstLine + placed.length - 1,
    };
  }

  const closest = describeClosest(fileLines, needleLines);
  const hint = closest
    ? `${closest}\nCopy old_string from these lines exactly (without the line-number prefix) and retry.`
    : 'Nothing in the file resembles it. The file may have changed since you read it — read the relevant range again before retrying.';
  return { ok: false, error: `Error: old_string not found in ${filePath}.\n${hint}` };
}

function ambiguous(filePath, body, parts, target, count) {
  const lines = [];
  let offset = 0;
  for (let i = 0; i < parts.length - 1 && lines.length < MAX_LISTED_LOCATIONS; i++) {
    offset += parts[i].length;
    lines.push(lineOf(body, offset));
    offset += target.length;
  }
  return `Error: old_string matches ${count} locations in ${filePath} (lines ${lines.join(', ')}${count > lines.length ? ', …' : ''}). `
    + 'Provide more surrounding context to make it unique, or pass replace_all=true to change every occurrence.';
}

// Move `newLines` from old_string's indentation to the file's, keeping each
// line's indentation relative to the block.
function reindent(newLines, needleLines, originalLines) {
  const n = firstNonBlank(needleLines);
  if (n < 0) return newLines;
  const from = indentOf(needleLines[n]);
  const to = indentOf(originalLines[n]);
  if (from === to) return newLines;
  return newLines.map((line) => {
    if (line.trim() === '') return line;
    if (line.startsWith(from)) return to + line.slice(from.length);
    return line;
  });
}

/** The edited region with a little context, numbered as `read` numbers it. */
export function editedSnippet(updated, firstLine, lastLine) {
  const lines = updated.split('\n');
  return numberedSnippet(lines, firstLine - SNIPPET_CONTEXT, lastLine + SNIPPET_CONTEXT);
}
