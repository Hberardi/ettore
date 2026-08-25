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

import { responseAnnouncesUnexecutedAction } from '../agents/turn-recovery.js';

export const DEFAULT_MAX_AUTO_RESUMES = 25;

// Phrases that only make sense when the whole job is over. Deliberately
// narrow: a partial "il primo step è completato" must NOT match, because
// resuming one turn too many costs a round-trip while stopping one turn too
// early costs the user a manual nudge.
const COMPLETION_PATTERNS = [
  /\btask\s+(?:complet[oai]|completat[oa]|finit[oa]|terminat[oa]|done|complete[d]?)\b/i,
  /\b(?:lavoro|attivit[àa]|implementazione|modifica|refactor|migrazione)\s+(?:completat[oa]|finit[oa]|conclus[oa]|terminat[oa])\b/i,
  /\bho\s+(?:finito|completato|concluso|terminato)\b/i,
  /\b(?:tutto|e[' ]?\s*tutto)\s+(?:fatto|pronto|completato|a\s+posto|sistemato)\b/i,
  /\ball\s+done\b|\bthat'?s\s+it\b|\bwork\s+complete\b|\bnothing\s+(?:else\s+)?left\b/i,
];

// A standalone "Fatto." on its own line is a real completion signal; the same
// word inside a sentence is not.
const STANDALONE_DONE = /^(?:fatto|done|completato|pronto)[.!]?$/i;

// Anything here means the model is still mid-job, and it vetoes a completion
// match found in the same tail. "primo/secondo/step" are included because
// "ho completato il primo file" is a progress report, not a finish line.
const CONTINUATION_MARKERS = new RegExp(
  '\\b(?:'
  + 'prossim[oi]\\s+(?:pass[oi]|step)|next\\s+steps?|'
  + 'manca(?:no)?|rest(?:a|ano)|rimane|rimangono|da\\s+fare|ancora\\s+(?:aperti|apert[oa]|da)|'
  + 'continuo|proseguo|procedo|passo\\s+a|'
  + 'ora|adesso|poi|quindi|'
  + 'prim[oa]|second[oa]|terz[oa]|parzial\\w*|in\\s+corso|step\\s+\\d'
  + ')\\b',
  'i',
);

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

// The decision only looks at the closing lines: a long answer can mention
// "ho finito di leggere il file" halfway through and still be mid-task.
function tailOf(text, lines = 2) {
  const rows = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (!rows.length) return '';
  return rows.slice(-lines).join(' ');
}

export function modelDeclaredCompletion(text) {
  const body = String(text || '').trim();
  if (!body) return false;

  const rows = body.split('\n').map(line => line.trim()).filter(Boolean);
  const lastRow = rows[rows.length - 1] || '';
  if (STANDALONE_DONE.test(lastRow)) return true;

  const tail = tailOf(body, 2);
  if (!COMPLETION_PATTERNS.some(re => re.test(tail))) return false;
  // "Ho completato il refactor, ora aggiorno i test" — the completion phrase
  // is real but scoped to a step, not the task.
  if (CONTINUATION_MARKERS.test(tail)) return false;
  return true;
}

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
