import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTurnOverlay,
  createTurnRecoveryState,
  responseAnnouncesUnexecutedAction,
  responseDefersWork,
  extractDeferral,
  responseLooksLikeUnappliedCode,
  toolBatchNeedsSequential,
  toolBatchExecutionGroups,
  userLikelyRequestedWorkspaceEdit,
  promptFileTargets,
  unaddressedTargets,
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
    deferralRetryUsed: false,
    repoMapNudgeUsed: false,
    unaddressedTargetsRetryUsed: false,
    truncationResumes: 0,
    maxTruncationResumes: 3,
    invalidToolCallStreak: 0,
    maxInvalidToolCallStreak: 3,
  });
});

test('responseDefersWork catches work parked on a condition nothing satisfies', () => {
  // The shape that started this: the model reads "tool use is disabled for
  // this recovery turn", treats it as an outage that will pass, and promises
  // to resume. Nothing ever resumes it.
  for (const parked of [
    'Tool use ancora disabilitato — appena torna disponibile parto dallo step 1 senza ulteriori conferme.',
    'Tool use disabilitato. Riprendo appena possibile.',
    'Continuo appena i tool tornano disponibili.',
    'Attendo che i tool tornino attivi.',
    'I will resume as soon as the tools are available again.',
    'Procedo più tardi con il resto del piano.',
  ]) {
    assert.equal(responseDefersWork(parked), true, parked);
  }
});

test('responseDefersWork leaves a real answer alone', () => {
  // A finished turn that reports a limitation is not a deferral, and
  // "continuo" as ordinary prose ("continuo a vedere l'errore") must not
  // cost the user a round-trip.
  for (const delivered of [
    'Ho letto tre file e trovato il bug alla riga 42. Non ho potuto eseguire i test.',
    'Continuo a vedere lo stesso errore di parsing nel modulo doganale.',
    'Il refactor è completo: ho aggiornato quattro file e i test passano.',
    'Quando avrai deciso il nome della colonna, dimmelo.',
    'Fatto.',
    '',
  ]) {
    assert.equal(responseDefersWork(delivered), false, delivered);
  }
});

test('extractDeferral quotes the sentence that did the deferring', () => {
  const quote = extractDeferral('Ho letto il file.\nRiprendo appena i tool tornano disponibili.');
  assert.match(quote, /Riprendo appena i tool/);
  assert.ok(quote.length <= 160);
  assert.equal(extractDeferral('Fatto.'), '');
});

test('responseAnnouncesUnexecutedAction covers the resumption verbs too', () => {
  assert.equal(responseAnnouncesUnexecutedAction('Riparto dallo step 1 senza ulteriori conferme.'), true);
  assert.equal(responseAnnouncesUnexecutedAction('Riprendo dal punto in cui ero.'), true);
  assert.equal(responseAnnouncesUnexecutedAction('Proseguo con il secondo file.'), true);
  assert.equal(responseAnnouncesUnexecutedAction('Ho finito il lavoro.'), false);
});

test('tool_loop_finalize tells the model there is no later turn to wait for', () => {
  const overlay = buildTurnOverlay('tool_loop_finalize', { reason: 'the budget is exhausted' });
  assert.match(overlay, /the budget is exhausted/);
  assert.match(overlay, /not coming back/i);
  assert.match(overlay, /do not promise to resume/i);
  // The old wording ("tool use is now disabled") is what invited the deferral.
  assert.doesNotMatch(overlay, /tool use is now disabled/i);
});

test('deliver_now quotes the deferral and asks for the answer instead', () => {
  const overlay = buildTurnOverlay('deliver_now', { quote: 'parto dallo step 1' });
  assert.match(overlay, /parto dallo step 1/);
  assert.match(overlay, /nothing resumes on its own/i);
  assert.ok(buildTurnOverlay('deliver_now', {}).length > 0, 'renders without a quote');
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

// ── The completion gate: files named in the prompt that the turn never read ──

test('promptFileTargets picks out real paths and leaves runtime names alone', () => {
  assert.deepEqual(
    promptFileTargets('aggiorna navbar.html e src/components/footer.html'),
    ['navbar.html', 'src/components/footer.html'],
  );
  // A version string and a sentence-ending abbreviation are not files.
  assert.deepEqual(promptFileTargets('siamo alla 1.4.4, aggiorna il parser ecc.'), []);
  // The runtime is not a file in the repository.
  assert.deepEqual(promptFileTargets('un progetto Node.js con Vue.js'), []);
  assert.deepEqual(promptFileTargets(''), []);
});

test('promptFileTargets stops at six so a bulk request is not chased file by file', () => {
  const prompt = Array.from({ length: 12 }, (_, i) => `f${i}.js`).join(' ');
  assert.equal(promptFileTargets(prompt).length, 6);
});

test('unaddressedTargets reports only what no tool call went near', () => {
  const prompt = 'aggiorna navbar.html e footer.html';
  const args = '{"file_path":"templates/components/navbar.html"}';
  assert.deepEqual(unaddressedTargets(prompt, args), ['footer.html']);

  // A grep that merely mentions the file counts as going near it.
  assert.deepEqual(
    unaddressedTargets(prompt, `${args} {"pattern":"footer.html"}`),
    [],
  );
  // No tool ran at all: everything the prompt named is unaddressed.
  assert.deepEqual(unaddressedTargets(prompt, ''), ['navbar.html', 'footer.html']);
});

test('the overlay names the files the turn skipped', () => {
  const text = buildTurnOverlay('unaddressed_targets', { targetList: '`footer.html`' });
  assert.match(text, /footer\.html/);
  assert.match(text, /has not been done/i);
});
