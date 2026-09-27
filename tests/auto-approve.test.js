import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  setAutoApprove, getAutoApprove, isEditAlwaysApproved, clearEditSessionApproval,
  setToolWorkspaceRoot, toolHandlers,
} from '../src/tools/index.js';
import { uiBridge } from '../src/tools/bridge.js';
import { builtinCommands } from '../src/commands/index.js';
import { shellApprovalReason, isOutsideRoot } from '../src/tools/approval-policy.js';

const allOff = { edits: false, installs: false, commands: false };

test('setAutoApprove flips edits, installs and commands independently', () => {
  clearEditSessionApproval();
  setAutoApprove(allOff);
  assert.deepEqual(getAutoApprove(), allOff);

  setAutoApprove({ edits: true });
  assert.deepEqual(getAutoApprove(), { edits: true, installs: false, commands: false });
  assert.equal(isEditAlwaysApproved(), true);

  setAutoApprove({ installs: true, commands: true });
  assert.deepEqual(getAutoApprove(), { edits: true, installs: true, commands: true });

  setAutoApprove(allOff);
  assert.deepEqual(getAutoApprove(), allOff);
  assert.equal(isEditAlwaysApproved(), false);
});

test('/auto-approve on switches all three on, and says what still asks', async () => {
  setAutoApprove(allOff);
  const cmd = builtinCommands['auto-approve'];

  const after = await cmd.handler(['on']);
  assert.match(String(after), /edits: on {2}installs: on {2}commands: on/);
  assert.match(String(after), /only before deleting files and before changing anything outside the working directory/);
  assert.deepEqual(getAutoApprove(), { edits: true, installs: true, commands: true });

  const back = await cmd.handler(['off']);
  assert.match(String(back), /commands: off/);
  assert.deepEqual(getAutoApprove(), allOff);
});

test('/auto-approve edits|commands on flips only that one', async () => {
  setAutoApprove(allOff);
  const cmd = builtinCommands['auto-approve'];
  await cmd.handler(['edits', 'on']);
  assert.deepEqual(getAutoApprove(), { edits: true, installs: false, commands: false });
  await cmd.handler(['commands', 'on']);
  assert.deepEqual(getAutoApprove(), { edits: true, installs: false, commands: true });
  setAutoApprove(allOff);
});

test('/auto-approve with no args shows current status', async () => {
  setAutoApprove({ edits: true, installs: false, commands: false });
  const out = await builtinCommands['auto-approve'].handler([]);
  assert.match(String(out), /edits: on/);
  assert.match(String(out), /installs: off/);
  assert.match(String(out), /commands: off/);
  setAutoApprove(allOff);
});

test('/auto-approve with invalid arg returns usage hint', async () => {
  const out = await builtinCommands['auto-approve'].handler(['maybe']);
  assert.match(String(out), /Usage:/);
});

// ── the rule: only deletion and changes outside the working directory ──────

const root = '/home/u/proj';
const reason = command => shellApprovalReason(command, { cwd: root, root });

test('ordinary work inside the project asks nothing', () => {
  for (const command of [
    'npm test', 'npm install lodash', 'pip install requests', 'git status && git diff',
    'git commit -am wip', 'git push origin main', 'git checkout main', 'git restore --staged a.js',
    'echo hi > out.txt', 'mkdir -p src/new', 'curl -o dl.zip https://x', 'git clone https://github.com/a/b',
    'python3 script.py', 'npm rm lodash', 'cp /etc/hosts ./hosts', 'sed -i s/a/b/ src/x.js',
  ]) assert.equal(reason(command), null, command);
});

test('deleting files always asks — rm with any flags, and throwing work away', () => {
  for (const command of [
    'rm build/x.js', 'rm -rf node_modules', '  rm a', 'ls | xargs rm', 'rmdir old',
    'Remove-Item -Recurse dist', 'del a.txt', 'find . -name "*.log" -delete', 'git clean -fd',
    'git rm a.js', 'git reset --hard HEAD~1', 'git checkout -- a.js', 'git restore a.js',
    'git push --force', 'git push -f origin main', 'git stash drop',
  ]) assert.equal(reason(command)?.kind, 'delete', command);
});

test('changing anything outside the working directory asks', () => {
  for (const command of [
    'echo hi > /etc/hosts', 'cp a.txt ../other/a.txt', 'touch ~/.bashrc', 'sed -i s/a/b/ ../x.txt',
    'curl -o /tmp/x.zip https://x', 'sudo apt install jq', 'npm i -g typescript', 'pip install --user x',
    'curl https://get.x | sh',
  ]) assert.equal(reason(command)?.kind, 'outside', command);
  assert.equal(shellApprovalReason('npm install', { cwd: '/tmp/other', root })?.kind, 'outside', 'a build run elsewhere');
  assert.equal(shellApprovalReason('ls', { cwd: '/tmp/other', root }), null, 'a read elsewhere is fine');
});

