// The github plugin. No test talks to GitHub: gh is replaced by a fake runner
// that answers from fixtures, and what is checked is what the plugin makes of
// those answers — above all the failing tests it pulls out of a CI log, and
// that nothing is ever published without the user's yes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'plugins', 'github');

async function freshPlugin() {
  return import(`${pathToFileURL(join(PLUGIN_DIR, 'index.js')).href}?bust=${Date.now()}-${Math.random()}`);
}

// A gh that answers by the arguments it is given, and records every call.
function fakeGh(routes) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    const key = `${file} ${args.join(' ')}`;
    for (const [pattern, answer] of routes) {
      if (pattern.test(key)) return typeof answer === 'function' ? answer(args) : answer;
    }
    throw new Error(`unexpected call: ${key}`);
  };
  run.calls = calls;
  return run;
}

const TAP_LOG = [
  '2026-09-27T08:26:07.7524859Z not ok 33 - a sub-agent run leaves the parent turn its todo sink',
  '2026-09-27T08:26:07.7661817Z   ---',
  '2026-09-27T08:26:07.7661817Z   duration_ms: 33.6',
  "2026-09-27T08:26:07.7661817Z   location: '/w/tests/agent-subagent.test.js:107:1'",
  "2026-09-27T08:26:07.7662442Z   failureType: 'testCodeFailure'",
  '2026-09-27T08:26:07.7662837Z   error: |-',
  '2026-09-27T08:26:07.7662837Z     Expected values to be strictly deep-equal:',
  "2026-09-27T08:26:07.7662837Z   code: 'ERR_ASSERTION'",
  '2026-09-27T08:26:07.7662837Z   stack: |-',
  '2026-09-27T08:26:07.7662837Z     TestContext.<anonymous> (file:///w/tests/agent-subagent.test.js:143:10)',
  '2026-09-27T08:26:07.7662837Z   ...',
  '2026-09-27T08:26:08.0000000Z not ok 5 - tests/agent-subagent.test.js',
  '2026-09-27T08:26:08.0000000Z   ---',
  "2026-09-27T08:26:08.0000000Z   failureType: 'subtestsFailed'",
  '2026-09-27T08:26:08.0000000Z   ...',
  '2026-09-27T08:26:29.3241382Z # pass 1445',
  '2026-09-27T08:26:29.3241588Z # fail 1',
  '2026-09-27T08:26:29.4000000Z ##[error]Process completed with exit code 1.',
].join('\n');

// ── the log reader ──────────────────────────────────────────────────────────

test('a Node test log gives back the failing test, its error, and the counts', async () => {
  const { extractFailures } = await freshPlugin();
  const out = extractFailures(TAP_LOG);
  assert.equal(out.failures.length, 1, 'the file-level "subtests failed" entry is not a second failure');
  assert.equal(out.failures[0].test, 'a sub-agent run leaves the parent turn its todo sink');
  assert.match(out.failures[0].details, /agent-subagent\.test\.js:107/);
  assert.match(out.failures[0].details, /strictly deep-equal/);
  assert.doesNotMatch(out.failures[0].details, /TestContext|duration_ms/, 'stack frames and timings are noise');
  assert.equal(out.summary, 'pass 1445, fail 1');
  assert.deepEqual(out.annotations, ['Process completed with exit code 1.']);
  assert.equal(out.tail, null);
});

test('pytest, Jest and Go failures are read too', async () => {
  const { extractFailures } = await freshPlugin();
  const pytest = extractFailures([
    '_________________________ test_total _________________________',
    '    def test_total():',
    '>       assert total([1, 2]) == 4',
    'E       assert 3 == 4',
    'tests/test_calc.py:7: AssertionError',
    '=========================== short test summary info ===========================',
    'FAILED tests/test_calc.py::test_total - assert 3 == 4',
    '========================= 1 failed, 9 passed in 0.12s =========================',
  ].join('\n'));
  assert.equal(pytest.failures[0].test, 'tests/test_calc.py::test_total');
  assert.match(pytest.failures[0].details, /E {7}assert 3 == 4/);
  assert.equal(pytest.summary, '1 failed, 9 passed');

  const jest = extractFailures([
    '  ● Cart › adds an item',
    '',
    '    expect(received).toBe(expected)',
    '    Expected: 2',
    '    Received: 1',
    '      at Object.<anonymous> (src/cart.test.js:12:20)',
    'Tests:       1 failed, 14 passed, 15 total',
  ].join('\n'));
  assert.equal(jest.failures[0].test, 'Cart › adds an item');
  assert.match(jest.failures[0].details, /Expected: 2\nReceived: 1/);
  assert.equal(jest.summary, '1 failed, 14 passed, 15 total');

  const go = extractFailures([
    '=== RUN   TestParse',
    '--- FAIL: TestParse (0.00s)',
    '    parse_test.go:14: got "a", want "b"',
    'FAIL',
  ].join('\n'));
  assert.deepEqual(go.failures, [{ test: 'TestParse', details: 'parse_test.go:14: got "a", want "b"' }]);
});

