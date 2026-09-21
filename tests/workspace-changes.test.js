import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { toolHandlers } from '../src/tools/index.js';
import {
  commandWriteTargets,
  diffSnapshots,
  parsePorcelainZ,
  snapshotWorkspace,
} from '../src/agents/workspace-changes.js';

const gitAvailable = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

test('porcelain -z: plain entries, and both ends of a rename', () => {
  const entries = parsePorcelainZ(' M src/a.js\0?? new.js\0R  b.js\0old-b.js\0');
  assert.deepEqual([...entries], [
    ['src/a.js', ' M'],
    ['new.js', '??'],
    ['b.js', 'R '],
    ['old-b.js', 'D '],
  ]);
});

test('diff: appeared, vanished and re-edited paths count, unchanged ones do not', () => {
  // The root is joined with the platform separator, so the expectation is
  // built the same way rather than hard-coding POSIX.
  const root = resolve(sep, 'r');
  const before = { root, entries: new Map([['a.js', ' M|1|10'], ['gone.js', '??|1|1'], ['same.js', ' M|5|5']]) };
  const after = { root, entries: new Map([['a.js', ' M|2|12'], ['new.js', '??|3|3'], ['same.js', ' M|5|5']]) };
  assert.deepEqual(
    diffSnapshots(before, after),
    [join(root, 'a.js'), join(root, 'gone.js'), join(root, 'new.js')],
  );
  assert.deepEqual(diffSnapshots(null, after), []);
});

test('command write targets: redirects, tee and in-place edits, never /dev or fd dups', () => {
  // Relative targets resolve against the cwd with the platform's separator.
  const cwd = resolve(sep, 'w');
  assert.deepEqual(commandWriteTargets('echo x > out.js', cwd), [join(cwd, 'out.js')]);
  assert.deepEqual(commandWriteTargets("sed -i 's/a/b/' src/x.py", cwd), [join(cwd, 'src', 'x.py')]);
  // An absolute POSIX path stays absolute on POSIX; on Windows it is not one,
  // so it resolves against the cwd like any other relative target.
  assert.deepEqual(commandWriteTargets('cat a | tee -a /abs/log.txt', cwd), [resolve(cwd, '/abs/log.txt')]);
  assert.deepEqual(commandWriteTargets('npm test 2>&1 > /dev/null', cwd), []);
  assert.deepEqual(commandWriteTargets('ls -la && grep foo bar.js', cwd), []);
});

test('snapshot sees a second edit to a file that was already dirty', { skip: !gitAvailable }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-ws-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await writeFile(join(dir, 'a.js'), 'one\n');
    const first = await snapshotWorkspace(dir);
    assert.ok(first, 'a git work tree yields a snapshot');
    await writeFile(join(dir, 'a.js'), 'two, and longer\n');
    const second = await snapshotWorkspace(dir);
    assert.deepEqual(diffSnapshots(first, second).map(p => p.slice(p.lastIndexOf(sep) + 1)), ['a.js']);
    assert.deepEqual(diffSnapshots(second, await snapshotWorkspace(dir)), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a code change made through bash goes to the release gate like a write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-shell-gate-'));
  const originalBash = toolHandlers.bash;
  const originalRunTests = toolHandlers.run_tests;
  let suiteRuns = 0;
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'g', private: true, scripts: { test: 'node check.cjs' } }));
    // Simulated so the test does not depend on spawning a shell. Outside git
    // the agent reads the target off the command, which is what this checks.
    toolHandlers.bash = async ({ command }) => {
      await writeFile(join(dir, 'sum.cjs'), 'module.exports = (a, b) => a + b;\n');
      return `$ ${command}\n(exit 0)`;
    };
    toolHandlers.run_tests = async () => {
      suiteRuns++;
      return 'Runner: npm\nResult: PASS\nok 1 - sum\n';
    };
    let turns = 0;
    const client = {
      async turn() {
        turns++;
        if (turns === 1) {
          const tc = {
            id: 'b1',
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command: "echo 'module.exports = (a, b) => a + b;' > sum.cjs", workdir: dir }) },
          };
          return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
        }
        return { type: 'text', content: 'Fatto.' };
      },
    };
    const agent = new Agent(client, {
      provider: 'test', model: 'gpt-4o', modelCapability: 'full', workdir: dir, contextWindow: 128000,
    }, 'build');
    const emitter = new EventEmitter();
    const gates = [];
    emitter.on('releaseGate', e => gates.push(e.status));
    await agent.run('crea sum.cjs che somma due numeri', emitter);
    assert.equal(suiteRuns, 1, 'the harness must run the suite the model skipped');
    assert.deepEqual(gates, ['open']);
    assert.ok(agent.getWorkingMemorySnapshot().workspaceRevision >= 1);
  } finally {
    toolHandlers.bash = originalBash;
    toolHandlers.run_tests = originalRunTests;
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});
