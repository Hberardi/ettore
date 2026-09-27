// The conversation is laid out for the panel it is shown in. It used to be
// laid out for the whole terminal and then cut to the panel beside the
// sidebar, so bubbles lost their right border and wrapped lines ended in "…".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAllAnsi } from '../src/utils/ansi.js';

async function tui(cols = 190, rows = 48) {
  const { TUI } = await import('../src/app/tui-native.js');
  const t = new TUI();
  t.cols = cols;
  t.rows = rows;
  t.availableHeight = rows - 8;
  return t;
}

const LONG = 'continua con il prossimo passo. Se il compito è davvero completo, rispondi solo "compito completato" e fermati. '
  + 'Questo testo è lungo apposta per vedere se va a capo invece di essere tagliato alla fine della riga.';

test('every transcript line fits the panel beside the sidebar', async () => {
  for (const cols of [100, 140, 190, 240]) {
    const t = await tui(cols);
    t.messages.push({ role: 'user', text: LONG, tools: [], id: 1 });
    t.messages.push({ role: 'assistant', text: `Riepilogo:\n\n- **Sintassi**: ${LONG}`, tools: [], id: 2 });
    const panel = t.messagesWidth();
    const lines = t._renderMessages().map((l) => stripAllAnsi(l));
    for (const line of lines) {
      assert.ok([...line].length <= panel, `${cols} cols: a line of ${[...line].length} in a panel of ${panel}: ${line}`);
    }
    assert.ok(!lines.some((l) => l.includes('…')), `${cols} cols: nothing is cut`);
    const text = lines.join(' ').replace(/[│┃╭╮╰╯━]/g, ' ').replace(/\s+/g, ' ');
    assert.match(text, /alla fine della riga\./, 'the whole message is there');
  }
});

test('the header keeps the mode label whole', async () => {
  const t = await tui(120);
  t.provider = 'minimax';
  t.model = 'MiniMax-M3';
  t.sessionId = 'muk31h2abcdef';
  const header = stripAllAnsi(t._renderHeader());
  assert.ok([...header].length <= 120, `header is ${[...header].length} wide`);
  assert.match(header, /BUILD $/);
});
