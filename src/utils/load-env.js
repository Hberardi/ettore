// Minimal .env loader — zero dependencies. Reads KEY=VALUE lines from a .env
// file and injects them into process.env WITHOUT overwriting variables that
// are already set (a real exported env var always wins over the file).
//
// We look in the project root (next to package.json) first so a globally
// installed `ettore` finds the same file regardless of the working directory,
// then fall back to the current directory. Importing this module runs the
// load once as a side effect — keep it as the first import in the CLI entry.

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

// Parse a single line into [key, value] or null (comment/blank/malformed).
// Supports `export KEY=val`, optional surrounding quotes, and inline `#`
// comments on unquoted values.
function parseLine(rawLine) {
  let line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;
  if (line.startsWith('export ')) line = line.slice(7).trim();

  const eq = line.indexOf('=');
  if (eq === -1) return null;

  const key = line.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = line.slice(eq + 1).trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
    value = value.slice(1, -1);
  } else {
    // Strip an inline comment on unquoted values (` # ...`).
    const hash = value.indexOf(' #');
    if (hash !== -1) value = value.slice(0, hash).trim();
  }
  return [key, value];
}

export function loadEnvFile(filePath, { override = false, env = process.env } = {}) {
  if (!filePath || !existsSync(filePath)) return { loaded: false, count: 0 };
  let text;
  try { text = readFileSync(filePath, 'utf-8'); }
  catch { return { loaded: false, count: 0 }; }

  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const pair = parseLine(rawLine);
    if (!pair) continue;
    const [key, value] = pair;
    if (!override && env[key] !== undefined) continue; // real env wins
    env[key] = value;
    count++;
  }
  return { loaded: true, count };
}

export function loadDotenv({ env = process.env } = {}) {
  // First existing file wins; project root takes priority over cwd.
  const candidates = [join(PROJECT_ROOT, '.env'), resolve(process.cwd(), '.env')];
  for (const candidate of candidates) {
    const result = loadEnvFile(candidate, { env });
    if (result.loaded) return { ...result, path: candidate };
  }
  return { loaded: false, count: 0, path: null };
}

// Side-effect on import: load the .env so downstream modules see the vars.
loadDotenv();
