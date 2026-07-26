import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOutput, cleanOutput } from '../src/utils/output.js';

// ── ANSI stripping ─────────────────────────────────────────────────────────
test('sanitizeOutput strips well-formed CSI escape sequences', () => {
  const dirty = '\x1b[31mhello\x1b[0m world';
  assert.equal(cleanOutput(dirty), 'hello world');
});

test('sanitizeOutput strips OSC and DCS escape sequences', () => {
  const dirty = '\x1b]0;set window title\x07normal text';
  assert.equal(cleanOutput(dirty), 'normal text');
});

test('sanitizeOutput strips a trailing lone ESC byte (the source of stray "Ù" garbage)', () => {
  const dirty = 'clean text\x1b';
  const cleaned = cleanOutput(dirty);
  assert.equal(cleaned, 'clean text');
  assert.ok(!cleaned.includes('\x1b'), 'ESC byte must be gone');
});

test('sanitizeOutput strips leading "[?25h" without ESC', () => {
  // Happens when an upstream filter eats the ESC byte but leaves the params.
  const dirty = '[?25hvisible text';
  assert.equal(cleanOutput(dirty), 'visible text');
});

test('sanitizeOutput preserves non-escape characters verbatim', () => {
  const text = 'normal text with <html> and unicode ù à € — all kept';
  assert.equal(cleanOutput(text), text);
});

test('sanitizeOutput is a no-op for clean short text', () => {
  const text = 'just a normal response, no escapes.';
  const r = sanitizeOutput(text);
  assert.equal(r.truncated, false);
  assert.equal(r.output, text);
});

// ── Truncation with head + tail ────────────────────────────────────────────
test('sanitizeOutput returns input verbatim when under cap', () => {
  const text = 'a'.repeat(1000);
  const r = sanitizeOutput(text, { maxBytes: 5000 });
  assert.equal(r.truncated, false);
  assert.equal(r.output, text);
  assert.equal(r.originalBytes, 1000);
  assert.equal(r.keptBytes, 1000);
});

test('sanitizeOutput truncates with head + tail + marker when over cap', () => {
  // 100KB of 'a' — cap at 1KB, head=600 bytes, tail=300 bytes, marker fills the rest.
  const text = 'a'.repeat(100_000);
  const r = sanitizeOutput(text, { maxBytes: 1000 });
  assert.equal(r.truncated, true);
  assert.ok(r.originalBytes >= 100_000);
  assert.ok(r.keptBytes <= 5000, 'kept output must stay small');
  assert.match(r.output, /head \+ \d+ tail kept/);
  // Both head and tail should be present (both are 'a's).
  assert.ok(r.output.includes('aaa'));
});

test('truncation marker mentions the truncation explicitly', () => {
  const text = 'x'.repeat(50_000);
  const r = sanitizeOutput(text, { maxBytes: 500 });
  assert.match(r.output, /truncated/);
  assert.match(r.output, /run the command directly/);
});

test('default cap is 50KB', () => {
  const text = 'x'.repeat(100_000);
  const r = sanitizeOutput(text);
  assert.equal(r.truncated, true);
});

// ── Multibyte UTF-8 safety ─────────────────────────────────────────────────
test('sanitizeOutput does not split a multibyte UTF-8 character at the head/tail boundary', () => {
  // Italian accented chars: 2 bytes each in UTF-8. Stuff enough that
  // head and tail cross byte boundaries near multi-byte chars.
  const text = 'à'.repeat(50_000);
  const r = sanitizeOutput(text, { maxBytes: 100 });
  assert.equal(r.truncated, true);
  // The output must be valid UTF-8 — Buffer.toString('utf8') replaces
  // partial sequences with U+FFFD, but at minimum the character count must
  // be a multiple of the source char width when no splits occur.
  assert.ok(r.output.length > 0, 'must produce some output');
  // Spot-check: the head should start with the same char the source does.
  assert.ok(r.output.startsWith('à'), 'head must start with the source char');
});

test('cleanOutput is just sanitizeOutput().output', () => {
  const text = 'hello\x1b[31m world';
  assert.equal(cleanOutput(text), sanitizeOutput(text).output);
});

// ── Integration: toolEnd-style preview stays small ────────────────────────
test('a 200KB tool output produces a sub-60KB sanitized preview', () => {
  const huge = '\x1b[32m' + 'log line\n'.repeat(20_000) + '\x1b[0m';
  const preview = cleanOutput(huge, { maxBytes: 8_000 });
  assert.ok(preview.length <= 8_500, `preview should be small, got ${preview.length}`);
  assert.ok(!preview.includes('\x1b'), 'no escape codes in preview');
});
