import {
  classifyVerification,
  detectProjectTestSuite,
  evaluateReleaseGate,
  recordVerification,
} from './release-gate.js';

// Runs the non-conversational side of the release gate. Agent remains
// responsible for deciding how to re-prompt the model when this reports a
// blocked status.
export class ReleaseGateCoordinator {
  constructor({
    detectTestSuite = detectProjectTestSuite,
    runTests,
  } = {}) {
    this.detectTestSuite = detectTestSuite;
    this.runTests = runTests;
    this.testSuiteCache = null;
  }

  async check({ state, workdir, emitter = null }) {
    if (!state.codeTouched) return { status: 'open' };
    if (this.testSuiteCache?.workdir !== workdir) {
      this.testSuiteCache = { workdir, runner: await this.detectTestSuite(workdir) };
    }
    const suiteAvailable = Boolean(this.testSuiteCache.runner);
    let status = evaluateReleaseGate(state, { suiteAvailable });
    if (status !== 'run_suite') return { status, ranBy: 'model' };

    const id = `release-gate-${state.mutationSeq}-${state.retries}`;
    const args = { suite: 'auto', workdir };
    emitter?.emit('toolStart', { id, name: 'run_tests', args });
    let output;
    try {
      output = await this.runTests(args);
    } catch (error) {
      output = `Error: ${error?.message || error}`;
    }
    emitter?.emit('toolEnd', { id, name: 'run_tests', args, output });
    recordVerification(state, classifyVerification('run_tests', args, output), output);
    status = evaluateReleaseGate(state, { suiteAvailable });
    // A runner that could not even start is not a red suite: ask the model
    // to perform a targeted verification instead.
    if (status === 'run_suite') status = 'needs_targeted_check';
    return { status, ranBy: 'harness', output };
  }
}