test('a log in no known format still says something: its tail', async () => {
  const { extractFailures } = await freshPlugin();
  const lines = Array.from({ length: 100 }, (_, i) => `2026-09-27T08:00:00.0000000Z step output ${i}`);
  const out = extractFailures(lines.join('\n'));
  assert.equal(out.failures.length, 0);
  assert.match(out.tail, /step output 99$/);
  assert.doesNotMatch(out.tail, /step output 10\n/, 'only the end of the log');
  assert.doesNotMatch(out.tail, /2026-09-27T/, 'timestamps stripped');
});

// ── the tools, against a fake gh ────────────────────────────────────────────

const RUNS = JSON.stringify([
  { databaseId: 3, displayTitle: 'fix', workflowName: 'CI', status: 'completed', conclusion: 'success', headBranch: 'main', headSha: 'ccccccc1', event: 'push', createdAt: '2026-09-27', url: 'u3' },
  { databaseId: 2, displayTitle: 'break', workflowName: 'CI', status: 'completed', conclusion: 'failure', headBranch: 'main', headSha: 'bbbbbbb1', event: 'push', createdAt: '2026-09-26', url: 'u2' },
]);
const JOBS = JSON.stringify({
  status: 'completed', conclusion: 'failure', url: 'u2', headSha: 'bbbbbbb1', displayTitle: 'break',
  jobs: [
    { databaseId: 20, name: 'test (ubuntu)', status: 'completed', conclusion: 'failure', url: 'j20', steps: [{ name: 'Run tests', conclusion: 'failure' }] },
    { databaseId: 21, name: 'lint', status: 'completed', conclusion: 'success', url: 'j21', steps: [] },
  ],
});

test('gh_ci_failure finds the latest failed run and returns its failing tests', async () => {
  const mod = await freshPlugin();
  const gh = fakeGh([
    [/^git rev-parse/, 'main\n'],
    [/^gh run list --branch main/, RUNS],
    [/^gh run view 2 /, JOBS],
    [/^gh api repos\/\{owner\}\/\{repo\}\/actions\/jobs\/20\/logs$/, TAP_LOG],
  ]);
  mod._setRunner(gh);
  const report = await mod.tools.gh_ci_failure.handler({}, { workspace: '/w' });
  assert.equal(report.run.id, 2, 'the latest *failed* run, not the latest run');
  assert.equal(report.jobs.length, 1, 'only failed jobs are fetched');
  assert.equal(report.jobs[0].job, 'test (ubuntu)');
  assert.deepEqual(report.jobs[0].failedSteps, ['Run tests']);
  assert.equal(report.jobs[0].failures[0].test, 'a sub-agent run leaves the parent turn its todo sink');
  assert.ok(!gh.calls.some(call => call.join(' ').includes('jobs/21')), 'a passing job\'s log is not downloaded');
});

test('gh_ci_status and /ci show the runs and the jobs of the latest', async () => {
  const mod = await freshPlugin();
  mod._setRunner(fakeGh([
    [/^git rev-parse/, 'main\n'],
    [/^gh run list/, RUNS],
    [/^gh run view 3 /, JOBS.replace('"failure","url":"u2"', '"success","url":"u3"')],
  ]));
  const status = await mod.tools.gh_ci_status.handler({}, { workspace: '/w' });
  assert.equal(status.runs.length, 2);
  assert.equal(status.jobs[1].name, 'lint');
  const text = await mod.commands.ci.handler('', { workspace: '/w' });
  assert.match(text, /CI on main — run 3/);
  assert.match(text, /✗ test \(ubuntu\) — failed at: Run tests/);
});

test('gh is always called with an argument array — a title cannot become a command', async () => {
  const mod = await freshPlugin();
  const gh = fakeGh([
    [/^git rev-parse/, 'feature\n'],
    [/^gh pr create/, 'https://github.com/o/r/pull/7\n'],
  ]);
  mod._setRunner(gh);
  const title = 'fix"; rm -rf ~; echo "';
  const out = await mod.tools.gh_pr_create.handler(
    { title, body: 'b' },
    { workspace: '/w', confirm: async () => ({ allowed: true }) },
  );
  assert.equal(out, 'Opened: https://github.com/o/r/pull/7');
  const call = gh.calls.find(c => c[1] === 'pr');
  assert.equal(call[call.indexOf('--title') + 1], title, 'passed through as one argument, untouched');
  assert.equal(call[call.indexOf('--head') + 1], 'feature');
});

