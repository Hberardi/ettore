// A tool that will not work, and the one to use instead.
//
// A tool can be unusable for the whole turn and not just unlucky: ripgrep is
// not installed, the PDF has no text layer, Chrome is missing, the shell
// session died, a binary is not on PATH, the call times out every time. The
// harness already retries a transient error and then hands the model
// `Error: …` — and from there it is on its own. In real sessions it retried
// the same call, or answered that it could not do the job, while a tool that
// would have worked sat in the same tool list.
//
// Most tools here have a stand-in: `grep` and a `bash` running rg, `read` and
// `Get-Content`, `read_pdf` and OCR, `run_tests` and the test command. Which
// one fits depends on what failed and why, which is a judgment — so Jev picks
// it, from a list the harness knows to be sound, and only when it is sure.
// Jev names the tool; the model makes the call, as it always has.

import { readChoice } from './index.js';

const CHECK_TIMEOUT_MS = 6_000;

// The stand-ins, per tool. Each one says how to use it for that job, because
// "use bash instead" without the command is advice the model has to invent.
export const TOOL_ALTERNATIVES = {
  grep: [
    { name: 'bash', how: 'run the platform search directly — `rg -n <pattern> <path>`, `grep -rn`, or `Select-String -Path <glob> -Pattern <pattern>` on Windows' },
    { name: 'repo_find_symbol', how: 'when the pattern is a symbol name rather than a free-form regex' },
    { name: 'glob', how: 'narrow to the likely files first, then read them' },
  ],
  glob: [
    { name: 'list_dir', how: 'walk the directories yourself, recursive=true' },
    { name: 'bash', how: '`find <dir> -name <pattern>` or `Get-ChildItem -Recurse -Filter <pattern>`' },
  ],
  read: [
    { name: 'bash', how: '`sed -n <from>,<to>p <file>`, `cat <file>`, or `Get-Content <file>`' },
    { name: 'read_pdf', how: 'when the file is a PDF' },
    { name: 'read_doc', how: 'when the file is a Word or OpenDocument file' },
  ],
  repo_find_symbol: [
    { name: 'grep', how: 'search for the symbol with word boundaries' },
    { name: 'bash', how: '`rg -nw <symbol>` or `grep -rnw <symbol>`' },
  ],
  repo_map: [
    { name: 'list_dir', how: 'map the tree yourself from the project root' },
    { name: 'glob', how: 'list the source files by extension' },
  ],
  bash: [
    { name: 'bash_session', how: 'the persistent shell, which survives a one-shot shell that cannot start' },
    { name: 'read', how: 'when the command was only reading a file' },
    { name: 'list_dir', how: 'when the command was only listing a directory' },
  ],
  bash_session: [
    { name: 'bash', how: 'a fresh shell per command, which does not depend on the session that died' },
  ],
  run_tests: [
    { name: 'bash', how: 'run the project\'s own test command — `npm test`, `pytest`, `go test ./...`, `cargo test`' },
  ],
  run_checks: [
    { name: 'bash', how: 'run the checkers directly — `eslint .`, `tsc --noEmit`, `ruff check`, `node --check <file>`' },
  ],
  git_status: [{ name: 'bash', how: '`git status --short --branch`' }],
  git_diff: [{ name: 'bash', how: '`git diff` (add `--staged` for the index)' }],
  dep_inspect: [{ name: 'bash', how: '`npm outdated --json`, `npm audit --json`, `pip list --outdated`' }],
  read_pdf: [
    { name: 'read_pdf', how: 'the same file with ocr=true, for a scan with no text layer' },
    { name: 'bash', how: '`pdftotext <file> -` when it is installed' },
  ],
  read_doc: [{ name: 'bash', how: '`unzip -p <file> word/document.xml` for .docx, `antiword` for .doc' }],
  webfetch: [
    { name: 'websearch', how: 'find the same content from another source' },
    { name: 'browser_app', how: 'open the page in a real browser, which gets past what a plain fetch cannot' },
  ],
  websearch: [{ name: 'webfetch', how: 'fetch a known URL directly instead of searching' }],
  browser_app: [
    { name: 'browser_check', how: 'the lighter check, when the full browser cannot start' },
    { name: 'webfetch', how: 'read the page without a browser, when the markup is enough' },
  ],
  desktop_app: [{ name: 'bash', how: 'launch the program from the shell and read what it prints' }],
  explore: [
    { name: 'grep', how: 'search for it yourself' },
    { name: 'repo_map', how: 'get the shape of the repository first, then read the files that matter' },
  ],
  web_image: [{ name: 'webfetch', how: 'fetch the page and work from its text' }],
  video_transcript: [{ name: 'audio_transcribe', how: 'transcribe the audio track instead' }],
};