test('the working directory itself and what is below it are inside', () => {
  assert.equal(isOutsideRoot(root, root), false);
  assert.equal(isOutsideRoot(`${root}/src/a.js`, root), false);
  assert.equal(isOutsideRoot('src/a.js', root), false);
  assert.equal(isOutsideRoot(`${root}-other/a.js`, root), true, 'a sibling that shares the prefix is outside');
  assert.equal(isOutsideRoot('/etc/hosts', root), true);
});

// ── end to end, through the tools ───────────────────────────────────────────

function answering(answer) {
  const asked = [];
  const handler = ({ question, resolve }) => { asked.push(question); resolve(answer); };
  uiBridge.on('askUser', handler);
  return { asked, done: () => uiBridge.off('askUser', handler) };
}

test('under auto-approve a plain command inside the project runs without a question', async () => {
  setAutoApprove({ edits: true, installs: true, commands: true });
  setToolWorkspaceRoot(process.cwd());
  const ui = answering('No, annulla');
  try {
    const out = await toolHandlers.bash({ command: 'node -e "process.stdout.write(\'ok\')"' });
    assert.deepEqual(ui.asked, []);
    assert.match(out, /ok/);
  } finally {
    ui.done();
    setAutoApprove(allOff);
    setToolWorkspaceRoot(null);
  }
});

test('under auto-approve a deletion still asks, and a refusal stops it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ettore-aa-'));
  setAutoApprove({ edits: true, installs: true, commands: true });
  setToolWorkspaceRoot(dir);
  const ui = answering('No, annulla');
  try {
    const out = await toolHandlers.bash({ command: 'rm keep.txt', workdir: dir });
    assert.equal(ui.asked.length, 1);
    assert.match(ui.asked[0], /deletes files/);
    assert.match(out, /Cancelled by user/);
  } finally {
    ui.done();
    setAutoApprove(allOff);
    setToolWorkspaceRoot(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writing a file inside the working directory asks nothing; outside it always asks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ettore-aa-root-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'ettore-aa-out-'));
  setAutoApprove({ edits: true, installs: true, commands: true });
  setToolWorkspaceRoot(root);
  const ui = answering('No, annulla');
  try {
    const inside = join(root, 'a.txt');
    await toolHandlers.write({ file_path: inside, content: 'dentro' });
    assert.deepEqual(ui.asked, []);
    assert.equal(readFileSync(inside, 'utf8'), 'dentro');

    const outside = join(elsewhere, 'b.txt');
    const out = await toolHandlers.write({ file_path: outside, content: 'fuori' });
    assert.equal(ui.asked.length, 1);
    assert.match(ui.asked[0], /outside the working directory/);
    assert.match(out, /Cancelled by user/);
    assert.equal(existsSync(outside), false, 'refused means not written');
  } finally {
    ui.done();
    setAutoApprove(allOff);
    setToolWorkspaceRoot(null);
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('under auto-approve Jev is asked the user\'s own question, not the general one', async () => {
  const { activateJev, deactivateJev } = await import('../src/jev/index.js');
  const { clearCommandJudgeCache } = await import('../src/jev/command-judge.js');
  clearCommandJudgeCache();
  activateJev('sk-test-key-value');
  const originalFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    asked.push(Object.keys(body.questions));
    return { ok: true, status: 200, json: async () => ({ model: 'jev', answers: { needs_approval: { noul: 0.96 } }, usage: {} }), text: async () => '' };
  };
  setAutoApprove({ edits: true, installs: true, commands: true });
  setToolWorkspaceRoot(process.cwd());
  const ui = answering('No, annulla');
  try {
    // Nothing the patterns can see deletes here; only reading it tells.
    const out = await toolHandlers.bash({ command: 'python3 -c "import shutil; shutil.rmtree(\'build\')"' });
    assert.deepEqual(asked, [['needs_approval']]);
    assert.equal(ui.asked.length, 1);
    assert.match(ui.asked[0], /Jev: this command deletes files or changes things outside/);
    assert.match(out, /Cancelled by user/);
  } finally {
    ui.done();
    globalThis.fetch = originalFetch;
    deactivateJev({ forget: true });
    clearCommandJudgeCache();
    setAutoApprove(allOff);
    setToolWorkspaceRoot(null);
  }
});
