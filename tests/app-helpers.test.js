import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate, sanitizeLLMText, formatK, toolLabel } from '../src/app/helpers.js';

test('truncate: short strings unchanged', () => {
  assert.equal(truncate('hi', 10), 'hi');
  assert.equal(truncate('', 5), '');
  assert.equal(truncate(null, 5), '');
});

test('truncate: long strings get ellipsis', () => {
  assert.equal(truncate('hello world', 7), 'hello …');
  assert.equal(truncate('1234567890', 5).length, 5);
});

test('formatK: thousands abbreviation', () => {
  assert.equal(formatK(0), '0');
  assert.equal(formatK(999), '999');
  assert.equal(formatK(1000), '1.0k');
  assert.equal(formatK(15_500), '15.5k');
});

test('sanitizeLLMText: strips ANSI CSI sequences', () => {
  assert.equal(sanitizeLLMText('\x1b[31mred\x1b[0m text'), 'red text');
  assert.equal(sanitizeLLMText('plain'), 'plain');
});

test('sanitizeLLMText: strips OSC 8 hyperlinks', () => {
  const evil = '\x1b]8;;https://evil.com\x07click\x1b]8;;\x07';
  const clean = sanitizeLLMText(evil);
  assert.ok(!clean.includes('\x1b'));
  assert.ok(!clean.includes('evil.com'));
  assert.ok(clean.includes('click'));
});

test('sanitizeLLMText: strips zero-width chars', () => {
  // U+200B zero-width space, U+FEFF BOM, U+2060 word joiner
  const dirty = 'foo​bar﻿baz⁠qux';
  assert.equal(sanitizeLLMText(dirty), 'foobarbazqux');
});

test('sanitizeLLMText: handles non-string input', () => {
  assert.equal(sanitizeLLMText(null), null);
  assert.equal(sanitizeLLMText(undefined), undefined);
  assert.equal(sanitizeLLMText(42), 42);
});

test('toolLabel: bash command', () => {
  const r = toolLabel('bash', { command: 'ls -la' });
  assert.equal(r.action, '$');
  assert.equal(r.detail, 'ls -la');
});

test('toolLabel: read/write/edit show only filename', () => {
  for (const name of ['read', 'write', 'edit']) {
    const r = toolLabel(name, { file_path: '/very/deep/path/to/file.txt' });
    assert.equal(r.action, name);
    assert.equal(r.detail, 'file.txt');
  }
});

test('toolLabel: grep with path', () => {
  const r = toolLabel('grep', { pattern: 'TODO', path: '/src' });
  assert.match(r.detail, /TODO/);
  assert.match(r.detail, /\/src/);
});

test('toolLabel: project inspection tools', () => {
  assert.deepEqual(toolLabel('list_dir', { path: 'src' }), { action: 'ls', detail: 'src' });
  assert.deepEqual(toolLabel('file_info', { path: 'package.json' }), { action: 'stat', detail: 'package.json' });
  assert.deepEqual(toolLabel('git_status', {}), { action: 'git', detail: 'status' });
  assert.deepEqual(toolLabel('git_diff', { staged: true }), { action: 'diff', detail: 'staged' });
});

test('toolLabel: webfetch detail is the URL', () => {
  const r = toolLabel('webfetch', { url: 'https://example.com/foo' });
  assert.equal(r.action, 'fetch');
  assert.match(r.detail, /example\.com/);
});

test('toolLabel: websearch detail is the query', () => {
  const r = toolLabel('websearch', { query: 'latest node release' });
  assert.equal(r.action, 'search');
  assert.match(r.detail, /latest node release/);
});

test('toolLabel: server console detail is the source', () => {
  const r = toolLabel('read_server_console', { file_path: '.ettore/server.log' });
  assert.equal(r.action, 'console');
  assert.equal(r.detail, '.ettore/server.log');
});

test('toolLabel: unknown tool falls through to first arg', () => {
  const r = toolLabel('mystery', { thing: 'value' });
  assert.equal(r.action, 'mystery');
  assert.equal(r.detail, 'value');
});

test('toolLabel: handles missing args', () => {
  const r = toolLabel('bash', null);
  assert.equal(r.action, 'bash');
  assert.equal(r.detail, '');
});
