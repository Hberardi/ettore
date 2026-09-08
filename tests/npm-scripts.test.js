// Regression: `npm test` ran zero tests on the version CI pinned.
//
// The script was `node --test "tests/**/*.test.js"`. Glob expansion in
// `node --test` arrived in Node 21, so on Node 20 the pattern was taken
// literally: the runner reported `Could not find 'tests/**/*.test.js'` and
// exited 1. CI had therefore never executed the suite — on any commit — and
// `prepublishOnly` would have failed a release the same way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

test('the test script uses no glob, which older Node cannot expand', () => {
  const script = pkg.scripts.test;
  assert.ok(
    !/[*?]/.test(script),
    `\`${script}\` relies on glob expansion; node --test only does that from Node 21, `
    + 'and package.json declares support from Node 18.',
  );
});

test('the test script does not name a directory either', () => {
  // Node 20 treats a bare directory as a tree to search; Node 22 treats it as
  // a module path and dies with MODULE_NOT_FOUND. Passing nothing is the only
  // form both agree on: search the working directory recursively.
  const script = pkg.scripts.test;
  assert.match(script, /^node --test\s*$/, `\`${script}\` is not the portable form`);
});

test('the declared engine range is one the test script can actually run', () => {
  // `node --test` with no arguments has searched recursively since Node 18,
  // which is the floor package.json declares.
  const range = pkg.engines?.node || '';
  const floor = Number((range.match(/(\d+)/) || [])[1]);
  assert.ok(Number.isFinite(floor) && floor >= 18, `unexpected engines.node: ${range}`);
});

test('CI exercises both ends of the supported range, on both platforms', () => {
  // A single pinned version is what let this survive: whoever ran the suite
  // locally was on a Node where the glob worked.
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf-8');
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /node:\s*\[20,\s*22\]/, 'the Node matrix must cover more than one version');
});
