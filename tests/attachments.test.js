import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachmentKind,
  buildAttachmentPrompt,
  inspectAttachment,
  loadAttachments,
} from '../src/utils/attachments.js';
import { TUI } from '../src/app/tui-native.js';

test('attachments classify files and build a local-file prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-attachments-'));
  const filePath = join(dir, 'brief.md');
  await writeFile(filePath, '# Brief\n');

  const file = await inspectAttachment(filePath, { cwd: dir });
  assert.equal(file.kind, 'text');
  assert.equal(attachmentKind('photo.png'), 'image');
  assert.match(buildAttachmentPrompt('Analizza', [file]), /brief\.md/);
  assert.match(buildAttachmentPrompt('Analizza', [file]), /Leggi|analizza/i);
});

test('loadAttachments deduplicates paths and rejects directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ettore-attachments-'));
  const filePath = join(dir, 'notes.txt');
  await writeFile(filePath, 'notes');

  const files = await loadAttachments([filePath, filePath], { cwd: dir });
  assert.equal(files.length, 1);
  await assert.rejects(inspectAttachment(dir, { cwd: dir }), /non è un file/);
});

test('TUI removes the last attachment without touching earlier ones', () => {
  const tui = Object.create(TUI.prototype);
  tui.attachments = [];
  tui.needsRender = false;
  tui.addAttachment({ path: '/tmp/one.txt', name: 'one.txt' });
  tui.addAttachment({ path: '/tmp/two.txt', name: 'two.txt' });

  assert.equal(tui.removeLastAttachment().name, 'two.txt');
  assert.deepEqual(tui.attachments.map(file => file.name), ['one.txt']);
  assert.equal(tui.removeLastAttachment().name, 'one.txt');
  assert.equal(tui.removeLastAttachment(), null);
});
