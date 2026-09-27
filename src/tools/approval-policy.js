// What still needs the user's OK once they have said "stop asking".
//
// `/auto-approve on` used to switch off two prompts — edits and project
// installs — and leave every other one in place: any `sudo`, any download or
// clone, any command matching a destructive regex, any command Jev flagged.
// With the agent working, that is a question every few steps, which is exactly
// what the user asked not to have.
//
// The rule the user set is narrower and clearer: with auto-approve on, ask only
// before files are deleted, and before anything is changed outside the working
// directory. Everything inside the project that does not delete is the agent's
// to do. This module decides which side of that line a command or a path falls
// on; the tools do the asking.

import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { commandWriteTargets } from '../agents/workspace-changes.js';
import { isPlainlyReadOnly } from '../jev/command-judge.js';

// Deleting files, or throwing away work that exists only on disk. `rm` counts
// with any flags — a plain `rm file.txt` deletes just as surely as `rm -rf`.
const DELETE_PATTERNS = [
  { re: /(?:^\s*|[;&|(`]\s*|\bsudo\s+|\bxargs\s+(?:-\S+\s+)*)rm(?:dir)?(?:\s|$)/i, label: 'rm' },
  { re: /(?:^\s*|[;&|(]\s*)(?:unlink|shred)(?:\s|$)/i, label: 'unlink / shred' },
  { re: /(?:^\s*|[;&|(]\s*)(?:del|erase|rd)\s/i, label: 'del / rd' },
  { re: /\bRemove-Item\b/i, label: 'Remove-Item' },
  { re: /\bfind\b[^;&|]*\s-(?:delete|exec(?:dir)?\s+rm)\b/i, label: 'find -delete' },
  { re: /\bgit\s+clean\b/i, label: 'git clean' },
  { re: /\bgit\s+rm\b/i, label: 'git rm' },
  { re: /\bgit\s+reset\s+[^;&|]*--hard\b/i, label: 'git reset --hard' },
  { re: /\bgit\s+checkout\s+(?:[^;&|]*\s)?--\s/i, label: 'git checkout --' },
  { re: /\bgit\s+checkout\s+\.(?:\s|$)/i, label: 'git checkout .' },
  // `--staged` alone only unstages; the working copy is untouched.
  { re: /\bgit\s+restore\b(?![^;&|]*--staged(?![^;&|]*--worktree))/i, label: 'git restore' },
  { re: /\bgit\s+stash\s+(?:drop|clear)\b/i, label: 'git stash drop' },
  { re: /\bgit\s+push\b[^;&|]*(?:--force\b|--force-with-lease\b|\s-f\b)/i, label: 'git push --force' },
];

// Changing the machine rather than the project: always outside the working
// directory, whatever the paths say.
const SYSTEM_PATTERNS = [
  { re: /\bsudo\b/i, label: 'sudo' },
  { re: /\b(?:apt(?:-get)?|dnf|yum|zypper|apk|brew|winget|choco|scoop|snap|pacman)\s+(?:install|add|remove|uninstall|upgrade|-S)\b/i, label: 'system package manager' },
  { re: /\bnpm\s+(?:install|i|add|uninstall|rm|update)\s+(?:[^;&|]*\s)?(?:-g|--global)\b/i, label: 'npm -g' },
  { re: /\b(?:pnpm|yarn)\s+(?:global\s+add|add\s+(?:[^;&|]*\s)?-g)\b/i, label: 'global package install' },
  { re: /\bpip3?\s+install\s+(?:[^;&|]*\s)?--user\b/i, label: 'pip install --user' },
  { re: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|powershell)\b/i, label: 'remote installer' },
  { re: /\bmkfs(?:\.|\s|$)/i, label: 'mkfs' },
  { re: /\bdd\s+[^;&|]*\bof=\/dev\//i, label: 'dd to a device' },
  { re: /\b(?:setx|reg\s+(?:add|delete)|Set-ItemProperty\s+-Path\s+HK)/i, label: 'system settings' },
];

// Commands whose trailing path arguments are the files they change.
const MUTATING_COMMAND_RE = /(?:^\s*|[;&|(]\s*)(cp|mv|touch|mkdir|chmod|chown|ln|install|rsync|Copy-Item|Move-Item|New-Item|Set-Content|Add-Content|Out-File)\s+([^;&|]+)/gi;
// Explicit output files for downloads.
const OUTPUT_FLAG_RE = /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^;&|]*?(?:\s-o|\s--output|\s-O|\s-OutFile)\s+("[^"]+"|'[^']+'|\S+)/gi;

function unquote(token) {
  return String(token).replace(/^(['"])(.*)\1$/, '$2');
}

function expandHome(path) {
  const text = String(path);
  if (text === '~') return homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return resolve(homedir(), text.slice(2));
  if (/^\$HOME[\\/]/.test(text)) return resolve(homedir(), text.slice(6));
  return text;
}

/** Whether `target` lies outside `root`. A path that is `root` itself is inside. */
export function isOutsideRoot(target, root) {
  if (!target || !root) return false;
  const absolute = isAbsolute(expandHome(target)) ? expandHome(target) : resolve(root, expandHome(target));
  const rel = relative(resolve(root), absolute);
  if (!rel) return false;
  return rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel);
}

function pathArguments(argText) {
  return String(argText || '')
    .match(/"[^"]+"|'[^']+'|\S+/g)
    ?.map(unquote)
    .filter(token => token && !token.startsWith('-') && !/^\d+$/.test(token) && !/^[ugoa]*[+-=][rwxXst]+$/.test(token))
    || [];
}

/**
 * Files the command visibly writes to, beyond what workspace-changes finds:
 * the destinations of cp/mv/touch/…, and download output files.
 */
function extraWriteTargets(command, cwd) {
  const text = String(command || '');
  const targets = [];
  for (const match of text.matchAll(MUTATING_COMMAND_RE)) {
    const verb = match[1].toLowerCase();
    const args = pathArguments(match[2]);
    if (!args.length) continue;
    // For copy and move only the destination changes; the rest are read.
    const changed = ['cp', 'mv', 'ln', 'install', 'rsync', 'copy-item', 'move-item'].includes(verb) ? [args[args.length - 1]] : args;
    targets.push(...changed);
  }
  for (const match of text.matchAll(OUTPUT_FLAG_RE)) targets.push(unquote(match[1]));
  return targets
    .map(expandHome)
    .filter(target => target && !target.startsWith('/dev/'))
    .map(target => (isAbsolute(target) ? target : resolve(cwd, target)));
}

/**
 * Why `command` needs the user's OK under auto-approve, or null when it does
 * not: `{ kind: 'delete' | 'outside', label }`.
 *
 * @param {object} p
 * @param {string} p.cwd   where the command runs
 * @param {string} p.root  the working directory the user granted
 */
export function shellApprovalReason(command, { cwd = process.cwd(), root = cwd } = {}) {
  const text = String(command || '');
  if (!text.trim()) return null;
  for (const { re, label } of DELETE_PATTERNS) {
    if (re.test(text)) return { kind: 'delete', label };
  }
  for (const { re, label } of SYSTEM_PATTERNS) {
    if (re.test(text)) return { kind: 'outside', label };
  }
  // Run from another folder, anything that is not plainly a read — a build,
  // an install, a script — changes things there.
  if (isOutsideRoot(cwd, root) && !isPlainlyReadOnly(text)) return { kind: 'outside', label: `runs in ${cwd}` };
  const targets = [...commandWriteTargets(text, cwd), ...extraWriteTargets(text, cwd)];
  const outside = targets.find(target => isOutsideRoot(target, root));
  if (outside) return { kind: 'outside', label: outside };
  return null;
}

/** The confirmation title for a reason, in the words the user reads. */
export function approvalTitle(reason) {
  if (!reason) return '';
  return reason.kind === 'delete'
    ? `🗑 This command deletes files (${reason.label})`
    : `📁 This command changes things outside the working directory (${reason.label})`;
}
