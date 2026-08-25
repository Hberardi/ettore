#!/usr/bin/env node
// Verification script: runs npm test, npm run lint, and python3 test_display.py
// sequentially, captures all output, and writes a summary to verify-result.log
// so the parent agent can read it without dealing with stdout buffering.

import { spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logFile = join(__dirname, '..', 'verify-result.log');

function run(label, cmd, args, opts = {}) {
  const start = Date.now();
  appendFileSync(logFile, `\n========== ${label} (${cmd} ${args.join(' ')}) ==========\n`);
  try {
    const result = spawnSync(cmd, args, {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      timeout: opts.timeout || 240_000,
      shell: process.platform === 'win32',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    appendFileSync(logFile, `[exit ${result.status} · ${elapsed}s]\n`);
    if (stdout) appendFileSync(logFile, `--- stdout ---\n${stdout}\n`);
    if (stderr) appendFileSync(logFile, `--- stderr ---\n${stderr}\n`);
    return { status: result.status, elapsed, stdout, stderr };
  } catch (e) {
    appendFileSync(logFile, `[ERROR] ${e.message}\n`);
    return { status: -1, elapsed: 0, stdout: '', stderr: String(e) };
  }
}

writeFileSync(logFile, `Verify run at ${new Date().toISOString()}\n`);

const results = {};

// 1. Lint
results.lint = run('Lint', 'npm', ['run', 'lint']);

// 2. Test
results.test = run('Test', 'npm', ['test']);

// 3. python3 test_display.py (if python3 is available)
const pyCheck = spawnSync('python3', ['--version'], { encoding: 'utf8', shell: true });
if (pyCheck.status === 0) {
  results.display = run('TUI display', 'python3', ['test_display.py']);
} else {
  const pyCheck2 = spawnSync('python', ['--version'], { encoding: 'utf8', shell: true });
  if (pyCheck2.status === 0) {
    results.display = run('TUI display', 'python', ['test_display.py']);
  } else {
    appendFileSync(logFile, '\n========== TUI display ==========\n[SKIP] python3 / python not available\n');
    results.display = { status: -2, elapsed: 0, stdout: '', stderr: 'python not available' };
  }
}

appendFileSync(logFile, '\n========== SUMMARY ==========\n');
const summary = {
  lint: { status: results.lint.status, elapsed: results.lint.elapsed },
  test: { status: results.test.status, elapsed: results.test.elapsed },
  display: { status: results.display.status, elapsed: results.display.elapsed },
};
appendFileSync(logFile, JSON.stringify(summary, null, 2) + '\n');

// Quick verdict
const failed = Object.entries(summary).filter(([k, v]) => v.status !== 0 && v.status !== -2);
if (failed.length === 0) {
  appendFileSync(logFile, 'VERDICT: PASS\n');
} else {
  appendFileSync(logFile, `VERDICT: FAIL (${failed.map(([k]) => k).join(', ')})\n`);
}

process.exit(0);
