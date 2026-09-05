// Rendering tests for the live directory panel. The tree data itself is
// covered in dir-tree.test.js; here the concern is what the sidebar draws
// from it, so the tree is supplied as a plain object rather than scanned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/app/tui-native.js';
import { stripAllAnsi } from '../src/utils/ansi.js';

function entry(path, depth, isDir, addedAt = null) {
  return { path, name: path.split('/').pop(), depth, isDir, addedAt };
}

function tuiWith(tree, { rows = 40, availableHeight = 30 } = {}) {
  const t = new TUI();
  t.cols = 100;
  t.rows = rows;
  t.availableHeight = availableHeight;
  t.fileTree = tree;
  t.fileTreeRoot = '/home/dev/project';
  return t;
}

const flat = (lines) => stripAllAnsi(lines.join('\n'));

test('the panel draws the tree with elbows and nesting', () => {
  const tree = {
    changeNoticeMs: 5000,
    entries: [
      entry('src', 0, true),
      entry('src/app', 1, true),
      entry('src/app/main.js', 2, false),
      entry('src/index.js', 1, false),
      entry('README.md', 0, false),
    ],
  };
  const out = flat(tuiWith(tree)._renderFileTree(31, 12));

  assert.match(out, /▸ FILES project/);
  assert.match(out, /├ src\//);
  // A directory is marked as one; the last child of a level uses the elbow.
  assert.match(out, /└ index\.js/);
  assert.match(out, /└ README\.md/);
  // Nesting is drawn with a continuation bar while siblings remain below.
  assert.match(out, /│ │ └ main\.js/);
});

test('a just-created file is called out, an old one is not', () => {
  const now = Date.now();
  const tree = {
    changeNoticeMs: 5000,
    entries: [entry('fresh.js', 0, false, now), entry('stale.js', 0, false, now - 60_000)],
  };
  const lines = tuiWith(tree)._renderFileTree(31, 8);
  const out = flat(lines);
  assert.match(out, /\+fresh\.js/);
  assert.doesNotMatch(out, /\+stale\.js/);
});

test('the change line names the create or delete, then goes quiet', () => {
  const now = Date.now();
  const tree = { changeNoticeMs: 5000, entries: [], lastChange: { kind: 'added', path: 'src/new.js', at: now } };
  const t = tuiWith(tree);
  assert.match(stripAllAnsi(t._renderFileTreeChange(31)), /\+ src\/new\.js/);

  tree.lastChange = { kind: 'removed', path: 'src/old.js', at: now };
  assert.match(stripAllAnsi(t._renderFileTreeChange(31)), /− src\/old\.js/);

  // Stale changes stop being reported rather than sitting there forever.
  tree.lastChange = { kind: 'added', path: 'src/new.js', at: now - 60_000 };
  assert.equal(t._renderFileTreeChange(31), null);
});

test('the window scrolls to a change instead of sitting on the alphabetical top', () => {
  const now = Date.now();
  const entries = [];
  for (let i = 0; i < 60; i++) entries.push(entry(`f${String(i).padStart(2, '0')}.js`, 0, false));
  entries[50].addedAt = now;
  const out = flat(tuiWith({ changeNoticeMs: 5000, entries })._renderFileTree(31, 12));

  assert.match(out, /\+f50\.js/, 'the new file is not in view');
  assert.match(out, /↑ \d+ above/);
  assert.doesNotMatch(out, /f00\.js/, 'still showing the top of the tree');
});

test('an unscrolled overflow reports what is below', () => {
  const entries = [];
  for (let i = 0; i < 40; i++) entries.push(entry(`f${i}.js`, 0, false));
  const out = flat(tuiWith({ changeNoticeMs: 5000, entries })._renderFileTree(31, 10));
  assert.match(out, /↓ \d+ more/);
  assert.doesNotMatch(out, /above/);
});

test('a capped scan says so', () => {
  const entries = [entry('a.js', 0, false)];
  const out = flat(tuiWith({ changeNoticeMs: 5000, entries, truncated: true })._renderFileTree(31, 10));
  assert.match(out, /capped/);
});

test('an unwatchable directory still shows its snapshot, with the reason', () => {
  const tree = { changeNoticeMs: 5000, entries: [entry('a.js', 0, false)], error: 'snapshot only (watch limit)' };
  const out = flat(tuiWith(tree)._renderFileTree(31, 10));
  assert.match(out, /snapshot/);
  assert.match(out, /a\.js/);
});

test('the panel yields rather than render a stub in a short terminal', () => {
  const tree = { changeNoticeMs: 5000, entries: [entry('a.js', 0, false)] };
  assert.deepEqual(tuiWith(tree)._renderFileTree(31, 2), []);
  assert.deepEqual(tuiWith(null)._renderFileTree(31, 20), []);
});

test('the sidebar keeps its fixed sections and gives the rest to the tree', () => {
  const entries = [];
  for (let i = 0; i < 80; i++) entries.push(entry(`f${i}.js`, 0, false));
  const t = tuiWith({ changeNoticeMs: 5000, entries }, { availableHeight: 30 });
  const lines = t._renderSidebar(31);
  const out = flat(lines);

  // The tree must not push out anything the sidebar had to say.
  for (const section of ['ACTIVITY', 'APPROVALS', 'KEYS', 'FILES']) {
    assert.match(out, new RegExp(section), `${section} was squeezed out`);
  }
  assert.equal(lines.length, 30, 'the sidebar overflowed its height');
});

test('a sidebar with no tree renders exactly as before', () => {
  const t = tuiWith(null, { availableHeight: 30 });
  const out = flat(t._renderSidebar(31));
  assert.doesNotMatch(out, /▸ FILES/);
  assert.match(out, /▸ KEYS/);
});
