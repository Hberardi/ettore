// Rendering tests for the live directory panel. The tree data itself is
// covered in dir-tree.test.js; here the concern is what the sidebar draws
// from it, so the tree is supplied as a plain object rather than scanned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/app/tui-native.js';
import { stripAllAnsi } from '../src/utils/ansi.js';

function entry(path, depth, isDir, addedAt = null, open = false) {
  return { path, name: path.split('/').pop(), depth, isDir, open, addedAt, hiddenChangeAt: null };
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
      // src is open (its children are listed); src/app is listed but closed.
      entry('src', 0, true, null, true),
      entry('src/app', 1, true, null, true),
      entry('src/app/main.js', 2, false),
      entry('src/index.js', 1, false),
      entry('README.md', 0, false),
    ],
  };
  const out = flat(tuiWith(tree)._renderFileTree(31, 12));

  assert.match(out, /▸ FILES project/);
  // An open directory shows ▾, a closed one ▸, so a closed directory does not
  // read as an empty one.
  assert.match(out, /├▾src\//);
  assert.match(out, /├▾app\//);
  assert.match(out, /└ index\.js/);
  assert.match(out, /└ README\.md/);
  // Nesting is drawn with a continuation bar while siblings remain below.
  assert.match(out, /│ │ └ main\.js/);
});

test('directories start closed and say so', () => {
  const tree = { changeNoticeMs: 5000, entries: [entry('src', 0, true), entry('README.md', 0, false)] };
  const out = flat(tuiWith(tree)._renderFileTree(31, 8));
  assert.match(out, /▸src\//);
  assert.doesNotMatch(out, /▾src\//);
});

test('the cursor marks a row without shifting it out of line', () => {
  const entries = [entry('a', 0, true), entry('b', 0, true), entry('c.js', 0, false)];
  const t = tuiWith({ changeNoticeMs: 5000, entries });
  t.treeFocus = true;
  t.treeCursor = 1;
  const rows = flat(t._renderFileTree(31, 8)).split('\n');
  const selected = rows.find(r => r.includes('b/'));
  const other = rows.find(r => r.includes('a/'));
  assert.ok(selected.startsWith('❯'), `no caret on the selected row: ${selected}`);
  assert.ok(other.startsWith(' '), `unselected row lost its gutter: ${other}`);
  // The caret lives in a reserved column, so both rows start their tree
  // drawing at the same offset.
  assert.equal(selected.indexOf('├'), other.indexOf('├'));
});

test('the header says whether the panel has the keyboard', () => {
  const tree = { changeNoticeMs: 5000, entries: [entry('a.js', 0, false)] };
  const t = tuiWith(tree);
  assert.match(flat(t._renderFileTree(31, 8)), /\^t/);
  t.treeFocus = true;
  assert.match(flat(t._renderFileTree(31, 8)), /\[nav\]/);
});

test('a change under a closed directory is shown on the fold', () => {
  const now = Date.now();
  const closed = entry('src', 0, true);
  closed.hiddenChangeAt = now;
  const out = flat(tuiWith({ changeNoticeMs: 5000, entries: [closed] })._renderFileTree(31, 8));
  assert.match(out, /▸•src\//);
});

test('the window follows the cursor, not just a fresh file', () => {
  const entries = [];
  for (let i = 0; i < 60; i++) entries.push(entry(`f${String(i).padStart(2, '0')}.js`, 0, false));
  const t = tuiWith({ changeNoticeMs: 5000, entries });
  t.treeFocus = true;
  t.treeCursor = 45;
  const out = flat(t._renderFileTree(31, 12));
  assert.match(out, /❯.*f45\.js/);
  assert.doesNotMatch(out, /f00\.js/);
});

test('cursor helpers stay inside the tree', () => {
  const entries = [entry('a', 0, true), entry('b', 0, true), entry('c.js', 0, false)];
  const t = tuiWith({ changeNoticeMs: 5000, entries });
  t.moveTreeCursor(-5);
  assert.equal(t.treeCursor, 0);
  t.moveTreeCursor(99);
  assert.equal(t.treeCursor, 2);
  assert.equal(t.treeSelection().path, 'c.js');

  t.setTreeCursorTo('b');
  assert.equal(t.treeCursor, 1);
  // A path that is no longer visible must not silently select its neighbour.
  t.setTreeCursorTo('gone');
  assert.equal(t.treeCursor, 1);
});

test('focus is refused when there is no tree to navigate', () => {
  const t = tuiWith(null);
  assert.equal(t.toggleTreeFocus(true), false);
  assert.equal(t.treeFocus, false);
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

  // Activity inside a closed directory is its own thing: reporting it as a
  // deletion would be worse than saying nothing.
  tree.lastChange = { kind: 'changed', path: 'src/app/new.js', at: now };
  const changed = stripAllAnsi(t._renderFileTreeChange(31));
  assert.match(changed, /• src\/app\/new\.js/);
  assert.doesNotMatch(changed, /−/);

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
