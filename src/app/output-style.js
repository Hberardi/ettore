// How a line of command output should look in the output window.
//
// Commands return plain text — it also goes to the shell (`ettore /plugins`)
// and to tests, where colour codes would be noise. The window used to paint
// every line the same accent colour, so a list of plugins was a wall of cyan
// where the names did not stand out from their descriptions. The shape of the
// text already says what each line is; this reads it:
//
//   Enabled plugins (7)              → title   (bold, accent)
//   ● github  v1.0.0 · 9 tools       → entry   (● and name bold; the rest dim)
//       GitHub from the agent: …     → detail  (plain text)
//       permissions: shell:exec      → meta    (dim)
//   Run /plugins info <name> …       → hint    (dim)
//
// Anything else is plain text, exactly as before.

const TITLE_RE = /^[^\s●•◆▸✓✗⚠-][^:]{0,80}(?:\(\d+\)|:)(?:\s+—.*)?$/;
// Only list bullets start an entry; ✓ and ✗ start a status line.
const ENTRY_RE = /^(\s{0,2})([●•])\s+(\S+)(.*)$/;
const META_RE = /^\s{2,}(?:permissions|perms|version|root|main|author|license|api ?version|loaded at|status)\s*:/i;
const HINT_RE = /^(?:Run |Use |Usage:|Tip:|Next:)/;

/**
 * The style of one output line: `{ kind, parts }`, where `parts` splits an
 * entry line into its marker, name and rest.
 */
export function styleOutputLine(line) {
  const text = String(line ?? '');
  if (!text.trim()) return { kind: 'blank' };
  const entry = ENTRY_RE.exec(text);
  if (entry) {
    return { kind: 'entry', parts: { indent: entry[1], marker: entry[2], name: entry[3], rest: entry[4] } };
  }
  if (META_RE.test(text)) return { kind: 'meta' };
  if (HINT_RE.test(text.trim())) return { kind: 'hint' };
  if (TITLE_RE.test(text) && !/^\s/.test(text)) return { kind: 'title' };
  if (/^\s{3,}/.test(text)) return { kind: 'detail' };
  return { kind: 'text' };
}
