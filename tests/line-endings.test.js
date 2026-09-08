// Regression: on a Git-for-Windows checkout (core.autocrlf=true) every
// multi-line edit failed with "old_string not found". `read` handed the model
// lines ending in \r, the model wrote `old_string` back with plain \n, and
// `edit` matched literally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectEol, toLf, applyEol, splitTolerant } from '../src/tools/line-endings.js';
import { toolHandlers } from '../src/tools/index.js';
import { uiBridge } from '../src/tools/bridge.js';

// edit/write refuse to touch the disk without a confirmation listener.
function withConfirm(fn) {
  const handler = ({ resolve }) => resolve('Sì, applica');
  uiBridge.on('askUser', handler);
  return Promise.resolve(fn()).finally(() => uiBridge.off('askUser', handler));
}

test('detectEol picks the file convention, and the majority when mixed', () => {
  assert.equal(detectEol('a\nb\n'), '\n');
  assert.equal(detectEol('a\r\nb\r\n'), '\r\n');
  assert.equal(detectEol(''), '\n');
  assert.equal(detectEol('single line'), '\n');
  assert.equal(detectEol('a\r\nb\r\nc\n'), '\r\n', 'mostly CRLF');
  assert.equal(detectEol('a\nb\nc\nd\ne\r\n'), '\n', 'mostly LF');
});

test('toLf and applyEol round-trip without touching a lone carriage return', () => {
  assert.equal(toLf('a\r\nb'), 'a\nb');
  assert.equal(applyEol('a\nb', '\r\n'), 'a\r\nb');
  assert.equal(applyEol('a\r\nb', '\n'), 'a\nb');
  // A \r that is not part of a line ending is data, not formatting.
  assert.equal(toLf('a\rb'), 'a\rb');
  assert.equal(applyEol('a\rb', '\r\n'), 'a\rb');
});

test('splitTolerant keeps the exact match as the fast path', () => {
  const out = splitTolerant('x\ny\nz', 'y');
  assert.equal(out.mode, 'exact');
  assert.equal(out.count, 1);
  assert.deepEqual(out.parts, ['x\n', '\nz']);
});

test('splitTolerant finds an LF needle in a CRLF haystack', () => {
  const out = splitTolerant('a\r\nb\r\nc\r\n', 'a\nb');
  assert.equal(out.mode, 'normalized');
  assert.equal(out.count, 1);
  assert.deepEqual(out.parts, ['', '\nc\n'], 'parts come back in LF for a single re-apply');
});

test('splitTolerant reports no match when the text really is absent', () => {
  assert.equal(splitTolerant('a\r\nb', 'zzz').count, 0);
  assert.equal(splitTolerant('a\nb', '').mode, 'none');
});

test('splitTolerant still counts multiple matches, so ambiguity is caught', () => {
  assert.equal(splitTolerant('q\r\nq\r\n', 'q').count, 2);
});

// ─── End to end through the edit tool ────────────────────────────────────────

async function withFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-eol-'));
  const file = join(dir, 'sample.js');
  await writeFile(file, content);
  try {
    return await withConfirm(() => fn(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a multi-line edit works on a CRLF file and keeps it CRLF', async () => {
  await withFile('const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n', async (file) => {
    // What the model sends: plain \n, because that is what models write.
    const result = await toolHandlers.edit({
      file_path: file,
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 10;\nconst b = 20;',
    });
    assert.match(result, /✓ Edited/, `edit failed: ${result}`);

    const after = await readFile(file, 'utf-8');
    assert.ok(after.includes('const a = 10;'), 'the edit did not apply');
    assert.ok(!after.includes('\n\n'), 'no stray blank lines');
    assert.equal(detectEol(after), '\r\n', 'the file must stay CRLF, or the diff covers the whole file');
    assert.equal(after, 'const a = 10;\r\nconst b = 20;\r\nconst c = 3;\r\n');
  });
});

test('an LF file is untouched in its endings by an ordinary edit', async () => {
  await withFile('one\ntwo\nthree\n', async (file) => {
    const result = await toolHandlers.edit({
      file_path: file,
      old_string: 'one\ntwo',
      new_string: 'ONE\nTWO',
    });
    assert.match(result, /✓ Edited/, result);
    assert.equal(await readFile(file, 'utf-8'), 'ONE\nTWO\nthree\n');
  });
});

test('an edit that is genuinely absent still reports not found', async () => {
  await withFile('a\r\nb\r\n', async (file) => {
    const result = await toolHandlers.edit({
      file_path: file,
      old_string: 'nowhere\nto be seen',
      new_string: 'x',
    });
    assert.match(result, /old_string not found/);
  });
});

test('an ambiguous edit is still refused on a CRLF file', async () => {
  await withFile('dup\r\ndup\r\n', async (file) => {
    const result = await toolHandlers.edit({ file_path: file, old_string: 'dup', new_string: 'x' });
    assert.match(result, /matches 2 locations/, result);
  });
});

test('write keeps an existing CRLF file CRLF', async () => {
  await withFile('old\r\ncontent\r\n', async (file) => {
    const result = await toolHandlers.write({ file_path: file, content: 'brand\nnew\nbody\n' });
    assert.match(result, /Written/, result);
    const after = await readFile(file, 'utf-8');
    assert.equal(after, 'brand\r\nnew\r\nbody\r\n');
  });
});

test('write to a new file uses the content as given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-eol-new-'));
  const file = join(dir, 'fresh.txt');
  try {
    await withConfirm(() => toolHandlers.write({ file_path: file, content: 'a\nb\n' }));
    assert.equal(await readFile(file, 'utf-8'), 'a\nb\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the reported line count is the same either way', async () => {
  await withFile('x\r\n', async (file) => {
    const result = await toolHandlers.write({ file_path: file, content: 'a\nb\nc\n' });
    // 3 lines plus the trailing empty one, counted on LF so CRLF does not
    // inflate it.
    assert.match(result, /Written 4 lines/, result);
  });
});