// ── nothing is published without a yes ─────────────────────────────────────

for (const [tool, args] of [
  ['gh_pr_create', { title: 't', body: 'b' }],
  ['gh_issue_create', { title: 't', body: 'b' }],
  ['gh_comment', { number: 3, body: 'b' }],
]) {
  test(`${tool}: refused without a way to ask, and cancelled on a no — gh never called`, async () => {
    const mod = await freshPlugin();
    const gh = fakeGh([[/^git rev-parse/, 'feature\n']]);
    mod._setRunner(gh);
    const noWay = await mod.tools[tool].handler(args, { workspace: '/w' });
    assert.match(noWay, /^Refused/);
    const no = await mod.tools[tool].handler(args, { workspace: '/w', confirm: async () => ({ allowed: false, reason: 'cancelled' }) });
    assert.match(no, /^Cancelled by user/);
    const nobody = await mod.tools[tool].handler(args, { workspace: '/w', confirm: async () => ({ allowed: false, reason: 'non_interactive' }) });
    assert.match(nobody, /^Blocked/);
    assert.ok(!gh.calls.some(c => c[0] === 'gh'), 'nothing reached GitHub');
  });
}

test('reading is low risk and allowed in plan mode; publishing is high risk', async () => {
  const { validateManifest, validatePluginModule } = await import('../src/plugins/manifest.js');
  const manifest = validateManifest(JSON.parse(readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf8')), PLUGIN_DIR);
  assert.equal(manifest.name, 'github');
  const validated = validatePluginModule(await freshPlugin());
  for (const name of ['gh_ci_status', 'gh_ci_failure', 'gh_pr_view', 'gh_pr_list', 'gh_issue_list', 'gh_issue_view']) {
    assert.equal(validated.tools[name].risk, 'low', name);
  }
  for (const name of ['gh_pr_create', 'gh_issue_create', 'gh_comment']) {
    assert.equal(validated.tools[name].risk, 'high', name);
  }
  assert.ok(validated.commands.ci && validated.commands.pr);
});

test('through the registry, the agent\'s confirm reaches the plugin', async () => {
  const { PluginRegistry } = await import('../src/plugins/registry.js');
  const { readManifest, importPlugin } = await import('../src/plugins/loader.js');
  const reg = new PluginRegistry({});
  const manifest = await readManifest(PLUGIN_DIR);
  const { mod, validated } = await importPlugin(manifest);
  mod._setRunner(fakeGh([[/^git rev-parse/, 'feature\n'], [/^gh issue create/, 'https://github.com/o/r/issues/9\n']]));
  reg.register({ manifest, ...validated, _module: mod, loadedAt: new Date().toISOString() });

  const asked = [];
  const handlers = reg.getAllToolHandlers({
    contextFactory: () => ({ workspace: '/w', confirm: async (title, detail) => { asked.push([title, detail]); return { allowed: true }; } }),
  });
  const out = await handlers.gh_issue_create({ title: 'Bug nel parser', body: 'dettagli' });
  assert.equal(out, 'Opened: https://github.com/o/r/issues/9');
  assert.match(asked[0][0], /issue su GitHub/);
  assert.match(asked[0][1], /Bug nel parser/);
});

test('/plugins enable on a plugin that is already running says so instead of failing', async () => {
  const { PluginRegistry } = await import('../src/plugins/registry.js');
  const { PluginRuntime } = await import('../src/plugins/runtime.js');
  const { readManifest, importPlugin } = await import('../src/plugins/loader.js');
  const { builtinCommands } = await import('../src/commands/index.js');
  const registry = new PluginRegistry({});
  const runtime = new PluginRuntime({ registry });
  const manifest = await readManifest(PLUGIN_DIR);
  const { mod, validated } = await importPlugin(manifest);
  registry.register({ manifest, ...validated, _module: mod, loadedAt: new Date().toISOString() });

  const result = await runtime.enable('github');
  assert.equal(result.manifest.name, 'github', 'same shape as a fresh enable');
  const out = await builtinCommands.plugins.handler(['enable', 'github'], { pluginRuntime: runtime });
  assert.match(out, /already enabled \(v1\.0\.0\)/);
});
