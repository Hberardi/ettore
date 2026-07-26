import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorizePath,
  authorizeToolAccess,
  clearWorkspaceApprovals,
  normalizeToolArgsForWorkspace,
  setWorkspacePolicy,
} from '../src/tools/workspace-policy.js';

afterEach(() => {
  setWorkspacePolicy(null);
  clearWorkspaceApprovals();
});

test('safe workspace policy permits paths inside root and blocks outside paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ettore-policy-'));
  const outside = await mkdtemp(join(tmpdir(), 'ettore-outside-'));
  try {
    setWorkspacePolicy({ root, profile: 'safe' });
    assert.equal((await authorizePath(join(root, 'new.txt'), 'write')).allowed, true);
    const denied = await authorizePath(join(outside, 'secret.txt'), 'read');
    assert.equal(denied.allowed, false);
    assert.match(denied.error, /safe workspace policy/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('safe workspace policy resolves symlinks before authorizing access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ettore-policy-'));
  const outside = await mkdtemp(join(tmpdir(), 'ettore-outside-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await mkdir(join(root, 'links'));
    await symlink(join(outside, 'secret.txt'), join(root, 'links', 'secret.txt'));
    setWorkspacePolicy({ root, profile: 'safe' });
    const denied = await authorizePath(join(root, 'links', 'secret.txt'), 'read');
    assert.equal(denied.allowed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('autonomous profile allows external reads but not unattended writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ettore-policy-'));
  const outside = await mkdtemp(join(tmpdir(), 'ettore-outside-'));
  try {
    setWorkspacePolicy({ root, profile: 'autonomous' });
    assert.equal((await authorizePath(join(outside, 'read.txt'), 'read')).allowed, true);
    assert.equal((await authorizePath(join(outside, 'write.txt'), 'write')).allowed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('authorizeToolAccess applies write policy to mutation tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ettore-policy-'));
  const outside = await mkdtemp(join(tmpdir(), 'ettore-outside-'));
  try {
    setWorkspacePolicy({ root, profile: 'safe' });
    const denied = await authorizeToolAccess('edit', {
      file_path: join(outside, 'x.txt'),
      old_string: 'a',
      new_string: 'b',
    });
    assert.equal(denied.allowed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('safe workspace policy blocks arbitrary shell tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ettore-policy-'));
  try {
    setWorkspacePolicy({ root, profile: 'safe' });
    const denied = await authorizeToolAccess('bash', { command: 'cat /etc/passwd' });
    assert.equal(denied.allowed, false);
    assert.match(denied.error, /arbitrary shell execution/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit policies stay isolated from the global compatibility policy', async () => {
  const globalRoot = await mkdtemp(join(tmpdir(), 'ettore-policy-global-'));
  const runRoot = await mkdtemp(join(tmpdir(), 'ettore-policy-run-'));
  try {
    setWorkspacePolicy({ root: globalRoot, profile: 'safe' });
    const allowed = await authorizeToolAccess(
      'write',
      { file_path: join(runRoot, 'x.txt'), content: 'x' },
      { root: runRoot, profile: 'safe' },
    );
    assert.equal(allowed.allowed, true);
  } finally {
    await rm(globalRoot, { recursive: true, force: true });
    await rm(runRoot, { recursive: true, force: true });
  }
});

test('relative tool paths and default workdirs resolve against the run workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ettore-policy-'));
  try {
    const writeArgs = normalizeToolArgsForWorkspace(
      'write',
      { file_path: 'src/new.js', content: '' },
      { root, profile: 'balanced' },
    );
    assert.equal(writeArgs.file_path, join(root, 'src/new.js'));

    const checkArgs = normalizeToolArgsForWorkspace(
      'run_checks',
      { profile: 'quick' },
      { root, profile: 'balanced' },
    );
    assert.equal(checkArgs.workdir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
