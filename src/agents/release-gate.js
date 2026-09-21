// Release gate: a build turn that changed code does not end until the
// project's test suite has passed on the code as it finally stands.
//
// The previous guard sent one "you did not verify" reminder and then let the
// turn end whatever happened next. Worse, it counted any run of run_tests or
// run_checks as verification — a red suite included — and a check run before
// the last edit still counted after it. The model could announce "fatto" over
// failing tests and nothing in the loop would notice.
//
// The gate keeps three facts per turn: how many successful edits have been
// made, and the outcome of the latest full-suite run and of the latest
// targeted check, each stamped with the edit count it saw. A run is only
// evidence for the code it ran against. When the model tries to finish
// without a green suite on the latest edit, the harness runs the suite itself
// and hands any failure back as work still to do.

import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

// Files whose change cannot break a test run. Everything else is treated as
// code: a config, a template or a SQL file breaks builds as readily as a .js.
const NON_CODE_EXT = new Set([
  '.md', '.markdown', '.txt', '.rst', '.adoc', '.log', '.csv', '.tsv',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.pdf',
  '.mp3', '.wav', '.mp4', '.mov', '.srt',
]);

// Commands that run a whole project's test suite rather than one check.
const SUITE_COMMAND_RE = /\b(?:npm\s+(?:test|t|run\s+test)\b|yarn\s+(?:run\s+)?test\b|pnpm\s+(?:run\s+)?test\b|bun\s+(?:run\s+)?test\b|pytest\b|python3?\s+-m\s+pytest\b|go\s+test\s+\.\/\.\.\.|cargo\s+test\b|mvn\s+(?:-\S+\s+)*test\b|gradlew?\s+test\b|make\s+(?:test|check)\b|node\s+--test\b|jest\b|vitest\s+run\b|rspec\b|phpunit\b|dotnet\s+test\b)/i;

// A test path, a -k / -t / --grep filter or a single named test narrows the
// run to part of the suite; that is a targeted check, not a regression run.
const NARROWED_RE = /(?:\s-k\s|\s-t\s|--grep\b|--testNamePattern\b|--test-name-pattern\b|::|\s--\s+\S*(?:test|spec)\S*\.\w+|\s\S+\.(?:test|spec)\.\w+|\stests?\/\S+|\s--run\s+\S)/i;

// Failure lines test runners print. Needed because a pipe (`npm test | tail`)
// swallows the exit code, so the bash tool reports success over a red run.
const FAILURE_OUTPUT_RE = /(?:^|\n)\s*(?:#\s*fail\s+[1-9]\d*|not ok \d+|FAIL(?:ED)?\b|Tests?:\s+[1-9]\d*\s+failed|[1-9]\d*\s+(?:failed|failing|errors?)\b|={3,}\s*[1-9]\d*\s+failed|test result: FAILED|--- FAIL:|npm ERR!)/;

const EXIT_CODE_RE = /\[(?:exit code:? [1-9]\d*|shell exited)/;

export const DEFAULT_MAX_RELEASE_GATE_RETRIES = 5;
const FAILURE_EXCERPT_LINES = 60;

/** Whether a touched path is something a test suite can be broken by. */
export function isCodePath(filePath) {
  const ext = extname(String(filePath || '')).toLowerCase();
  return !NON_CODE_EXT.has(ext);
}

/**
 * What a tool call proves about the code, if anything.
 *
 * @returns {null | {kind: 'suite'|'targeted'|'no_suite', passed: boolean}}
 */
export function classifyVerification(name, args = {}, output = '', verifierRe = null) {
  const text = String(output ?? '');
  if (name === 'run_tests') {
    if (/no supported test runner/i.test(text)) return { kind: 'no_suite', passed: false };
    if (text.startsWith('Error:')) return null;
    return { kind: 'suite', passed: /Result:\s*PASS/.test(text) };
  }
  if (name === 'run_checks') {
    if (/no supported check suite/i.test(text)) return { kind: 'no_suite', passed: false };
    if (text.startsWith('Error:')) return null;
    const ranTests = /\[test\] (?:PASS|FAIL)/.test(text);
    const passed = !/\] FAIL\b/.test(text) && /\] PASS\b/.test(text);
    return { kind: ranTests ? 'suite' : 'targeted', passed };
  }
  if (name === 'bash' || name === 'bash_session') {
    const command = String(args.command || '');
    const isSuite = SUITE_COMMAND_RE.test(command) && !NARROWED_RE.test(` ${command} `);
    if (!isSuite && !(verifierRe && verifierRe.test(command))) return null;
    const failed = text.startsWith('Error:') || EXIT_CODE_RE.test(text) || FAILURE_OUTPUT_RE.test(text);
    return { kind: isSuite ? 'suite' : 'targeted', passed: !failed };
  }
  return null;
}

