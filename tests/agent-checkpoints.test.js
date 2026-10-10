import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agents/index.js';
import { checkpoints } from '../src/agents/checkpoints.js';
import { builtinCommands } from '../src/commands/index.js';
import { killBashSession } from '../src/tools/bash-session.js';

const posixOnly = { skip: process.platform === 'win32' };

after(() => { checkpoints.clear(); killBashSession(); });

function toolCall(id, name, args) {
  const tc = { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  return { type: 'tool_calls', tool_calls: [tc], message: { role: 'assistant', content: '', tool_calls: [tc] } };
}

async function repoWith(files) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ettore-agent-checkpoint-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

// A scripted model: one tool call per step, then a closing sentence.
function scriptedAgent(dir, steps) {
  let turn = 0;
  return new Agent({
    async turn() {
      const step = steps[turn++];
      return step || { type: 'text', content: 'Done.' };
    },
  }, {
    provider: 'test', model: 'gpt-4o', modelCapability: 'full',
    workdir: dir, contextWindow: 128000, verifyAfterEdit: false,
  }, 'build');
}

test('a turn that writes a file and edits another through the shell is undone by /undo', posixOnly, async () => {
  const dir = await repoWith({ 'notes.txt': 'one\ntwo\n' });
  try {
    const created = join(dir, 'created.txt');
    const agent = scriptedAgent(dir, [
      toolCall('w1', 'write', { file_path: created, content: 'made by the agent\n' }),
      toolCall('b1', 'bash', { command: "sed -i 's/two/TWO/' notes.txt && echo three >> notes.txt", workdir: dir }),
    ]);

    checkpoints.begin('change the notes');
    await agent.run('change the notes', new EventEmitter());
    assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'one\nTWO\nthree\n');
    assert.deepEqual((await checkpoints.changes()).map(c => [c.path, c.status, c.added, c.removed]), [
      [created, 'added', 1, 0],
      [join(dir, 'notes.txt'), 'modified', 2, 1],
    ]);

    const messagesBefore = agent.messages.length;
    const out = await builtinCommands.undo.handler([], { agent, isRunning: () => false });
    assert.match(out, /✓ Undone "change the notes": 2 files/);
    assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'one\ntwo\n');
    assert.equal(existsSync(created), false);

    // The model is told, or it would build on edits that are gone.
    assert.equal(agent.messages.length, messagesBefore + 1);
    const note = agent.messages[agent.messages.length - 1];
    assert.equal(note.role, 'user');
    assert.match(note.content, /\/undo/);
    assert.match(note.content, /notes\.txt/);

    const redone = await builtinCommands.redo.handler([], { agent, isRunning: () => false });
    assert.match(redone, /✓ Redone "change the notes": 2 files/);
    assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'one\nTWO\nthree\n');
    assert.equal(await readFile(created, 'utf8'), 'made by the agent\n');
  } finally {
    checkpoints.clear();
    await rm(dir, { recursive: true, force: true });
  }
});

test('/undo refuses while a turn is running and says so when there is nothing to undo', async () => {
  checkpoints.clear();
  assert.match(await builtinCommands.undo.handler([], { isRunning: () => true }), /A turn is running/);
  assert.match(await builtinCommands.undo.handler([], { isRunning: () => false }), /Nothing to undo/);
  assert.match(await builtinCommands.undo.handler(['list'], {}), /Nothing to undo/);
  assert.match(await builtinCommands.redo.handler([], { isRunning: () => false }), /Nothing to redo/);
  assert.match(await builtinCommands.undo.handler(['sideways'], {}), /Usage/);
});

test('a turn run with no request open records nothing — one-shot mode has no /undo', posixOnly, async () => {
  const dir = await repoWith({ 'notes.txt': 'one\n' });
  try {
    checkpoints.clear();
    const agent = scriptedAgent(dir, [
      toolCall('w1', 'write', { file_path: join(dir, 'created.txt'), content: 'x\n' }),
    ]);
    await agent.run('make a file', new EventEmitter());
    assert.equal(existsSync(join(dir, 'created.txt')), true);
    assert.deepEqual(checkpoints.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
