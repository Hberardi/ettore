// The built-in searcher that runs when neither ripgrep nor grep is installed.
// That is the normal state of a Windows box, where code search — the thing an
// agent turn starts with — used to fail outright.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchFiles } from '../src/tools/grep-fallback.js';

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-grep-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

test('matches are reported as path:line:text, the format both backends produce', async () => {
  const dir = await fixture({ 'a.js': 'const x = 1;\nconst target = 2;\n' });
  try {
    const out = await searchFiles({ pattern: 'target', path: dir });
    assert.equal(out.split('\n').length, 1);
    assert.match(out, /a\.js:2:const target = 2;$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the search is recursive and skips node_modules and .git', async () => {
  const dir = await fixture({
    'src/deep/nested.js': 'needle here\n',
    'node_modules/pkg/index.js': 'needle in a dependency\n',
    '.git/config': 'needle in git\n',
  });
  try {
    const out = await searchFiles({ pattern: 'needle', path: dir });
    assert.match(out, /nested\.js:1:/);
    assert.ok(!out.includes('node_modules'), `node_modules must be skipped: ${out}`);
    assert.ok(!out.includes('.git'), `.git must be skipped: ${out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('include limits the files read, at any depth', async () => {
  const dir = await fixture({
    'a.js': 'match me\n',
    'b.py': 'match me\n',
    'sub/c.js': 'match me\n',
  });
  try {
    const out = await searchFiles({ pattern: 'match', path: dir, include: '*.js' });
    assert.match(out, /a\.js:/);
    assert.match(out, /c\.js:/, 'a bare filename glob must still match at depth');
    assert.ok(!out.includes('b.py'), `.py must be excluded: ${out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fixed + wholeWord reproduces what repo_find_symbol asked grep for', async () => {
  const dir = await fixture({
    'a.js': 'const parse = 1;\nconst parseAll = 2;\nreparse();\n',
  });
  try {
    const out = await searchFiles({ pattern: 'parse', path: dir, fixed: true, wholeWord: true });
    assert.match(out, /a\.js:1:/);
    assert.ok(!out.includes('parseAll'), 'parseAll is not the whole word parse');
    assert.ok(!out.includes('reparse'), 'reparse is not the whole word parse');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a literal search does not let regex metacharacters through', async () => {
  const dir = await fixture({ 'a.js': 'a.b\naxb\n' });
  try {
    const out = await searchFiles({ pattern: 'a.b', path: dir, fixed: true });
    assert.match(out, /a\.js:1:a\.b/);
    assert.ok(!out.includes('axb'), 'the dot must be literal when fixed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a CRLF file reports the same text a POSIX checkout would', async () => {
  const dir = await fixture({ 'win.js': 'const a = 1;\r\nconst target = 2;\r\n' });
  try {
    const out = await searchFiles({ pattern: 'target', path: dir });
    assert.match(out, /win\.js:2:const target = 2;$/, `trailing \\r must be trimmed: ${JSON.stringify(out)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('binary files are skipped instead of dumping bytes into the result', async () => {
  const dir = await fixture({ 'ok.txt': 'needle\n' });
  try {
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x00, 0x6c, 0x65]));
    const out = await searchFiles({ pattern: 'need', path: dir });
    assert.match(out, /ok\.txt:/);
    assert.ok(!out.includes('blob.bin'), `binary must be skipped: ${out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('maxMatches caps the result', async () => {
  const dir = await fixture({ 'many.js': Array.from({ length: 50 }, (_, i) => `hit ${i}`).join('\n') });
  try {
    const out = await searchFiles({ pattern: 'hit', path: dir, maxMatches: 5 });
    assert.equal(out.split('\n').length, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no matches is an empty string, not an error', async () => {
  const dir = await fixture({ 'a.js': 'nothing here\n' });
  try {
    assert.equal(await searchFiles({ pattern: 'absent', path: dir }), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an invalid regex is reported, not thrown as a crash', async () => {
  const dir = await fixture({ 'a.js': 'x\n' });
  try {
    await assert.rejects(
      () => searchFiles({ pattern: '(unclosed', path: dir }),
      /invalid search pattern/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unreadable file is skipped rather than aborting the search', async () => {
  const dir = await fixture({ 'a.js': 'needle\n', 'b.js': 'needle\n' });
  try {
    let calls = 0;
    const out = await searchFiles({
      pattern: 'needle',
      path: dir,
      readFileFn: async (file) => {
        calls++;
        if (calls === 1) throw new Error('EACCES');
        return Buffer.from('needle\n');
      },
    });
    assert.equal(out.split('\n').length, 1, `one file failed, the other must still report: ${out}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an aborted signal stops the walk', async () => {
  const dir = await fixture({ 'a.js': 'needle\n', 'b.js': 'needle\n' });
  try {
    const controller = new AbortController();
    controller.abort();
    assert.equal(await searchFiles({ pattern: 'needle', path: dir, signal: controller.signal }), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
