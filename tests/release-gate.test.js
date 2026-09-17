import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Agent } from '../src/agents/index.js';
import { setAutoApprove } from '../src/tools/index.js';
import { promptSeen } from './helpers/prompt-seen.js';
import {
  classifyVerification,
  createReleaseGateState,
  detectProjectTestSuite,
  evaluateReleaseGate,
  recordMutation,
  recordVerification,
} from '../src/agents/release-gate.js';

const VERIFIER_RE = /\bnode\s+--check\b/;

test('a red run_tests is evidence of failure, not verification', () => {
  assert.deepEqual(classifyVerification('run_tests', {}, 'Runner: npm\nResult: FAIL\n...'), { kind: 'suite', passed: false });
  assert.deepEqual(classifyVerification('run_tests', {}, 'Runner: npm\nResult: PASS\n'), { kind: 'suite', passed: true });
  assert.equal(classifyVerification('run_tests', {}, 'Error: no supported test runner detected').kind, 'no_suite');
});

test('run_checks counts as a suite run only when it ran the tests', () => {
  assert.deepEqual(classifyVerification('run_checks', {}, '[lint] PASS\nok\n\n[test] PASS\nok'), { kind: 'suite', passed: true });
  assert.deepEqual(classifyVerification('run_checks', {}, '[lint] FAIL\n1 error'), { kind: 'targeted', passed: false });
});

test('bash: a full suite command, a narrowed one, and a piped red run', () => {
  assert.deepEqual(classifyVerification('bash', { command: 'npm test' }, 'ok'), { kind: 'suite', passed: true });
  assert.equal(classifyVerification('bash', { command: 'npm test' }, 'x\n[exit code 1]').passed, false);
  assert.equal(classifyVerification('bash', { command: 'pytest tests/test_a.py' }, 'ok', /pytest/).kind, 'targeted');
  assert.equal(classifyVerification('bash', { command: 'npm test | tail -5' }, '# pass 3\n# fail 2').passed, false);
  assert.equal(classifyVerification('bash', { command: 'npm test | tail -5' }, '# pass 3\n# fail 0').passed, true);
  assert.equal(classifyVerification('bash', { command: 'ls -la' }, 'ok', VERIFIER_RE), null);
});

test('only a green suite on the latest edit opens the gate', () => {
  const s = createReleaseGateState();
  assert.equal(evaluateReleaseGate(s, { suiteAvailable: true }), 'open');
  recordMutation(s, 'a.js', '✓ Edited a.js');
  assert.equal(evaluateReleaseGate(s, { suiteAvailable: true }), 'run_suite');
  recordVerification(s, { kind: 'suite', passed: false }, 'boom');
  assert.equal(evaluateReleaseGate(s, { suiteAvailable: true }), 'suite_failing');
  recordVerification(s, { kind: 'suite', passed: true }, 'ok');
  assert.equal(evaluateReleaseGate(s, { suiteAvailable: true }), 'open');
  recordMutation(s, 'a.js', '✓ Edited a.js');
  assert.equal(evaluateReleaseGate(s, { suiteAvailable: true }), 'run_suite');
});

test('docs-only changes and failed edits do not close the gate', () => {
  const s = createReleaseGateState();
  recordMutation(s, 'README.md', '✓ Edited');
  recordMutation(s, 'a.js', 'Error: old_string not found');
  recordMutation(s, 'b.js', 'Blocked: overwrite/edit requires interactive confirmation.');
  assert.equal(evaluateReleaseGate(s, { suiteAvailable: true }), 'open');
});

test('the default npm placeholder script is not a test suite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-gate-'));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    assert.equal(await detectProjectTestSuite(dir), null);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }));
    assert.equal(await detectProjectTestSuite(dir), 'npm');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function writeCall(id, path, content) {
  return { id, type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: path, content }) } };
}

test('the harness runs the suite itself and refuses to finish until it is green', { skip: Boolean(process.env.ETTORE_RELEASE_GATE) }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-gate-'));
  setAutoApprove({ edits: true });
  try {
    // The suite passes only when sum.cjs really adds.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'g', private: true, scripts: { test: 'node check.cjs' } }));
    await writeFile(join(dir, 'check.cjs'), "const s = require('./sum.cjs'); if (s(2, 3) !== 5) { console.log('not ok 1 - sum(2,3) should be 5'); process.exit(1); } console.log('ok 1');\n");
    const target = join(dir, 'sum.cjs');
    let turns = 0;
    let sawBlocked = false;
    const client = {
      async turn(messages) {
        turns++;
        if (turns === 1) {
          const tc = writeCall('w1', target, 'module.exports = (a, b) => a - b;\n');
          return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
        }
        if (turns === 2) return { type: 'text', content: 'Fatto.' };
        if (turns === 3) {
          const seen = String(promptSeen(messages));
          sawBlocked = /RELEASE BLOCKED/.test(seen) && /sum\(2,3\) should be 5/.test(seen);
          const tc = writeCall('w2', target, 'module.exports = (a, b) => a + b;\n');
          return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
        }
        return { type: 'text', content: 'Corretto, test verdi.' };
      },
    };
    const agent = new Agent(client, {
      provider: 'test', model: 'gpt-4o', modelCapability: 'full', workdir: dir, contextWindow: 128000,
    }, 'build');
    const emitter = new EventEmitter();
    const gates = [];
    emitter.on('releaseGate', e => gates.push(e.status));
    const result = await agent.run('crea sum.cjs che somma due numeri', emitter);
    assert.equal(sawBlocked, true, 'the failing run must be handed back to the model');
    assert.equal(turns, 4);
    assert.match(String(result), /test verdi/);
    assert.doesNotMatch(String(result), /NON verificato/);
    assert.deepEqual(gates, ['suite_failing', 'open']);
    assert.equal(await readFile(target, 'utf-8'), 'module.exports = (a, b) => a + b;\n');
  } finally {
    setAutoApprove({ edits: false });
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});
