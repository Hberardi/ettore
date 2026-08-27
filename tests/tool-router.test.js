import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { toolDefinitions } from '../src/tools/index.js';
import { Agent } from '../src/agents/index.js';
import {
  selectToolDefinitions,
  selectedToolNames,
  promptHasEditIntent,
  isContinuationPrompt,
} from '../src/agents/tool-router.js';

function route(prompt, extra = {}) {
  return selectedToolNames(selectToolDefinitions(toolDefinitions, {
    mode: 'build',
    prompt,
    maxTools: 16,
    ...extra,
  }));
}

test('tool router reduces the default schema set', () => {
  const names = route('explain the architecture');
  assert.ok(names.length < toolDefinitions.length);
  assert.ok(names.length <= 16);
  assert.ok(names.includes('read'));
  assert.ok(names.includes('repo_map'));
  assert.equal(names.includes('video_transcript'), false);
});

test('tool router includes mutation and verification tools for edit tasks', () => {
  const names = route('modifica il parser e verifica i test');
  for (const expected of ['write', 'edit', 'apply_patch_structured', 'run_checks', 'run_tests']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test('tool router selects specialized tools only when relevant', () => {
  const web = route('cerca la documentazione aggiornata online');
  assert.ok(web.includes('websearch'));
  assert.ok(web.includes('webfetch'));
  assert.ok(web.includes('web_image'));

  const images = route('trova e analizza una immagine online');
  assert.ok(images.includes('web_image'));

  const video = route('trascrivi questo video YouTube');
  assert.ok(video.includes('video_transcript'));

  const runtime = route('controlla il server e i log runtime');
  assert.ok(runtime.includes('dev_server'));
  assert.ok(runtime.includes('read_server_console'));
});

test('tool router preserves specialized web tools when an edit request hits the cap', () => {
  const names = route('aggiorna il client usando la documentazione online più recente');
  assert.ok(names.includes('websearch'));
  assert.ok(names.includes('webfetch'));
  assert.ok(names.includes('write'));
  assert.ok(names.includes('run_checks'));
});

test('tool router returns no schemas for lite models', () => {
  const tools = selectToolDefinitions(toolDefinitions, {
    mode: 'build',
    prompt: 'edit file',
    isLite: true,
  });
  assert.deepEqual(tools, []);
});

test('build mode keeps the write tools whatever the prompt looks like', () => {
  const prompts = [
    'continua',
    'continua con il prossimo passo. Se il task è davvero completo, rispondi solo "task completo" e fermati.',
    'vai avanti',
    'il menu della navbar non si vede',
    'perché la pagina è vuota?',
  ];
  for (const prompt of prompts) {
    const names = route(prompt);
    for (const expected of ['write', 'edit', 'apply_patch_structured']) {
      assert.ok(names.includes(expected), `"${prompt}" lost ${expected}`);
    }
  }
});

test('plan mode stays read-only even when asked to change things', () => {
  const names = selectedToolNames(selectToolDefinitions(toolDefinitions, {
    mode: 'plan',
    prompt: 'modifica templates/components/navbar.html',
    maxTools: 16,
  }));
  for (const forbidden of ['write', 'edit', 'apply_patch_structured', 'bash_session']) {
    assert.equal(names.includes(forbidden), false, `plan mode exposed ${forbidden}`);
  }
});

test('an overlay ordering an edit brings the toolchain with it', () => {
  // The recovery overlay tells the model to use write/edit; it used to be
  // delivered with exactly those tools filtered out.
  const overlay = 'You announced an action but did not perform it. Read any needed files, '
    + 'then use write/edit tools to actually create or modify files in the working directory now.';
  const names = route('continua', { overlay });
  assert.ok(names.includes('write'));
  assert.ok(names.includes('edit'));
  assert.ok(names.includes('run_checks'));
});

test('a sticky edit intent survives a bare continuation', () => {
  const plain = route('continua');
  assert.equal(plain.includes('run_checks'), false);

  const sticky = route('continua', { editIntentSticky: true });
  assert.ok(sticky.includes('run_checks'));
  assert.ok(sticky.includes('run_tests'));
});

test('the write tools outrank contextual families when the cap bites', () => {
  const names = route('aggiorna il sito usando la documentazione online e controlla il server', { maxTools: 8 });
  assert.equal(names.length, 8);
  for (const expected of ['write', 'edit', 'apply_patch_structured']) {
    assert.ok(names.includes(expected), `cap dropped ${expected}`);
  }
});

test('edit intent and continuation are recognised for the caller', () => {
  assert.equal(promptHasEditIntent('modifica la navbar'), true);
  assert.equal(promptHasEditIntent('spiegami come funziona il parser'), false);
  assert.equal(isContinuationPrompt('continua'), true);
  assert.equal(isContinuationPrompt('vai avanti'), true);
  assert.equal(isContinuationPrompt('continua con il prossimo passo'), true);
  assert.equal(isContinuationPrompt('continuiamo il refactor di navbar.html'), false);
});

test('the agent hands the write tools to the provider on a continuation turn', async () => {
  const routed = [];
  const client = {
    async turn(messages, tools) {
      routed.push(selectedToolNames(tools || []));
      return { type: 'text', content: 'ok' };
    },
  };
  const agent = new Agent(client, {
    provider: 'test',
    model: 'gpt-4o',
    modelCapability: 'full',
    workdir: process.cwd(),
    contextWindow: 128000,
    verifyAfterEdit: false,
  }, 'build');

  await agent.run('modifica templates/components/navbar.html', new EventEmitter());
  await agent.run('continua', new EventEmitter());

  assert.equal(routed.length, 2);
  for (const expected of ['write', 'edit']) {
    assert.ok(routed[1].includes(expected), `the continuation turn lost ${expected}`);
  }
  // The task is still an edit task, so its verification tools come along too.
  assert.ok(routed[1].includes('run_checks'));

  // A fresh question that asks for no change clears the intent again.
  await agent.run('spiegami come funziona il parser', new EventEmitter());
  assert.equal(routed[2].includes('run_checks'), false);
});
