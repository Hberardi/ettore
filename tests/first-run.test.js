import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWelcome, detectLocalOptions, localeCode, localeLanguage, projectFacts, projectSuggestions,
  welcomeChoiceFor, welcomeText,
} from '../src/app/first-run.js';
import { TUI } from '../src/app/tui-native.js';
import { stripAllAnsi } from '../src/utils/ansi.js';
import { builtinCommands } from '../src/commands/index.js';

const ollamaUp = models => async () => ({ ok: true, json: async () => ({ models: models.map(name => ({ name })) }) });
const nothingListening = async () => { throw new Error('ECONNREFUSED'); };

test('a running Ollama and an installed claude CLI are both found', async () => {
  const found = await detectLocalOptions({
    fetchFn: ollamaUp(['qwen2.5-coder:32b', 'llama3.1:8b']),
    findOnPathFn: name => (name === 'claude' ? '/usr/bin/claude' : name === 'ollama' ? '/usr/bin/ollama' : null),
  });
  assert.deepEqual(found, {
    ollama: { installed: true, running: true, models: ['qwen2.5-coder:32b', 'llama3.1:8b'] },
    claudeCli: true,
  });
});

test('a machine with neither says so without throwing', async () => {
  const found = await detectLocalOptions({ fetchFn: nothingListening, findOnPathFn: () => null });
  assert.deepEqual(found, { ollama: { installed: false, running: false, models: [] }, claudeCli: false });
});

test('with no model the card offers what works on this machine, numbered', () => {
  const welcome = buildWelcome({
    connected: null,
    local: { ollama: { installed: true, running: true, models: ['a:7b', 'b:7b'] }, claudeCli: true },
    firstRun: true,
    providerCount: 32,
  });
  assert.deepEqual(welcome.choices.map(c => [c.key, c.action]), [
    ['1', { type: 'connect', provider: 'ollama' }],
    ['2', { type: 'connect', provider: 'claude-code' }],
    ['3', { type: 'pickProvider' }],
  ]);
  const text = welcomeText(welcome);
  assert.match(text, /Welcome\. ETTORE needs a model/);
  assert.match(text, /2 models, no API key \(a:7b, …\)/);
  assert.match(text, /and 28 more/);
});

test('with nothing local there is still one way in, and a stopped Ollama gets a hint', () => {
  const bare = buildWelcome({ connected: null, local: { ollama: { installed: false, running: false, models: [] }, claudeCli: false } });
  assert.deepEqual(bare.choices.map(c => c.action.type), ['pickProvider']);
  assert.match(bare.headline, /No model connected/);

  const stopped = buildWelcome({ connected: null, local: { ollama: { installed: true, running: false, models: [] }, claudeCli: false } });
  assert.deepEqual(stopped.choices.map(c => c.action.type), ['pickProvider']);
  assert.ok(stopped.notes.some(note => /installed but not running/.test(note)));

  const empty = buildWelcome({ connected: null, local: { ollama: { installed: true, running: true, models: [] }, claudeCli: false } });
  assert.ok(empty.notes.some(note => /ollama pull/.test(note)));
});

test('the suggestions follow what the folder actually holds', () => {
  const labels = facts => projectSuggestions(facts).map(s => s.label);
  assert.deepEqual(labels({ name: 'p', empty: true, dirty: null, testRunner: null, hasReadme: false }), ['Start a new project here']);
  assert.deepEqual(
    labels({ name: 'p', empty: false, dirty: 4, testRunner: 'npm', hasReadme: false }),
    ['Explain this project', 'Review my 4 uncommitted changes', 'Run the tests and fix what fails'],
  );
  assert.deepEqual(
    labels({ name: 'p', empty: false, dirty: 0, testRunner: null, hasReadme: false }),
    ['Explain this project', 'Write a README', 'Find one thing worth fixing'],
  );
  assert.deepEqual(
    labels({ name: 'p', empty: false, dirty: 1, testRunner: null, hasReadme: true }),
    ['Explain this project', 'Review my 1 uncommitted change', 'Find one thing worth fixing'],
  );
});

