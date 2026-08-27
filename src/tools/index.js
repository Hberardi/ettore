import { exec, execFile, spawn } from 'child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getBashSession } from './bash-session.js';
import { sanitizeOutput } from '../utils/output.js';
import { promisify } from 'util';
import { readFile, writeFile, readdir, stat, access, readlink } from 'fs/promises';
import { join, extname, dirname } from 'path';
import { glob as globby } from 'glob';
import { uiBridge } from './bridge.js';
import { transcribeVideo, renderTranscript } from './video-transcript.js';
import { describeVideo } from './video-describe.js';
import { fetchWebImage } from './web-image.js';
import { generateSceneImage, generateSceneClip, assembleMusicVideo, lyricsToSrt } from './music-video.js';
import { readAudio, renderAudioResult } from './audio-read.js';
import { extractPdfTextWithSuperOcr, isLikelyUsablePdfText } from './pdf-ocr.js';
import * as browser from './browser-driver.js';
import * as desktop from './desktop-app.js';

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
const DEV_SERVER_LOG_MAX = 2000;
let activeToolAbortSignal = null;
const toolAbortStorage = new AsyncLocalStorage();
const devServers = new Map();

export function setToolAbortSignal(signal) {
  activeToolAbortSignal = signal || null;
}

// Keep cancellation scoped to one tool invocation. The legacy global signal
// remains as a fallback for callers outside the agent, while parallel tools
// get isolated signals through AsyncLocalStorage.
export function runWithToolAbortSignal(signal, fn) {
  return toolAbortStorage.run(signal || null, fn);
}

// Sink registered by Agent.run() so the todo_write tool can update the
// agent's todo state (and the UI) without reaching into the agent directly.
// Cleared at the end of every turn — outside an agent run, todo_write is a
// no-op error so the model gets actionable feedback.
let activeTodoSink = null;

export function setAgentTodoSink(sink) {
  activeTodoSink = sink || null;
}

