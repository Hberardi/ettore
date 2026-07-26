import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setAutoApprove, getAutoApprove, isEditAlwaysApproved, clearEditSessionApproval } from '../src/tools/index.js';
import { builtinCommands } from '../src/commands/index.js';

test('setAutoApprove flips edits and installs independently', () => {
  clearEditSessionApproval();
  setAutoApprove({ edits: false, installs: false });
  assert.deepEqual(getAutoApprove(), { edits: false, installs: false });

  setAutoApprove({ edits: true });
  assert.deepEqual(getAutoApprove(), { edits: true, installs: false });
  assert.equal(isEditAlwaysApproved(), true);

  setAutoApprove({ installs: true });
  assert.deepEqual(getAutoApprove(), { edits: true, installs: true });

  setAutoApprove({ edits: false, installs: false });
  assert.deepEqual(getAutoApprove(), { edits: false, installs: false });
  assert.equal(isEditAlwaysApproved(), false);
});

test('/auto-approve on flips both flags, off clears them', async () => {
  setAutoApprove({ edits: false, installs: false });
  const cmd = builtinCommands['auto-approve'];

  const after = await cmd.handler(['on']);
  assert.match(String(after), /edits: on/);
  assert.match(String(after), /installs: on/);
  assert.deepEqual(getAutoApprove(), { edits: true, installs: true });

  const back = await cmd.handler(['off']);
  assert.match(String(back), /edits: off/);
  assert.match(String(back), /installs: off/);
  assert.deepEqual(getAutoApprove(), { edits: false, installs: false });
});

test('/auto-approve edits on only flips edits', async () => {
  setAutoApprove({ edits: false, installs: false });
  const cmd = builtinCommands['auto-approve'];
  await cmd.handler(['edits', 'on']);
  assert.deepEqual(getAutoApprove(), { edits: true, installs: false });
  setAutoApprove({ edits: false, installs: false });
});

test('/auto-approve with no args shows current status', async () => {
  setAutoApprove({ edits: true, installs: false });
  const cmd = builtinCommands['auto-approve'];
  const out = await cmd.handler([]);
  assert.match(String(out), /edits: on/);
  assert.match(String(out), /installs: off/);
  setAutoApprove({ edits: false, installs: false });
});

test('/auto-approve with invalid arg returns usage hint', async () => {
  const cmd = builtinCommands['auto-approve'];
  const out = await cmd.handler(['maybe']);
  assert.match(String(out), /Usage:/);
});
