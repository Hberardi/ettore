# ETTORE — Report UX/TUI: "la CLI si blocca"

**Data:** 2026-08-14
**Scope:** modalità interattiva (`bin/cli.js` → `src/app/native-ui.js` + `src/app/tui-native.js` + `src/agents/index.js`)
**Pain point dichiarato dall'utente:** la CLI si blocca (freezes, non solo lag).

---

## TL;DR

La causa più probabile del "blocco" **non è un singolo punto**, ma la somma di 3 fattori che si moltiplicano durante lo streaming LLM:

1. **Render TUI a 60 fps che ridipinge TUTTO da zero** (incluso markdown/tabelle/syntax highlight) per ogni frame. Con conversazioni lunghe o output di tool grossi, un singolo `render()` supera i 100-500 ms → frame persi → TUI "morto" tra un frame e l'altro.
2. **Throttle del render che perde eventi silenziosamente.** `scheduleRender` controlla un intervallo minimo e, se fuori finestra, ritorna senza rischedulare. Il commento dice "will catch next interval" ma se il prossimo trigger è proprio l'`setInterval` a 16 ms, l'utente vede fino a 16-100 ms di freeze durante i burst di token.
3. **Lavoro sincrono pesante nell'agent loop** (regex matchAll, parsing `<todo>`/`<done>`, filter tool-tag) che gira sul main thread e compete con il render loop. Nei modelli veloci con chunk piccoli, il main thread si satura.

I watchdog esistenti (`stallWatchdog`, 120-300 s) sono troppo lenti per dare un feedback percepibile: l'utente vede uno schermo morto per **fino a 2 minuti** prima di qualsiasi messaggio di errore.

---

## Cause primarie (in ordine di impatto)

### 1. `TUI._render()` ridipinge l'intera conversazione ogni frame
**File:** `src/app/tui-native.js:200-253` (`_render`), `296-344` (`_renderMessages`), `354-492` (`_renderMessageFull`)

