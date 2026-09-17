import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planEdit } from '../src/tools/edit-match.js';
import { toolHandlers, setAutoApprove } from '../src/tools/index.js';

test('an exact match is replaced and reports where it landed', () => {
  const plan = planEdit('a\nb\nc\n', 'b', 'B');
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'exact');
  assert.equal(plan.updated, 'a\nB\nc\n');
  assert.equal(plan.firstLine, 2);
});

test('an ambiguous match names the lines it was found on', () => {
  const plan = planEdit('x\nfoo\ny\nfoo\n', 'foo', 'bar');
  assert.equal(plan.ok, false);
  assert.match(plan.error, /matches 2 locations/);
  assert.match(plan.error, /lines 2, 4/);
  assert.match(plan.error, /replace_all/);
});

test('replace_all changes every occurrence', () => {
  const plan = planEdit('foo foo foo', 'foo', 'bar', { replaceAll: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.count, 3);
  assert.equal(plan.updated, 'bar bar bar');
});

test('trailing whitespace in the file does not defeat a match', () => {
  const plan = planEdit('function f() {  \n  return 1;\n}\n', 'function f() {\n  return 1;', 'function f() {\n  return 2;');
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'whitespace');
  assert.equal(plan.updated, 'function f() {\n  return 2;\n}\n');
});

test('a block copied at the wrong indentation is matched and re-indented', () => {
  const file = 'class A {\n    run() {\n        go();\n    }\n}\n';
  const plan = planEdit(file, 'run() {\n    go();\n}', 'run() {\n    go();\n    stop();\n}');
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.updated, 'class A {\n    run() {\n        go();\n        stop();\n    }\n}\n');
});

test('a whitespace-tolerant match must still be unique', () => {
  const plan = planEdit('  a();\n\ta();\n', 'a();', 'b();');
  assert.equal(plan.ok, false);
  assert.match(plan.error, /matches 2 locations/);
});

test('a miss quotes the closest region and the first differing line', () => {
  const file = 'const x = 1;\nfunction total(items) {\n  return items.reduce((a, b) => a + b, 0);\n}\n';
  const plan = planEdit(file, 'function total(items) {\n  return items.reduce((a, b) => a + b);\n}', 'x');
  assert.equal(plan.ok, false);
  assert.match(plan.error, /old_string not found/);
  assert.match(plan.error, /Closest region is lines 2-4/);
  assert.match(plan.error, /First difference at line 3/);
});

test('a miss with nothing similar says to re-read instead of quoting noise', () => {
  const plan = planEdit('alpha\nbeta\n', 'completely\ndifferent text', 'x');
  assert.equal(plan.ok, false);
  assert.doesNotMatch(plan.error, /Closest region/);
  assert.match(plan.error, /read the relevant range again/);
});

test('a no-op or empty edit is refused', () => {
  assert.match(planEdit('a', 'a', 'a').error, /identical/);
  assert.match(planEdit('a', '', 'b').error, /empty/);
});

test('edit returns the edited lines numbered, and applies replace_all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-edit-'));
  setAutoApprove({ edits: true });
  try {
    const file = join(dir, 'f.js');
    await writeFile(file, 'let n = 1;\nuse(n);\nuse(n);\n');
    const result = await toolHandlers.edit({ file_path: file, old_string: 'use(n)', new_string: 'use(m)', replace_all: true });
    assert.match(result, /✓ Edited/, result);
    assert.match(result, /2 occurrences replaced/);
    assert.match(result, /\n2\tuse\(m\);/);
    assert.equal(await readFile(file, 'utf-8'), 'let n = 1;\nuse(m);\nuse(m);\n');
  } finally {
    setAutoApprove({ edits: false });
    await rm(dir, { recursive: true, force: true });
  }
});

test('grep supports ignore_case, context and files_only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-grep-'));
  try {
    await writeFile(join(dir, 'a.txt'), 'one\nNeedle\nthree\n');
    await writeFile(join(dir, 'b.txt'), 'nothing here\n');
    assert.equal(await toolHandlers.grep({ pattern: 'needle', path: dir }), 'No matches');
    const ctx = await toolHandlers.grep({ pattern: 'needle', path: dir, ignore_case: true, context: 1 });
    assert.match(ctx, /one/);
    assert.match(ctx, /three/);
    const files = await toolHandlers.grep({ pattern: 'needle', path: dir, ignore_case: true, files_only: true });
    assert.equal(files.trim(), join(dir, 'a.txt'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
