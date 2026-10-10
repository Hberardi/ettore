// The first screen: what to connect, and what to ask.
//
// A new user used to be met by an empty transcript and a prompt. Typing into
// it produced "Not connected yet. Use /connect", and `/connect` listed thirty
// providers by name. Nothing on the screen said that an Ollama already running
// on the machine would do, that the `claude` CLI they had installed counted as
// a subscription, or — once a model answered — what this tool is good for in
// the folder they started it in.
//
// The welcome card answers both from what is actually on the machine: the
// ways to get a model that work here without typing a key, and up to three
// requests made for this project. Each is one keystroke: type its number.
//
// Detection only. Nothing here connects, spends or writes; the TUI acts on
// the choice the user makes. Everything is plain data so it can be tested
// without a terminal — src/app/tui-native.js draws it.

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { detectProjectTestSuite } from '../agents/release-gate.js';
import { findOnPath } from '../utils/platform.js';

const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags';
// Long enough for a local daemon to answer, short enough that a machine
// without one does not notice the wait.
const PROBE_TIMEOUT_MS = 700;
const GIT_TIMEOUT_MS = 1500;

/**
 * Ways to reach a model that are already on this machine.
 * @returns {Promise<{ollama: {installed: boolean, running: boolean, models: string[]}, claudeCli: boolean}>}
 */
