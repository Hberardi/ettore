// Matching cases taken from a real skill set, where the old keyword scoring
// failed in both directions at once: it woke a security skill on "che ore
// sono" while a skill named `audit-color` stayed asleep on "controlla i
// colori".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillSystem } from '../src/skills/index.js';

// Modelled on the skills actually on the machine: two with triggers, three
// with none and only prose to match on — which is what exposed the flaws.
function system(extra = []) {
  const s = new SkillSystem();
  const skills = [
    {
      name: 'code', description: 'Specializzato in scrittura e analisi codice',
      triggers: ['codice', 'implementa', 'modifica', 'funzione', 'test', 'refactoring'],
    },
    {
      name: 'debug', description: 'Analisi e risoluzione bug',
      triggers: ['bug', 'errore', 'debug', 'fallisce', 'stacktrace'],
    },
    {
      name: 'audit-color',
      description: 'Eseguire un audit completo del sistema cromatico, per identificare i colori incoerenti',
      triggers: [],
    },
    {
      name: 'senior-web-designer',
      description: 'Agire come Senior Web Designer e UI/UX Specialist durante analisi, progettazione e implementazione del layout',
      triggers: [],
    },
    {
      name: 'security-engineering',
      description: 'Agire come Senior Software Engineer multidisciplinare con competenze di sicurezza, rete e funzionamento dei sistemi',
      triggers: [],
    },
    ...extra,
  ];
  for (const skill of skills) s.skills.set(skill.name, { enabled: true, instructions: '', ...skill });
  return s;
}

const names = (s, prompt) => s.matchSkills(prompt).map(x => x.name);

// ── The failures that prompted the rewrite ───────────────────────────────────

test('a skill matches a prompt in the other language than its name', () => {
  // `colori` against `audit-color` shared no exact token at all.
  const s = system();
  assert.ok(names(s, 'controlla i colori').includes('audit-color'));
  assert.ok(names(s, 'rivedi i colori della UI').includes('audit-color'));
});

test('function words alone wake nothing', () => {
  // "che ore sono" scored 2.3 against the security skill on `che` and `sono`.
  const s = system();
  assert.deepEqual(names(s, 'che ore sono'), []);
  assert.deepEqual(names(s, 'grazie mille'), []);
  assert.deepEqual(names(s, 'ok va bene'), []);
});

test('a guessed stem does not fire a skill on its own', () => {
  // `funziona` against `funzionamento` is a guess, and "questo non funziona"
  // has nothing else in it.
  const s = system();
  assert.deepEqual(names(s, 'questo non funziona più'), []);
});

test('one word of prompt counts once, however many spellings the skill has', () => {
  const s = system();
  const scored = s.scoreSkills('questo non funziona più');
  const sec = scored.find(r => r.skill.name === 'security-engineering');
  // Three variants of the same root used to score three times over.
  assert.ok(sec.matched.length <= 1, `one word matched ${sec.matched.length} times: ${sec.matched}`);
});

// ── What must keep working ───────────────────────────────────────────────────

test('triggers remain the strongest and most reliable signal', () => {
  const s = system();
  assert.ok(names(s, 'sistema il bug nel parser').includes('debug'));
  assert.ok(names(s, 'aggiungi una funzione di export').includes('code'));
  assert.ok(names(s, 'refactoring del modulo di rete').includes('code'));
});

test('a prompt naming a skill outright selects it', () => {
  const s = system();
  assert.ok(names(s, 'usa audit-color su questa pagina').includes('audit-color'));
});

test('several relevant skills can fire together', () => {
  const s = system();
  const hit = names(s, 'perché fallisce il test?');
  assert.ok(hit.includes('debug'), hit.join(','));
  assert.ok(hit.includes('code'), hit.join(','));
});

test('a long description no longer buys relevance it has not got', () => {
  // The security skill's prose is the longest in the set; before the rewrite
  // that alone made it the most likely to match anything.
  const s = system();
  assert.ok(!names(s, 'controlla i colori').includes('security-engineering'));
  assert.ok(!names(s, 'che ore sono').includes('security-engineering'));
});

test('a distinctive word beats a common one', () => {
  const s = system();
  const scored = s.scoreSkills('rifai il layout della pagina');
  assert.equal(scored[0].skill.name, 'senior-web-designer');
  assert.ok(scored[0].score > 0);
});

// ── Shape and limits ─────────────────────────────────────────────────────────

test('scoreSkills reports why, not just whether', () => {
  const s = system();
  const top = s.scoreSkills('sistema il bug nel parser')[0];
  assert.equal(top.skill.name, 'debug');
  // A trigger hit is marked so it can be told from an inferred one.
  assert.ok(top.matched.some(m => m.startsWith('!')), top.matched.join(','));
  assert.equal(top.explicit, true);
});

test('an empty or wordless prompt matches nothing', () => {
  const s = system();
  assert.deepEqual(names(s, ''), []);
  assert.deepEqual(names(s, '   '), []);
  assert.deepEqual(names(s, '!!! ???'), []);
});

test('disabled skills never match', () => {
  const s = system();
  s.skills.get('debug').enabled = false;
  assert.ok(!names(s, 'sistema il bug nel parser').includes('debug'));
});

test('no more skills are returned than the cap allows', () => {
  const s = system();
  assert.ok(s.matchSkills('codice test bug errore refactoring layout colori').length <= 3);
  assert.equal(s.matchSkills('sistema il bug', { maxSkills: 1 }).length, 1);
});
