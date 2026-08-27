// Auto-resume policy: decides whether a finished turn should silently roll
// into another one instead of handing control back to the user.
//
// The TUI used to inline this decision, with two flaws that made the CLI stop
// mid-task and wait for a manual "continua":
//   1. The completion check matched a bare "fatto" / "completato" anywhere in
//      the response, so "Fatto. Ora passo al file successivo" read as "the
//      model is done" and killed the resume.
//   2. A text-only turn (no tools, no todo plan) never resumed, even when the
//      model had just announced the next action it failed to perform.
// Both are fixed here, with a repeat guard so a model that keeps emitting the
// same words without touching anything still stops instead of looping.

import {
  modelDeclaredCompletion,
  responseAnnouncesUnexecutedAction,
  tailOf,
} from '../agents/turn-recovery.js';

// Re-exported so the TUI and its tests keep a single import site for the
// policy, even though the predicate itself now lives with the agent loop that
// also needs it.
export { modelDeclaredCompletion };

export const DEFAULT_MAX_AUTO_RESUMES = 25;

// Work the model itself says is still open. Unlike CONTINUATION_MARKERS this
// set is narrow enough to *trigger* a resume on its own: a turn that ends on
// "mancano 3 file" or "resta da aggiornare il README" is unfinished even when
// it ran no tool and declared no todo plan.
const UNFINISHED_WORK = new RegExp(
  '\\b(?:'
  + 'manca(?:no)?|rest(?:a|ano)\\s+da|riman[ge](?:ono)?|da\\s+fare|'
  + 'ancora\\s+(?:da|apert[oi]|apert[ae])|non\\s+ho\\s+ancora|'
  + 'prossim[oi]\\s+(?:pass[oi]|step)|next\\s+steps?'
  + ')\\b',
  'i',
);

// Stable fingerprint of a finished turn. Two turns sharing it produced the
// same words, ran the same number of tools and left the same steps open.
export function turnSignature({ text = '', toolCount = 0, pendingTodos = 0 } = {}) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return `${pendingTodos}:${toolCount}:${normalized}`;
}

/**
 * @returns {{ resume: boolean, reason: string, why: string, signature: string }}
 *   `reason` is a stable machine tag; `why` is the Italian sentence the TUI
 *   shows, so the user always learns why the run kept going — or stopped.
 */
export function autoResumeDecision({
  text = '',
  toolCount = 0,
  pendingTodos = 0,
  attempts = 0,
  maxAttempts = DEFAULT_MAX_AUTO_RESUMES,
  lastSignature = null,
  mode = 'build',
} = {}) {
  const signature = turnSignature({ text, toolCount, pendingTodos });
  const stop = (reason, why) => ({ resume: false, reason, why, signature });

  if (attempts >= maxAttempts) {
    return stop('budget_exhausted', `auto-resume esaurito (${maxAttempts} riprese in questo turno)`);
  }
  if (modelDeclaredCompletion(text)) {
    return stop('model_done', 'il modello ha dichiarato il lavoro completo');
  }

  const tail = tailOf(text, 2);
  const announced = responseAnnouncesUnexecutedAction(text);
  const declaredPending = UNFINISHED_WORK.test(tail);
  if (pendingTodos <= 0 && toolCount <= 0 && !announced && !declaredPending) {
    return stop('nothing_pending', 'nessun passo aperto e nessuna attività da riprendere');
  }
  // The model repeated itself word for word without running a single tool.
  // Another resume would produce the same sentence a third time.
  if (lastSignature && lastSignature === signature && toolCount <= 0) {
    return stop('repeated_without_progress', 'il modello ha ripetuto la stessa risposta senza eseguire nulla');
  }

  // Plan mode is read-only analysis: the plan *is* the deliverable, so a
  // finished analysis must not be pushed into "continua con il prossimo
  // passo". Only the model's own unfinished-business signals resume there.
  const planMode = String(mode || '') === 'plan';
  if (planMode && !announced && !declaredPending) {
    return stop('plan_mode_complete', 'plan mode: l\'analisi è il risultato, non proseguo da solo');
  }

  if (!planMode && pendingTodos > 0) {
    return { resume: true, reason: 'pending_todos', why: `${pendingTodos} step dal piano aperti`, signature };
  }
  if (!planMode && toolCount > 0) {
    return { resume: true, reason: 'tool_activity', why: `${toolCount} tool eseguiti, proseguo automaticamente`, signature };
  }
  if (announced) {
    return { resume: true, reason: 'announced_action', why: 'azione annunciata ma non eseguita', signature };
  }
  return { resume: true, reason: 'declared_pending_work', why: 'il modello ha indicato lavoro ancora da fare', signature };
}
