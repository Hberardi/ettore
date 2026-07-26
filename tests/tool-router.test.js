import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinitions } from '../src/tools/index.js';
import { selectToolDefinitions, selectedToolNames } from '../src/agents/tool-router.js';

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