function getToolAbortSignal(timeoutMs = null) {
  const signal = toolAbortStorage.getStore() || activeToolAbortSignal;
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
// Session-wide project-install bypass. Flipped to true either by the user
// answering "Sì, sempre per questa sessione" once, or by /auto-approve.
const projectInstallApproval = { all: false };

export function isEditAlwaysApproved() {
  return editSessionApproval.all === true;
}

export function clearEditSessionApproval() {
  editSessionApproval.all = false;
}

// Toggle auto-approve flags from the UI / commands / config bootstrap.
// `edits` covers write+edit prompts; `installs` covers project-kind installs
// (npm/pip/yarn/poetry/etc). System installs (sudo, apt, brew) and
// destructive commands (rm -rf, force push) STILL require explicit confirmation
// — those have real blast radius beyond the project tree.
export function setAutoApprove({ edits, installs } = {}) {
  if (typeof edits === 'boolean') editSessionApproval.all = edits;
  if (typeof installs === 'boolean') projectInstallApproval.all = installs;
}

export function getAutoApprove() {
  return {
    edits: editSessionApproval.all === true,
    installs: projectInstallApproval.all === true,
  };
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

function extractHtmlImageUrls(html, baseUrl, limit = 10) {
  const urls = [];
  const seen = new Set();
  const tags = String(html || '').match(/<img\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const candidates = [];
    for (const match of tag.matchAll(/\b(?:src|data-src|data-original)\s*=\s*["']([^"']+)["']/gi)) {
      candidates.push(match[1]);
    }
    for (const match of tag.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
      candidates.push(...match[1].split(',').map(item => item.trim().split(/\s+/)[0]));
    }
    for (const candidate of candidates) {
      try {
        const parsed = new URL(decodeHtml(candidate), baseUrl);
        if (!['http:', 'https:'].includes(parsed.protocol) || isBlockedHost(parsed.hostname)) continue;
        if (seen.has(parsed.href)) continue;
        seen.add(parsed.href);
        urls.push(parsed.href);
        if (urls.length >= limit) return urls;
      } catch {}
    }
  }
  return urls;
}

function escapeRegExp(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactTemporarySecrets(text = '', values = []) {
  let out = String(text || '');
  for (const value of values) {
    const secret = String(value || '');
    if (!secret) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '[redacted]');
  }
  return out;
}

function extractHtmlAttr(tag = '', name = '') {
  const attr = escapeRegExp(name);
  const re = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`, 'i');
  const match = String(tag || '').match(re);
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function extractLoginForm(html = '', baseUrl = '') {
  const forms = String(html || '').match(/<form\b[\s\S]*?<\/form>/gi) || [];
  const base = new URL(baseUrl);

  for (const form of forms) {
    const inputTags = form.match(/<input\b[^>]*>/gi) || [];
    const inputs = inputTags
      .map(tag => ({
        tag,
        name: extractHtmlAttr(tag, 'name'),
        type: (extractHtmlAttr(tag, 'type') || 'text').toLowerCase(),
        value: extractHtmlAttr(tag, 'value'),
        disabled: /\bdisabled\b/i.test(tag),
      }))
      .filter(input => input.name && !input.disabled);

    const passwordField = inputs.find(input => input.type === 'password');
    if (!passwordField) continue;

    const userCandidates = inputs.filter(input =>
      !['password', 'hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'reset'].includes(input.type)
    );
    const usernameField = userCandidates.find(input => /user|login|email|mail|account/i.test(input.name))
      || userCandidates[0];
    if (!usernameField) continue;

    const formTag = form.match(/<form\b[^>]*>/i)?.[0] || '';
    const actionRaw = extractHtmlAttr(formTag, 'action') || base.href;
    const actionUrl = new URL(actionRaw, base.href);
    if (actionUrl.origin !== base.origin || isBlockedHost(actionUrl.hostname)) {
      return { unsupported: 'login form submits credentials to a different or blocked origin' };
    }

    const method = (extractHtmlAttr(formTag, 'method') || 'post').toLowerCase() === 'get' ? 'get' : 'post';
    const fields = new URLSearchParams();
    for (const input of inputs) {
      if (['submit', 'button', 'file', 'reset'].includes(input.type)) continue;
      fields.set(input.name, input.value || '');
    }

    return {
      actionUrl: actionUrl.href,
      method,
      fields,
      usernameField: usernameField.name,
      passwordField: passwordField.name,
    };
  }

  return null;
}

function getSetCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get?.('set-cookie');
  if (!raw) return [];
  return String(raw).split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
}

function buildCookieHeader(headers) {
  return getSetCookieHeaders(headers)
    .map(cookie => String(cookie || '').split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function requestSensitiveInput({ question, trim = true }) {
  if (uiBridge.listenerCount('askUser') === 0) {
    return { allowed: false, interactive: false, reason: 'non_interactive' };
  }

  const answer = await new Promise((resolve) => {
    uiBridge.emit('askUser', {
      question,
      options: [],
      sensitive: true,
      resolve,
    });
  });

  if (answer === '__cancelled__') return { allowed: false, interactive: true, reason: 'cancelled' };
  const rawValue = String(answer ?? '');
  const value = trim ? rawValue.trim() : rawValue;
  if (!value) return { allowed: false, interactive: true, reason: 'empty' };
  return { allowed: true, value, interactive: true };
}

async function requestWebCredentials(origin) {
  const username = await requestSensitiveInput({
    question: `Credenziali temporanee per ${origin}\nUsername (non verrà salvato):`,
  });
  if (!username.allowed) return username;

  const password = await requestSensitiveInput({
    question: `Credenziali temporanee per ${origin}\nPassword (non verrà salvata):`,
    trim: false,
  });
  if (!password.allowed) return password;

  return {
    allowed: true,
    username: username.value,
    password: password.value,
  };
}

function formatCredentialBlock(reason) {
  if (reason === 'non_interactive') {
    return 'Error: this site requires credentials. Run ettore in interactive mode so webfetch can ask for temporary username/password without saving them.';
  }
  return 'Cancelled by user: credentials were not provided.';
}

function formatWebPageText({ html, baseUrl, redactions = [], authenticated = false }) {
  const scrubbedHtml = redactTemporarySecrets(html, redactions);
  const text = stripHtml(scrubbedHtml).slice(0, 7000);
  const imageUrls = extractHtmlImageUrls(html, baseUrl);
  const imageSection = imageUrls.length
    ? `\n\nImage URLs found on the page:\n${imageUrls.map((imageUrl, index) => `${index + 1}. ${imageUrl}`).join('\n')}`
    : '';
  const authNote = authenticated
    ? 'Authenticated fetch used temporary credentials for this request only. Credentials were not saved.\n\n'
    : '';
  return `${authNote}${text}${imageSection}`.slice(0, 8000);
}

async function submitLoginForm({ html, pageUrl, credentials, signal }) {
  const form = extractLoginForm(html, pageUrl);
  if (!form) return { ok: false, error: 'no supported same-origin login form found' };
  if (form.unsupported) return { ok: false, error: form.unsupported };

  form.fields.set(form.usernameField, credentials.username);
  form.fields.set(form.passwordField, credentials.password);

  let actionUrl = form.actionUrl;
  const headers = {
    'User-Agent': 'Ettore-CLI/1.0',
    'Accept': 'text/html,application/xhtml+xml',
  };
  const options = {
    method: form.method.toUpperCase(),
    headers,
    redirect: 'manual',
    signal,
  };

  if (form.method === 'get') {
    const parsed = new URL(actionUrl);
    for (const [key, value] of form.fields) parsed.searchParams.set(key, value);
    actionUrl = parsed.href;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = form.fields.toString();
  }

  const response = await fetch(actionUrl, options);
  const cookieHeader = buildCookieHeader(response.headers);
  if (!cookieHeader) {
    return { ok: false, error: `login did not provide a session cookie (HTTP ${response.status})` };
  }
  return { ok: true, cookieHeader };
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

// Ask the user via the UI bridge for a yes/no confirmation.
// In CLI/scripted mode without an interactive listener, callers can opt-in to
// strict blocking (used for destructive shell commands).
async function requestConfirmation({ title, detail, allowNonInteractive = true }) {
  if (uiBridge.listenerCount('askUser') === 0) {
    if (allowNonInteractive) return { allowed: true, interactive: false };
    return { allowed: false, interactive: false, reason: 'non_interactive' };
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
  if (kind === 'project' && projectInstallApproval.all) {
    return { allowed: true, remembered: true };
  }
  if (kind === 'project' && installSessionApproval.has(approvalKey)) {
    return { allowed: true, remembered: true };
  }

  if (uiBridge.listenerCount('askUser') === 0) {
    if (kind === 'system' || kind === 'download') {
      return { allowed: false, interactive: false, reason: 'non_interactive' };
    }
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

async function requestEditConfirmation({ filePath, oldString, newString, fileContent = '', allowNonInteractive = true }) {
  if (editSessionApproval.all) return { allowed: true, remembered: true };
  if (uiBridge.listenerCount('askUser') === 0) {
    if (allowNonInteractive) return { allowed: true, interactive: false };
    return { allowed: false, interactive: false, reason: 'non_interactive' };
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
  if (name === 'web_image') return String(args.url || '');
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

function splitCommandOutput({ stdout, stderr, exitCode }) {
  const out = [];
  if (stdout) out.push(String(stdout));
  if (stderr) out.push(`[stderr]\n${String(stderr)}`);
  if (typeof exitCode === 'number' && exitCode !== 0) out.push(`[exit code: ${exitCode}]`);
  const text = out.join('\n').trim() || '(no output)';
  return truncateLines(text, 400).text;
}

function trimLogBuffer(lines, max = DEV_SERVER_LOG_MAX) {
  if (!Array.isArray(lines)) return [];
  if (lines.length <= max) return lines;
  return lines.slice(lines.length - max);
}

async function detectTestRunner(cwd) {
  if (await fileExists(join(cwd, 'package.json'))) return { kind: 'npm', cmd: 'npm', args: ['test', '--', '--silent'] };
  if (await fileExists(join(cwd, 'pytest.ini')) || await fileExists(join(cwd, 'pyproject.toml')) || await fileExists(join(cwd, 'requirements.txt'))) {
    return { kind: 'pytest', cmd: 'python3', args: ['-m', 'pytest', '-q'] };
  }
  if (await fileExists(join(cwd, 'go.mod'))) return { kind: 'go', cmd: 'go', args: ['test', './...'] };
  if (await fileExists(join(cwd, 'Cargo.toml'))) return { kind: 'cargo', cmd: 'cargo', args: ['test', '--quiet'] };
  return null;
}

async function detectCheckCommands(cwd) {
  const checks = [];
  if (await fileExists(join(cwd, 'package.json'))) {
    checks.push({ name: 'lint', cmd: 'npm', args: ['run', 'lint'] });
    checks.push({ name: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] });
    checks.push({ name: 'test', cmd: 'npm', args: ['test', '--', '--silent'] });
    return checks;
  }
  if (await fileExists(join(cwd, 'pyproject.toml')) || await fileExists(join(cwd, 'pytest.ini')) || await fileExists(join(cwd, 'requirements.txt'))) {
    checks.push({ name: 'lint', cmd: 'python3', args: ['-m', 'ruff', 'check', '.'] });
    checks.push({ name: 'typecheck', cmd: 'python3', args: ['-m', 'mypy', '.'] });
    checks.push({ name: 'test', cmd: 'python3', args: ['-m', 'pytest', '-q'] });
    return checks;
  }
  if (await fileExists(join(cwd, 'go.mod'))) {
    checks.push({ name: 'lint', cmd: 'go', args: ['vet', './...'] });
    checks.push({ name: 'test', cmd: 'go', args: ['test', './...'] });
    return checks;
  }
  if (await fileExists(join(cwd, 'Cargo.toml'))) {
    checks.push({ name: 'lint', cmd: 'cargo', args: ['clippy', '--quiet'] });
    checks.push({ name: 'test', cmd: 'cargo', args: ['test', '--quiet'] });
    return checks;
  }
  return checks;
}

function buildPatchSummary({ filePath, oldString, newString, beforeCount, afterCount, applied }) {
  const header = [
    `File: ${filePath}`,
    `Matches before: ${beforeCount}`,
    `Matches after: ${afterCount}`,
    `Applied: ${applied ? 'yes' : 'no'}`,
  ];
  const diff = buildEditDiff({
    filePath,
    oldString,
    newString,
    fileContent: '',
    maxBlockLines: 18,
  });
  return `${header.join('\n')}\n\n${diff}`;
}

async function buildRepoMap(root, {
  maxDepth = 3,
  maxEntries = 400,
  includeHidden = false,
} = {}) {
  const depthLimit = Math.max(1, Math.min(Number(maxDepth) || 3, 6));
  const entryLimit = Math.max(20, Math.min(Number(maxEntries) || 400, 2000));
  const ignore = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.cache/**', '**/coverage/**'];
  const pattern = includeHidden ? '**/*' : '**/*';
  const files = await globby(pattern, {
    cwd: root,
    onlyFiles: true,
    dot: Boolean(includeHidden),
    followSymbolicLinks: false,
    maxDepth: depthLimit,
    ignore,
  });
  const limited = files.slice(0, entryLimit);
  const extCount = new Map();
  const topDirs = new Map();
  const keyFiles = [];
  const entrypoints = [];
  for (const rel of limited) {
    const ext = extname(rel) || '(noext)';
    extCount.set(ext, (extCount.get(ext) || 0) + 1);
    const top = rel.split('/')[0] || '.';
    topDirs.set(top, (topDirs.get(top) || 0) + 1);
    if (/^(README|readme|AGENTS)\.md$/.test(rel) || /(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|docker-compose\.ya?ml|Dockerfile)$/i.test(rel)) {
      keyFiles.push(rel);
    }
    if (/(^|\/)(index|main|app|server|cli)\.(js|mjs|cjs|ts|py|go|rs)$/i.test(rel) || /^bin\/.+/i.test(rel)) {
      entrypoints.push(rel);
    }
  }
  const topExt = [...extCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const topDirRows = [...topDirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const sections = [];
  sections.push(`Root: ${root}`);
  sections.push(`Scanned files: ${limited.length}${files.length > limited.length ? ` (truncated from ${files.length})` : ''}`);
  sections.push(`Depth: <= ${depthLimit}`);
  sections.push('');
  sections.push('Top directories (by file count):');
  for (const [d, n] of topDirRows) sections.push(`- ${d}: ${n}`);
  sections.push('');
  sections.push('Top extensions:');
  for (const [e, n] of topExt) sections.push(`- ${e}: ${n}`);
  sections.push('');
  sections.push('Likely entrypoints:');
  for (const p of entrypoints.slice(0, 30)) sections.push(`- ${p}`);
  if (entrypoints.length === 0) sections.push('- (none found)');
  sections.push('');
  sections.push('Key files:');
  for (const p of keyFiles.slice(0, 30)) sections.push(`- ${p}`);
  if (keyFiles.length === 0) sections.push('- (none found)');
  sections.push('');
  sections.push('Sample files:');
  for (const p of limited.slice(0, 120)) sections.push(`- ${p}`);
  return sections.join('\n');
}

// Tool implementations
// LLMs sometimes pass ask_user options as objects ({label:"A", description:"..."})
// rather than plain strings. `String({...})` would render "[object Object]" in the
// TUI; extract a human label from common fields and fall back to String() only if
// the element is a primitive.
export function normalizeAskUserOption(o) {
  if (o == null) return '';
  if (typeof o === 'string') return o;
  if (typeof o === 'object') {
    const label = o.label ?? o.text ?? o.value ?? o.name;
    if (typeof label === 'string' && label.trim()) return label;
    return '';
  }
  return String(o);
}

export const toolHandlers = {
  async dep_inspect({ ecosystem = 'auto', workdir, max_items = 100 }) {
    try {
      const cwd = workdir || process.cwd();
      const limit = Math.max(5, Math.min(Number(max_items) || 100, 500));
      const eco = String(ecosystem || 'auto').toLowerCase();
      const out = [];

      const runNpm = async () => {
        const [outdated, audit] = await Promise.allSettled([
          execFileAsync('npm', ['outdated', '--json'], { cwd, maxBuffer: 10 * 1024 * 1024, signal: getToolAbortSignal(30000) }),
          execFileAsync('npm', ['audit', '--json'], { cwd, maxBuffer: 10 * 1024 * 1024, signal: getToolAbortSignal(30000) }),
        ]);
        let outdatedRows = [];
        if (outdated.status === 'fulfilled') {
          const data = JSON.parse(String(outdated.value.stdout || '{}'));
          outdatedRows = Object.entries(data).map(([name, v]) => `${name}: ${v.current} -> ${v.latest}`);
        }
        let vulnSummary = 'unknown';
        if (audit.status === 'fulfilled') {
          const data = JSON.parse(String(audit.value.stdout || '{}'));
          const m = data?.metadata?.vulnerabilities;
          if (m) vulnSummary = `low:${m.low} moderate:${m.moderate} high:${m.high} critical:${m.critical}`;
        }
        out.push('Ecosystem: npm');
        out.push(`Outdated: ${outdatedRows.length}`);
        outdatedRows.slice(0, limit).forEach(r => out.push(`- ${r}`));
        out.push(`Vulnerabilities: ${vulnSummary}`);
      };

      const runPython = async () => {
        let freeze = '';
        try {
          const { stdout } = await execFileAsync('python3', ['-m', 'pip', 'list', '--outdated', '--format=json'], {
            cwd, maxBuffer: 10 * 1024 * 1024, signal: getToolAbortSignal(30000),
          });
          freeze = stdout || '[]';
        } catch {}
        const list = JSON.parse(String(freeze || '[]'));
        out.push('Ecosystem: python');
        out.push(`Outdated: ${list.length}`);
        list.slice(0, limit).forEach(p => out.push(`- ${p.name}: ${p.version} -> ${p.latest_version}`));
      };

      const runCargo = async () => {
        let tree = '';
        try {
          const { stdout } = await execFileAsync('cargo', ['outdated', '--root-deps-only'], {
            cwd, maxBuffer: 10 * 1024 * 1024, signal: getToolAbortSignal(30000),
          });
          tree = stdout || '';
        } catch {}
        out.push('Ecosystem: cargo');
        out.push(tree ? truncateLines(tree.trim(), limit).text : 'Outdated: unavailable (cargo-outdated missing?)');
      };

      const runGo = async () => {
        let modules = '';
        try {
          const { stdout } = await execFileAsync('go', ['list', '-m', '-u', 'all'], {
            cwd, maxBuffer: 10 * 1024 * 1024, signal: getToolAbortSignal(30000),
          });
          modules = stdout || '';
        } catch {}
        out.push('Ecosystem: go');
        out.push(modules ? truncateLines(modules.trim(), limit).text : 'Outdated: unavailable');
      };

      const has = async (file) => fileExists(join(cwd, file));
      const jobs = [];
      if (eco === 'auto' || eco === 'npm') if (await has('package.json')) jobs.push(runNpm);
      if (eco === 'auto' || eco === 'python') if (await has('pyproject.toml') || await has('requirements.txt')) jobs.push(runPython);
      if (eco === 'auto' || eco === 'cargo') if (await has('Cargo.toml')) jobs.push(runCargo);
      if (eco === 'auto' || eco === 'go') if (await has('go.mod')) jobs.push(runGo);
      if (!jobs.length) return `Error: no supported dependency ecosystem found for "${eco}".`;
      for (const j of jobs) await j();
      return out.join('\n');
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async browser_check({ url, expect_texts = [], timeout_ms = 15000 }) {
    try {
      if (!url) return 'Error: browser_check requires "url".';
      let parsed;
      try { parsed = new URL(String(url)); } catch { return 'Error: invalid URL'; }
      if (!['http:', 'https:'].includes(parsed.protocol)) return `Error: unsupported protocol "${parsed.protocol}"`;
      if (isBlockedHost(parsed.hostname)) return 'Error: access to private/loopback addresses not allowed';

      const timeout = Math.max(1000, Math.min(Number(timeout_ms) || 15000, 120000));
      emitToolProgress('browser_check', { url }, 'Fetching page…');
      const res = await fetch(parsed.href, {
        headers: { 'User-Agent': 'Ettore-CLI/1.0' },
        signal: getToolAbortSignal(timeout),
      });
      const html = await res.text();
      const text = stripHtml(html);
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = stripHtml(titleMatch?.[1] || '');
      const checks = Array.isArray(expect_texts)
        ? expect_texts
            .map(v => String(v || '').trim())
            .filter(Boolean)
            .slice(0, 20)
            .map(t => ({ text: t, ok: text.toLowerCase().includes(t.toLowerCase()) }))
        : [];
      const ok = res.ok && checks.every(c => c.ok);
      const lines = [
        `URL: ${parsed.href}`,
        `HTTP: ${res.status}${res.ok ? ' OK' : ''}`,
        `Title: ${title || '(none)'}`,
        `Result: ${ok ? 'PASS' : 'FAIL'}`,
      ];
      if (checks.length) {
        lines.push('Checks:');
        for (const c of checks) lines.push(`- ${c.ok ? 'PASS' : 'FAIL'} "${c.text}"`);
      }
      return lines.join('\n');
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async dev_server({ action = 'status', id = 'default', command, workdir, port, log_lines = 120 }) {
    try {
      const key = String(id || 'default');
      const act = String(action || 'status').toLowerCase();
      const rec = devServers.get(key) || null;

      if (act === 'status') {
        if (!rec) return `Server "${key}" not running.`;
        return [
          `id: ${key}`,
          `running: ${rec.running ? 'yes' : 'no'}`,
          `pid: ${rec.pid ?? 'n/a'}`,
          `workdir: ${rec.workdir || process.cwd()}`,
          `port: ${rec.port || 'n/a'}`,
          `started_at: ${rec.startedAt || 'n/a'}`,
          rec.exitCode != null ? `exit_code: ${rec.exitCode}` : '',
        ].filter(Boolean).join('\n');
      }

      if (act === 'logs') {
        if (!rec) return `Server "${key}" not running.`;
        const n = Math.max(1, Math.min(Number(log_lines) || 120, 1000));
        const tail = rec.logs.slice(Math.max(0, rec.logs.length - n)).join('\n');
        return tail || '(no logs yet)';
      }

      if (act === 'stop') {
        if (!rec) return `Server "${key}" not running.`;
        try {
          if (rec.pid) process.kill(-rec.pid, 'SIGTERM');
          else rec.proc.kill('SIGTERM');
        } catch {
          try { rec.proc.kill('SIGTERM'); } catch {}
        }
        rec.running = false;
        devServers.delete(key);
        return `Stopped server "${key}" (pid ${rec.pid ?? 'n/a'}).`;
      }

      if (act === 'start') {
        if (!command || !String(command).trim()) return 'Error: dev_server start requires non-empty "command".';
        if (rec?.running) return `Server "${key}" already running (pid ${rec.pid}). Stop it first or use another id.`;

        const cwd = workdir || process.cwd();
        const child = spawn('bash', ['-lc', String(command)], {
          cwd,
          env: { ...process.env },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const serverRec = {
          id: key,
          proc: child,
          pid: child.pid,
          running: true,
          workdir: cwd,
          port: Number(port) || null,
          startedAt: new Date().toISOString(),
          logs: [],
          exitCode: null,
        };
        const pushLog = (line) => {
          if (!line) return;
          serverRec.logs.push(String(line));
          serverRec.logs = trimLogBuffer(serverRec.logs);
        };
        child.stdout?.on('data', (buf) => String(buf || '').split(/\r?\n/).forEach(pushLog));
        child.stderr?.on('data', (buf) => String(buf || '').split(/\r?\n/).forEach(pushLog));
        child.on('exit', (code) => {
          serverRec.running = false;
          serverRec.exitCode = Number.isInteger(code) ? code : null;
        });
        devServers.set(key, serverRec);
        return `Started server "${key}" (pid ${child.pid})${serverRec.port ? ` on port ${serverRec.port}` : ''}.`;
      }

      return `Error: unsupported action "${action}". Use start|stop|status|logs.`;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  // Drive a web app in a real browser: open it, click through it, and read
  // the browser console (errors, exceptions, failed requests) while doing so.
  async browser_app({
    action = 'status',
    id = 'default',
    url,
    selector,
    text,
    key,
    expression,
    port,
    file_path,
    level = 'info',
    limit = 80,
    since_last = false,
    only_failed = true,
    headless = null,
    timeout_ms = 30000,
    full_page = false,
    max_chars = 4000,
    ms = 1000,
    submit = false,
    replace = true,
    width = 1280,
    height = 800,
  } = {}) {
    const act = String(action || 'status').toLowerCase();
    const sessionId = String(id || 'default');
    const timeout = Math.max(1000, Math.min(Number(timeout_ms) || 30000, 300000));

    const requireSession = () => {
      const session = browser.getSession(sessionId);
      if (!session) {
        throw new Error(`no browser session "${sessionId}". Start one with action=open (url=...) or attach to a debugging port with action=attach.`);
      }
      if (session.client.closed) {
        throw new Error(`browser session "${sessionId}" lost its connection (the browser was probably closed). Reopen it with action=open.`);
      }
      return session;
    };
    // Report what just broke, right where it broke.
    const withErrors = (session, head) => {
      const errors = browser.takeNewErrors(session);
      if (!errors.length) return head;
      return [
        head,
        `${errors.length} new console error(s):`,
        ...errors.map(e => browser.formatEventLine(e, session.startedAt)),
      ].join('\n');
    };
    // After a navigation, only the messages that navigation produced are
    // interesting — replaying the whole buffer just repeats old failures.
    const consoleSnapshot = (session, { minLevel = 'warning', max = 30, from = 0 } = {}) => {
      const out = browser.summarizeConsole(session.events.slice(from), {
        minLevel,
        limit: max,
        startedAt: session.startedAt,
      });
      browser.syncCursors(session);
      return out;
    };
    const shotPath = () => file_path || join('.ettore', 'screenshots', `${sessionId}-${Date.now()}.png`);

    try {
      if (act === 'list') {
        const rows = browser.listSessions();
        if (!rows.length) return 'No browser session open.';
        return rows
          .map(s => `${s.id}: ${s.url} — port ${s.port}, ${s.headless ? 'headless' : 'visible'}${s.attached ? ', attached' : ''}, ${s.events} console message(s), ${s.errors} error(s)`)
          .join('\n');
      }

      if (act === 'open') {
        emitToolProgress('browser_app', { action: act, id: sessionId }, 'Launching the browser…');
        const session = await browser.launchSession({ id: sessionId, headless, width, height });
        const lines = [`Browser session "${sessionId}" open (${session.headless ? 'headless' : 'visible'}, debug port ${session.port}).`];
        if (url) {
          emitToolProgress('browser_app', { action: act, id: sessionId }, `Opening ${url}…`);
          const from = session.events.length;
          const loaded = await browser.navigate(session, String(url), { timeoutMs: timeout });
          lines.push(`Loaded ${url}${loaded ? '' : ' (load event did not fire within the timeout)'}.`);
          lines.push(consoleSnapshot(session, { from }));
        }
        return lines.join('\n');
      }

      if (act === 'attach') {
        emitToolProgress('browser_app', { action: act, id: sessionId }, `Attaching to port ${port}…`);
        const session = await browser.attachSession({ id: sessionId, port: Number(port) });
        return [
          `Attached to the debugging port ${session.port} as session "${sessionId}" (current page: ${session.url}).`,
          consoleSnapshot(session),
        ].join('\n');
      }

      if (act === 'close') {
        const closed = await browser.closeSession(sessionId);
        return closed ? `Browser session "${sessionId}" closed.` : `No browser session "${sessionId}".`;
      }

      if (act === 'status') {
        const session = browser.getSession(sessionId);
        if (!session) return `No browser session "${sessionId}".`;
        const errors = session.events.filter(e => browser.levelRank(e.level) >= 3).length;
        return [
          `id: ${sessionId}`,
          `url: ${session.url}`,
          `mode: ${session.attached ? 'attached' : (session.headless ? 'headless' : 'visible')}`,
          `debug_port: ${session.port}`,
          `console_messages: ${session.events.length} (${errors} error(s))`,
          `requests: ${session.requests.size}`,
          `started_at: ${new Date(session.startedAt).toISOString()}`,
        ].join('\n');
      }

      const session = requireSession();

      if (act === 'goto' || act === 'navigate') {
        if (!url) return 'Error: browser_app goto requires "url".';
        emitToolProgress('browser_app', { action: act, id: sessionId }, `Opening ${url}…`);
        const from = session.events.length;
        const loaded = await browser.navigate(session, String(url), { timeoutMs: timeout });
        return [
          `Loaded ${url}${loaded ? '' : ' (load event did not fire within the timeout)'}.`,
          consoleSnapshot(session, { from }),
        ].join('\n');
      }

      if (act === 'reload') {
        const from = session.events.length;
        await session.client.send('Page.reload', { ignoreCache: true });
        await new Promise(done => { setTimeout(done, Math.max(300, Math.min(Number(ms) || 1000, 15000))); });
        return [`Reloaded ${session.url}.`, consoleSnapshot(session, { from })].join('\n');
      }

      if (act === 'console') {
        return browser.readConsole(session, {
          minLevel: String(level || 'info'),
          limit: Math.max(1, Math.min(Number(limit) || 80, 400)),
          sinceLast: Boolean(since_last),
        });
      }

      if (act === 'errors') {
        return browser.readConsole(session, {
          minLevel: 'error',
          limit: Math.max(1, Math.min(Number(limit) || 80, 400)),
          sinceLast: Boolean(since_last),
        });
      }

      if (act === 'network') {
        return browser.readNetwork(session, {
          onlyFailed: only_failed !== false,
          limit: Math.max(1, Math.min(Number(limit) || 40, 200)),
        });
      }

      if (act === 'click') {
        if (!selector) return 'Error: browser_app click requires "selector" (CSS, or text=Label).';
        emitToolProgress('browser_app', { action: act, id: sessionId }, `Clicking ${selector}…`);
        const box = await browser.clickElement(session, String(selector));
        await new Promise(done => { setTimeout(done, 350); });
        return withErrors(session, `Clicked <${box.tag}> "${box.text || selector}".`);
      }

      if (act === 'type') {
        if (text === undefined || text === null) return 'Error: browser_app type requires "text".';
        emitToolProgress('browser_app', { action: act, id: sessionId }, 'Typing…');
        const report = await browser.typeInto(session, selector ? String(selector) : null, String(text), {
          replace: replace !== false,
          submit: Boolean(submit),
        });
        await new Promise(done => { setTimeout(done, 350); });
        // The typed text is never echoed back: on a login form it is the
        // credential, and this string reaches the transcript and the logs.
        // What the model needs is *where* it landed — exactly what it used to
        // get wrong without noticing.
        const resolved = report.resolvedFrom ? ` (matched ${report.resolvedFrom}, filled its field)` : '';
        return withErrors(
          session,
          `Typed ${report.length} character(s) into ${report.target}${resolved}${submit ? ' and pressed Enter' : ''}.`,
        );
      }

      if (act === 'press') {
        if (!key) return 'Error: browser_app press requires "key" (Enter, Tab, Escape, ArrowDown, …).';
        await browser.pressKey(session, String(key));
        await new Promise(done => { setTimeout(done, 300); });
        return withErrors(session, `Pressed ${key}.`);
      }

      if (act === 'eval') {
        if (!expression) return 'Error: browser_app eval requires "expression".';
        const value = await browser.evaluate(session, String(expression), { timeoutMs: timeout });
        let rendered;
        try { rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
        catch { rendered = String(value); }
        return withErrors(session, `Result: ${String(rendered ?? 'undefined').slice(0, Math.max(200, Math.min(Number(max_chars) || 4000, 40000)))}`);
      }

      if (act === 'text') {
        const body = await browser.pageText(session, Number(max_chars) || 4000);
        return body.trim() ? body : '(the page has no visible text)';
      }

      if (act === 'snapshot') {
        const snap = await browser.snapshot(session, Number(limit) || 40);
        const rows = (snap.elements || []).map(el => {
          const label = el.label ? ` "${el.label}"` : '';
          const type = el.type ? `[${el.type}]` : '';
          const kind = el.field ? ' (input field)' : '';
          const flags = `${el.required ? ' (required)' : ''}${el.disabled ? ' (disabled)' : ''}`;
          return `- ${el.tag}${type}${label}${kind} → ${el.selector}${flags}`;
        });
        return [`${snap.title || '(no title)'} — ${snap.url}`, `${rows.length} interactive element(s):`, ...rows].join('\n');
      }

      if (act === 'check') {
        emitToolProgress('browser_app', { action: act, id: sessionId }, 'Checking the page elements…');
        if (selector) {
          const probe = await browser.probe(session, String(selector), { field: false });
          if (probe.problem && probe.ok === false && !probe.describe) {
            return `✗ ${selector}: ${probe.problem}`;
          }
          const lines = [
            `${probe.ok ? '✓' : '✗'} ${selector} → ${probe.describe} at (${probe.x}, ${probe.y})`
            + `${probe.ok ? ' — usable' : ` — ${probe.problem}`}`,
          ];
          if (!probe.field) {
            // What "type" would actually do with this locator, before the
            // model finds out by filling the wrong box.
            const asField = await browser.probe(session, String(selector), { field: true, point: false });
            lines.push(asField.describe
              ? `   typing here would fill: ${asField.describe}${asField.problem ? ` (${asField.problem})` : ''}`
              : `   typing here would fail: ${asField.problem}`);
          }
          return withErrors(session, lines.join('\n'));
        }
        const report = await browser.probeAll(session, Number(limit) || 40);
        const items = report.elements || [];
        const broken = items.filter(item => !item.ok);
        const fields = items.filter(item => item.field);
        const lines = [
          `${report.title || '(no title)'} — ${report.url}`,
          `${items.length} interactive element(s), ${fields.length} input field(s), ${broken.length} with problems.`,
        ];
        for (const item of broken.slice(0, 20)) {
          lines.push(`✗ ${item.describe || item.locator}${item.label ? ` "${item.label}"` : ''} → ${item.problem}`);
        }
        for (const item of fields.filter(f => f.ok).slice(0, 20)) {
          lines.push(`✓ ${item.describe}${item.label ? ` "${item.label}"` : ''} → fillable at (${item.x}, ${item.y})`);
        }
        return withErrors(session, lines.join('\n'));
      }

      if (act === 'wait') {
        if (selector) {
          await browser.waitForSelector(session, String(selector), timeout);
          return withErrors(session, `Element ${selector} is visible.`);
        }
        const pause = Math.max(50, Math.min(Number(ms) || 1000, 60000));
        await new Promise(done => { setTimeout(done, pause); });
        return withErrors(session, `Waited ${pause}ms.`);
      }

      if (act === 'screenshot') {
        const target = shotPath();
        emitToolProgress('browser_app', { action: act, id: sessionId }, 'Capturing the page…');
        const shot = await browser.screenshot(session, target, { fullPage: Boolean(full_page) });
        return `Screenshot saved to ${shot.path} (${formatBytes(shot.bytes)}).`;
      }

      return `Error: unsupported action "${action}". Use open|attach|goto|click|type|press|eval|text|snapshot|check|console|errors|network|wait|screenshot|reload|status|list|close.`;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  // Launch and drive a desktop (GUI) app: keep its stdout/stderr, list and
  // screenshot its windows, click and type into it.
  async desktop_app({
    action = 'status',
    id = 'default',
    command,
    workdir,
    file_path,
    x,
    y,
    button = 1,
    text,
    keys,
    window_id,
    title,
    lines = 200,
    only_errors = false,
    timeout_ms = 15000,
    virtual_display = null,
    debug_port = null,
    ms = 1000,
  } = {}) {
    const act = String(action || 'status').toLowerCase();
    const appId = String(id || 'default');
    const timeout = Math.max(500, Math.min(Number(timeout_ms) || 15000, 300000));

    const requireApp = () => {
      const app = desktop.getApp(appId);
      if (!app) throw new Error(`no desktop app "${appId}". Start one with action=open (command="…").`);
      return app;
    };
    const shotPath = () => file_path || join('.ettore', 'screenshots', `${appId}-${Date.now()}.png`);

    try {
      if (act === 'capabilities') {
        const caps = desktop.describeCapabilities();
        return [
          `display: ${caps.display || '(none — a virtual display will be started with Xvfb)'}`,
          `session: ${caps.wayland ? 'wayland' : 'x11'}`,
          `windows: ${caps.windowManagerTool || 'unavailable (install wmctrl or xdotool)'}`,
          `screenshot: ${caps.screenshotTool || 'unavailable (install imagemagick, gnome-screenshot, scrot…)'}`,
          `input: ${caps.inputTool || 'unavailable — ' + desktop.inputUnavailableMessage()}`,
          `virtual display: ${caps.virtualDisplayTool || 'unavailable (install xvfb)'}`,
        ].join('\n');
      }

      if (act === 'list') {
        const rows = desktop.listApps();
        if (!rows.length) return 'No desktop app started.';
        return rows
          .map(a => `${a.id}: ${a.command} — pid ${a.pid}, ${a.running ? 'running' : `exited (code ${a.exitCode ?? 'n/a'})`}, display ${a.display || 'n/a'}, ${a.logLines} log line(s)`)
          .join('\n');
      }

      if (act === 'open') {
        if (!command) return 'Error: desktop_app open requires "command".';
        emitToolProgress('desktop_app', { action: act, id: appId }, 'Launching the app…');
        const app = await desktop.openApp({
          id: appId,
          command: String(command),
          workdir: workdir || process.cwd(),
          virtual_display,
          debug_port,
        });
        await new Promise(done => { setTimeout(done, Math.max(300, Math.min(Number(ms) || 1000, 30000))); });
        const out = [
          `Desktop app "${appId}" started (pid ${app.pid}) on display ${app.display || 'n/a'}.`,
          `command: ${app.command}`,
        ];
        if (!app.running) out.push(`WARNING: the process already exited with code ${app.exitCode ?? 'n/a'}.`);
        if (app.debugPort) {
          out.push(`DevTools port ${app.debugPort} requested: read its renderer console with browser_app action=attach port=${app.debugPort}.`);
        } else if (desktop.looksLikeElectron(app.command)) {
          out.push('This looks like an Electron app: restart it with debug_port=9222 to read its renderer console via browser_app action=attach.');
        }
        const logs = desktop.readLogs(app, { lines: 40 });
        out.push('--- output ---', logs);
        const problems = desktop.detectAppErrors(app.logs);
        if (problems.length) out.push(`${problems.length} suspicious line(s) — inspect them with action=errors.`);
        return out.join('\n');
      }

      if (act === 'stop') {
        const stopped = await desktop.stopApp(appId);
        return stopped ? `Desktop app "${appId}" stopped.` : `No desktop app "${appId}".`;
      }

      const app = requireApp();

      if (act === 'status') {
        return [
          `id: ${appId}`,
          `command: ${app.command}`,
          `pid: ${app.pid}`,
          `running: ${app.running ? 'yes' : `no (exit code ${app.exitCode ?? 'n/a'})`}`,
          `display: ${app.display || 'n/a'}`,
          `workdir: ${app.workdir}`,
          `log_lines: ${app.logs.length}`,
          `started_at: ${new Date(app.startedAt).toISOString()}`,
        ].join('\n');
      }

      if (act === 'logs') {
        return desktop.readLogs(app, {
          lines: Math.max(1, Math.min(Number(lines) || 200, 2000)),
          onlyErrors: Boolean(only_errors),
        });
      }

      if (act === 'errors') {
        return desktop.readLogs(app, { onlyErrors: true });
      }

      if (act === 'windows') {
        const windows = await desktop.listWindows(app);
        if (!windows.length) return `App "${appId}" has no visible window (yet).`;
        return windows
          .map(w => `${w.id} ${w.width}x${w.height}+${w.x}+${w.y} pid ${w.pid} "${w.title}"`)
          .join('\n');
      }

      if (act === 'wait') {
        if (title !== undefined || !Number(ms)) {
          const win = await desktop.waitForWindow(app, { timeoutMs: timeout, title: title || '' });
          return `Window ready: ${win.id} ${win.width}x${win.height}+${win.x}+${win.y} "${win.title}"`;
        }
        const pause = Math.max(100, Math.min(Number(ms) || 1000, 60000));
        await new Promise(done => { setTimeout(done, pause); });
        return `Waited ${pause}ms. ${desktop.readLogs(app, { lines: 20 })}`;
      }

      if (act === 'focus') {
        const windows = await desktop.listWindows(app);
        const target = window_id || windows[0]?.id;
        if (!target) return `App "${appId}" has no window to focus.`;
        await desktop.focusWindow(target, app.display);
        return `Focused window ${target}.`;
      }

      if (act === 'screenshot') {
        let target = window_id || null;
        if (!target) {
          try { target = (await desktop.listWindows(app))[0]?.id || null; } catch {}
        }
        emitToolProgress('desktop_app', { action: act, id: appId }, 'Capturing the window…');
        const shot = await desktop.captureWindow({ windowId: target, path: shotPath(), display: app.display });
        return `Screenshot saved to ${shot.path} (${shot.tool}${target ? `, window ${target}` : ', full screen'}).`;
      }

      if (act === 'click') {
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
          return 'Error: desktop_app click requires numeric "x" and "y" (window-relative when window_id is given, screen coordinates otherwise).';
        }
        const windows = await desktop.listWindows(app).catch(() => []);
        const point = await desktop.clickAt({
          x: Number(x),
          y: Number(y),
          button: Number(button) || 1,
          windowId: window_id || null,
          display: app.display,
          windows,
        });
        await new Promise(done => { setTimeout(done, 400); });
        const fresh = desktop.detectAppErrors(app.logs.slice(-30));
        const head = `Clicked at ${point.x},${point.y}.`;
        return fresh.length ? `${head}\nRecent suspicious output:\n${fresh.map(f => f.line).join('\n')}` : head;
      }

      if (act === 'type') {
        if (text === undefined || text === null) return 'Error: desktop_app type requires "text".';
        await desktop.typeText({ text: String(text), windowId: window_id || null, display: app.display });
        await new Promise(done => { setTimeout(done, 300); });
        return `Typed ${String(text).length} character(s) into the focused widget.`;
      }

      if (act === 'press') {
        if (!keys) return 'Error: desktop_app press requires "keys" (e.g. Return, ctrl+s, alt+F4).';
        await desktop.pressKeys({ keys: String(keys), windowId: window_id || null, display: app.display });
        await new Promise(done => { setTimeout(done, 300); });
        return `Pressed ${keys}.`;
      }

      return `Error: unsupported action "${action}". Use open|logs|errors|windows|wait|focus|screenshot|click|type|press|status|list|stop|capabilities.`;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async repo_find_symbol({ symbol, path = '.', max_results = 80 }) {
    try {
      const q = String(symbol || '').trim();
      if (!q) return 'Error: repo_find_symbol requires non-empty "symbol".';
      const searchPath = path || process.cwd();
      const safeLimit = Math.max(1, Math.min(Number(max_results) || 80, 500));
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = `\\b(${escaped})\\b`;

      const tryRipgrep = async () => {
        const { stdout } = await execFileAsync('rg', ['--line-number', '--with-filename', '--no-heading', '-e', pattern, searchPath], {
          maxBuffer: 10 * 1024 * 1024,
          signal: getToolAbortSignal(30000),
        });
        return stdout || '';
      };

      // Fallback when ripgrep isn't installed: GNU/BSD grep with -w (whole word)
      // + -F (fixed string) reproduces the \b(symbol)\b match portably, without
      // depending on grep's regex dialect.
      const tryGrep = async () => {
        const { stdout } = await execFileAsync('grep', ['-rnwF', '-e', q, searchPath], {
          maxBuffer: 10 * 1024 * 1024,
          signal: getToolAbortSignal(30000),
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
            // grep exits 1 with no output when there are simply no matches —
            // treat that as "no matches", not an error.
            else if (grepErr?.code === 1) output = '';
            else return `Error: ${grepErr.message}`;
          }
        }
      }
      if (!output.trim()) return `No matches for symbol "${q}".`;
      const lines = output.trimEnd().split('\n').slice(0, safeLimit);
      const body = lines.join('\n');
      const suffix = output.trimEnd().split('\n').length > safeLimit
        ? `\n... truncated at ${safeLimit} matches`
        : '';
      return body + suffix;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async apply_patch_structured({ file_path, old_string, new_string, expected_count = 1, preview_only = false }) {
    try {
      if (!file_path || typeof old_string !== 'string' || typeof new_string !== 'string') {
        return 'Error: apply_patch_structured requires file_path, old_string, new_string.';
      }
      const content = await readFile(file_path, 'utf-8');
      const count = old_string === '' ? 0 : content.split(old_string).length - 1;
      const expected = Math.max(1, Number(expected_count) || 1);
      if (count !== expected) {
        return `Error: expected ${expected} match(es) for old_string in ${file_path}, found ${count}.`;
      }
      const replaced = content.replaceAll(old_string, new_string);
      const afterCount = new_string === '' ? 0 : replaced.split(old_string).length - 1;
      const summary = buildPatchSummary({
        filePath: file_path,
        oldString: old_string,
        newString: new_string,
        beforeCount: count,
        afterCount,
        applied: !preview_only,
      });
      if (preview_only) return `Preview only:\n${summary}`;
      const ok = await requestEditConfirmation({
        filePath: file_path,
        oldString: old_string,
        newString: new_string,
        fileContent: content,
        allowNonInteractive: false,
      });
      if (!ok.allowed) {
        if (ok.reason === 'non_interactive') {
          return `Blocked: overwrite/edit requires interactive confirmation. Run this command from interactive mode.`;
        }
        return `Cancelled by user: refused to apply structured patch to ${file_path}.`;
      }
      await writeFile(file_path, replaced, 'utf-8');
      uiBridge.emit('fileChanged', {
        type: 'edit',
        path: file_path,
        oldLines: old_string.split('\n').length,
        newLines: new_string.split('\n').length,
        diff: new_string.split('\n').length - old_string.split('\n').length,
      });
      return `Applied structured patch.\n${summary}`;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async run_checks({ profile = 'quick', workdir, timeout_ms = 240000 }) {
    try {
      const cwd = workdir || process.cwd();
      const timeout = Math.max(10_000, Math.min(Number(timeout_ms) || 240000, 600000));
      const mode = String(profile || 'quick').toLowerCase();
      const checks = await detectCheckCommands(cwd);
      if (!checks.length) return 'Error: no supported check suite detected for this repository.';
      const selected = mode === 'full'
        ? checks
        : checks.filter(c => c.name === 'lint' || c.name === 'test');
      const out = [];
      for (const c of selected) {
        emitToolProgress('run_checks', { profile: mode }, `Running ${c.name}…`);
        try {
          const { stdout, stderr } = await execFileAsync(c.cmd, c.args, {
            cwd,
            maxBuffer: 20 * 1024 * 1024,
            timeout,
            signal: getToolAbortSignal(timeout + 5000),
          });
          out.push(`[${c.name}] PASS\n${splitCommandOutput({ stdout, stderr, exitCode: 0 })}`);
        } catch (error) {
          const code = Number.isInteger(error?.code) ? error.code : null;
          out.push(`[${c.name}] FAIL\n${splitCommandOutput({ stdout: error?.stdout || '', stderr: error?.stderr || error?.message || '', exitCode: code })}`);
          return out.join('\n\n');
        }
      }
      return out.join('\n\n');
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async repo_map({ path = '.', max_depth = 3, max_entries = 400, include_hidden = false }) {
    try {
      const root = path || process.cwd();
      const st = await stat(root);
      if (!st.isDirectory()) return `Error: not a directory: ${root}`;
      emitToolProgress('repo_map', { path: root }, 'Scanning repository structure…');
      return await buildRepoMap(root, {
        maxDepth: max_depth,
        maxEntries: max_entries,
        includeHidden: include_hidden,
      });
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async run_tests({ suite = 'auto', workdir, timeout_ms = 180000 }) {
    try {
      const cwd = workdir || process.cwd();
      const safeTimeout = Math.max(10_000, Math.min(Number(timeout_ms) || 180000, 600000));
      const selected = String(suite || 'auto').toLowerCase();
      let runner = null;

      if (selected === 'auto') {
        runner = await detectTestRunner(cwd);
        if (!runner) return 'Error: no supported test runner detected (package.json, pytest, go.mod, Cargo.toml).';
      } else if (selected === 'npm') {
        runner = { kind: 'npm', cmd: 'npm', args: ['test', '--', '--silent'] };
      } else if (selected === 'node') {
        runner = { kind: 'node', cmd: 'node', args: ['--test'] };
      } else if (selected === 'pytest') {
        runner = { kind: 'pytest', cmd: 'python3', args: ['-m', 'pytest', '-q'] };
      } else if (selected === 'go') {
        runner = { kind: 'go', cmd: 'go', args: ['test', './...'] };
      } else if (selected === 'cargo') {
        runner = { kind: 'cargo', cmd: 'cargo', args: ['test', '--quiet'] };
      } else {
        return `Error: unsupported suite "${suite}". Use one of: auto, npm, node, pytest, go, cargo.`;
      }

      emitToolProgress('run_tests', { suite: selected }, `Running ${runner.kind} tests…`);
      const { stdout, stderr } = await execFileAsync(runner.cmd, runner.args, {
        cwd,
        maxBuffer: 20 * 1024 * 1024,
        timeout: safeTimeout,
        signal: getToolAbortSignal(safeTimeout + 5000),
      });
      return `Runner: ${runner.kind}\nResult: PASS\n${splitCommandOutput({ stdout, stderr, exitCode: 0 })}`;
    } catch (error) {
      const code = Number.isInteger(error?.code) ? error.code : null;
      const timedOut = error?.killed || /timed out|timeout/i.test(String(error?.message || ''));
      const result = timedOut ? 'TIMEOUT' : 'FAIL';
      const details = splitCommandOutput({ stdout: error?.stdout || '', stderr: error?.stderr || error?.message || '', exitCode: code });
      return `Runner: ${String(suite || 'auto').toLowerCase()}\nResult: ${result}\n${details}`;
    }
  },

  async bash({ command, workdir, timeout_ms }) {
    try {
      const installAction = detectInstallAction(command);
      if (installAction) {
        const ok = await requestInstallConfirmation({
          label: installAction.label,
          kind: installAction.kind,
          command,
        });
        if (!ok.allowed) {
          if (ok.reason === 'non_interactive') {
            return `Blocked: "${installAction.label}" requires interactive confirmation. Run this command from interactive mode.`;
          }
          return `Cancelled by user: refused to run "${installAction.label}" command.`;
        }
      }

      const danger = detectDestructive(command);
      if (danger) {
        const ok = await requestConfirmation({
          title: `⚠ Comando potenzialmente distruttivo (${danger})`,
          detail: `$ ${command}`,
          allowNonInteractive: false,
        });
        if (!ok.allowed) {
          if (ok.reason === 'non_interactive') {
            return `Blocked: "${danger}" requires interactive confirmation. Run this command from interactive mode.`;
          }
          return `Cancelled by user: refused to run "${danger}" command.`;
        }
      }
      const startedAt = Date.now();
      const timeoutMs = Math.max(1000, Math.min(Number(timeout_ms) || 120_000, 600_000));
      const heartbeat = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        emitToolProgress('bash', { command }, `Running… ${elapsed}s elapsed`);
      }, 5000);
      try {
        // Same stdin trap as the persistent session: `exec` hands the child a
        // stdin pipe nobody ever writes to or closes, so anything that reads
        // stdin (a prompt, a REPL, `git commit` with no -m) blocks forever.
        // `execFile` drops a `stdio` option, so the redirect has to live in the
        // command itself; a heredoc or explicit `< file` still takes priority.
        const { stdout, stderr } = await execAsync(`{ ${command}\n} < /dev/null`, {
          cwd: workdir || process.cwd(),
          maxBuffer: 10 * 1024 * 1024,
          timeout: timeoutMs,
          signal: getToolAbortSignal(),
        });
        // Cap and clean so chat clients don't truncate silently. The bash
        // tool is the most common source of runaway output (e.g. a `cat` on
        // a large file, or a Python script that prints verbosely) and the
        // truncated "Need to re-run" message downstream is confusing.
        const cleaned = sanitizeOutput(stdout || stderr || '(no output)', { maxBytes: 50_000 });
        if (cleaned.truncated) {
          return cleaned.output +
            `\n\n[bash output was ${cleaned.originalBytes} bytes; cap is 50KB — see "Run command directly" hint]`;
        }
        return cleaned.output;
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      // Errors also flow through sanitizeOutput to keep stray ANSI escapes
      // out of the user's terminal.
      if (error?.killed && error?.signal && error?.name !== 'AbortError') {
        const partial = sanitizeOutput(`${error.stdout || ''}${error.stderr || ''}`, { maxBytes: 10_000 });
        return `${partial.output}\n[timeout — command killed. Re-run with a larger timeout_ms, or make it non-interactive.]`.trim();
      }
      const msg = sanitizeOutput(`Error: ${error.message}\n${error.stderr || ''}`, { maxBytes: 10_000 });
      return msg.output;
    }
  },

  async bash_session({ command, timeout_ms, workdir }) {
    try {
      if (typeof command !== 'string' || !command.trim()) {
        return 'Error: bash_session requires a non-empty `command`.';
      }
      const installAction = detectInstallAction(command);
      if (installAction) {
        const ok = await requestInstallConfirmation({
          label: installAction.label,
          kind: installAction.kind,
          command,
        });
        if (!ok.allowed) {
          if (ok.reason === 'non_interactive') {
            return `Blocked: "${installAction.label}" requires interactive confirmation. Run this command from interactive mode.`;
          }
          return `Cancelled by user: refused to run "${installAction.label}" command.`;
        }
      }

      const danger = detectDestructive(command);
      if (danger) {
        const ok = await requestConfirmation({
          title: `⚠ Comando potenzialmente distruttivo (${danger})`,
          detail: `$ ${command}`,
          allowNonInteractive: false,
        });
        if (!ok.allowed) {
          if (ok.reason === 'non_interactive') {
            return `Blocked: "${danger}" requires interactive confirmation. Run this command from interactive mode.`;
          }
          return `Cancelled by user: refused to run "${danger}" command.`;
        }
      }

      const timeoutMs = Math.max(1000, Math.min(Number(timeout_ms) || 120_000, 600_000));
      const session = getBashSession(workdir || process.cwd());
      const result = await session.run(command, {
        timeoutMs,
        signal: getToolAbortSignal(),
        onProgress: (msg) => emitToolProgress('bash_session', { command }, msg),
      });

      const parts = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
      if (result.timedOut) {
        parts.push(`[timeout after ${Math.round(timeoutMs / 1000)}s — session killed, will respawn fresh on next call]`);
      } else if (result.aborted) {
        parts.push(`[aborted by user — session killed, will respawn on next call]`);
      } else if (result.sessionDied) {
        parts.push(`[shell exited (code ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ''}) — session will respawn on next call]`);
      } else if (result.writeError) {
        parts.push(`[stdin write failed: ${result.writeError}]`);
      } else if (result.exitCode !== 0) {
        parts.push(`[exit code: ${result.exitCode}]`);
      }
      if (result.bufferOverflow) {
        parts.push('[output truncated — exceeded 10MB buffer; pipe through head/grep for narrower output]');
      }
      return parts.length ? parts.join('\n') : '(no output)';
    } catch (error) {
      return `Error: ${error.message}`;
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

  async read_pdf({ file_path, page_from = 1, page_to, max_chars = 20000, ocr = false, ocr_lang = 'auto', ocr_dpi = 300 }) {
    try {
      if (!file_path) return 'Error: read_pdf requires file_path';
      const safeFrom = Math.max(1, Number(page_from) || 1);
      const safeTo = page_to == null ? null : Math.max(safeFrom, Number(page_to) || safeFrom);
      const charLimit = Math.max(1000, Math.min(Number(max_chars) || 20000, 200000));
      const lang = String(ocr_lang || 'auto').trim() || 'auto';
      const dpi = Math.max(150, Math.min(Number(ocr_dpi) || 300, 600));
      const forceOcr = Boolean(ocr);
      let nativeText = '';
      let ocrError = '';

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
          nativeText = String(stdout || '').trim();
          if (isLikelyUsablePdfText(nativeText)) {
            if (nativeText.length > charLimit) return `${nativeText.slice(0, charLimit)}\n... truncated at ${charLimit} chars`;
            return nativeText;
          }
        } catch (pdfErr) {
          const missing = /ENOENT|not found/i.test(String(pdfErr?.message || ''));
          if (!missing && pdfErr?.stdout) {
            nativeText = String(pdfErr.stdout).trim();
            if (isLikelyUsablePdfText(nativeText)) {
              return nativeText.length > charLimit ? `${nativeText.slice(0, charLimit)}\n... truncated at ${charLimit} chars` : nativeText;
            }
          }
        }
      }

      // Super OCR path: automatic for empty/suspicious native text, or forced by the model.
      try {
        const ocrResult = await extractPdfTextWithSuperOcr({
          filePath: file_path,
          pageFrom: safeFrom,
          pageTo: safeTo,
          lang,
          dpi,
          maxChars: charLimit,
          signal: timeout => getToolAbortSignal(timeout),
          onProgress: message => emitToolProgress('read_pdf', { file_path }, message),
        });
        if (ocrResult.text) {
          const suffix = ocrResult.warning ? `\n\n[${ocrResult.warning}]` : '';
          const result = `${ocrResult.text}${suffix}`;
          return result.length > charLimit ? `${result.slice(0, charLimit)}\n... truncated at ${charLimit} chars` : result;
        }
      } catch (ocrErr) {
        ocrError = String(ocrErr?.message || 'strumenti OCR non disponibili');
      }

      if (nativeText) {
        return nativeText.length > charLimit ? `${nativeText.slice(0, charLimit)}\n... truncated at ${charLimit} chars` : nativeText;
      }

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
      if (!text) {
        const hint = ocrError ? `\nOCR error: ${ocrError}` : '';
        return `No readable text found in PDF: ${file_path}${hint}`;
      }
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
          allowNonInteractive: false,
        });
        if (!ok.allowed) {
          if (ok.reason === 'non_interactive') {
            return `Blocked: overwrite/edit requires interactive confirmation. Run this command from interactive mode.`;
          }
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
        allowNonInteractive: false,
      });
      if (!ok.allowed) {
        if (ok.reason === 'non_interactive') {
          return `Blocked: overwrite/edit requires interactive confirmation. Run this command from interactive mode.`;
        }
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

  async todo_write({ action, items, index }) {
    if (!activeTodoSink) {
      return 'Error: todo_write is only available during an agent turn.';
    }
    const act = String(action || '').toLowerCase().trim();

    if (act === 'set' || act === 'append') {
      if (!Array.isArray(items)) {
        return `Error: todo_write ${act} requires "items" to be an array of strings.`;
      }
      const cleaned = items
        .map(s => String(s ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 20);
      if (!cleaned.length) {
        return `Error: todo_write ${act} requires at least one non-empty item.`;
      }
      if (act === 'set') {
        activeTodoSink.setList(cleaned);
        return `OK: set ${cleaned.length} todo item(s). Now execute step 1 and call todo_write({action:'complete', index:1}) when it's done.`;
      }
      activeTodoSink.append(cleaned);
      return `OK: appended ${cleaned.length} todo item(s).`;
    }

    if (act === 'complete') {
      const i = Number(index);
      if (!Number.isInteger(i) || i < 1) {
        return 'Error: todo_write complete requires integer "index" >= 1 (1-based).';
      }
      const result = activeTodoSink.markDone(i - 1);
      if (result && result.outOfRange) {
        return `Error: index ${i} is out of range — the current todo list has ${result.size} item(s).`;
      }
      const remaining = result?.remaining ?? 0;
      return remaining > 0
        ? `OK: marked step ${i} as done. ${remaining} step(s) still pending.`
        : `OK: marked step ${i} as done. All steps complete.`;
    }

    return `Error: unknown action "${action}". Use one of: set, append, complete.`;
  },

  async ask_user({ question, options }) {
    const opts = Array.isArray(options)
      ? options.map(normalizeAskUserOption).filter(Boolean)
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

  async video_transcript({ url, language = 'en' }) {
    if (!url) return 'Error: video_transcript requires a "url" argument.';
    try {
      // Cascade can include a whisper run on long audio — give it room.
      const signal = getToolAbortSignal(600_000);
      const log = (msg) => emitToolProgress('video_transcript', { url }, msg);
      const result = await transcribeVideo(
        { url, preferLang: language },
        { signal, log },
      );
      return renderTranscript(result);
    } catch (e) {
      return `Error: ${e.message}`;
    }
  },

  async video_describe({ url, prompt }) {
    if (!url) return 'Error: video_describe requires a "url" argument.';
    try {
      const log = (msg) => emitToolProgress('video_describe', { url }, msg);
      log('Asking Gemini to watch the video frames…');
      const signal = getToolAbortSignal(600_000);
      const result = await describeVideo({ url, prompt }, { signal });
      if (result.error) return `Error: ${result.error}`;
      const header = [
        `[${(result.source || 'gemini').toUpperCase()} — VISUAL]`,
        `video_id: ${result.videoId}`,
        '',
      ].join('\n');
      return header + result.description;
    } catch (e) {
      return `Error: ${e.message}`;
    }
  },

  async audio_read({ file_path, mode = 'transcribe', language = 'auto', prompt }) {
    if (!file_path) return 'Error: audio_read requires a "file_path" argument.';
    try {
      // whisper on a long track can run for minutes — give it the same room
      // as video_transcript.
      const signal = getToolAbortSignal(600_000);
      const log = (msg) => emitToolProgress('audio_read', { file_path }, msg);
      const result = await readAudio({ file_path, mode, language, prompt }, { signal, log });
      return renderAudioResult(result);
    } catch (e) {
      return `Error: ${e.message}`;
    }
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

      const baseHeaders = { 'User-Agent': 'Ettore-CLI/1.0' };
      let authenticated = false;
      let redactions = [];
      let response = await fetch(parsed.href, {
        headers: baseHeaders,
        signal: getToolAbortSignal(15_000),
      });

      if ([401, 403].includes(Number(response.status))) {
        emitToolProgress('webfetch', { url: parsed.href }, 'Site requires credentials; asking user…');
        const credentials = await requestWebCredentials(parsed.origin);
        if (!credentials.allowed) return formatCredentialBlock(credentials.reason);

        const auth = Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64');
        response = await fetch(parsed.href, {
          headers: {
            ...baseHeaders,
            'Authorization': `Basic ${auth}`,
          },
          signal: getToolAbortSignal(15_000),
        });
        authenticated = true;
        redactions = [credentials.username, credentials.password];
        if (!response.ok) return `Error: ${response.status} after temporary credentials`;
      }

      if (!response.ok) return `Error: ${response.status}`;
      let html = await response.text();
      let responseUrl = response.url || parsed.href;

      if (!authenticated) {
        const loginForm = extractLoginForm(html, responseUrl);
        if (loginForm?.unsupported) {
          return `Error: page appears to require login, but ${loginForm.unsupported}.`;
        }
        if (loginForm) {
          emitToolProgress('webfetch', { url: parsed.href }, 'Login form detected; asking user for temporary credentials…');
          const credentials = await requestWebCredentials(parsed.origin);
          if (!credentials.allowed) return formatCredentialBlock(credentials.reason);

          const login = await submitLoginForm({
            html,
            pageUrl: responseUrl,
            credentials,
            signal: getToolAbortSignal(15_000),
          });
          if (!login.ok) return `Error: login failed: ${login.error}`;

          response = await fetch(parsed.href, {
            headers: {
              ...baseHeaders,
              'Cookie': login.cookieHeader,
            },
            signal: getToolAbortSignal(15_000),
          });
          authenticated = true;
          redactions = [credentials.username, credentials.password];
          if (!response.ok) return `Error: ${response.status} after temporary login`;
          html = await response.text();
          responseUrl = response.url || parsed.href;
        }
      }

      return formatWebPageText({ html, baseUrl: responseUrl, redactions, authenticated });
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async web_image({ url }) {
    try {
      emitToolProgress('web_image', { url }, 'Downloading and validating image…');
      return await fetchWebImage(url, { signal: getToolAbortSignal(20_000) });
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
  },

  async generate_scene_image({ prompt, file_path, size }) {
    try {
      emitToolProgress('generate_scene_image', { prompt }, 'Generating scene frame…');
      const r = await generateSceneImage({ prompt, filePath: file_path, size }, { signal: getToolAbortSignal(120_000) });
      return `Frame generated: ${r.path} (${r.size}, ${r.bytes} bytes)`;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async generate_scene_clip({ prompt, output_path, subject_reference_image, first_frame_image, duration, resolution, model }) {
    try {
      emitToolProgress('generate_scene_clip', { prompt }, 'Starting clip generation (this can take a few minutes)…');
      const r = await generateSceneClip(
        {
          prompt,
          outputPath: output_path,
          subjectReferenceImage: subject_reference_image,
          firstFrameImage: first_frame_image,
          duration,
          resolution,
          model,
        },
        {
          signal: getToolAbortSignal(),
          onProgress: (msg) => emitToolProgress('generate_scene_clip', { prompt }, msg),
        },
      );
      return `Clip generated: ${r.path} (model ${r.model}, ${r.duration}s ${r.resolution}, ${r.bytes} bytes)`;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async assemble_music_video({ audio_path, clip_paths, output_path, subtitles_path, width }) {
    try {
      emitToolProgress('assemble_music_video', {}, 'Assembling clips, audio and subtitles…');
      const r = await assembleMusicVideo(
        { audioPath: audio_path, clipPaths: clip_paths, outputPath: output_path, subtitlesPath: subtitles_path, width },
        { signal: getToolAbortSignal(600_000) },
      );
      return `Music video assembled: ${r.path} (${r.clipCount} clips, ${r.durationSeconds.toFixed(1)}s audio)`;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  },

  async lyrics_to_srt({ lyrics, output_path }) {
    try {
      const srt = lyricsToSrt(lyrics);
      if (!srt) return 'Error: no [MM:SS] timestamped lines found in the provided lyrics.';
      if (!output_path) return `Error: lyrics_to_srt requires an "output_path".`;
      const { writeFile: wf, mkdir: mk } = await import('fs/promises');
      await mk(dirname(output_path), { recursive: true });
      await wf(output_path, srt, 'utf-8');
      const cues = (srt.match(/-->/g) || []).length;
      return `Subtitles written: ${output_path} (${cues} cues)`;
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
      name: 'dep_inspect',
      description: 'Inspect dependency health in a repository (outdated/vulnerability summary where supported) for npm, python, cargo, or go.',
      parameters: {
        type: 'object',
        properties: {
          ecosystem: { type: 'string', enum: ['auto', 'npm', 'python', 'cargo', 'go'], description: 'auto|npm|python|cargo|go. Default: auto' },
          workdir: { type: 'string', description: 'Optional working directory' },
          max_items: { type: 'number', minimum: 5, maximum: 500, description: 'Maximum rows per ecosystem, 5-500. Default: 100' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_check',
      description: 'Run a browser-style smoke check on a public URL: fetch page, report HTTP status/title, and validate expected visible texts.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Public http/https URL to check' },
          expect_texts: { type: 'array', items: { type: 'string' }, description: 'Optional list of expected text snippets to verify on the page' },
          timeout_ms: { type: 'number', minimum: 1000, maximum: 120000, description: 'Request timeout in ms (1000-120000). Default: 15000' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dev_server',
      description: 'Manage a local development server process by id: start, stop, status, logs.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'status', 'logs'], description: 'One of: start, stop, status, logs' },
          id: { type: 'string', description: 'Logical server id. Default: default' },
          command: { type: 'string', description: 'Command to start the server (required for action=start)' },
          workdir: { type: 'string', description: 'Working directory for start command' },
          port: { type: 'number', description: 'Optional port metadata for status output' },
          log_lines: { type: 'number', minimum: 1, maximum: 1000, description: 'For action=logs, number of tail lines (1-1000). Default: 120' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_app',
      description: 'Open and drive a web app in a real browser (Chrome/Chromium via DevTools Protocol) and READ THE BROWSER CONSOLE: console messages, uncaught exceptions, failed requests and HTTP 4xx/5xx. Works on localhost dev servers. Use it to reproduce a bug in the UI, click and type like a user, then read the errors it produced. action=attach connects to an already running app that exposes --remote-debugging-port (e.g. an Electron desktop app).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'attach', 'goto', 'click', 'type', 'press', 'eval', 'text', 'snapshot', 'check', 'console', 'errors', 'network', 'wait', 'screenshot', 'reload', 'status', 'list', 'close'], description: 'open (launch browser, optionally at url), attach (connect to an existing debugging port), goto, click, type, press, eval, text, snapshot (list clickable elements), check (verify elements are really usable: visible, enabled, not covered — with a selector it checks one and points at it, without one it checks the whole page), console, errors, network, wait, screenshot, reload, status, list, close' },
          id: { type: 'string', description: 'Session id, so several apps can be driven at once. Default: default' },
          url: { type: 'string', description: 'URL to load (action=open/goto). localhost is allowed.' },
          selector: { type: 'string', description: 'CSS selector, or text=Label / label=Label / placeholder=Hint to match what is visible on the page (click/type/wait). For action=type the match is resolved to the actual control: naming a form label fills the field that label belongs to, and the tool fails loudly instead of typing into the wrong element.' },
          text: { type: 'string', description: 'Text to type (action=type). Never echoed back in the result: only the character count and the field it went into.' },
          key: { type: 'string', description: 'Key to press: Enter, Tab, Escape, ArrowDown, … (action=press)' },
          expression: { type: 'string', description: 'JavaScript to evaluate in the page (action=eval)' },
          port: { type: 'number', description: 'Debugging port to attach to (action=attach)' },
          file_path: { type: 'string', description: 'Screenshot destination file. Default: .ettore/screenshots/<id>-<timestamp>.png' },
          level: { type: 'string', enum: ['debug', 'info', 'warning', 'error'], description: 'Minimum console level to return (action=console). Default: info' },
          limit: { type: 'number', minimum: 1, maximum: 400, description: 'Maximum messages/elements/requests to return. Default: 80' },
          since_last: { type: 'boolean', description: 'Only console messages produced since the previous read. Default: false' },
          only_failed: { type: 'boolean', description: 'action=network: only failed requests and HTTP >= 400. Default: true' },
          headless: { type: 'boolean', description: 'Force headless (true) or a visible window (false). Default: visible when a desktop is available' },
          submit: { type: 'boolean', description: 'action=type: press Enter after typing. Default: false' },
          replace: { type: 'boolean', description: 'action=type: clear the field first. Default: true' },
          full_page: { type: 'boolean', description: 'action=screenshot: capture beyond the viewport. Default: false' },
          max_chars: { type: 'number', minimum: 200, maximum: 40000, description: 'action=text/eval: maximum characters returned. Default: 4000' },
          ms: { type: 'number', minimum: 50, maximum: 60000, description: 'action=wait: pause in ms when no selector is given. Default: 1000' },
          timeout_ms: { type: 'number', minimum: 1000, maximum: 300000, description: 'Navigation/wait timeout in ms. Default: 30000' },
          width: { type: 'number', description: 'Window width on open. Default: 1280' },
          height: { type: 'number', description: 'Window height on open. Default: 800' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'desktop_app',
      description: 'Launch and drive a desktop (GUI) application: start it while capturing stdout/stderr (crashes, tracebacks, GTK/Qt criticals), list and screenshot its windows, click, type and press keys in it. Use it to reproduce a bug in a real desktop app before fixing the code. Clicking and typing need xdotool on X11; action=capabilities reports what is available.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'logs', 'errors', 'windows', 'wait', 'focus', 'screenshot', 'click', 'type', 'press', 'status', 'list', 'stop', 'capabilities'], description: 'open, logs, errors (only suspicious lines), windows, wait, focus, screenshot, click, type, press, status, list, stop, capabilities' },
          id: { type: 'string', description: 'App id, so several apps can run at once. Default: default' },
          command: { type: 'string', description: 'Command that starts the GUI app (action=open), e.g. "python3 app.py" or "npm run electron"' },
          workdir: { type: 'string', description: 'Working directory for the command' },
          file_path: { type: 'string', description: 'Screenshot destination file. Default: .ettore/screenshots/<id>-<timestamp>.png' },
          window_id: { type: 'string', description: 'Target window id from action=windows (e.g. 0x03200007)' },
          title: { type: 'string', description: 'action=wait: wait for a window whose title contains this text' },
          x: { type: 'number', description: 'action=click: X coordinate (relative to window_id when given, screen otherwise)' },
          y: { type: 'number', description: 'action=click: Y coordinate' },
          button: { type: 'number', minimum: 1, maximum: 3, description: 'action=click: mouse button, 1=left 2=middle 3=right. Default: 1' },
          text: { type: 'string', description: 'action=type: text to type into the focused widget' },
          keys: { type: 'string', description: 'action=press: key or combination, e.g. Return, ctrl+s, alt+F4' },
          lines: { type: 'number', minimum: 1, maximum: 2000, description: 'action=logs: tail size. Default: 200' },
          only_errors: { type: 'boolean', description: 'action=logs: keep only suspicious lines. Default: false' },
          virtual_display: { type: 'boolean', description: 'Run the app on a virtual X display (Xvfb). Default: true only when no desktop is available' },
          debug_port: { type: 'number', description: 'Add --remote-debugging-port to the command (Electron/Chromium apps), so browser_app action=attach can read its console' },
          ms: { type: 'number', minimum: 100, maximum: 60000, description: 'Settle time after open, or pause for action=wait. Default: 1000' },
          timeout_ms: { type: 'number', minimum: 500, maximum: 300000, description: 'action=wait: window timeout in ms. Default: 15000' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repo_find_symbol',
      description: 'Find occurrences of a symbol name across the repository with file:line output (rg-based). Useful for locating definitions/usages before editing.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Symbol/function/class name to locate' },
          path: { type: 'string', description: 'Base directory to search. Default: current directory' },
          max_results: { type: 'number', minimum: 1, maximum: 500, description: 'Maximum matching lines to return, 1-500. Default: 80' }
        },
        required: ['symbol']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch_structured',
      description: 'Apply a validated exact-string patch on one file with expected match count and optional preview-only mode.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to target file' },
          old_string: { type: 'string', description: 'Exact source text to replace' },
          new_string: { type: 'string', description: 'Replacement text' },
          expected_count: { type: 'number', description: 'Expected number of matches for old_string. Default: 1' },
          preview_only: { type: 'boolean', description: 'If true, do not write file; return preview only' }
        },
        required: ['file_path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_checks',
      description: 'Run a project quality gate profile using safe predefined commands (lint/typecheck/test where available).',
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', enum: ['quick', 'full'], description: 'quick or full. quick runs core checks; full runs all detected checks.' },
          workdir: { type: 'string', description: 'Optional working directory' },
          timeout_ms: { type: 'number', minimum: 10000, maximum: 600000, description: 'Timeout per check command in ms (10000-600000). Default: 240000' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repo_map',
      description: 'Build a compact repository map: top directories, extension distribution, likely entrypoints, key project files, and sample file list.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Base directory to scan. Default: current directory' },
          max_depth: { type: 'number', description: 'Max recursion depth, 1-6. Default: 3' },
          max_entries: { type: 'number', minimum: 20, maximum: 2000, description: 'Max files scanned, 20-2000. Default: 400' },
          include_hidden: { type: 'boolean', description: 'Include dot-files/directories. Default: false' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Run project tests with a safe predefined runner (no arbitrary shell). Supports auto detection or explicit suite: auto, npm, node, pytest, go, cargo.',
      parameters: {
        type: 'object',
        properties: {
          suite: { type: 'string', enum: ['auto', 'npm', 'node', 'pytest', 'go', 'cargo'], description: 'Test suite to run: auto|npm|node|pytest|go|cargo. Default: auto' },
          workdir: { type: 'string', description: 'Optional working directory' },
          timeout_ms: { type: 'number', minimum: 10000, maximum: 600000, description: 'Timeout in milliseconds (10000-600000). Default: 180000' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command in a fresh subprocess and return the output. Stateless — every call starts in the original cwd with the original env. Use `bash_session` instead when later commands need state from earlier ones. stdin is /dev/null: a command that waits for input gets EOF instead of hanging, so pass flags like -y/--yes/-m rather than relying on a prompt.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          workdir: { type: 'string', description: 'Working directory (optional)' },
          timeout_ms: { type: 'number', minimum: 1000, maximum: 600000, description: 'Optional timeout in ms (default 120000, max 600000). On timeout the command is killed and partial output is returned.' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bash_session',
      description: 'Execute a shell command in a PERSISTENT bash session. Working directory, exported variables, defined functions, and shell options persist between calls — so `cd subdir` followed by `pwd` returns the new path, and a `VAR=x` followed by `echo $VAR` returns x. Use this when later commands depend on state from earlier ones (cd, source, exports, function defs). The session auto-respawns if it crashes or is killed by a timeout. stdin is /dev/null: a command that waits for input gets EOF instead of hanging, so pass flags like -y/--yes/-m rather than relying on a prompt.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run in the persistent session' },
          workdir: { type: 'string', description: 'Initial working directory. Changing it recreates the persistent session.' },
          timeout_ms: { type: 'number', minimum: 1000, maximum: 600000, description: 'Optional timeout in ms (default 120000, max 600000). On timeout the session is killed and respawned fresh.' }
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
          offset: { type: 'number', minimum: 0, description: 'Start line (0-based)' },
          limit: { type: 'number', minimum: 1, maximum: 1000, description: 'Max lines to return (1-1000)' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_pdf',
      description: 'Extract readable text from any PDF, including scanned or low-quality pages. Uses native extraction first and automatically activates Super OCR with preprocessing, deskew, denoise, adaptive thresholding, multiple Tesseract layouts, and automatic Italian/English language selection when native text is missing or unreliable.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the PDF file' },
          page_from: { type: 'number', minimum: 1, description: 'First page to read, 1-based. Default: 1' },
          page_to: { type: 'number', minimum: 1, description: 'Last page to read, 1-based (optional)' },
          max_chars: { type: 'number', minimum: 1000, maximum: 200000, description: 'Maximum characters to return, 1000-200000. Default: 20000' },
          ocr: { type: 'boolean', description: 'If true, force Super OCR even when the PDF contains selectable text. Default: false means automatic OCR fallback.' },
          ocr_lang: { type: 'string', description: 'Tesseract language code (auto, eng, ita, or eng+ita). Default: auto, preferring ita+eng when installed.' },
          ocr_dpi: { type: 'number', minimum: 150, maximum: 600, description: 'Render DPI for difficult scans, 150-600. Default: 300' }
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
          max_chars: { type: 'number', minimum: 1000, maximum: 200000, description: 'Maximum characters to return, 1000-200000. Default: 20000' }
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
          max_lines: { type: 'number', minimum: 1, maximum: 2000, description: 'Maximum lines to return from the tail, 1-2000. Default: 300' },
          max_chars: { type: 'number', minimum: 1000, maximum: 200000, description: 'Maximum characters to return, 1000-200000. Default: 40000' }
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
          max_results: { type: 'number', minimum: 1, maximum: 5000, description: 'Maximum files to return, 1-5000. Default: 500' }
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
          max_matches: { type: 'number', minimum: 1, maximum: 5000, description: 'Maximum matching lines to return, 1-5000. Default: 500' }
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
          max_entries: { type: 'number', minimum: 1, maximum: 1000, description: 'Maximum entries to return, 1-1000. Default: 200' }
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
          max_chars: { type: 'number', minimum: 1000, maximum: 50000, description: 'Maximum characters to return, 1000-50000. Default: 12000' }
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
      description: 'Fetch the text content of a URL. Supports public pages, HTTP Basic Auth, and simple same-origin HTML login forms by asking the user for temporary username/password interactively; credentials are used only for the current request and are not saved.',
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
      name: 'web_image',
      description: 'Download a public JPEG, PNG, GIF, or WebP URL and pass the actual image to the vision model for visual analysis. Use this after finding a direct image URL; do not use webfetch for image bytes.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Direct public http/https image URL' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'video_transcript',
      description: 'Fetch a spoken-text transcript of a video so the model can understand what it is about. Cascade: (1) YouTube captions when available — free, instant; (2) local whisper transcription if yt-dlp + whisper are installed — free forever, works on any video URL yt-dlp supports; (3) Google Gemini API if GEMINI_API_KEY is set — YouTube URLs only, free tier. Returns transcript with timestamps, plus title and channel for YouTube. The returned header indicates which source was used.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'YouTube URL or 11-char video ID' },
          language: { type: 'string', description: 'Preferred caption language code (e.g. "en", "it"). Falls back to whatever is available. Default: "en".' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'video_describe',
      description: 'Watch a YouTube video and describe what is visually happening on screen: slides, code, diagrams, on-screen text, UI, demos, gestures, scene changes with timestamps. Uses the Google Gemini API free tier (GEMINI_API_KEY env var required). YouTube URLs only — for non-YouTube hosts use video_transcript to get the audio track instead. Returns a description plus a source marker header. Pair with video_transcript when both the audio AND the visuals matter.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'YouTube URL or 11-char video ID' },
          prompt: { type: 'string', description: 'Optional override for the visual-description prompt. Use this to focus the model on specific visual elements (e.g. "only describe the code shown on screen"). Defaults to a general visual-description prompt.' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'audio_read',
      description: 'Read a LOCAL music/audio file (mp3, wav, m4a, flac, ogg, opus, aac, aiff, webm) so you can understand it. Two modes. mode="transcribe" (default) extracts the sung/spoken words (lyrics) with [MM:SS] timestamps — uses local whisper when installed (free, offline, any size), otherwise the Gemini free tier (GEMINI_API_KEY, files up to ~14MB). mode="describe" analyzes the music itself — genre, mood, tempo/BPM, key, instruments, song structure — and always uses Gemini (needs a multimodal model). For audio from a URL/YouTube use video_transcript instead.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to a local audio file (absolute, or relative to the working directory).' },
          mode: { type: 'string', enum: ['transcribe', 'describe'], description: 'transcribe = extract lyrics/spoken words (default); describe = analyze genre, tempo, instruments, mood, structure.' },
          language: { type: 'string', description: 'transcribe only: preferred language code (e.g. "en", "it") to steer whisper. Default "auto" detects it.' },
          prompt: { type: 'string', description: 'Optional override for the model prompt, e.g. to focus the analysis or transcription on something specific.' }
        },
        required: ['file_path']
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
          max_results: { type: 'number', minimum: 1, maximum: 10, description: 'Number of results to return, 1-10. Default: 5' },
          site: { type: 'string', description: 'Optional domain filter, e.g. nodejs.org or docs.github.com' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Manage the structured todo list shown in the UI progress panel. Replaces the legacy <todo>/<done:N> text markers — prefer this tool when a task needs 3+ distinct steps. Three actions: action="set" with items=[...] to declare the initial plan; action="complete" with index=N (1-based) to check off a step as you finish it; action="append" with items=[...] to add follow-up steps discovered mid-task. Call set ONCE at the start, then complete after each step.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['set', 'append', 'complete'],
            description: 'set: declare/replace the list. append: add more items. complete: mark one item done.'
          },
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Required for action=set or action=append. One short line per step. Max 20 items.'
          },
          index: {
            type: 'integer',
            description: 'Required for action=complete. 1-based index of the step that just finished.'
          }
        },
        required: ['action']
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
  },
  {
    type: 'function',
    function: {
      name: 'generate_scene_image',
      description: 'Generate a single still frame for a music-video scene using OpenAI gpt-image-1 (needs OPENAI_API_KEY). Use this only when you want to art-direct a precise first frame for image-to-video; for keeping the same character across scenes use generate_scene_clip with subject_reference_image instead.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Visual description of the frame.' },
          file_path: { type: 'string', description: 'Where to write the PNG (absolute or relative to workdir).' },
          size: { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024'], description: 'Image size. Default 1024x1024.' }
        },
        required: ['prompt', 'file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_scene_clip',
      description: 'Generate ONE real animated video clip (6 or 10s) via MiniMax Hailuo (needs MINIMAX_API_KEY). This is the core of music-video generation. To keep the SAME character across different scenes, pass subject_reference_image (a photo of the person) — that selects the S2V-01 subject-reference engine. Alternatively pass first_frame_image to animate from a specific starting frame, or neither for pure text-to-video. Slow (a few minutes) and PAID per clip: generate clips one at a time and confirm large batches with the user first. The prompt should describe the scene AND the motion (camera + subject action).',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Scene + motion description (e.g. "the character walks through neon-lit rain, slow dolly-in").' },
          output_path: { type: 'string', description: 'Where to write the .mp4 clip.' },
          subject_reference_image: { type: 'string', description: 'Path or public URL of the character reference photo. Keeps the same person across scenes (uses S2V-01).' },
          first_frame_image: { type: 'string', description: 'Path or public URL of a first frame to animate from (image-to-video). Ignored if subject_reference_image is set.' },
          duration: { type: 'integer', enum: [6, 10], description: 'Clip length in seconds. Default 6.' },
          resolution: { type: 'string', enum: ['512P', '768P', '1080P'], description: 'Output resolution. Default 768P.' },
          model: { type: 'string', description: 'Override the MiniMax model. Default: S2V-01 when subject_reference_image is set, else MiniMax-Hailuo-2.3.' }
        },
        required: ['prompt', 'output_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'assemble_music_video',
      description: 'Assemble ordered animated clips + the user\'s audio track into the final music video with ffmpeg. Clip audio is dropped in favor of the song; pass subtitles_path (an .srt) to burn in lyrics. Needs ffmpeg installed.',
      parameters: {
        type: 'object',
        properties: {
          audio_path: { type: 'string', description: 'Path to the song (mp3/wav/…).' },
          clip_paths: { type: 'array', items: { type: 'string' }, description: 'Ordered list of clip .mp4 paths to concatenate.' },
          output_path: { type: 'string', description: 'Where to write the final .mp4.' },
          subtitles_path: { type: 'string', description: 'Optional .srt file to burn in as subtitles (see lyrics_to_srt).' },
          width: { type: 'number', description: 'Output width in px (height auto, keeps aspect). Default 1280.' }
        },
        required: ['audio_path', 'clip_paths', 'output_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lyrics_to_srt',
      description: 'Convert lyrics with [MM:SS] (or [HH:MM:SS]) timestamps — as returned by audio_read mode="transcribe" — into an .srt subtitle file for burning into the music video. Each line runs until the next timestamped line.',
      parameters: {
        type: 'object',
        properties: {
          lyrics: { type: 'string', description: 'Timestamped lyrics text (lines like "[00:12] first line").' },
          output_path: { type: 'string', description: 'Where to write the .srt file.' }
        },
        required: ['lyrics', 'output_path']
      }
    }
  }
];

function typeMatches(value, expected) {
  if (!expected) return true;
  if (expected === 'string')  return typeof value === 'string';
  if (expected === 'number')  return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'array')   return Array.isArray(value);
  if (expected === 'object')  return value !== null && typeof value === 'object' && !Array.isArray(value);
  return true;
}

// Coerce a single value to the type its schema declares, but only when the
// conversion is lossless and unambiguous. Anything doubtful is returned
// untouched so validateToolArgs still rejects it with a clear message.
function coerceToSchemaType(value, expected) {
  if (!expected || typeMatches(value, expected)) return value;

  if (expected === 'number' || expected === 'integer') {
    // MiniMax serialises numeric arguments as JSON strings
    // (`{"offset":"5020","limit":"90"}`). Round-tripping through Number is
    // exact for anything that matches a plain numeric literal.
    if (typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) {
      const num = Number(value.trim());
      if (!Number.isFinite(num)) return value;
      if (expected === 'integer') return Number.isInteger(num) ? num : value;
      return num;
    }
    return value;
  }

  if (expected === 'boolean' && typeof value === 'string') {
    const probe = value.trim().toLowerCase();
    if (probe === 'true') return true;
    if (probe === 'false') return false;
    return value;
  }

  if ((expected === 'array' || expected === 'object') && typeof value === 'string') {
    const probe = value.trim();
    const looksRight = expected === 'array'
      ? probe.startsWith('[') && probe.endsWith(']')
      : probe.startsWith('{') && probe.endsWith('}');
    if (!looksRight) return value;
    try {
      const parsed = JSON.parse(probe);
      return typeMatches(parsed, expected) ? parsed : value;
    } catch {
      return value;
    }
  }

  if (expected === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
    return String(value);
  }

  return value;
}

// Bring `args` in line with the tool's declared types before validation.
// Models routinely get JSON scalar types wrong while getting the *values*
// right; rejecting `"5020"` for a number field would fail a call that is
// otherwise perfectly well formed.
export function coerceToolArgsToSchema(name, args = {}) {
  const tool = toolDefinitions.find(t => t.function?.name === name);
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  const props = tool.function.parameters?.properties || {};

  let changed = false;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    const coerced = coerceToSchemaType(value, props[key]?.type);
    if (coerced !== value) changed = true;
    out[key] = coerced;
  }
  return changed ? out : args;
}

// Validate `args` against the tool's declared input schema.
// MiniMax and other models occasionally emit tool_use blocks with `input: {}`
// or wrong-typed fields — we catch that here and return an actionable error
// the model can recover from, instead of letting the handler crash with a
// cryptic Node.js message.
export function validateToolArgs(name, args = {}) {
  const tool = toolDefinitions.find(t => t.function?.name === name);
  if (!tool) return { valid: true };
  const schema = tool.function.parameters || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties || {};
  const missing = [];
  const wrongType = [];

  const labelType = (val) => (Array.isArray(val) ? 'array' : typeof val);

  for (const key of required) {
    const val = args[key];
    if (val === undefined || val === null || val === '') {
      missing.push(key);
      continue;
    }
    const expected = props[key]?.type;
    if (expected && !typeMatches(val, expected)) {
      wrongType.push(`${key} expected ${expected}, got ${labelType(val)}`);
    }
  }

  for (const [key, spec] of Object.entries(props)) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    const val = args[key];
    if (val === undefined || val === null) continue;
    const expected = spec?.type;
    if (expected && !typeMatches(val, expected)) {
      wrongType.push(`${key} expected ${expected}, got ${labelType(val)}`);
      continue;
    }
    if (Array.isArray(spec?.enum) && spec.enum.length > 0 && !spec.enum.includes(val)) {
      wrongType.push(`${key} expected one of [${spec.enum.join(', ')}], got ${String(val)}`);
    }
    if ((spec?.type === 'number' || spec?.type === 'integer') && typeof val === 'number' && Number.isFinite(val)) {
      if (typeof spec.minimum === 'number' && val < spec.minimum) {
        wrongType.push(`${key} expected >= ${spec.minimum}, got ${val}`);
      }
      if (typeof spec.maximum === 'number' && val > spec.maximum) {
        wrongType.push(`${key} expected <= ${spec.maximum}, got ${val}`);
      }
    }
  }
  if (!missing.length && !wrongType.length) return { valid: true };
  const parts = [];
  if (missing.length) parts.push(`missing required argument(s): ${missing.join(', ')}`);
  if (wrongType.length) parts.push(`invalid value — ${wrongType.join('; ')}`);
  const sent = JSON.stringify(args).slice(0, 200);
  return {
    valid: false,
    error: `Error: tool '${name}' called with invalid arguments — ${parts.join('; ')}. You sent: ${sent}. Call '${name}' again with all required arguments and correct types.`,
  };
}
