import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoResumeDecision,
  modelDeclaredCompletion,
  turnSignature,
  DEFAULT_MAX_AUTO_RESUMES,
} from '../src/app/auto-resume.js';

test('mid-task "fatto" does not read as completion', () => {
  const midTask = [
    'Fatto. Ora passo al file successivo: aggiorno tests/foo.test.js',
    'Ho fatto un backup prima di procedere, continuo con la migrazione',
    'Ho completato il refactor, ora aggiorno i test',
    'Il primo step è completato, mancano ancora 3 file',
  ];
  for (const text of midTask) {
    assert.equal(modelDeclaredCompletion(text), false, text);
  }
});

test('conclusive phrasing reads as completion', () => {
  const done = [
    'task completo',
    'Ho aggiornato i tre file e i test passano.\n\nTask completo.',
    'Fatto.',
    'Lavoro completato: la suite è verde.',
    'All done.',
  ];
  for (const text of done) {
    assert.equal(modelDeclaredCompletion(text), true, text);
  }
});

test('completion is judged on the closing lines, not the whole answer', () => {
  const text = 'Ho finito di leggere il file di config.\nOra manca ancora il collegamento nella TUI.';
  assert.equal(modelDeclaredCompletion(text), false);
});

test('resumes after tool work that stopped short of a conclusion', () => {
  const d = autoResumeDecision({ text: 'Ho letto i tre file coinvolti.', toolCount: 3 });
  assert.equal(d.resume, true);
  assert.equal(d.reason, 'tool_activity');
});

test('resumes on pending todos even without tool activity', () => {
  const d = autoResumeDecision({ text: 'Riepilogo del piano.', toolCount: 0, pendingTodos: 2 });
  assert.equal(d.resume, true);
  assert.equal(d.reason, 'pending_todos');
});

test('resumes on an announced-but-unexecuted action with no tools', () => {
  const d = autoResumeDecision({ text: 'Prossimo passo: modifico src/app.js', toolCount: 0 });
  assert.equal(d.resume, true);
});

test('resumes when the model names work still left to do', () => {
  const d = autoResumeDecision({ text: 'Una volta sistemato questo, resta da aggiornare il README', toolCount: 0 });
  assert.equal(d.resume, true);
  assert.equal(d.reason, 'declared_pending_work');
});

test('a plain answer with nothing pending ends the turn', () => {
  const d = autoResumeDecision({ text: 'Il file si trova in src/app/native-ui.js.', toolCount: 0 });
  assert.equal(d.resume, false);
  assert.equal(d.reason, 'nothing_pending');
});

test('declared completion stops the run even after tool work', () => {
  const d = autoResumeDecision({ text: 'Ho applicato le modifiche.\nTask completo.', toolCount: 5 });
  assert.equal(d.resume, false);
  assert.equal(d.reason, 'model_done');
});

test('an identical toolless turn is not resumed twice', () => {
  const text = 'Prossimo passo: modifico src/app.js';
  const first = autoResumeDecision({ text, toolCount: 0 });
  assert.equal(first.resume, true);

  const second = autoResumeDecision({ text, toolCount: 0, attempts: 1, lastSignature: first.signature });
  assert.equal(second.resume, false);
  assert.equal(second.reason, 'repeated_without_progress');
});

test('a repeated message still resumes when the turn ran tools', () => {
  const text = 'Prossimo passo: modifico src/app.js';
  const sig = turnSignature({ text, toolCount: 0, pendingTodos: 0 });
  const d = autoResumeDecision({ text, toolCount: 2, attempts: 1, lastSignature: sig });
  assert.equal(d.resume, true);
});

test('the budget bounds the number of resumes', () => {
  const d = autoResumeDecision({
    text: 'Prossimo passo: modifico src/app.js',
    toolCount: 1,
    attempts: 4,
    maxAttempts: 4,
  });
  assert.equal(d.resume, false);
  assert.equal(d.reason, 'budget_exhausted');
  assert.match(d.why, /4/);
});

test('the default budget is well above the old hardcoded 10', () => {
  assert.ok(DEFAULT_MAX_AUTO_RESUMES > 10);
});

test('plan mode does not resume a finished analysis', () => {
  const d = autoResumeDecision({
    text: 'Ecco la struttura del modulo e le modifiche che servirebbero.',
    toolCount: 6,
    pendingTodos: 3,
    mode: 'plan',
  });
  assert.equal(d.resume, false);
  assert.equal(d.reason, 'plan_mode_complete');
});

test('plan mode still resumes when the model left its own analysis open', () => {
  const d = autoResumeDecision({
    text: 'Ora leggo src/agents/index.js per completare la mappa.',
    toolCount: 2,
    mode: 'plan',
  });
  assert.equal(d.resume, true);
});
