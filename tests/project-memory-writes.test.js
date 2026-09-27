// The project journal (.ettore/ecosystem.md) goes into every session's system
// prompt, so what is written there — and how — matters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  projectMemoryDisabled,
  saveEcosystemMemory,
} from '../src/memory/index.js';

test('ETTORE_PROJECT_MEMORY=off switches project memory off, and anything else leaves it on', () => {
  for (const off of ['off', 'OFF', '0', 'false', 'no']) assert.equal(projectMemoryDisabled({ ETTORE_PROJECT_MEMORY: off }), true, off);
  for (const on of [undefined, '', 'on', '1']) assert.equal(projectMemoryDisabled({ ETTORE_PROJECT_MEMORY: on }), false, String(on));
});

test('the test suite runs with project memory off, so it cannot touch the checkout\'s .ettore/', () => {
  assert.equal(projectMemoryDisabled(), true);
});

test('concurrent writes leave one whole file, never a mix of two', async () => {
  // Two sessions on one project — or a test suite running files in parallel —
  // each rewrite the journal. With a plain writeFile their writes interleaved
  // and left entries cut mid-word.
  const root = mkdtempSync(join(tmpdir(), 'ettore-eco-'));
  try {
    const versions = Array.from({ length: 24 }, (_, i) => `## LEARNED_EXPERIENCES\n${`entry ${i} `.repeat(4000)}\n`);
    await Promise.all(versions.map(content => saveEcosystemMemory(root, content)));
    const dir = join(root, '.ettore');
    const written = readFileSync(join(dir, 'ecosystem.md'), 'utf8');
    assert.ok(versions.includes(written), 'the file is exactly one of the versions written');
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [], 'no temp file left behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a sub-agent\'s turn is never filed as an experience of the project', async () => {
  const { Agent } = await import('../src/agents/index.js');
  const previous = process.env.ETTORE_PROJECT_MEMORY;
  const root = mkdtempSync(join(tmpdir(), 'ettore-learn-'));
  process.env.ETTORE_PROJECT_MEMORY = 'on';
  try {
    const client = { async turn() { return { type: 'text', content: 'Sta in src/a.js:1.' }; } };
    const make = () => new Agent(client, {
      provider: 'test', model: 'gpt-4o', modelCapability: 'full',
      workdir: root, contextWindow: 128000, verifyAfterEdit: false,
    }, 'build');

    const sub = make();
    sub._isSubagent = true;
    await sub._learnFromTurn('You are an exploration sub-agent. QUESTION: dove?', 'Sta in src/a.js:1.');
    const journal = () => { try { return readFileSync(join(root, '.ettore', 'ecosystem.md'), 'utf8'); } catch { return ''; } };
    assert.doesNotMatch(journal(), /exploration sub-agent/, 'the brief must not become a "request" in the journal');

    // A turn that did nothing is not worth an entry (see the next test), so
    // the main agent's turn here edits a file and runs the tests, as a real
    // one would.
    const main = make();
    main.workingMemory.toolCalls = {
      'edit:1': { name: 'edit', args: { file_path: 'src/parser.js' }, count: 1 },
      'bash:2': { name: 'bash', args: { command: 'npm test' }, count: 1 },
    };
    await main._learnFromTurn('sistema il parser', 'Fatto.');
    assert.match(journal(), /sistema il parser/, 'the main agent still learns from its own turns');
    assert.match(journal(), /src\/parser\.js/, 'with the file the turn touched');
  } finally {
    if (previous === undefined) delete process.env.ETTORE_PROJECT_MEMORY;
    else process.env.ETTORE_PROJECT_MEMORY = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a turn that ran no tool and taught nothing leaves the journal alone', async () => {
  // One entry per turn is how the journal filled with noise that every later
  // session read back as experience: "Fatto." after a question is not one.
  const { Agent } = await import('../src/agents/index.js');
  const previous = process.env.ETTORE_PROJECT_MEMORY;
  const root = mkdtempSync(join(tmpdir(), 'ettore-learn-'));
  process.env.ETTORE_PROJECT_MEMORY = 'on';
  try {
    const client = { async turn() { return { type: 'text', content: 'Fatto.' }; } };
    const agent = new Agent(client, {
      provider: 'test', model: 'gpt-4o', modelCapability: 'full',
      workdir: root, contextWindow: 128000, verifyAfterEdit: false,
    }, 'build');
    await agent._learnFromTurn('che ore sono?', 'Fatto.');
    let journal = '';
    try { journal = readFileSync(join(root, '.ettore', 'ecosystem.md'), 'utf8'); } catch { /* no journal at all */ }
    assert.doesNotMatch(journal, /che ore sono/);
  } finally {
    if (previous === undefined) delete process.env.ETTORE_PROJECT_MEMORY;
    else process.env.ETTORE_PROJECT_MEMORY = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
