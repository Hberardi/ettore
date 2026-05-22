import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, readdir, stat, access, mkdtemp, rm, readlink } from 'fs/promises';
import { join, extname } from 'path';
import { tmpdir } from 'os';
import { glob as globby } from 'glob';
import { uiBridge } from './bridge.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 1000;
const DEFAULT_GLOB_RESULTS = 500;
const MAX_GLOB_RESULTS = 5000;
const DEFAULT_GREP_MATCHES = 500;
const MAX_GREP_MATCHES = 5000;
const DEFAULT_SERVER_LOG_LINES = 300;
const DEFAULT_SERVER_LOG_CHARS = 40000;
const MAX_SERVER_LOG_LINES = 2000;
const MAX_SERVER_LOG_CHARS = 200000;
let activeToolAbortSignal = null;

export function setToolAbortSignal(signal) {
  activeToolAbortSignal = signal || null;
}

function getToolAbortSignal(timeoutMs = null) {
  const signal = activeToolAbortSignal;
  if (!signal && !timeoutMs) return undefined;
  if (!timeoutMs) return signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  return signal;
}

// Patterns that should never run unattended without explicit user OK.
// Order matters only for readability — first match wins.
const DESTRUCTIVE_BASH_PATTERNS = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, label: 'rm -rf' },
  { re: /\bgit\s+push\s+(--force|-f)(?!\w)/i,           label: 'git push --force' },
  { re: /\bgit\s+reset\s+--hard\b/i,                    label: 'git reset --hard' },
  { re: /\bgit\s+clean\s+-[a-z]*f/i,                    label: 'git clean -f' },
  { re: /\bsudo\b/i,                                    label: 'sudo' },
  { re: /\bmkfs(\.|$|\s)/i,                             label: 'mkfs' },
  { re: /\bdd\s+if=/i,                                  label: 'dd' },
  { re: /\bchmod\s+(-R\s+)?[0-7]*777\b/i,               label: 'chmod 777' },
  { re: /:\(\)\s*\{.*\}\s*;?\s*:/,                      label: 'fork bomb' },
  { re: /\bcurl\s+[^|]*\|\s*(sudo\s+)?(sh|bash)/i,      label: 'curl | sh' },
  { re: /\bwget\s+[^|]*\|\s*(sudo\s+)?(sh|bash)/i,      label: 'wget | sh' },
];