test('projectFacts reads a real folder: git state, tests, README', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-first-run-'));
  try {
    assert.deepEqual(await projectFacts(dir), {
      name: dir.split('/').pop(), empty: true, dirty: null, testRunner: null, hasReadme: false,
    });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await mkdir(join(dir, '.ettore'));
    await writeFile(join(dir, '.ettore', 'memory.md'), '# memory\n');
    assert.equal((await projectFacts(dir)).empty, true, "ETTORE's own folder is not the project");
    assert.equal((await projectFacts(dir)).dirty, 0, 'nor one of its uncommitted changes');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    await writeFile(join(dir, 'README.md'), '# p\n');
    await writeFile(join(dir, 'index.js'), '');
    const facts = await projectFacts(dir);
    assert.equal(facts.empty, false);
    assert.equal(facts.testRunner, 'npm');
    assert.equal(facts.hasReadme, true);
    assert.equal(facts.dirty, 3, 'the three new files, all untracked');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('with a model the card says which, where the key came from, and what to ask', () => {
  const welcome = buildWelcome({
    connected: { provider: 'google', name: 'Google Gemini', model: 'models/gemini-2.0-flash', envVar: 'GOOGLE_API_KEY' },
    facts: { name: 'shop', empty: false, dirty: 2, testRunner: 'pytest', hasReadme: true },
    firstRun: true,
    language: 'Italian',
  });
  const text = welcomeText(welcome);
  assert.match(text, /^Connected: Google Gemini · models\/gemini-2\.0-flash/);
  assert.match(text, /key from GOOGLE_API_KEY · \/select changes the model/);
  assert.match(text, /start with one of these in shop/);
  assert.match(text, / {2}3 {2}Run the tests and fix what fails — pytest/);
  assert.equal(welcome.choices.length, 3);
  for (const choice of welcome.choices) {
    assert.equal(choice.action.type, 'prompt');
    assert.match(choice.action.text, / Answer in Italian\.$/);
  }
  // English system: the prompt is sent as written.
  const english = buildWelcome({ connected: welcome.connected, facts: { name: 'shop', empty: true, dirty: null, testRunner: null, hasReadme: false } });
  assert.doesNotMatch(english.choices[0].action.text, /Answer in/);
});

test('only a bare number that is on the card picks a choice', () => {
  const choices = [{ key: '1', label: 'a' }, { key: '2', label: 'b' }];
  assert.equal(welcomeChoiceFor('2', choices).label, 'b');
  assert.equal(welcomeChoiceFor(' 1 ', choices).label, 'a');
  assert.equal(welcomeChoiceFor('3', choices), null);
  assert.equal(welcomeChoiceFor('1 please', choices), null);
  assert.equal(welcomeChoiceFor('12', choices), null);
  assert.equal(welcomeChoiceFor('', choices), null);
  assert.equal(welcomeChoiceFor('1', []), null);
});

test('the system language is read from the locale, and only when there are prompts for it', () => {
  assert.equal(localeCode({ LANG: 'it_IT.UTF-8' }), 'it');
  assert.equal(localeLanguage({ LANG: 'it_IT.UTF-8' }), 'Italian');
  assert.equal(localeLanguage({ LC_ALL: 'de_DE', LANG: 'it_IT' }), 'German');
  assert.equal(localeCode({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(localeLanguage({ LANG: 'en_US.UTF-8' }), null);
  assert.equal(localeCode({ LANG: 'ja_JP.UTF-8' }), 'en');
  assert.equal(localeCode({}), 'en');
});

test('both cards fit the width they are given', () => {
  const tui = new TUI();
  const cards = [
    buildWelcome({
      connected: null,
      local: { ollama: { installed: true, running: true, models: ['a-model-with-quite-a-long-name:480b-cloud', 'b'] }, claudeCli: true },
      firstRun: true,
      providerCount: 32,
    }),
    buildWelcome({
      connected: { provider: 'openai-compat', name: 'OpenAI Compatible', model: 'some-org/a-very-long-model-identifier-v3.5-instruct', envVar: null },
      facts: { name: 'a-project-with-a-long-directory-name', empty: false, dirty: 12, testRunner: 'cargo', hasReadme: false },
    }),
  ];
  for (const welcome of cards) {
    for (const width of [44, 60, 90, 140]) {
      const lines = tui._renderMessageFull({ role: 'system', kind: 'welcome', welcome, text: welcomeText(welcome) }, width);
      for (const line of lines) {
        assert.ok(tui._visualLen(line) <= width, `width ${width}: "${stripAllAnsi(line)}" is ${tui._visualLen(line)} wide`);
      }
      const plain = lines.map(stripAllAnsi).join('\n');
      for (const choice of welcome.choices) assert.ok(plain.includes(` ${choice.key}  `), `choice ${choice.key} is shown at width ${width}`);
    }
  }
});

test('/welcome asks the TUI to show the card', async () => {
  assert.deepEqual(await builtinCommands.welcome.handler([], {}), { action: 'welcome' });
});
