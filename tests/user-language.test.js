// The prompts ETTORE sends in the user's name follow the user's language.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLanguage, conversationLanguage, continuationPrompt, DONE_PHRASES,
} from '../src/app/user-language.js';
import { modelDeclaredCompletion } from '../src/agents/turn-recovery.js';
import { isContinuationPrompt } from '../src/agents/tool-router.js';

test('common requests are placed in their language', () => {
  assert.equal(detectLanguage('aggiusta e poi aggiusta il fatto che se sto parlando in italiano deve essere in italiano'), 'it');
  assert.equal(detectLanguage('please fix the sidebar, it cuts the model name'), 'en');
  assert.equal(detectLanguage('arregla el menú, no se ve bien y está cortado'), 'es');
  assert.equal(detectLanguage('corrige le menu, il ne s\'affiche pas avec les couleurs'), 'fr');
  assert.equal(detectLanguage('bitte mach die Seitenleiste breiter, sie ist zu schmal'), 'de');
  assert.equal(detectLanguage('corrija o menu, não está a funcionar'), 'pt');
});

test('text that says nothing about its language is not guessed', () => {
  assert.equal(detectLanguage(''), null);
  assert.equal(detectLanguage('npm test'), null);
  assert.equal(detectLanguage('src/app/tui-native.js:42'), null);
});

test('the conversation language comes from what the user typed, not from auto prompts', () => {
  const messages = [
    { role: 'user', text: 'sistema il parser e aggiungi i test' },
    { role: 'assistant', text: 'Done. All tests pass.' },
    { role: 'user', text: 'continue with the next step. If the task is really complete, reply only "task complete" and stop.', auto: true },
  ];
  assert.equal(conversationLanguage(messages), 'it');
});

test('a message with no clear language falls back to the previous ones, then to English', () => {
  assert.equal(conversationLanguage([
    { role: 'user', text: 'fai il commit ed il push' },
    { role: 'user', text: 'npm test' },
  ]), 'it');
  assert.equal(conversationLanguage([{ role: 'user', text: 'npm test' }]), 'en');
  assert.equal(conversationLanguage([]), 'en');
});

test('continuation prompts come in the user\'s language, and English otherwise', () => {
  assert.match(continuationPrompt('resume', 'it'), /^continua con il prossimo passo.*"compito completato"/);
  assert.match(continuationPrompt('resume', 'en'), /^continue with the next step.*"task complete"/);
  assert.match(continuationPrompt('plan', 'es'), /^continúa/);
  assert.equal(continuationPrompt('act', 'xx'), continuationPrompt('act', 'en'));
});

test('every continuation prompt is read by the router as a continuation', () => {
  for (const kind of ['resume', 'plan', 'act']) {
    for (const lang of Object.keys(DONE_PHRASES)) {
      assert.equal(isContinuationPrompt(continuationPrompt(kind, lang)), true, `${kind}/${lang}`);
    }
  }
});

test('the answer each prompt asks for is recognised as the end of the work', () => {
  for (const [lang, phrase] of Object.entries(DONE_PHRASES)) {
    assert.equal(modelDeclaredCompletion(phrase), true, lang);
    assert.equal(modelDeclaredCompletion(`${phrase}.`), true, `${lang} with a full stop`);
  }
  // Scoped to a step, it is progress, not the end.
  assert.equal(modelDeclaredCompletion('compito completato per il primo file, ora passo al secondo'), false);
});