// Failures worth routing around: the tool is unusable here, not unlucky.
// A wrong argument, a file that does not exist, a test that failed — those are
// answers, and swapping the tool for another would hide them.
//
// ENOENT is the trap: `spawn rg ENOENT` is a missing program, while
// `ENOENT: no such file or directory, open 'x.js'` is a missing file — the
// second is the model's path being wrong, and a different tool would not find
// the file either. Only the spawn shape counts.
const BLOCKED_RE = /(spawn \S+ ENOENT|not installed|command not found|is not recognized|executable (?:file )?not found|not found (?:on|in) PATH|is not available|timed out after|\[timeout|permission denied|EACCES|EPERM|could not start|failed to launch|no display|missing binary|exit code 127)/i;

/** Whether `output` says the tool itself could not run. */
export function looksBlocked(output = '') {
  const text = String(output || '');
  if (!text) return false;
  if (!/^Error:|\[timeout|\[exit code/i.test(text) && !/^Unknown tool:/.test(text)) return false;
  return BLOCKED_RE.test(text) || /^Unknown tool:/.test(text);
}

/**
 * The stand-ins for `tool` that this turn could actually call.
 * `available` is the set of tool names the model has been handed, plus the
 * ones the harness is willing to add for it.
 */
export function alternativesFor(tool, available = null) {
  const list = TOOL_ALTERNATIVES[tool] || [];
  if (!available) return list;
  return list.filter(alt => alt.name === tool || available.has(alt.name));
}

/**
 * Ask Jev which stand-in to use. Never throws; an unsure or failing answer
 * comes back as `{ pick: null }` and the caller leaves the error as it is.
 *
 * @returns {Promise<{pick: object|null, confidence: number|null, ms: number, error: string|null}>}
 */
export async function judgeToolFallback(client, { goal, tool, args = {}, error = '', candidates = [] } = {}, { signal = null } = {}) {
  const empty = { pick: null, confidence: null, ms: 0, error: null };
  if (!client || !candidates.length) return empty;
  const startedAt = Date.now();
  const criteria = { none: 'None of these would do the job, or the failure is about the request rather than the tool.' };
  // Two stand-ins can name the same tool for different jobs (read_pdf with
  // OCR, bash two ways), so the option key is positional and the tool name
  // travels in the text Jev reads.
  const byKey = new Map();
  candidates.forEach((candidate, index) => {
    const key = `option_${index}`;
    byKey.set(key, candidate);
    criteria[key] = `Use \`${candidate.name}\`: ${candidate.how}`;
  });
  try {
    const { answers } = await client.evaluate({
      state: {
        user_goal: String(goal || '').slice(0, 2000),
        failed_tool: tool,
        failed_input: JSON.stringify(args).slice(0, 600),
        failure: String(error || '').replace(/\s+/g, ' ').slice(0, 600),
      },
      questions: {
        fallback: {
          type: 'choice',
          instructions: {
            question: '`failed_tool` could not do its job here. Which of these is the way to get `user_goal` moving again?',
            note: 'Pick a stand-in only when it would really produce what the failed call was after. If the failure says the request itself is wrong — a path that does not exist, a bad argument — answer none.',
          },
          criteria,
        },
      },
      signal,
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    const verdict = readChoice(answers?.fallback);
    const ms = Date.now() - startedAt;
    if (!verdict.decisive || !verdict.choice || verdict.choice === 'none') {
      return { ...empty, confidence: verdict.confidence, ms };
    }
    return { pick: byKey.get(verdict.choice) || null, confidence: verdict.confidence, ms, error: null };
  } catch (err) {
    return { ...empty, ms: Date.now() - startedAt, error: err?.message || String(err) };
  }
}

/** The line appended to the failed tool's result, where the model will read it. */
export function fallbackNote(tool, pick) {
  return `\n\n[Jev: \`${tool}\` cannot do this here. Use \`${pick.name}\` instead — ${pick.how}. Do not retry \`${tool}\` for this.]`;
}