/** The runner the project's own test suite is started with, or null. */
export async function detectProjectTestSuite(workdir) {
  const root = workdir || process.cwd();
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8'));
    const script = String(pkg?.scripts?.test || '');
    // `npm init` writes a test script whose only job is to fail.
    if (script && !/no test specified/i.test(script)) return 'npm';
    return null;
  } catch { /* no package.json, or not JSON */ }
  const exists = async (f) => {
    try { await readFile(join(root, f)); return true; } catch { return false; }
  };
  if (await exists('pytest.ini') || await exists('conftest.py')) return 'pytest';
  if (await exists('pyproject.toml')) {
    const toml = await readFile(join(root, 'pyproject.toml'), 'utf-8').catch(() => '');
    if (/pytest/i.test(toml)) return 'pytest';
  }
  if (await exists('go.mod')) return 'go';
  if (await exists('Cargo.toml')) return 'cargo';
  return null;
}

export function createReleaseGateState() {
  return {
    // Successful mutations so far this turn. A verification is stamped with
    // this number and is only evidence for exactly that state of the code.
    mutationSeq: 0,
    codeTouched: false,
    lastSuite: null,     // { seq, passed, output }
    lastTargeted: null,  // { seq, passed }
    suiteMissing: false,
    retries: 0,
  };
}

// A mutation tool that refused, was cancelled or failed changed nothing.
const NOT_APPLIED_RE = /^(?:Error:|Blocked:|Cancelled\b)/;

export function mutationApplied(output) {
  return !NOT_APPLIED_RE.test(String(output ?? ''));
}

export function recordMutation(state, filePath, output) {
  if (!mutationApplied(output)) return;
  state.mutationSeq++;
  if (isCodePath(filePath)) state.codeTouched = true;
}

export function recordVerification(state, verdict, output) {
  if (!verdict) return;
  if (verdict.kind === 'no_suite') {
    state.suiteMissing = true;
    return;
  }
  const entry = { seq: state.mutationSeq, passed: verdict.passed, output: String(output ?? '') };
  if (verdict.kind === 'suite') state.lastSuite = entry;
  // A green suite also answers the targeted question.
  if (verdict.kind === 'targeted' || verdict.passed) state.lastTargeted = entry;
}

/**
 * What the gate needs before the turn may end.
 *
 * @returns {'open'|'run_suite'|'suite_failing'|'needs_targeted_check'}
 */
export function evaluateReleaseGate(state, { suiteAvailable }) {
  if (!state.codeTouched || state.mutationSeq === 0) return 'open';
  if (suiteAvailable && !state.suiteMissing) {
    const suite = state.lastSuite;
    if (suite && suite.seq === state.mutationSeq) return suite.passed ? 'open' : 'suite_failing';
    return 'run_suite';
  }
  const check = state.lastTargeted;
  return check && check.seq === state.mutationSeq && check.passed ? 'open' : 'needs_targeted_check';
}

/** The part of a failing run worth handing back: the end, where the summary is. */
export function failureExcerpt(output) {
  const lines = String(output ?? '').trimEnd().split('\n');
  if (lines.length <= FAILURE_EXCERPT_LINES) return lines.join('\n');
  const failing = lines.filter(l => /(?:^not ok|FAIL|Error|failed|✗|✖)/.test(l)).slice(0, 20);
  return [
    ...failing,
    `… (${lines.length - FAILURE_EXCERPT_LINES} lines omitted) …`,
    ...lines.slice(-(FAILURE_EXCERPT_LINES - failing.length)),
  ].join('\n');
}
