import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSelectedPaths } from '../src/utils/file-picker.js';

test('file picker parses native chooser output', () => {
  assert.deepEqual(parseSelectedPaths('/tmp/a.png\n/tmp/report.pdf\n'), ['/tmp/a.png', '/tmp/report.pdf']);
  assert.deepEqual(parseSelectedPaths(''), []);
});