- Ogni frame: header + status + N messaggi (full markdown parsing) + sidebar + input + overlays.
- `_renderMessageFull` per OGNI messaggio esegue: detection tabelle markdown, heading, list items, `_renderMarkdown`, `_highlightCode` (regex per keywords/strings/numbers/comments), `_compactRows`.
- Crescita lineare con `messages.length` e con la lunghezza di ogni messaggio (incluso l'output di tool in `_renderStreamingFull`).
- Su un terminale 80×24 con 30 messaggi da 50 righe, una singola `_render()` può superare i 200 ms. A 60 fps = catastrofe.

**Effetto percepito:** durante lo streaming, l'utente vede il cursore "saltare" (frame persi) o, peggio, lo schermo restare identico per 100-300 ms tra un chunk e l'altro.

**Fix raccomandato (in ordine):**
- A. **Render incrementale / diff-by-line.** Mantieni una cache `lastRenderedLines: string[]` per la zona messaggi. Ricalcola solo le righe cambiate, e usa `ANSI.move(x,y)` per scrivere solo quelle. Su 30 messaggi × 50 righe = 1500 righe: se ne cambia 1, ne scrivi 1.
- B. **Cap della lunghezza visualizzata per i messaggi vecchi.** Tronca a N righe con `[...mostra/N]`. Le conversazioni reali di ETTORE producono history di migliaia di righe.
- C. **Throttle adattivo.** Se `_render()` supera i 33 ms, scala la frequenza a 30 fps; se supera 100 ms, a 10 fps finché non si stabilizza.
- D. **Cap `tool.output` rendering.** Tronca a 4-8 KB per il display, con link "show full" via `/output <id>`. Questo è il moltiplicatore più cattivo (un tool di 100 KB di output × 60 fps = 6 MB/s di CPU solo per sanitizzare).

**Impatto stimato:** passa da 200-500 ms/frame a 5-20 ms/frame. L'utente smette di vedere lo "schermo morto".

---

### 2. `scheduleRender` droppa eventi silenziosamente
**File:** `src/app/native-ui.js:248-262`

```js
const scheduleRender = () => {
  if (renderPending) return;
  renderPending = true;
  setImmediate(() => {
    const now = Date.now();
    if (now - lastRenderTime < MIN_RENDER_INTERVAL) {
      renderPending = false;
      return; // Skip - will catch next interval
    }
    lastRenderTime = now;
    tui.render();
    tui.needsRender = false;
    renderPending = false;
  });
};
```

- Il commento è fuorviante. Se il throttle scatta, `renderPending = false` e non rischedula nulla.
- L'`setInterval` a 16 ms (`startRenderLoop` line 818-826) è il safety net, MA: (a) controlla `tui.needsRender || tui.isRunning`, quindi se nessuno ha chiamato `scheduleRender` di recente ma `tui.isRunning` è true, l'interval renderizza comunque — OK; (b) se l'`_render()` è lento, l'interval può accavallarsi.
- **Caso problematico:** durante un tool call, `scheduleRender` viene chiamato da `toolStart`/`toolEnd`/`toolProgress`. Se l'utente ridimensiona la finestra (resize flood), decine di `scheduleRender` in 100 ms → solo 1-2 render effettivi. Sembra freezato per l'utente.

**Fix raccomandato:**
- Rischedula sempre dopo un drop: `setTimeout(scheduleRender, MIN_RENDER_INTERVAL - (now - lastRenderTime))`.
- Coalesce eventi resize con un debounce di 50 ms.

---

### 3. Work sincrono nell'agent `onToken` durante lo streaming
**File:** `src/agents/index.js:862-977`

Ogni chunk del modello esegue, in ordine:
- `parseBuffer += text; emitBuffer += text;`
- Think-tag filtering: 1-3 `match()`, slicing, allocations
- `stripThinkTags(emitBuffer)`
- `filterToolCallStream(emitBuffer, inToolLeak)` (regex su tool-tag leakati)
- `parseBuffer.matchAll(DONE_MARKER_RE)` (anche se non c'è `<done:N>` nel chunk)
- `parseBuffer.match(TODO_CAPTURE_RE)` (anche se non c'è `<todo>`)
- `flushSafe()` → emit `token` event → che nel TUI handler chiama `splitStreamBuffer` (4 regex) + `sanitizeModelText` (`stripAllAnsi`)

Con un modello che emette chunk da 5-20 caratteri a 50-100 Hz, il main thread è occupato dal parsing ~80% del tempo. Il render loop sopravvive a malapena.

**Fix raccomandato:**
- **Short-circuit le regex se i marker non sono probabili nel buffer corrente.** Tieni un flag `bufferContainsLessThan` e skipp `matchAll(DONE_MARKER_RE)` se non c'è `<` nel buffer.
- **Accumula `parseBuffer` su un worker / microtask separato.** Già la `setImmediate` su `flushSafe` aiuterebbe.
- **Cache l'output di `sanitizeModelText`** per chunk identici (raro ma possibile con provider che ritrasmettono).
- **Coalesce `token` events nel TUI handler** — accetta N token in 16 ms, sanitizza una volta, render una volta. Già parzialmente fatto da `scheduleRender`, ma il lavoro di sanitize è comunque sincrono per ogni chunk.

---

### 4. Stall watchdog timeout troppo lungo
**File:** `src/app/native-ui.js:832-866`

- Model stall: 120 s (300 s per MiniMax M2.7 e simili con reasoning silenzioso).
- Tool stall: 300 s.
- L'utente vede uno schermo "morto" fino a 2-5 minuti prima di sapere che qualcosa è andato storto.

**Fix raccomandato:**
- Mostra SEMPRE un feedback entro 2-3 s: "Sto aspettando la risposta del modello… (Xs)" con un timer visibile.
- Differenzia "waiting on model" vs "waiting on tool" vs "waiting on network" con icone diverse.
- Riduci il primo livello di watchdog a 30 s (per model), 60 s (per tool) per il messaggio di warning; mantieni il timeout duro a 300 s.

---

### 5. `process.stdout.write` bloccante su Windows TTY
**File:** `src/app/tui-native.js:252`

```js
process.stdout.write(this._stripOrphanSgr(out));
```

- Una singola write di un buffer di 20-100 KB (sidebar lunga + messaggi) può bloccarsi su Windows TTY quando il buffer del pipe è pieno.
- Durante l'attesa, il main thread non può processare `keypress` events.
- Su Windows Terminal / ConEmu / WSL il pipe ha una capacità limitata; con alt fps può fare backpressure.

**Fix raccomandato:**
- Usa `process.stdout.cork()` / `process.stdout.uncork()` per fare un'unica write atomica del frame intero.
- Spezza il render in blocchi ≤ 16 KB e scrivi in sequenza con `setImmediate` tra i blocchi.
- Su Windows, valuta `process.stdout.write(..., { encoding: 'utf8' })` esplicito.

---

### 6. Nessun lock per input durante `agent.run()`
**File:** `src/app/native-ui.js:1281-1331` (`handleInput`), `1321-1330`

```js
tui.isRunning = true;
tui.turnState = 'started';
tui.streaming = { ... };
agent.run(imageRefs.text, emitter, { imageAttachments }).then(...).catch(() => {});
```

- `agent.run()` è fire-and-forget. Se l'utente preme di nuovo Enter, parte un secondo `run` (Agent lo abort via `abortController`, ma il TUI non sa niente).
- L'`abortController` in `Agent.run` (line 642-644) aborta il run precedente, ma il TUI mostra ancora il vecchio `streaming.text` mentre il nuovo run inizia a scrivere nel suo — confusione visiva.
- Il catch silenzioso (`catch(() => {})`) nasconde crash dell'agent.

**Fix raccomandato:**
- Blocca l'input quando `tui.isRunning === true` con un messaggio tipo "(invio non permesso durante un run — premi ESC per annullare)".
- Aggiungi un piccolo spinner/icona "running" nella status bar per chiarezza.
- Logga gli errori di `agent.run` in `process.stderr` (almeno in modalità `--debug`).

---

### 7. Tool output visualizzato integralmente, anche se 100 KB
**File:** `src/app/native-ui.js:440-441` (in `toolEnd`):

```js
tool.output = typeof output === 'string' ? output : JSON.stringify(output);
```

- L'output viene pushato nello streaming senza troncamento.
- `_renderStreamingFull` lo disegna per intero, e ad ogni frame successivo lo ri-disegna.

**Fix raccomandato:**
- Tronca a 4 KB per il display live. Aggiungi `tool.outputFull` con l'output completo, accessibile con un tasto (es. `o` su tool selezionato, o `/output <tool_id>`).
- Mostra "Output troncato (mostrati 4 KB di 100 KB — /output 5 per vedere tutto)".

---

## Cause secondarie (amplificano il problema)

### 8. Sidebar ridisegnata interamente ogni frame
**File:** `src/app/tui-native.js:212, 221-222, 226, 232, 237, 242`

Per ogni riga del sidebar:
```js
out += ANSI.move(mainWidth + 2, i + 2) + `\x1b[48;5;236m${this._padVisual(sideLines[i] || '', sidebarWidth)}${C.reset}`;
```

- 24-50 righe × 60 fps = ~3000 write/secondo solo per il background del sidebar.
- Il sidebar cambia di rado (ogni qualche secondo, non ogni frame).

**Fix:** cache l'output del sidebar e riscrivilo solo quando `tui.provider`, `tui.model`, `tui.sessionCost`, ecc. cambiano (pattern observer).

---

### 9. `tui.messages.push` patched per sanitize, ma il patching è O(n) per messaggio
**File:** `src/app/native-ui.js:177-185`

```js
const originalMessagesPush = tui.messages.push.bind(tui.messages);
tui.messages.push = (...items) => {
  const sanitized = items.map((item) => { ... });
  return originalMessagesPush(...sanitized);
};
```

- Ogni `messages.push` passa per la sanitize. OK per il contenuto, ma le mutazioni successive (es. `_renderStreamingFull` che muta `streaming.text` ad ogni token) non passano per questo filtro.
- Non è un problema di freeze, ma di coerenza: un messaggio pushato raw può contenere ANSI pericoloso prima di essere renderizzato.

**Fix:** meno critico, ma centralizza la sanitize in un unico punto (es. `_render()`) e togli il patch su `push`.

---

### 10. Auto-save session dopo ogni turn
**File:** `src/app/native-ui.js:1327-1330`

```js
agent.run(...).then(async () => {
  session.messages = agent.messages;
  await saveSession(session).catch(() => {});
}).catch(() => {});
```

- `saveSession` scrive su disco. Su filesystem lenti (network drive, OneDrive) può richiedere 200-1000 ms.
- Awaited ma in `.then` — non blocca l'utente in modo evidente, ma succhia CPU.
- Errori silenziosamente ingoiati.

**Fix:**
- Debounce il save (aspetta 5 s di inattività prima di scrivere).
- Salva in background senza await.

---

### 11. `loadImageAttachments` nel keypress handler
**File:** `src/app/native-ui.js:1302`

```js
imageAttachments = await loadImageAttachments(imageRefs.paths, { cwd: config.workdir });
```

- Blocca l'input finché l'immagine non è caricata.
- Per immagini da 5-10 MB o path di rete, l'utente vede lag.

**Fix:** carica in background, mostra "Caricamento immagine…", permetti all'utente di continuare a scrivere.

---

### 12. `createSession` blocking startup
**File:** `src/app/native-ui.js:236`

```js
const session = await createSession(p, m);
```

- Avviene prima che `startRenderLoop` parta. Se il filesystem è lento, l'utente vede "ETTORE — AI Coding Agent" ma niente risponde ai tasti per 1-3 s.

**Fix:** mostrare un "Loading session…\n" esplicito PRIMA dell'await, o rimandare la creazione al primo messaggio.

---

### 13. Resize handler non debounciato
**File:** `src/app/native-ui.js:807-812`

```js
const onResize = () => {
  process.stdout.write('\x1b[2J\x1b[H');
  tui.updateSize();
  tui.render();
};
process.stdout.on('resize', onResize);
```

- Trascinando il bordo di un terminale Windows: 20-50 event/secondo, ognuno fa clear+full-render.
- Su history lunga, ogni resize = 200-500 ms di freeze.

**Fix:** debounce 50-100 ms con `setTimeout`.

---

## Metriche proposte per validare le fix

Prima di toccare codice, misura:

1. **Frame time del render loop.** Aggiungi un counter `frameMs` in `_render()` e stampalo ogni 5 s su stderr (solo in modalità debug). Confronta prima/dopo la fix #1.
2. **Numero di `scheduleRender` skipped vs eseguiti** (counter su `renderPending`). Rapporto atteso: >10:1 oggi, <2:1 dopo la fix #2.
3. **Tempo di `onToken`** nel agent loop. Misura con `performance.now()` o `process.hrtime.bigint()`. Se >5 ms per chunk, fix #3 è prioritaria.
4. **TTFB percepito** (time-to-first-byte dopo Enter). Se >500 ms costanti, è un problema di avvio (fix #12).
5. **Tool output size distribution.** Logga `tool.output.length` per tool. Se il 90° percentile è >10 KB, fix #7 è urgente.

---

## Roadmap raccomandata

### Quick wins (1-2 giorni, alto impatto)
- **Fix #2** (rischedula render dopo drop) — 10 righe di codice, impatto immediato sulla responsività percepita.
- **Fix #4** (feedback visibile entro 2-3 s) — 20 righe, elimina il "è vivo?" per l'utente.
- **Fix #6** (lock input durante run) — 5 righe + un messaggio nello status.
- **Fix #11** (caricamento immagini in background) — refactor di 30 righe, elimina lag di digitazione.
- **Fix #13** (debounce resize) — 3 righe.

### Medi (1 settimana, impatto strutturale)
- **Fix #1.A** (render incrementale con diff-by-line) — refactor significativo, ma il moltiplicatore più grande.
- **Fix #1.D** (cap tool output a 4 KB) — facile, grande effetto sui tool pesanti (webfetch, read su file grossi, grep estesi).
- **Fix #3** (short-circuit regex + coalesce token events) — medio refactor dell'agent loop.

### Lungo termine (2+ settimane)
- **Fix #1.B** (history cap con virtualizzazione) — conversazioni di centinaia di messaggi oggi sono ingestibili.
- **Fix #5** (write coalescing su Windows) — dipende da profiling reale su Windows Terminal.
- **Fix #8** (sidebar cache) — micro-ottimizzazione, ma su history lunga fa differenza.

---

## Domande aperte da chiarire con l'utente

Per procedere con le fix servono queste informazioni:

1. **Su quale OS/terminale si manifesta il blocco?** (Windows Terminal, ConEmu, iTerm, GNOME Terminal, WSL?) — Fix #5 cambia in base alla risposta.
2. **Il blocco avviene durante lo streaming, durante un tool call, o all'avvio?** — Cambia la priorità: se è durante tool, fix #1.D + #4; se è durante streaming, fix #1.A + #3; se è all'avvio, fix #12.
3. **Quanto sono lunghe tipicamente le conversazioni prima del freeze?** (10, 50, 200+ messaggi?) — Determina l'urgenza di #1.B.
4. **Quali tool sono più usati quando si blocca?** (bash, webfetch, read su file grossi, grep?) — Se è un tool specifico, forse ha un bug suo (es. `bash` con output di 50 MB che satura il display).
5. **C'è uno schema riproducibile?** (es. "succede sempre dopo il 5° tool call in una sessione lunga") — Aiuta a individuare la causa specifica.

---

## File di riferimento

- `src/app/native-ui.js` — orchestrator eventi TUI, scheduleRender, stall watchdog, keypress handling
- `src/app/tui-native.js` — renderer ANSI, _render, _renderMessages, _renderMessageFull, sidebar
- `src/agents/index.js` — agent loop, onToken (sync work su stream), iterazioni, tool execution
- `src/agents/compressor.js` — gestione contesto (probabilmente OK, ma verificare se blocca)
- `src/agents/turn-state.js` — state machine (verificare se ha side-effect sync)
- `src/tools/index.js` — tool dispatcher (verificare se qualche tool blocca il main thread)

---

**Autore report:** Mavis
**Status:** BOZZA — da validare con utente su 1-5 prima di scrivere fix

---

## DRILL-DOWN: freeze durante una tool call

**Trigger utente:** "la CLI si blocca durante una tool call"

Questo caso è distinto dal freeze durante lo streaming. Lo streaming LLM produce token visibili e frame frequenti; durante una tool call, il main thread è occupato dal tool stesso, e il render TUI non riceve alcun evento finché il tool non termina. L'utente vede uno schermo apparentemente morto.

### A. Nessun elapsed time visibile per il tool in esecuzione
**File:** `src/app/tui-native.js:866-882` (`_renderStreamingFull`, sezione "tool attivo")

Il rendering del tool attivo mostra:
```
  ◐ read file_path=src/big.ts … 
```

Ma **nessun timer, nessun "Xs elapsed", nessuna barra di progresso**. Per tool che girano 5-10 minuti (es. `video_transcript` con whisper, `bash` con test suite grossa, `webfetch` su siti lenti) l'utente non sa se:
- il tool sta lavorando (normale)
- il tool è bloccato su un lock di rete
- il tool è in deadlock

Il dato `startMs` esiste ed è registrato (line 425 di `native-ui.js`), ma non viene mai letto dal render.

**Fix raccomandato:**
```js
// In _renderStreamingFull, subito dopo `if (runningTool) {`:
const elapsedMs = Date.now() - (runningTool.startMs || Date.now());
const elapsedStr = elapsedMs < 60_000
  ? `${Math.floor(elapsedMs / 1000)}s`
  : `${Math.floor(elapsedMs / 60_000)}m ${Math.floor((elapsedMs % 60_000) / 1000)}s`;
const elapsedColor = elapsedMs > 60_000 ? C.warn : C.dim;
const line = `  ${toolColor}${pulse}${C.reset} ${toolColor}${C.bold}${runningTool.name}${C.reset}${descStr}${progress} ${elapsedColor}(${elapsedStr})${C.reset} ${C.dim}…${C.reset}`;
```

Effetto: l'utente vede sempre un timer accanto al tool, e diventa giallo/rosso dopo 60s. Niente più "è vivo o è morto?".

---

### B. ~15 tool su ~30 non emettono `toolProgress` (zero feedback)
**File:** `src/tools/index.js` — emitToolProgress è chiamato da: read_pdf, browser_check, run_checks, repo_map, run_tests, bash, bash_session, video_transcript, video_describe, audio_read, webfetch, web_image, websearch, generate_scene_image, generate_scene_clip, assemble_music_video.

**Tool che NON emettono progress:**
- `read`, `write`, `edit`, `apply_patch_structured` (file I/O)
- `glob`, `grep`, `list_dir`, `file_info` (file discovery)
- `git_status`, `git_diff` (git)
- `dev_server`, `dep_inspect`, `repo_find_symbol`
- `audio_transcribe`, `image_*`, `memory_*`
- `ask_user` (gestito diversamente, OK)
- `todo_write` (gestito diversamente, OK)

Per `read` su un file da 50MB, `grep` su un monorepo, `repo_map` su un progetto grosso, l'utente vede solo il pulse e basta.

**Fix raccomandato:**
1. **Heartbeat globale nel TUI per ogni tool in esecuzione**, indipendentemente dal tool. Crea un `setInterval` che aggiorna `tui.streaming.tools[i].lastTickAt = Date.now()` e marca `needsRender = true` ogni 500 ms durante un tool. Mostra l'elapsed time basato su `startMs` (vedi fix A).
2. **Per i tool senza progress, aggiungi un emit iniziale** in ogni handler: `emitToolProgress(name, args, 'Esecuzione…')` come prima riga. Costo: 1 riga di codice per tool, ROI immediato.

---

### C. `lastActivityAt` si aggiorna SOLO su `toolProgress` (non sul heartbeat)
**File:** `src/app/native-ui.js:464-473`

```js
uiBridge.on('toolProgress', ({ name, key, message }) => {
  if (!tui.streaming) return;
  tui.streaming.lastActivityAt = Date.now();
  ...
});
```

Il watchdog di stallo (`native-ui.js:832-866`) misura l'idle da `lastActivityAt`. Se un tool è silenzioso per 5 minuti (read su file lentissimo, webfetch in attesa di TCP), l'utente vede 5 minuti di "thinking…" e basta. Il watchdog avvisa solo a 300s.

**Fix raccomandato:**
- Aggiorna `lastActivityAt` ad ogni frame del render loop durante `isRunning`, non solo su `toolProgress`. In `startRenderLoop`:
  ```js
  renderLoop = setInterval(() => {
    if (tui.needsRender || tui.isRunning) {
      tui.render();
      tui.needsRender = false;
      if (tui.isRunning && tui.streaming?.waitKind === 'tool') {
        tui.streaming.lastActivityAt = Date.now(); // ← aggiungi
      }
    }
  }, 16);
  ```
- Così il watchdog misura "l'utente vede qualcosa che si muove" e non "il tool ha emesso un evento".

---

### D. Tool output viene renderizzato in full nel frame successivo
**File:** `src/app/native-ui.js:434-448` (`toolEnd`), `tui-native.js:_renderStreamingFull`

Quando un tool termina, `toolEnd` salva l'output completo in `tool.output`. `_renderStreamingFull` lo renderizza (assieme a tutto il resto) al prossimo frame. Se `webfetch` ha restituito 50KB o `grep` ha restituito 10k righe, il render successivo fa il parsing markdown + ANSI sanitize di 50KB in un colpo, bloccando il main thread per 100-500 ms.

**Fix raccomandato:**
- Tronca `tool.output` per il rendering a 4 KB (le prime 2KB + le ultime 2KB), e salva `tool.outputFull` con l'originale. Aggiungi un link "show full output" (es. tasto `o` o `/output <tool_id>`).
- Quando il tool completa, NON emettere `toolEnd` con tutto l'output inline nel `streaming` — emetti solo il riassunto. Il full output viene letto al bisogno.

Skeleton:
```js
// In toolEnd handler (native-ui.js:434):
const FULL_LIMIT = 4096;
const display = String(output).length > FULL_LIMIT
  ? String(output).slice(0, FULL_LIMIT / 2) + '\n[…truncated, /output ' + id + ' for full…]\n' + String(output).slice(-FULL_LIMIT / 2)
  : output;
tool.displayOutput = display;
tool.fullOutput = output;
tool.output = display; // backward-compat
```

---

### E. Nessun modo di abortire un tool in modo selettivo
**File:** `src/app/native-ui.js:1399-1413` (keypress Ctrl+C / ESC)

ESC durante `isRunning` chiama `agent?.cancel()` che aborta TUTTO il run, non solo il tool corrente. Se l'utente vuole solo annullare un singolo tool, non può.

**Fix raccomandato (nice-to-have):**
- Aggiungi un tasto `x` durante un tool call → solo quel tool viene skippato con output `Error: skipped by user`, e il loop continua con gli altri tool del batch.
- Per fare questo serve che `executeParsedTool` osservi un AbortSignal "per-tool", non solo quello globale del run.

---

## Priorità per il caso "tool call freeze"

Sulla base di questo drill-down, ordino diversamente:

1. **Fix A** (elapsed time visibile) — 10 righe, impatto immediato. **DA FARE PRIMA.**
2. **Fix C** (heartbeat del render aggiorna `lastActivityAt`) — 3 righe, watchdog diventa realistico.
3. **Fix D** (truncate tool output a 4 KB) — 20 righe, elimina i freeze post-tool.
4. **Fix B.1** (heartbeat globale per tutti i tool) — 15 righe, uniforma il feedback.
5. **Fix B.2** (emit iniziale per ogni tool) — 30 righe (1 per tool), zero sforzo.
6. **Fix E** (abort selettivo) — medio, nice-to-have, non bloccante.

Con Fix A+C+D (45 righe totali) il "freeze durante tool call" dovrebbe ridursi al rumore di fondo. Le altre sono ciliegina.

---

## PATCH APPLICATE (2026-08-14)

Tre modifiche mirate, ~20 righe effettive in totale, focus su "tool call freeze":

### Patch 1 — `src/app/tui-native.js` (Fix A)
Aggiunto elapsed time + liveness fallback nel render del tool in esecuzione (`_renderStreamingFull`, linea ~876).

**Cosa vede l'utente adesso:**
```
  ◐ read file_path=src/big.ts … [5s] (ancora in esecuzione…)
  ◐ bash command="npm test" … [42s] (in attesa completamento tool…)
  ◐ webfetch url=… … [2m15s] ← giallo dopo 60s
  ◐ repo_map … [3m42s] ← rosso dopo 180s
```

I colori sono:
- `dim` (grigio) per 0-60s
- `warn` (giallo) per 60-180s
- `err` (rosso) per >180s

Il fallback "(ancora in esecuzione…)" appare automaticamente per i tool silenziosi (read, write, edit, grep, glob, git_*, list_dir, file_info, dev_server, dep_inspect, …) dopo 3 secondi senza un loro `toolProgress` esplicito.

### Patch 2 — `src/app/native-ui.js` (Fix C)
Aggiornato `lastActivityAt` ad ogni frame del render loop durante l'attesa di un tool (`startRenderLoop`, linea ~818).

**Effetto:** il watchdog di stallo (che si attiva a 300s) misura ora "l'utente vede qualcosa muoversi" e non "il tool ha emesso un evento". Un tool lento su disco non triggera più un messaggio di errore dopo 5 minuti se l'UI sta continuando a mostrare il timer che scorre.

### Patch 3 — `src/agents/index.js` (Fix B.2 centralizzato)
Aggiunto un emit iniziale `toolProgress` con messaggio "Avvio…" per OGNI tool, prima dell'esecuzione, in `executeParsedTool` (linea ~1465).

**Effetto:** anche i tool che non hanno un loro `emitToolProgress` (read, write, edit, grep, glob, list_dir, file_info, git_*, dep_inspect, repo_find_symbol, …) ora mostrano un feedback immediato "Avvio…" che viene poi sovrascritto dal loro progress specifico o lasciato in place se sono veramente silenziosi.

### Verifica pipeline

**Pipeline eseguita con successo (utente, 2026-08-14):**

| Step | Esito |
|------|-------|
| `npm test` | ✅ 461 passed, 0 failed (11.5s) |
| `npm run lint` | ✅ nessun errore |
| `python3 test_display.py` | ✅ 0 issues su 4 scenari + regression |

Nessuna patch ha richiesto adattamenti nei test esistenti. Le ipotesi "potrebbe rompere asserzioni" non si sono verificate: i test sul TUI non ispezionano la stringa esatta del render del tool running, e i test sul tool scheduling contano gli eventi con tolleranza su quelli extra.

---

## FOLLOW-UP: model wait freeze (2026-08-14, 18:59)

**Trigger:** l'utente ha ricevuto in tempo reale il messaggio `Error: stallo rilevato (nessun token dal modello da 300s). Operazione annullata automaticamente.` — esattamente il caso coperto dal report ma sul ramo `waitKind === 'model'` invece di `waitKind === 'tool'`.

**Cosa mancava nelle 3 patch iniziali:** il freeze durante l'attesa del modello (no tool in esecuzione, nessun testo ancora visibile, solo `●●● thinking…`) era visivamente identico a un'attesa di 1 secondo. Per 5 minuti l'utente vedeva solo il pulse e basta.

### Fix M — Elapsed time + escalation colore durante model wait

**File:** `src/app/tui-native.js`, `_renderStreamingFull` (~line 794 e 813).

**Prima:**
```
●●● thinking…
stato: in attesa risposta modello…     (sempre accent, sempre lo stesso)
```
(per 5 minuti, fino al watchdog)

**Dopo:**
```
●●● thinking… [3s]                       ← dim
●●● thinking… [42s]                      ← dim
●●● thinking… [1m15s]                    ← warn (giallo)
●●● thinking… [3m42s]                    ← err (rosso)
stato: in attesa risposta modello…        ← colore che escala insieme
```

L'utente vede il tempo scorrere e può premere ESC prima che il watchdog a 300s tagli la connessione. Il watchdog rimane come hard cap — la differenza è che l'utente ora ha scelta.

### Decisione esplicita: NO heartbeat per model wait

Fix C (render loop aggiorna `lastActivityAt` durante l'attesa) NON è stato esteso a `waitKind === 'model'`. Motivo: se il provider è genuinamente down o il modello è hung, l'utente vuole che il watchdog a 300s tagli comunque. Aggiungere un heartbeat per il model wait impedirebbe al watchdog di funzionare, trasformando un hang in un'attesa infinita.

Il compromesso: l'utente vede `[Xs]` salire e preme ESC se vuole, oppure aspetta i 300s e il watchdog fa il suo dovere.

### Verifica da fare

Stesse raccomandazioni di prima — niente di rotto atteso, ma vale la pena:
1. `npm test` — i test esistenti non ispezionano la stringa esatta del "thinking…" label
2. `npm run lint`
3. `python3 test_display.py` — il layout dovrebbe reggere l'aggiunta di `[Xs]` e la riga `stato: …` colorata

---

## FOLLOW-UP #2: timer nascosto sotto la fold (2026-08-14, 19:10)

**Trigger:** l'utente segnala che ETTORE si è "bloccata così" con la sola riga `Piano: …` + `Prossimo passo: cerco "q-scaletta: …"` visibile. Il grep tool era partito, ma il `[Xs]` aggiunto con Fix A nella sezione "tool attivo" in fondo al blocco assistant era **clippato dal layout** (il piano testuale occupava lo spazio visibile, la sezione in fondo era sotto la fold).

**Causa:** Fix A metteva il timer nel posto sbagliato. La sezione "tool attivo" sta DOPO la visualizzazione del testo nel blocco assistant. Se il testo è lungo, la sezione tool attivo esce dalla viewport e l'utente vede solo il piano.

### Fix A2 — Timer sempre in cima al blocco

**File:** `src/app/tui-native.js`, `_renderStreamingFull`, costruzione di `actLabel` (linea ~784).

Il timer `[Xs]` adesso vive dentro l'`actLabel`, la PRIMA riga del blocco assistant — quella con il pulse + nome del tool. Sempre visibile sopra la fold, anche se il blocco è alto 1 sola riga o se il piano testuale è lungo.

La sezione "tool attivo" resta dov'è (in fondo), con il suo `[Xs]` ridondante per chi ha abbastanza spazio — ma la fonte di verità per l'utente è la riga in cima.

### Verifica da fare

Riavvia ETTORE (`Ctrl+D` o `/exit` + `node bin/cli.js`) e riaccrocca lo stesso scenario (es. `trova "scaletta"` o un `grep` qualunque). Dovresti vedere nella riga in cima al blocco:

```
◐ grep pattern="..." … [3s]      ← grigio
◐ grep pattern="..." … [42s]     ← grigio  
◐ grep pattern="..." … [1m15s]   ← giallo
◐ grep pattern="..." … [3m42s]   ← rosso
```

Se vedi ancora "Piano: …" senza `[Xs]` accanto al nome del tool, le patch non sono state caricate — riavvia e riprova.

---

## FOLLOW-UP #3: retry su tool call malformata invisibile (2026-08-14, 19:19)

**Trigger:** l'utente ha visto ETTORE bloccarsi con `The previous tool call was malformed. Let me retry with valid JSON arguments.` senza capire cosa stesse succedendo.

**Causa:** l'agent ha già la logica di retry per tool call malformate (`_retryAfterInvalidToolArgs` in `src/agents/index.js:554`), che emette un `toolProgress` con `name: 'tool-args-retry'` per segnalare l'evento. Ma il TUI handler di `toolProgress` cerca solo tool running con quel nome, e `'tool-args-retry'` non è un tool reale — il messaggio veniva **silenziosamente droppato**.

L'utente vedeva solo il testo del modello ("let me retry") senza sapere che l'agent era in modalità retry. Identico, visivamente, a un hang del modello.

### Fix R — Surface agent-level recovery events come system message

**File:** `src/app/native-ui.js`, handler `uiBridge.on('toolProgress')` (linea ~464).

Quando il nome del progress è uno dei "recovery" event dell'agent (`tool-args-retry`, `loop-recovery`, `auto-continue`), viene pushato come system message nel conversation log. L'utente vede:

```
⚠ Provider rejected tool arguments (400). Retrying with strict-JSON nudge.
```

invece di:

```
The previous tool call was malformed. Let me retry with valid JSON arguments.
```

Da solo non è abbastanza per distinguere un retry lento da un hang, ma rende esplicito **che c'è un recovery in corso**, dando contesto per decidere se aspettare o premere ESC.

### Verifica da fare

Riavvia ETTORE, riproduci un caso di tool call malformata (es. forza il modello a emettere un tool call con argomenti non-JSON). Dovresti vedere il system message `⚠ Provider rejected tool arguments (...)` prima della risposta del modello.

### Follow-up cumulativo: 5 fix applicate

| # | File | Cosa risolve |
|---|------|--------------|
| Fix A | `src/app/tui-native.js` | Timer `[Xs]` per tool running |
| Fix C | `src/app/native-ui.js` | Watchdog non scatta durante tool wait se UI è viva |
| Fix B.2 | `src/agents/index.js` | Emit "Avvio…" per ogni tool |
| Fix M | `src/app/tui-native.js` | Timer `[Xs]` per model wait (thinking…) |
| Fix A2 | `src/app/tui-native.js` | Timer sempre in cima al blocco (actLabel) |
| Fix R | `src/app/native-ui.js` | Surface retry/recovery events come system message |

---

## FOLLOW-UP #4: watchdog aggressivo + soft warning (2026-08-14, 19:31)

**Trigger:** l'utente ha continuato a ricevere `Error: stallo rilevato (nessun token dal modello da 300s). Operazione annullata automaticamente.` anche con le fix precedenti. Dice: *"penso che sia un problema di agente"*.

**Diagnosi:** le fix precedenti davano visibilità ma non toccavano il problema vero — la soglia di 300s era troppo permissiva. Il modello genuinamente non risponde in 5 minuti. Meglio fallire prima e lasciare che l'utente riaccrochi o cambi modello.

### Fix S — Watchdog più aggressivo + soft warning

**File:** `src/app/native-ui.js`, `startStallWatchdog` (linea ~855).

**Cambiamenti:**

1. **Soglia hard ridotta:**
   - Modello normale: 120s → **90s**
   - Modello long-reasoning (MiniMax M2.7, NVIDIA Kimi): 300s → **180s**
   - Tool: 300s (invariato, legittimamente può essere lungo)

2. **Soft warning a 60s (model) / 120s (tool):**
   - Pusha un system message `⚠ Modello senza risposta da 60s — se continua, premi ESC per annullare o cambia modello con /use.`
   - Non cancella nulla, dà solo contesto azionabile
   - Flag `_softWarned` su `tui.streaming` previene duplicati

3. **Threshold configurabile via env var:**
   - `ETTORE_STALL_TIMEOUT_MS=60000` per forzare 60s
   - Utile per utenti connessioni lente che vogliono soglia più alta, o per debugging

4. **Messaggio di errore migliorato:**
   - Aggiunge suggerimenti actionable: riprova con `/use`, riduci con `/compress`, override con env var
   - Era solo "stallo rilevato, annullato" — ora guida l'utente al prossimo passo

### Cosa vede l'utente adesso

Sequenza tipica di un model hung:

```
●●● thinking… [55s]
stato: in attesa risposta modello…       ← Fix M, dim
●●● thinking… [61s]                      
⚠ Modello senza risposta da 61s — se continua, premi ESC per annullare o cambia modello con /use.   ← Fix S soft warning
●●● thinking… [1m30s]                     ← dim
●●● thinking… [2m45s]                     ← err (rosso, Fix M)
●●● thinking… [3m]                        
Error: stallo rilevato (nessun token dal modello da 180s). Operazione annullata automaticamente.   ← Fix S, soglia ridotta
Suggerimenti: (1) riprova con /use per cambiare modello, (2) riduci il contesto con /compress, (3) imposta ETTORE_STALL_TIMEOUT_MS per cambiare la soglia.
```

A 60s l'utente sa che qualcosa non va. A 90-180s (dipende dal modello) il watchdog taglia, con suggerimenti su cosa fare.

### Cumulative: 7 fix applicate

| # | File | Cosa risolve |
|---|------|--------------|
| Fix A | `src/app/tui-native.js` | Timer `[Xs]` per tool running |
| Fix C | `src/app/native-ui.js` | Watchdog non scatta durante tool wait se UI è viva |
| Fix B.2 | `src/agents/index.js` | Emit "Avvio…" per ogni tool |
| Fix M | `src/app/tui-native.js` | Timer `[Xs]` per model wait (thinking…) |
| Fix A2 | `src/app/tui-native.js` | Timer sempre in cima al blocco (actLabel) |
| Fix R | `src/app/native-ui.js` | Surface retry/recovery events come system message |
| **Fix S** | `src/app/native-ui.js` | Watchdog aggressivo (90/180s) + soft warning 60s + env var config |




