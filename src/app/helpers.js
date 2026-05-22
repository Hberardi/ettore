// Pure helpers extracted from app/index.js.
// Keeping them in a separate module makes them testable and trims the main
// 2k+ line component file.

import { stripAllAnsi } from '../utils/ansi.js';

export function truncate(str, max) {
  if (!str) return '';
  const s = String(str);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Strips ANSI/OSC escape sequences and invisible Unicode characters from
// LLM-generated text. Apply BEFORE rendering anything that came from a model
// response — never to tool output (which may legitimately contain ANSI).
//
// Why this matters: a malicious or hallucinated response could otherwise
// inject cursor controls, OSC 8 hyperlinks, or zero-width chars that break
// the terminal display or hide content from the user.
export function sanitizeLLMText(text) {
  if (!text || typeof text !== 'string') return text;
  return stripAllAnsi(text);
}

export function formatK(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// Build a compact action/detail label for a tool call (used in the TUI).
// Pure: depends only on its arguments.
export function toolLabel(name, args) {
  if (!args) return { action: name, detail: '' };
  const short = (s, n = 60) => truncate(String(s || '').replace(/\n/g, ' ').trim(), n);
  const filename = (p) => String(p || '').split('/').pop() || String(p || '');

  switch (name) {
    case 'bash':
      return { action: '$', detail: short(args.command, 70) };
    case 'read':
      return { action: 'read', detail: filename(args.file_path) };
    case 'write':
      return { action: 'write', detail: filename(args.file_path) };
    case 'edit':
      return { action: 'edit', detail: filename(args.file_path) };
    case 'glob':
      return { action: 'glob', detail: short(args.pattern, 50) };
    case 'grep':
      return {
        action: 'grep',
        detail: short(args.pattern, 30) + (args.path ? `  in ${short(args.path, 25)}` : ''),
      };
    case 'list_dir':
      return { action: 'ls', detail: short(args.path || '.', 60) };
    case 'file_info':
      return { action: 'stat', detail: short(args.path, 60) };
    case 'git_status':
      return { action: 'git', detail: 'status' };
    case 'git_diff':
      return { action: 'diff', detail: short(args.file_path || (args.staged ? 'staged' : 'unstaged'), 60) };
    case 'webfetch': case 'WebFetch':
      return { action: 'fetch', detail: short(args.url, 60) };
    case 'websearch': case 'WebSearch':
      return { action: 'search', detail: short(args.query, 60) };
    case 'read_server_console':
      return { action: 'console', detail: short(args.file_path || args.pid || args.workdir || 'server logs', 60) };
    default: {
      const first = Object.values(args)[0];
      return { action: name, detail: first ? short(first, 55) : '' };
    }
  }
}
