// The language the user is writing in, for the messages ETTORE writes in
// their name.
//
// When a turn stops mid-work, the TUI sends the next prompt itself — it shows
// in the conversation as a "YOU" message. Those prompts were in one fixed
// language: English after the interface was translated, Italian before. A user
// writing Italian then saw themselves "saying" English, and the model, prompted
// in English, switched to answering in English. The prompts now follow the
// language of the user's own recent messages.
//
// Detection is a count of common short words, enough to tell apart the
// languages below in a sentence or two. Anything it cannot place is English.

const STOPWORDS = {
  it: ['il', 'lo', 'la', 'gli', 'le', 'di', 'che', 'non', 'per', 'con', 'una', 'sono', 'è', 'del', 'della', 'questo', 'questa', 'fai', 'puoi', 'anche', 'come', 'perché', 'perchè', 'quando', 'ma', 'se', 'nel', 'nella', 'alla', 'sul', 'tutto', 'ancora', 'deve', 'fare', 'ho', 'hai', 'cosa', 'dove', 'poi', 'aggiungi', 'sistema', 'aggiusta', 'crea', 'mi', 'ci', 'più', 'solo'],
  en: ['the', 'and', 'is', 'are', 'of', 'to', 'in', 'that', 'it', 'for', 'with', 'this', 'you', 'can', 'please', 'what', 'how', 'why', 'when', 'should', 'add', 'fix', 'make', 'create', 'not', 'do', 'does', 'be', 'on', 'my', 'from', 'have', 'has', 'will', 'would', 'there', 'all', 'but'],
  es: ['el', 'los', 'las', 'que', 'de', 'y', 'es', 'una', 'por', 'para', 'con', 'no', 'del', 'este', 'esta', 'puedes', 'también', 'cómo', 'qué', 'cuando', 'pero', 'si', 'hay', 'haz', 'añade', 'arregla', 'todo', 'muy', 'está', 'son'],
  fr: ['le', 'les', 'des', 'est', 'une', 'et', 'que', 'pour', 'avec', 'dans', 'pas', 'ce', 'cette', 'vous', 'tu', 'peux', 'aussi', 'comment', 'pourquoi', 'quand', 'mais', 'si', 'fais', 'ajoute', 'corrige', 'tout', 'sur', 'du', 'au', 'il', 'je', 'ne'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'ein', 'eine', 'zu', 'auf', 'für', 'auch', 'wie', 'warum', 'wenn', 'aber', 'ich', 'du', 'bitte', 'mach', 'füge', 'kannst', 'den', 'dem', 'es', 'sind', 'noch'],
  pt: ['o', 'os', 'as', 'que', 'de', 'e', 'é', 'uma', 'um', 'por', 'para', 'com', 'não', 'do', 'da', 'este', 'esta', 'você', 'pode', 'também', 'como', 'quando', 'mas', 'se', 'faça', 'adicione', 'corrija', 'tudo', 'muito', 'está', 'são'],
};

const SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words)]));

/** 'it' | 'en' | 'es' | 'fr' | 'de' | 'pt', or null when the text says too little. */
export function detectLanguage(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}']+/gu) || [];
  if (!words.length) return null;
  const scores = {};
  for (const [lang, set] of Object.entries(SETS)) {
    scores[lang] = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
  }
  // Italian and Spanish/Portuguese share short words; letters only one of
  // them uses settle a tie.
  if (/[ñ¿¡]/.test(text)) scores.es += 2;
  if (/[ãõç]/.test(text)) scores.pt += 2;
  if (/[äöüß]/.test(text)) scores.de += 2;
  if (/\b(?:perch[eé]|cos[iì]|pi[uù])\b/i.test(text)) scores.it += 1;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] === 0) return null;
  if (second && best[1] === second[1]) return null;
  return best[0];
}

/**
 * The language of the user's own latest messages — those they typed, not the
 * prompts ETTORE sent for them (`auto: true`). Falls back to `fallback`.
 */
export function conversationLanguage(messages = [], fallback = 'en') {
  const typed = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === 'user' && !m.auto && typeof m.text === 'string' && m.text.trim());
  for (let i = typed.length - 1; i >= Math.max(0, typed.length - 3); i--) {
    const lang = detectLanguage(typed[i].text);
    if (lang) return lang;
  }
  return fallback;
}

// What the model is asked to answer when the work really is over. The
// completion check (`modelDeclaredCompletion`) recognises each of these.
export const DONE_PHRASES = {
  it: 'compito completato',
  en: 'task complete',
  es: 'tarea completada',
  fr: 'tâche terminée',
  de: 'Aufgabe erledigt',
  pt: 'tarefa concluída',
};

// Each starts with a word the tool router reads as "continue", so the
// resumed turn keeps the previous intent and plan (see isContinuationPrompt).
const PROMPTS = {
  resume: {
    it: `continua con il prossimo passo. Se il compito è davvero completo, rispondi solo "${DONE_PHRASES.it}" e fermati.`,
    en: `continue with the next step. If the task is really complete, reply only "${DONE_PHRASES.en}" and stop.`,
    es: `continúa con el siguiente paso. Si la tarea está realmente terminada, responde solo "${DONE_PHRASES.es}" y detente.`,
    fr: `continue avec l'étape suivante. Si la tâche est vraiment terminée, réponds seulement "${DONE_PHRASES.fr}" et arrête-toi.`,
    de: `mach weiter mit dem nächsten Schritt. Wenn die Aufgabe wirklich fertig ist, antworte nur "${DONE_PHRASES.de}" und hör auf.`,
    pt: `continua com o próximo passo. Se a tarefa estiver realmente concluída, responde apenas "${DONE_PHRASES.pt}" e para.`,
  },
  plan: {
    it: 'continua con il prossimo passo del piano — eseguilo, non annunciarlo',
    en: 'continue with the next step of the plan — do it, do not announce it',
    es: 'continúa con el siguiente paso del plan — hazlo, no lo anuncies',
    fr: "continue avec l'étape suivante du plan — fais-la, ne l'annonce pas",
    de: 'mach weiter mit dem nächsten Schritt des Plans — führ ihn aus, kündige ihn nicht nur an',
    pt: 'continua com o próximo passo do plano — executa-o, não o anuncies',
  },
  act: {
    it: 'continua: esegui il prossimo passo concreto con un tool — smetti di annunciare cosa farai',
    en: 'continue: carry out the next concrete step with a tool — stop announcing what you will do',
    es: 'continúa: ejecuta el siguiente paso concreto con una herramienta — deja de anunciar lo que harás',
    fr: "continue : exécute l'étape concrète suivante avec un outil — arrête d'annoncer ce que tu vas faire",
    de: 'mach weiter: führe den nächsten konkreten Schritt mit einem Tool aus — hör auf anzukündigen, was du tun wirst',
    pt: 'continua: executa o próximo passo concreto com uma ferramenta — para de anunciar o que vais fazer',
  },
};

/** The prompt ETTORE sends for the user: `kind` is 'resume', 'plan' or 'act'. */
export function continuationPrompt(kind, lang = 'en') {
  const set = PROMPTS[kind] || PROMPTS.resume;
  return set[lang] || set.en;
}
