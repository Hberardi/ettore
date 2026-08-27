import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTurnOverlay,
  createTurnRecoveryState,
  responseAnnouncesUnexecutedAction,
  responseLooksLikeUnappliedCode,
  toolBatchNeedsSequential,
  toolBatchExecutionGroups,
  userLikelyRequestedWorkspaceEdit,
} from '../src/agents/turn-recovery.js';

test('userLikelyRequestedWorkspaceEdit detects edit intent in English and Italian', () => {
  assert.equal(userLikelyRequestedWorkspaceEdit('please edit this file'), true);
  assert.equal(userLikelyRequestedWorkspaceEdit('modifica la cli'), true);
  assert.equal(userLikelyRequestedWorkspaceEdit('just explain the architecture'), false);
});

test('responseLooksLikeUnappliedCode detects fenced snippets and code-like prose', () => {
  assert.equal(responseLooksLikeUnappliedCode('```js\nconst x = 1;\n```'), true);
  assert.equal(responseLooksLikeUnappliedCode('const x = 1;\nreturn x;\nif (x) y();'), true);
  assert.equal(responseLooksLikeUnappliedCode('Spiego soltanto cosa farei.'), false);
});

test('responseAnnouncesUnexecutedAction detects plan and action announcements', () => {
  assert.equal(responseAnnouncesUnexecutedAction('Piano: aggiorno il file domani.'), true);
  assert.equal(responseAnnouncesUnexecutedAction('Ora creo il componente padre.'), true);
  assert.equal(responseAnnouncesUnexecutedAction('Diagnostico subito.'), true);
  assert.equal(responseAnnouncesUnexecutedAction('Adesso verifico il problema.'), true);
  assert.equal(responseAnnouncesUnexecutedAction("Now I'll update the config."), true);
  assert.equal(responseAnnouncesUnexecutedAction('Questo e solo un riassunto finale.'), false);
});

test('toolBatchNeedsSequential returns true for dependent or stateful batches', () => {
  assert.equal(toolBatchNeedsSequential([{ name: 'write' }, { name: 'read' }]), true);
  assert.equal(toolBatchNeedsSequential([{ name: 'repo_map' }, { name: 'grep' }]), true);
  assert.equal(toolBatchNeedsSequential([{ name: 'bash_session' }, { name: 'read' }]), true);
  assert.equal(toolBatchNeedsSequential([{ name: 'grep' }, { name: 'file_info' }]), false);
  assert.equal(toolBatchNeedsSequential([{ name: 'read' }]), false);
});

test('toolBatchExecutionGroups preserves dependencies while widening read parallelism', () => {
  assert.deepEqual(
    toolBatchExecutionGroups([{ name: 'repo_map' }, { name: 'grep' }, { name: 'file_info' }])
      .map(group => group.map(tool => tool.name)),
    [['repo_map'], ['grep', 'file_info']],
  );
  assert.deepEqual(
    toolBatchExecutionGroups([{ name: 'write' }, { name: 'read' }])
      .map(group => group.map(tool => tool.name)),
    [['write'], ['read']],
  );
  assert.deepEqual(
    toolBatchExecutionGroups([{ name: 'grep' }, { name: 'file_info' }])
      .map(group => group.map(tool => tool.name)),
    [['grep', 'file_info']],
  );
});

test('createTurnRecoveryState returns clean defaults', () => {
  const state = createTurnRecoveryState();
  assert.deepEqual(state, {
    workspaceEditRetries: 0,
    maxWorkspaceEditRetries: 2,
    lastWorkspaceEditProgress: null,
    verifyRetryUsed: false,
    repoMapNudgeUsed: false,
    truncationResumes: 0,
    maxTruncationResumes: 3,
    invalidToolCallStreak: 0,
    maxInvalidToolCallStreak: 3,
  });
});

test('buildTurnOverlay explains a truncated reply without inviting a restart', () => {
  const overlay = buildTurnOverlay('output_truncated', { attempt: 2, max: 3 });
  assert.match(overlay, /cut off by the output token limit/i);
  assert.match(overlay, /resume 2\/3/i);
  assert.match(overlay, /do not restart/i);
});

test('buildTurnOverlay renders known overlays and returns empty string for unknown keys', () => {
  assert.match(buildTurnOverlay('workspace_edit_retry'), /did not perform it/i);
  assert.match(
    buildTurnOverlay('verify_after_edit', { touchedCount: 2, touchedList: 'a.js, b.js' }),
    /You modified 2 file\(s\) \(a\.js, b\.js\) but did not verify them\./
  );
  assert.match(
    buildTurnOverlay('auto_continue', { attempt: 1, max: 3, pendingLines: '2. B\n3. C' }),
    /auto-continue 1\/3/i
  );
  assert.match(buildTurnOverlay('repo_map_first'), /call repo_map first/i);
  assert.match(buildTurnOverlay('invalid_tool_call', { streak: 1, max: 3 }), /1\/2 warning before abort/i);
  assert.equal(buildTurnOverlay('missing_key'), '');
});