export async function detectLocalOptions({
  fetchFn = globalThis.fetch,
  findOnPathFn = findOnPath,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const ollama = { installed: Boolean(findOnPathFn('ollama')), running: false, models: [] };
  try {
    const response = await fetchFn(OLLAMA_TAGS_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) {
      const body = await response.json();
      ollama.running = true;
      ollama.models = (Array.isArray(body?.models) ? body.models : [])
        .map(model => String(model?.name || model?.model || ''))
        .filter(Boolean);
    }
  } catch {
    // Nothing listening: the common case, and not an error.
  }
  return { ollama, claudeCli: Boolean(findOnPathFn('claude')) };
}

function gitDirtyCount(cwd) {
  return new Promise((resolvePromise) => {
    execFile('git', ['status', '--porcelain'], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolvePromise(null); return; }
      // ETTORE's own folder is created on first start; counting it would
      // tell every new user they have one uncommitted change.
      resolvePromise(String(stdout).split('\n').filter(line => line && !/^.. "?\.ettore\//.test(line)).length);
    });
  });
}

/**
 * What can be told about the folder without reading its code.
 * @returns {Promise<{name: string, empty: boolean, dirty: number|null, testRunner: string|null, hasReadme: boolean}>}
 *   `dirty` is null outside a git work tree.
 */
export async function projectFacts(cwd = process.cwd()) {
  let entries = [];
  try { entries = await readdir(cwd); } catch { /* unreadable: treat as empty */ }
  // ETTORE's own folder appears the moment it starts; it is not the project.
  const visible = entries.filter(name => name !== '.ettore' && name !== '.git');
  const [dirty, testRunner] = await Promise.all([
    gitDirtyCount(cwd),
    detectProjectTestSuite(cwd).catch(() => null),
  ]);
  return {
    name: basename(cwd) || cwd,
    empty: visible.length === 0,
    dirty,
    testRunner,
    hasReadme: entries.some(name => /^readme(\.|$)/i.test(name)),
  };
}

const TEST_COMMANDS = { npm: 'npm test', node: 'node --test', pytest: 'pytest', go: 'go test ./...', cargo: 'cargo test' };

/**
 * Up to three requests worth making in this folder, most useful first. Each
 * is a full prompt: choosing one sends it as if the user had typed it.
 */
export function projectSuggestions(facts, { max = 3 } = {}) {
  if (facts.empty) {
    return [{
      label: 'Start a new project here',
      detail: 'this folder is empty',
      prompt: 'This folder is empty and I want to start a new project in it. Ask me what I want to build, then propose a structure and wait for my go-ahead before writing any file.',
    }];
  }
  const out = [{
    label: 'Explain this project',
    detail: 'what it does, how it is organised, how to run it',
    prompt: 'Explore this project and explain what it does, how it is organised and how to run it. Do not change any file.',
  }];
  if (facts.dirty) {
    out.push({
      label: `Review my ${facts.dirty} uncommitted change${facts.dirty === 1 ? '' : 's'}`,
      detail: 'what could break, what is missing',
      prompt: 'Review my uncommitted changes — the git diff and the untracked files — and tell me what could break and what is missing. Do not change any file.',
    });
  }
  if (facts.testRunner) {
    out.push({
      label: 'Run the tests and fix what fails',
      detail: TEST_COMMANDS[facts.testRunner] || facts.testRunner,
      prompt: 'Run the project\'s test suite. If anything fails, find the cause and fix it. If everything passes, tell me which parts of the code have the weakest tests.',
    });
  }
  if (!facts.hasReadme) {
    out.push({
      label: 'Write a README',
      detail: 'there is none yet',
      prompt: 'Write a README.md for this project: what it is, how to install it, how to run it and how to test it. Base every statement on the code.',
    });
  }
  out.push({
    label: 'Find one thing worth fixing',
    detail: 'with the evidence, before changing anything',
    prompt: 'Look through this project for one concrete bug or rough edge worth fixing. Show me the evidence and wait for my go-ahead before changing anything.',
  });
  return out.slice(0, max);
}

const LANGUAGE_NAMES = { it: 'Italian', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese' };

/** The system's language as a two-letter code ETTORE has prompts for, else 'en'. */
export function localeCode(env = process.env) {
  const raw = String(env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE || '').toLowerCase();
  return LANGUAGE_NAMES[raw.slice(0, 2)] ? raw.slice(0, 2) : 'en';
}

/**
 * The language of the user's system, as an English name, or null for English
 * and for anything not recognised. The suggested prompts are written in
 * English; a user whose system is in Italian should get the answer in
 * Italian without having to ask.
 */
export function localeLanguage(env = process.env) {
  return LANGUAGE_NAMES[localeCode(env)] || null;
}

/**
 * @param {object} input
 * @param {null|{provider: string, name: string, model: string|null, envVar: string|null}} input.connected
 * @param {object} input.local from detectLocalOptions
 * @param {object} input.facts from projectFacts
 * @param {boolean} input.firstRun
 * @param {string|null} input.language from localeLanguage
 * @returns {object} the card: a headline, the numbered choices and the lines
 *   around them. `choices[i].action` is what the TUI does for that number.
 */
export function buildWelcome({ connected = null, local = null, facts = null, firstRun = false, language = null, providerCount = 0 } = {}) {
  if (!connected) {
    const choices = [];
    const notes = [];
    const ollama = local?.ollama;
    if (ollama?.running && ollama.models.length) {
      choices.push({
        // Not "free": an Ollama install can list cloud models that are billed
        // to the user's Ollama account.
        label: 'Ollama — already running here',
        detail: `${ollama.models.length} model${ollama.models.length === 1 ? '' : 's'}, no API key (${ollama.models[0]}${ollama.models.length > 1 ? ', …' : ''})`,
        action: { type: 'connect', provider: 'ollama' },
      });
    } else if (ollama?.running) {
      notes.push('Ollama is running but has no model yet: `ollama pull <model>`, then /connect ollama.');
    } else if (ollama?.installed) {
      notes.push('Ollama is installed but not running: start it, then /connect ollama.');
    }
    if (local?.claudeCli) {
      choices.push({
        label: 'Your Claude subscription',
        detail: 'through the claude CLI installed here — no API key',
        action: { type: 'connect', provider: 'claude-code' },
      });
    }
    choices.push({
      label: 'Paste an API key',
      detail: `OpenAI, Anthropic, Gemini, OpenRouter${providerCount > 4 ? ` and ${providerCount - 4} more` : ''}`,
      action: { type: 'pickProvider' },
    });
    notes.push('A key already in your environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, …) is picked up at start.');
    return {
      firstRun,
      connected: null,
      headline: firstRun ? 'Welcome. ETTORE needs a model to work with.' : 'No model connected.',
      prompt: 'Type a number and press Enter:',
      choices: choices.map((choice, i) => ({ key: String(i + 1), ...choice })),
      notes,
      tips: [],
    };
  }

  const suggestions = facts ? projectSuggestions(facts) : [];
  const suffix = language ? ` Answer in ${language}.` : '';
  return {
    firstRun,
    connected,
    headline: `Connected: ${connected.name} · ${connected.model || 'no model selected'}`,
    connectedNote: [
      connected.envVar ? `key from ${connected.envVar}` : '',
      '/select changes the model',
    ].filter(Boolean).join(' · '),
    prompt: suggestions.length
      ? `Ask anything — or start with one of these in ${facts.name}. Type a number and press Enter:`
      : 'Ask anything.',
    choices: suggestions.map((suggestion, i) => ({
      key: String(i + 1),
      label: suggestion.label,
      detail: suggestion.detail,
      action: { type: 'prompt', text: `${suggestion.prompt}${suffix}` },
    })),
    notes: [],
    tips: [
      'Esc stops a turn · /undo takes its file changes back',
      'Tab switches build / plan · / lists every command',
    ],
  };
}

/** The card as plain lines, for logs and for anything that reads `msg.text`. */
export function welcomeText(welcome) {
  const lines = [welcome.headline];
  if (welcome.connectedNote) lines.push(welcome.connectedNote);
  if (welcome.choices.length) {
    lines.push(welcome.prompt);
    for (const choice of welcome.choices) lines.push(`  ${choice.key}  ${choice.label} — ${choice.detail}`);
  } else if (welcome.prompt) {
    lines.push(welcome.prompt);
  }
  lines.push(...welcome.notes, ...welcome.tips);
  return lines.join('\n');
}

/** The choice a typed line selects, or null: a bare number that is on the card. */
export function welcomeChoiceFor(text, choices = []) {
  const typed = String(text || '').trim();
  if (!/^\d$/.test(typed)) return null;
  return choices.find(choice => choice.key === typed) || null;
}