// Commands that can install dependencies/apps or download artifacts.
// These are not necessarily destructive, but must always be user-approved.
const INSTALL_BASH_PATTERNS = [
  { re: /\bnpm\s+(install|i)\b/i,                        label: 'npm install', kind: 'project' },
  { re: /\bpnpm\s+(install|i|add)\b/i,                   label: 'pnpm install/add', kind: 'project' },
  { re: /\byarn\s+(add|install)\b/i,                     label: 'yarn add/install', kind: 'project' },
  { re: /\bpip3?\s+install\b/i,                          label: 'pip install', kind: 'project' },
  { re: /\buv\s+pip\s+install\b/i,                       label: 'uv pip install', kind: 'project' },
  { re: /\bpoetry\s+add\b/i,                             label: 'poetry add', kind: 'project' },
  { re: /\bcomposer\s+require\b/i,                       label: 'composer require', kind: 'project' },
  { re: /\bcargo\s+add\b/i,                              label: 'cargo add', kind: 'project' },
  { re: /\bgo\s+get\b/i,                                 label: 'go get', kind: 'project' },
  { re: /\bbrew\s+install\b/i,                           label: 'brew install', kind: 'system' },
  { re: /\bapt(-get)?\s+install\b/i,                     label: 'apt install', kind: 'system' },
  { re: /\bdnf\s+install\b/i,                            label: 'dnf install', kind: 'system' },
  { re: /\byum\s+install\b/i,                            label: 'yum install', kind: 'system' },
  { re: /\bpacman\s+-S\b/i,                              label: 'pacman -S', kind: 'system' },
  { re: /\bapk\s+add\b/i,                                label: 'apk add', kind: 'system' },
  { re: /\bwinget\s+install\b/i,                         label: 'winget install', kind: 'system' },
  { re: /\bchoco\s+install\b/i,                          label: 'choco install', kind: 'system' },
  { re: /\bsnap\s+install\b/i,                           label: 'snap install', kind: 'system' },
  { re: /\bgem\s+install\b/i,                            label: 'gem install', kind: 'project' },
  { re: /\bgit\s+clone\b/i,                              label: 'git clone', kind: 'download' },
  { re: /\bcurl\s+-[^\n]*\s+https?:\/\//i,               label: 'curl download', kind: 'download' },
  { re: /\bwget\s+https?:\/\//i,                         label: 'wget download', kind: 'download' },
];

const installSessionApproval = new Set();
const editSessionApproval = { all: false };

export function isEditAlwaysApproved() {
  return editSessionApproval.all === true;
}

export function clearEditSessionApproval() {
  editSessionApproval.all = false;
}

export function listInstallSessionApprovals(kind = null) {
  const targetKind = kind ? String(kind).toLowerCase() : null;
  return Array.from(installSessionApproval)
    .map(item => {
      const [kind, ...rest] = String(item).split(':');
      return { kind, label: rest.join(':') || '' };
    })
    .filter(item => !targetKind || item.kind === targetKind)
    .sort((a, b) => `${a.kind}:${a.label}`.localeCompare(`${b.kind}:${b.label}`));
}

export function clearInstallSessionApprovals(kind = null) {
  const targetKind = kind ? String(kind).toLowerCase() : null;
  if (!targetKind) {
    installSessionApproval.clear();
    return;
  }
  for (const item of Array.from(installSessionApproval)) {
    const [itemKind] = String(item).split(':');
    if (itemKind === targetKind) {
      installSessionApproval.delete(item);
    }
  }
}

function detectDestructive(command) {
  for (const { re, label } of DESTRUCTIVE_BASH_PATTERNS) {
    if (re.test(command)) return label;
  }
  return null;
}

function detectInstallAction(command) {
  for (const { re, label, kind } of INSTALL_BASH_PATTERNS) {
    if (re.test(command)) return { label, kind };
  }
  return null;
}

function decodeHtml(text = '') {
  const entities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    '#39': "'",
  };
  return String(text)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z0-9#]+);/g, (_, name) => entities[name] || `&${name};`);
}

function stripHtml(html = '') {
  return decodeHtml(String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function isBlockedHost(hostname = '') {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc00:|fe80:)/i.test(hostname);
}

function normalizeDuckDuckGoUrl(href = '') {
  const decoded = decodeHtml(href);
  try {
    const url = new URL(decoded, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return url.href;
  } catch {
    return decoded;
  }
}

// Ask the user via the UI bridge for a yes/no confirmation. If no interactive
// listener is attached (CLI / scripted mode), fall back to allowing the action
// so non-interactive runs aren't broken — but flag it in the returned warning.
async function requestConfirmation({ title, detail }) {
  if (uiBridge.listenerCount('askUser') === 0) {
    return { allowed: true, interactive: false };
  }
  const answer = await new Promise((resolve) => {
    uiBridge.emit('askUser', {
      question: detail ? `${title}\n${detail}` : title,
      options: ['Sì, procedi', 'No, annulla'],
      resolve,
    });
  });
  if (answer === '__cancelled__') return { allowed: false, interactive: true, reason: 'cancelled' };
  return { allowed: /^Sì/i.test(String(answer)), interactive: true };
}

async function requestInstallConfirmation({ label, kind, command }) {
  const approvalKey = `${kind}:${label}`;
  if (kind === 'project' && installSessionApproval.has(approvalKey)) {
    return { allowed: true, remembered: true };
  }

  if (uiBridge.listenerCount('askUser') === 0) {
    return { allowed: true, interactive: false };
  }

  const titleByKind = kind === 'system'
    ? `⚠ Installazione di sistema rilevata (${label})`
    : kind === 'project'
      ? `📦 Installazione dipendenze progetto (${label})`
      : `⬇️ Download/clone rilevato (${label})`;

  const options = kind === 'project'
    ? ['Sì, una volta', 'Sì, sempre per questa sessione', 'No, annulla']
    : ['Sì, procedi', 'No, annulla'];

  const answer = await new Promise((resolve) => {
    uiBridge.emit('askUser', {
      question: `${titleByKind}\n$ ${command}`,
      options,
      resolve,
    });
  });

  if (answer === '__cancelled__' || /^No/i.test(String(answer))) {
    return { allowed: false, interactive: true, reason: 'cancelled' };
  }

  if (kind === 'project' && /sempre/i.test(String(answer))) {
    installSessionApproval.add(approvalKey);
    return { allowed: true, remembered: true };
  }

  return { allowed: true, interactive: true };
}

// Build a compact unified-style diff snippet between two text blocks.
// Not a full LCS — shows old block as `-` and new block as `+`, with surrounding
// context lines from the file when available. Good enough for human preview.
function buildEditDiff({ filePath, oldString, newString, fileContent = '', maxBlockLines = 12 }) {
  const oldLines = String(oldString || '').split('\n');
  const newLines = String(newString || '').split('\n');

  let contextBefore = [];
  let contextAfter = [];
  if (fileContent) {
    const idx = fileContent.indexOf(oldString);
    if (idx !== -1) {
      const before = fileContent.slice(0, idx).split('\n');
      const after = fileContent.slice(idx + oldString.length).split('\n');
      contextBefore = before.slice(-2).filter(l => l !== '' || before.length > 1);
      contextAfter = after.slice(0, 2).filter(l => l !== '' || after.length > 1);
    }
  }

  const trim = (lines, max) => lines.length > max
    ? [...lines.slice(0, max), `… (${lines.length - max} more lines)`]
    : lines;

  const out = [`--- ${filePath}`, `+++ ${filePath}`];
  for (const l of contextBefore) out.push(`  ${l}`);
  for (const l of trim(oldLines, maxBlockLines)) out.push(`- ${l}`);
  for (const l of trim(newLines, maxBlockLines)) out.push(`+ ${l}`);
  for (const l of contextAfter) out.push(`  ${l}`);
  return out.join('\n');
}

async function requestEditConfirmation({ filePath, oldString, newString, fileContent = '' }) {
  if (editSessionApproval.all) return { allowed: true, remembered: true };
  if (uiBridge.listenerCount('askUser') === 0) {
    return { allowed: true, interactive: false };
  }

  const diff = buildEditDiff({ filePath, oldString, newString, fileContent });
  const answer = await new Promise((resolve) => {
    uiBridge.emit('askUser', {
      question: `✎ Applicare questa modifica a ${filePath}?\n\n${diff}`,
      options: ['Sì, applica', 'Sì, sempre per questa sessione', 'No, annulla'],
      resolve,
    });
  });

  if (answer === '__cancelled__' || /^No/i.test(String(answer))) {
    return { allowed: false, interactive: true, reason: 'cancelled' };
  }
  if (/sempre/i.test(String(answer))) {
    editSessionApproval.all = true;
    return { allowed: true, remembered: true };
  }
  return { allowed: true, interactive: true };
}

// Stable key tying a progress event to a specific running tool call.
// The TUI matches incoming `toolProgress` events to running tools by name + this key.
export function toolProgressKey(name, args = {}) {
  if (!args || typeof args !== 'object') return '';
  if (name === 'bash')      return String(args.command || '').slice(0, 80);
  if (name === 'websearch') return String(args.query || '');
  if (name === 'webfetch')  return String(args.url || '');
  if (name === 'grep')      return String(args.pattern || '');
  if (name === 'glob')      return String(args.pattern || '');
  if (args.file_path)       return String(args.file_path);
  return '';
}

function emitToolProgress(name, args, message) {
  try {
    uiBridge.emit('toolProgress', {
      name,
      key: toolProgressKey(name, args),
      message: String(message || '').slice(0, 200),
    });
  } catch {}
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function truncateLines(text, maxLines) {
  const lines = String(text || '').split('\n');
  if (lines.length <= maxLines) return { text: lines.join('\n'), truncated: false, total: lines.length };
  return {
    text: lines.slice(0, maxLines).join('\n') + `\n... truncated at ${maxLines} lines (total ${lines.length})`,
    truncated: true,
    total: lines.length,
  };
}

function tailText(text, maxLines, maxChars) {
  const lines = String(text || '').split(/\r?\n/);
  let selected = lines.slice(Math.max(0, lines.length - maxLines));
  let out = selected.join('\n').trimEnd();
  if (out.length > maxChars) {
    out = out.slice(out.length - maxChars);
  }
  return {
    text: out,
    truncated: lines.length > maxLines || String(text || '').length > maxChars,
    lineCount: lines.length,
  };
}

async function resolveServerConsoleSource({ filePath, pid, workdir }) {
  const explicit = String(filePath || '').trim();
  if (explicit) return { source: explicit, kind: 'file' };

  const procPid = String(pid || '').trim();
  if (procPid) {
    for (const fd of ['1', '2']) {
      try {
        const link = await readlink(`/proc/${procPid}/fd/${fd}`);
        if (!link || /^pipe:|^socket:|^anon_inode:|^tty:/.test(link)) continue;
        if (await fileExists(link)) return { source: link, kind: fd === '1' ? 'pid-stdout' : 'pid-stderr' };
      } catch {
        // ignore and fall through to file discovery
      }
    }
  }

  const root = workdir || process.cwd();
  const patterns = [
    '.ettore/server.log',
    '.ettore/logs/*.log',
    'logs/*.log',
    'logs/**/*.log',
    '*.log',
    '*server*.log',
    '*server*.txt',
    '*console*.log',
  ];
  const candidates = [];
  for (const pattern of patterns) {
    try {
      const hits = await globby(pattern, {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        dot: true,
        followSymbolicLinks: false,
        ignore: ['**/node_modules/**', '**/.git/**'],
        maxDepth: 4,
      });
      candidates.push(...hits);
    } catch {
      // ignore individual pattern failures
    }
  }

  const unique = [...new Set(candidates)];
  for (const candidate of unique) {
    try {
      const st = await stat(candidate);
      if (st.isFile()) return { source: candidate, kind: 'discovered-file' };
    } catch {
      // ignore and continue
    }
  }

  return null;
}

async function resolveTmuxPaneByPid(pid) {
  const procPid = String(pid || '').trim();
  if (!procPid) return null;
  try {
    const { stdout: ttyRaw } = await execFileAsync('ps', ['-p', procPid, '-o', 'tty='], {
      maxBuffer: 1024 * 1024,
      signal: getToolAbortSignal(5000),
    });
    const tty = String(ttyRaw || '').trim();
    if (!tty || tty === '?') return null;
    const paneTty = tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
    const { stdout } = await execFileAsync('tmux', ['list-panes', '-a', '-F', '#{pane_id}|#{pane_tty}'], {
      maxBuffer: 1024 * 1024,
      signal: getToolAbortSignal(5000),
    });
    const rows = String(stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
    for (const row of rows) {
      const [paneId, ttyPath] = row.split('|');
      if (ttyPath && paneId && ttyPath.trim() === paneTty) return paneId.trim();
    }
    return null;
  } catch {
    return null;
  }
}

async function listTmuxPanes() {
  try {
    const format = '#{pane_id}|#{pane_tty}|#{pane_active}|#{pane_current_command}|#{pane_current_path}|#{session_name}|#{window_index}.#{pane_index}';
    const { stdout } = await execFileAsync('tmux', ['list-panes', '-a', '-F', format], {
      maxBuffer: 2 * 1024 * 1024,
      signal: getToolAbortSignal(5000),
    });
    return String(stdout || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [paneId, paneTty, paneActive, paneCmd, panePath, sessionName, paneIndex] = line.split('|');
        return {
          paneId: String(paneId || '').trim(),
          paneTty: String(paneTty || '').trim(),
          paneActive: String(paneActive || '').trim() === '1',
          paneCmd: String(paneCmd || '').trim(),
          panePath: String(panePath || '').trim(),
          sessionName: String(sessionName || '').trim(),
          paneIndex: String(paneIndex || '').trim(),
        };
      })
      .filter(p => p.paneId);
  } catch {
    return [];
  }
}

function scoreTmuxPaneForServer(pane, root) {
  let score = 0;
  const cmd = String(pane.paneCmd || '').toLowerCase();
  const path = String(pane.panePath || '');
  if (pane.paneActive) score += 30;
  if (root && path && (path === root || path.startsWith(`${root}/`))) score += 50;
  if (/node|python|uvicorn|gunicorn|npm|pnpm|yarn|bun|deno|java|dotnet|go|docker|pm2/.test(cmd)) score += 20;
  return score;
}

async function resolveTmuxPaneAuto(workdir) {
  const panes = await listTmuxPanes();
  if (!panes.length) return null;
  const root = String(workdir || process.cwd());
  const ranked = panes
    .map(pane => ({ pane, score: scoreTmuxPaneForServer(pane, root) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score > 0 ? ranked[0].pane : null;
}

async function captureTmuxPane({ target, maxLines }) {
  const linesBack = Math.max(20, Number(maxLines) || DEFAULT_SERVER_LOG_LINES);
  const { stdout } = await execFileAsync('tmux', ['capture-pane', '-p', '-t', String(target), '-S', `-${linesBack}`], {
    maxBuffer: 20 * 1024 * 1024,
    signal: getToolAbortSignal(10000),
  });
  return String(stdout || '');
}

async function extractPdfTextWithOcr({ filePath, pageFrom, pageTo, lang, dpi, maxChars }) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'ettore-pdf-ocr-'));
  try {
    emitToolProgress('read_pdf', { file_path: filePath }, 'Rendering PDF pages…');
    const outPrefix = join(tempRoot, 'page');
    const ppArgs = ['-f', String(pageFrom), '-r', String(dpi)];
    if (pageTo != null) ppArgs.push('-l', String(pageTo));
    ppArgs.push('-png', filePath, outPrefix);
    await execFileAsync('pdftoppm', ppArgs, { maxBuffer: 20 * 1024 * 1024 });

    const pageImages = (await readdir(tempRoot))
      .filter(name => /^page-\d+\.png$/i.test(name))
      .sort((a, b) => a.localeCompare(b));

    if (!pageImages.length) return '';

    const total = pageImages.length;
    const chunks = [];
    let i = 0;
    for (const image of pageImages) {
      i++;
      emitToolProgress('read_pdf', { file_path: filePath }, `OCR page ${i}/${total}…`);
      const imagePath = join(tempRoot, image);
      const { stdout } = await execFileAsync('tesseract', [imagePath, 'stdout', '-l', lang], {
        maxBuffer: 20 * 1024 * 1024,
        signal: getToolAbortSignal(120000),
      });
      const text = String(stdout || '').trim();
      if (text) chunks.push(text);
      if (chunks.join('\n\n').length > maxChars) break;
    }
    return chunks.join('\n\n').trim();
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function listDirEntries(basePath, recursive, maxEntries, prefix = '') {
  const dirents = await readdir(basePath, { withFileTypes: true });
  const sorted = dirents.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const rows = [];
  for (const d of sorted) {
    if (rows.length >= maxEntries) break;
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    rows.push(`${d.isDirectory() ? 'dir ' : 'file'} ${rel}${d.isDirectory() ? '/' : ''}`);
    if (recursive && d.isDirectory() && !d.name.startsWith('.') && rows.length < maxEntries) {
      const childRows = await listDirEntries(join(basePath, d.name), recursive, maxEntries - rows.length, rel);
      rows.push(...childRows);
    }
  }
  return rows;
}

// Tool implementations
export const toolHandlers = {
  async bash({ command, workdir }) {
    try {
      const installAction = detectInstallAction(command);
      if (installAction) {
        const ok = await requestInstallConfirmation({
          label: installAction.label,
          kind: installAction.kind,
          command,
        });
        if (!ok.allowed) {
          return `Cancelled by user: refused to run "${installAction.label}" command.`;
        }
      }

      const danger = detectDestructive(command);
      if (danger) {
        const ok = await requestConfirmation({
          title: `⚠ Comando potenzialmente distruttivo (${danger})`,
          detail: `$ ${command}`,
        });
        if (!ok.allowed) {
          return `Cancelled by user: refused to run "${danger}" command.`;
        }
      }
      const startedAt = Date.now();
      const heartbeat = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        emitToolProgress('bash', { command }, `Running… ${elapsed}s elapsed`);
      }, 5000);
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workdir || process.cwd(),
          maxBuffer: 10 * 1024 * 1024,
          signal: getToolAbortSignal(),
        });
        return stdout || stderr || '(no output)';
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      return `Error: ${error.message}\n${error.stderr || ''}`;
    }
  },

  async read({ file_path, offset = 0, limit = DEFAULT_READ_LIMIT }) {
    try {
      const safeOffset = Math.max(0, Number(offset) || 0);
      const safeLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_READ_LIMIT, MAX_READ_LIMIT));
      const content = await readFile(file_path, 'utf-8');
      const lines = content.split('\n');
      const selected = lines.slice(safeOffset, safeOffset + safeLimit);
      const body = selected.map((line, i) => `${safeOffset + i + 1}\t${line}`).join('\n');
      const end = Math.min(lines.length, safeOffset + safeLimit);
      const footer = end < lines.length ? `\n... showing lines ${safeOffset + 1}-${end} of ${lines.length}` : '';
      return body + footer;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async read_pdf({ file_path, page_from = 1, page_to, max_chars = 20000, ocr = false, ocr_lang = 'eng', ocr_dpi = 200 }) {
    try {
      if (!file_path) return 'Error: read_pdf requires file_path';
      const safeFrom = Math.max(1, Number(page_from) || 1);
      const safeTo = page_to == null ? null : Math.max(safeFrom, Number(page_to) || safeFrom);
      const charLimit = Math.max(1000, Math.min(Number(max_chars) || 20000, 200000));
      const lang = String(ocr_lang || 'eng').trim() || 'eng';
      const dpi = Math.max(72, Math.min(Number(ocr_dpi) || 200, 600));
      const forceOcr = Boolean(ocr);

      // Preferred path: pdftotext for real PDF text extraction.
      if (!forceOcr) {
        try {
          const args = ['-layout', '-enc', 'UTF-8', '-f', String(safeFrom)];
          if (safeTo != null) args.push('-l', String(safeTo));
          args.push(file_path, '-');
          const { stdout } = await execFileAsync('pdftotext', args, {
            maxBuffer: 20 * 1024 * 1024,
            signal: getToolAbortSignal(120000),
          });
          const text = String(stdout || '').trim();
          if (text) {
            if (text.length > charLimit) return `${text.slice(0, charLimit)}\n... truncated at ${charLimit} chars`;
            return text;
          }
        } catch (pdfErr) {
          const missing = /ENOENT|not found/i.test(String(pdfErr?.message || ''));
          if (!missing && pdfErr?.stdout) {
            const text = String(pdfErr.stdout).trim();
            if (text) return text.length > charLimit ? `${text.slice(0, charLimit)}\n... truncated at ${charLimit} chars` : text;
          }
        }
      }

      // OCR path (forced or fallback when text extraction produced nothing).
      try {
        const ocrText = await extractPdfTextWithOcr({
          filePath: file_path,
          pageFrom: safeFrom,
          pageTo: safeTo,
          lang,
          dpi,
          maxChars: charLimit,
        });
        if (ocrText) return ocrText.length > charLimit ? `${ocrText.slice(0, charLimit)}\n... truncated at ${charLimit} chars` : ocrText;
      } catch {}

      // Last fallback: binary strings extraction when pdf tools aren't installed.
      const { stdout } = await execFileAsync('strings', ['-n', '6', file_path], {
        maxBuffer: 20 * 1024 * 1024,
        signal: getToolAbortSignal(30000),
      });
      const text = String(stdout || '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n')
        .trim();
      if (!text) return `No readable text found in PDF: ${file_path}`;
      return text.length > charLimit
        ? `${text.slice(0, charLimit)}\n... truncated at ${charLimit} chars`
        : text;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async read_doc({ file_path, max_chars = 20000 }) {
    try {
      if (!file_path) return 'Error: read_doc requires file_path';
      const charLimit = Math.max(1000, Math.min(Number(max_chars) || 20000, 200000));
      const ext = extname(file_path).toLowerCase();

      if (ext === '.docx') {
        const { stdout } = await execFileAsync('unzip', ['-p', file_path, 'word/document.xml'], {
          maxBuffer: 20 * 1024 * 1024,
          signal: getToolAbortSignal(30000),
        });
        const text = stripHtml(stdout || '');
        if (!text) return `No readable text found in DOCX: ${file_path}`;
        return text.length > charLimit ? `${text.slice(0, charLimit)}\n... truncated at ${charLimit} chars` : text;
      }

      if (ext === '.odt') {
        const { stdout } = await execFileAsync('unzip', ['-p', file_path, 'content.xml'], {
          maxBuffer: 20 * 1024 * 1024,
          signal: getToolAbortSignal(30000),
        });
        const text = stripHtml(stdout || '');
        if (!text) return `No readable text found in ODT: ${file_path}`;
        return text.length > charLimit ? `${text.slice(0, charLimit)}\n... truncated at ${charLimit} chars` : text;
      }

      if (ext === '.doc') {
        try {
          const { stdout } = await execFileAsync('antiword', [file_path], {
            maxBuffer: 20 * 1024 * 1024,
            signal: getToolAbortSignal(30000),
          });
          const text = String(stdout || '').trim();
          if (text) return text.length > charLimit ? `${text.slice(0, charLimit)}\n... truncated at ${charLimit} chars` : text;
        } catch {}
      }

      const text = await readFile(file_path, 'utf-8');
      if (!text.trim()) return `No readable text found in document: ${file_path}`;
      return text.length > charLimit ? `${text.slice(0, charLimit)}\n... truncated at ${charLimit} chars` : text;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async read_server_console({ file_path, pid, workdir, tmux_target, max_lines = DEFAULT_SERVER_LOG_LINES, max_chars = DEFAULT_SERVER_LOG_CHARS }) {
    try {
      const safeLines = Math.max(1, Math.min(Number(max_lines) || DEFAULT_SERVER_LOG_LINES, MAX_SERVER_LOG_LINES));
      const safeChars = Math.max(1000, Math.min(Number(max_chars) || DEFAULT_SERVER_LOG_CHARS, MAX_SERVER_LOG_CHARS));

      const explicitTmuxTarget = String(tmux_target || '').trim();
      if (explicitTmuxTarget) {
        const captured = await captureTmuxPane({ target: explicitTmuxTarget, maxLines: safeLines });
        const tail = tailText(captured, safeLines, safeChars);
        const header = `Source: tmux -> ${explicitTmuxTarget}\nMode: capture-pane last ${safeLines} lines`;
        return tail.truncated ? `${header}\n\n${tail.text || '(empty)'}\n... truncated` : `${header}\n\n${tail.text || '(empty)'}`;
      }

      const tmuxFromPid = await resolveTmuxPaneByPid(pid);
      if (tmuxFromPid) {
        const captured = await captureTmuxPane({ target: tmuxFromPid, maxLines: safeLines });
        const tail = tailText(captured, safeLines, safeChars);
        const header = `Source: tmux (from pid ${pid}) -> ${tmuxFromPid}\nMode: capture-pane last ${safeLines} lines`;
        return tail.truncated ? `${header}\n\n${tail.text || '(empty)'}\n... truncated` : `${header}\n\n${tail.text || '(empty)'}`;
      }

      const tmuxAuto = await resolveTmuxPaneAuto(workdir);
      if (tmuxAuto?.paneId) {
        const captured = await captureTmuxPane({ target: tmuxAuto.paneId, maxLines: safeLines });
        const tail = tailText(captured, safeLines, safeChars);
        const meta = `${tmuxAuto.sessionName || 'session'} ${tmuxAuto.paneIndex || ''}`.trim();
        const header = `Source: tmux auto -> ${tmuxAuto.paneId}${meta ? ` (${meta})` : ''}\nMode: capture-pane last ${safeLines} lines`;
        return tail.truncated ? `${header}\n\n${tail.text || '(empty)'}\n... truncated` : `${header}\n\n${tail.text || '(empty)'}`;
      }

      const source = await resolveServerConsoleSource({ filePath: file_path, pid, workdir });
      if (!source) {
        return 'No readable live console found. If the app runs in tmux, pass tmux_target (e.g. %1) or pid; otherwise write output to .ettore/server.log or pass file_path.';
      }

      const text = await readFile(source.source, 'utf-8');
      if (!String(text || '').trim()) {
        return `No readable console output found in ${source.source}`;
      }

      const tail = tailText(text, safeLines, safeChars);
      const header = `Source: ${source.kind} -> ${source.source}\nMode: tail last ${safeLines} lines`;
      const body = tail.text || '(empty)';
      return tail.truncated
        ? `${header}\n\n${body}\n... truncated`
        : `${header}\n\n${body}`;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async write({ file_path, content }) {
    try {
      const exists = await fileExists(file_path);
      if (exists) {
        let oldContent = '';
        try { oldContent = await readFile(file_path, 'utf-8'); } catch {}
        const ok = await requestEditConfirmation({
          filePath: file_path,
          oldString: oldContent,
          newString: content,
          fileContent: oldContent,
        });
        if (!ok.allowed) {
          return `Cancelled by user: refused to overwrite ${file_path}.`;
        }
      }
      const lines = content.split('\n').length;
      await writeFile(file_path, content, 'utf-8');
      uiBridge.emit('fileChanged', { type: 'write', path: file_path, lines });
      return `✓ Written ${lines} lines to ${file_path}`;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async edit({ file_path, old_string, new_string }) {
    try {
      const content = await readFile(file_path, 'utf-8');
      const parts = content.split(old_string);
      if (parts.length === 1) {
        return `Error: old_string not found in ${file_path}`;
      }
      if (parts.length > 2) {
        return `Error: old_string matches ${parts.length - 1} locations in ${file_path}. Provide more surrounding context to make it unique.`;
      }
      const ok = await requestEditConfirmation({
        filePath: file_path,
        oldString: old_string,
        newString: new_string,
        fileContent: content,
      });
      if (!ok.allowed) {
        return `Cancelled by user: refused to apply edit to ${file_path}.`;
      }
      const oldLines = old_string.split('\n').length;
      const newLines = new_string.split('\n').length;
      const diff = newLines - oldLines;
      await writeFile(file_path, parts.join(new_string), 'utf-8');
      uiBridge.emit('fileChanged', { type: 'edit', path: file_path, oldLines, newLines, diff });
      return `✓ Edited ${file_path} (${oldLines} → ${newLines} lines, ${diff > 0 ? '+' : ''}${diff})`;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async glob({ pattern, path, max_results = DEFAULT_GLOB_RESULTS }) {
    try {
      const safeLimit = Math.max(1, Math.min(Number(max_results) || DEFAULT_GLOB_RESULTS, MAX_GLOB_RESULTS));
      const files = await globby(pattern, { cwd: path || process.cwd(), absolute: true });
      if (!files.length) return 'No files found';
      const sorted = files.sort((a, b) => a.localeCompare(b));
      const out = sorted.slice(0, safeLimit).join('\n');
      return sorted.length > safeLimit
        ? `${out}\n... truncated at ${safeLimit} results (total ${sorted.length})`
        : out;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async grep({ pattern, path, include, max_matches = DEFAULT_GREP_MATCHES }) {
    try {
      const searchPath = path || process.cwd();
      const safeLimit = Math.max(1, Math.min(Number(max_matches) || DEFAULT_GREP_MATCHES, MAX_GREP_MATCHES));

      const tryRipgrep = async () => {
        const args = ['--line-number', '--with-filename', '--no-heading', pattern, searchPath];
        if (include) args.unshift('-g', include);
        const { stdout } = await execFileAsync('rg', args, {
          maxBuffer: 10 * 1024 * 1024,
          signal: getToolAbortSignal(),
        });
        return stdout || '';
      };

      const tryGrep = async () => {
        const args = ['-rn'];
        if (include) args.push(`--include=${include}`);
        args.push(pattern, searchPath);
        const { stdout } = await execFileAsync('grep', args, {
          maxBuffer: 10 * 1024 * 1024,
          signal: getToolAbortSignal(),
        });
        return stdout || '';
      };

      let output = '';
      try {
        output = await tryRipgrep();
      } catch (rgErr) {
        const rgMissing = /ENOENT|not found/i.test(String(rgErr?.message || ''));
        if (!rgMissing && rgErr?.stdout) output = rgErr.stdout;
        if (!output) {
          try {
            output = await tryGrep();
          } catch (grepErr) {
            if (grepErr?.stdout) output = grepErr.stdout;
            else return `Error: ${grepErr.message}`;
          }
        }
      }

      if (!output.trim()) return 'No matches';
      return truncateLines(output.trimEnd(), safeLimit).text;
    } catch (error) {
      return error.stdout || `Error: ${error.message}`;
    }
  },

  async list_dir({ path = '.', recursive = false, max_entries = 200 }) {
    try {
      const limit = Math.max(1, Math.min(Number(max_entries) || 200, 1000));
      const st = await stat(path);
      if (!st.isDirectory()) return `Error: not a directory: ${path}`;
      const rows = await listDirEntries(path, Boolean(recursive), limit);
      const suffix = rows.length >= limit ? `\n... truncated at ${limit} entries` : '';
      return rows.length ? rows.join('\n') + suffix : '(empty directory)';
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async file_info({ path }) {
    try {
      if (!path) return 'Error: file_info requires path';
      const st = await stat(path);
      return [
        `Path: ${path}`,
        `Type: ${st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other'}`,
        `Size: ${formatBytes(st.size)}`,
        `Modified: ${st.mtime.toISOString()}`,
        `Mode: ${st.mode.toString(8).slice(-3)}`,
      ].join('\n');
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async git_status({ workdir }) {
    try {
      const { stdout, stderr } = await execFileAsync('git', ['status', '--short', '--branch'], {
        cwd: workdir || process.cwd(),
        maxBuffer: 1024 * 1024,
        signal: getToolAbortSignal(),
      });
      return stdout || stderr || '(clean)';
    } catch (error) {
      return `Error: ${error.message}\n${error.stderr || ''}`;
    }
  },

  async git_diff({ workdir, staged = false, file_path, max_chars = 12000 }) {
    try {
      const args = ['diff'];
      if (staged) args.push('--staged');
      if (file_path) args.push('--', file_path);
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: workdir || process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
        signal: getToolAbortSignal(),
      });
      const out = stdout || stderr || '(no diff)';
      const limit = Math.max(1000, Math.min(Number(max_chars) || 12000, 50000));
      return out.length > limit ? `${out.slice(0, limit)}\n... truncated at ${limit} chars` : out;
    } catch (error) {
      return `Error: ${error.message}\n${error.stderr || ''}`;
    }
  },

  async mark_step_done({ step }) {
    const idx = parseInt(step, 10);
    if (!isNaN(idx) && idx > 0) {
      uiBridge.emit('stepDone', idx - 1);
    }
    return 'ok';
  },

  async ask_user({ question, options }) {
    const opts = Array.isArray(options)
      ? options.map(o => String(o)).filter(Boolean)
      : [];
    if (!question) {
      return 'Error: ask_user requires a question';
    }
    // If no interactive UI is available, return an error that tells the model to stop
    if (uiBridge.listenerCount('askUser') === 0) {
      return `ERROR: No interactive UI available. The user needs to run 'ettore' in interactive mode to answer questions. Please tell the user: "Avvia 'ettore' senza argomenti per entrare in modalità interattiva, poi ripeti la richiesta."`;
    }
    return await new Promise((resolve) => {
      uiBridge.emit('askUser', {
        question: String(question),
        options: opts,
        resolve: (answer) => {
          if (answer === '__cancelled__') {
            resolve('User cancelled the selection.');
          } else {
            resolve(opts.length === 0 ? answer : `User selected: ${answer}`);
          }
        },
      });
    });
  },

  async webfetch({ url }) {
    try {
      // Validate URL scheme
      let parsed;
      try { parsed = new URL(url); } catch { return 'Error: invalid URL'; }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return `Error: unsupported protocol "${parsed.protocol}" — only http/https allowed`;
      }
      // Block private/loopback addresses (SSRF protection)
      const host = parsed.hostname;
      if (isBlockedHost(host)) {
        return 'Error: access to private/loopback addresses not allowed';
      }
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Ettore-CLI/1.0' },
        signal: getToolAbortSignal(15_000),
      });
      if (!response.ok) return `Error: ${response.status}`;
      const html = await response.text();
      return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async websearch({ query, max_results = 5, site }) {
    try {
      const q = String(query || '').trim();
      if (!q) return 'Error: websearch requires a query';

      const limit = Math.max(1, Math.min(Number(max_results) || 5, 10));
      let searchQuery = q;
      if (site) {
        const domain = String(site).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!domain || isBlockedHost(domain)) return 'Error: invalid or blocked site filter';
        searchQuery += ` site:${domain}`;
      }

      emitToolProgress('websearch', { query: q }, `Querying DuckDuckGo…`);
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Ettore-CLI/1.0',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: getToolAbortSignal(15_000),
      });
      if (!response.ok) return `Error: search failed with HTTP ${response.status}`;

      emitToolProgress('websearch', { query: q }, `Parsing results…`);
      const html = await response.text();
      const results = [];
      const blocks = html.match(/<div class="result[\s\S]*?<\/div>\s*<\/div>/gi) || [];
      for (const block of blocks) {
        const link = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!link) continue;
        const title = stripHtml(link[2]);
        const resultUrl = normalizeDuckDuckGoUrl(link[1]);
        if (!/^https?:\/\//i.test(resultUrl)) continue;
        const parsed = new URL(resultUrl);
        if (isBlockedHost(parsed.hostname)) continue;
        const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
        const snippet = stripHtml(snippetMatch?.[1] || snippetMatch?.[2] || '');
        results.push({ title, url: resultUrl, snippet });
        if (results.length >= limit) break;
      }

      if (results.length === 0) {
        return `No search results for "${q}".`;
      }

      return results.map((r, i) => {
        const snippet = r.snippet ? `\n   ${r.snippet}` : '';
        return `${i + 1}. ${r.title}\n   ${r.url}${snippet}`;
      }).join('\n\n');
    } catch (error) {
      return `Error: websearch failed: ${error.message}`;
    }
  },

  async memory_write({ section, content, mode = 'append', workdir }) {
    try {
      const { updateMemorySection } = await import('../memory/index.js');
      const root = workdir || process.cwd();
      await updateMemorySection(root, section, content, mode);
      uiBridge.emit('memorySaved', { section, projectRoot: root });
      return `Memory saved — section: ${section} (${mode})`;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  }
};

// OpenAI-format tool definitions
export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command and return the output',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          workdir: { type: 'string', description: 'Working directory (optional)' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file and return its contents with line numbers',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file' },
          offset: { type: 'number', description: 'Start line (0-based)' },
          limit: { type: 'number', description: 'Max lines to return (1-1000)' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_pdf',
      description: 'Extract readable text from a PDF file. Supports optional page range, OCR, and output truncation.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the PDF file' },
          page_from: { type: 'number', description: 'First page to read, 1-based. Default: 1' },
          page_to: { type: 'number', description: 'Last page to read, 1-based (optional)' },
          max_chars: { type: 'number', description: 'Maximum characters to return, 1000-200000. Default: 20000' },
          ocr: { type: 'boolean', description: 'If true, force OCR text extraction from rendered page images' },
          ocr_lang: { type: 'string', description: 'Tesseract language code (e.g. eng, ita, eng+ita). Default: eng' },
          ocr_dpi: { type: 'number', description: 'Render DPI for OCR, 72-600. Default: 200' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_doc',
      description: 'Extract readable text from document files (.docx, .odt, .doc, or plain text-like files).',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the document file' },
          max_chars: { type: 'number', description: 'Maximum characters to return, 1000-200000. Default: 20000' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_server_console',
      description: 'Read recent server console output from tmux panes, a log file, a process stdout/stderr redirection, or common project log locations. Use this to inspect runtime errors and live server traces.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Explicit log file path to read (optional)' },
          pid: { type: 'string', description: 'Process id whose stdout/stderr should be inspected (optional)' },
          tmux_target: { type: 'string', description: 'tmux target pane/window/session (e.g. %3 or dev:1.0). If set, capture-pane is used.' },
          workdir: { type: 'string', description: 'Project directory for log discovery (optional)' },
          max_lines: { type: 'number', description: 'Maximum lines to return from the tail, 1-2000. Default: 300' },
          max_chars: { type: 'number', description: 'Maximum characters to return, 1000-200000. Default: 40000' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write content to a file (creates or overwrites)',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file' },
          content: { type: 'string', description: 'Content to write' }
        },
        required: ['file_path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: 'Edit a file by replacing an exact string',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file' },
          old_string: { type: 'string', description: 'Exact string to replace' },
          new_string: { type: 'string', description: 'Replacement string' }
        },
        required: ['file_path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. **/*.js)' },
          path: { type: 'string', description: 'Base directory (optional)' },
          max_results: { type: 'number', description: 'Maximum files to return, 1-5000. Default: 500' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a pattern in files',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or string to search' },
          path: { type: 'string', description: 'Directory to search in' },
          include: { type: 'string', description: 'File pattern filter (e.g. *.js)' },
          max_matches: { type: 'number', description: 'Maximum matching lines to return, 1-5000. Default: 500' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories with structured output. Prefer this over bash ls/find for browsing the project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list. Default: current directory' },
          recursive: { type: 'boolean', description: 'Whether to recurse into child directories. Default: false' },
          max_entries: { type: 'number', description: 'Maximum entries to return, 1-1000. Default: 200' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_info',
      description: 'Get metadata for a file or directory: type, size, modified time, and mode.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory path' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show concise git branch and working tree status. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          workdir: { type: 'string', description: 'Repository directory. Default: current working directory' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show git diff for unstaged or staged changes. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          workdir: { type: 'string', description: 'Repository directory. Default: current working directory' },
          staged: { type: 'boolean', description: 'Show staged diff instead of unstaged diff' },
          file_path: { type: 'string', description: 'Optional single file path to diff' },
          max_chars: { type: 'number', description: 'Maximum characters to return, 1000-50000. Default: 12000' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user a multiple-choice question and wait for their answer. Use this whenever you need the user to pick between concrete alternatives before you can proceed — e.g. programming language, framework, database, UI library, architectural approach, etc. Never invent answers or assume preferences: if the task has meaningful choices, ASK. Provide a clear question and 2–6 distinct options.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to show the user (concise, one sentence).',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of options the user can pick from (2–6 items).',
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'webfetch',
      description: 'Fetch the text content of a URL',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'websearch',
      description: 'Search the public web for up-to-date information. Returns numbered results with title, URL, and snippet. Use webfetch on a result URL when you need page details.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Number of results to return, 1-10. Default: 5' },
          site: { type: 'string', description: 'Optional domain filter, e.g. nodejs.org or docs.github.com' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_write',
      description: 'Persist important project information to long-term memory. Use this to save architectural decisions, tech stack details, user preferences, known bugs, and coding patterns discovered during the session.',
      parameters: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['STACK', 'ARCHITECTURE', 'PATTERNS', 'DECISIONS', 'BUGS_TODO', 'USER_PREFERENCES'],
            description: 'Which section of the project memory to update'
          },
          content: {
            type: 'string',
            description: 'Content to save. Be concise. Use bullet points.'
          },
          mode: {
            type: 'string',
            enum: ['append', 'replace'],
            description: 'append adds to existing content, replace overwrites. Default: append'
          },
          workdir: {
            type: 'string',
            description: 'Working directory to detect project root from (optional)'
          }
        },
        required: ['section', 'content']
      }
    }
  }
];
