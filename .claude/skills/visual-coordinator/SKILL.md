---
name: visual-coordinator
description: Coordinatore del team di verifica CLI — orchestra gli agenti specializzati in parallelo e sintetizza i risultati finali
---

# Visual Coordinator — Controllo CLI & LLM Integration

## Team di Verifica Disponibile

| Agente | Percorso Skill | Ruolo |
|--------|---------------|-------|
| **esperto-cli** | `.claude/skills/esperto-cli/SKILL.md` | Verifica UX, struttura comandi, standard CLI |
| **esperto-llm** | `.claude/skills/esperto-llm/SKILL.md` | Verifica integrazione LLM, prompt, API |
| **esperto-sicurezza** | `.claude/skills/esperto-sicurezza/SKILL.md` | Audit sicurezza, vulnerabilità, secrets |
| **esperto-programmatore** | `.claude/skills/esperto-programmatore/SKILL.md` | Review codice, architettura, performance |

## Flusso di Lavoro

```
┌─────────────────────────────────────────────────────────────┐
│                    PARALLELO                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ esperto- │  │ esperto- │  │ esperto- │  │ esperto- │   │
│  │   cli    │  │   llm    │  │sicurezza │  │programma-│   │
│  │          │  │          │  │          │  │  tore    │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │             │             │             │          │
│       └─────────────┴─────────────┴─────────────┘          │
│                         │                                  │
│                         ▼                                  │
│              ┌─────────────────────┐                       │
│              │  VISUAL-COORDINATOR │                       │
│              │     (SINTESI)       │                       │
│              └─────────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

## Istruzioni Operative

1. **Ricevi il task di verifica** dalla CLI utente
2. **Lancia tutti e 4 gli agenti in PARALLELO** con il task specifico
3. **Raccogli gli output** di ogni agente
4. **Sintetizza** i risultati in un report unico
5. **Identifica criticità** e priorità di intervento
6. **Restituisci** il report finale strutturato

## Task Template per ogni Agente

### Per esperto-cli:
```
TASK: Verifica UX e struttura della CLI in [percorso]
- Analizza la CLI attuale
- Valuta UX secondo standard Unix/POSIX
- Identifica problemi di usabilità
- Proponi miglioramenti specifici
- Valuta autocompletamento e help text
OUTPUT: Report dettagliato con score e raccomandazioni
```

### Per esperto-llm:
```
TASK: Verifica integrazione LLM in [percorso]
- Analizza come la CLI usa LLM
- Verifica configurazione API
- Valuta prompt e strategia modelli
- Controlla gestione errori e fallback
- Stima costi e ottimizzazioni
OUTPUT: Report integrazione LLM con criticità e suggerimenti
```

### Per esperto-sicurezza:
```
TASK: Audit sicurezza della CLI in [percorso]
- Scansiona vulnerabilità nel codice
- Verifica gestione secrets e credenziali
- Controlla input sanitization
- Identifica rischi command injection
- Fornisci security score
OUTPUT: Report sicurezza con vulnerabilità e fix
```

### Per esperto-programmatore:
```
TASK: Review codice e architettura in [percorso]
- Analizza struttura del codice
- Valuta qualità e manutenibilità
- Controlla gestione errori
- Verifica testing esistente
- Proponi refactoring se necessario
OUTPUT: Report codice con valutazione tecnica
```

## Output Atteso (Sintesi Finale)

```
# 🔍 REPORT VERIFICA COMPLETA — CLI & LLM Integration

## 📊 Executive Summary
- **Stato Generale**: [✅ OK / ⚠️ Migliorabile / ❌ Critico]
- **Score Complessivo**: [X/10]
- **Criticità Critiche**: [N]
- **Criticità Medie**: [N]
- **Criticità Basse**: [N]

---

## 🖥️ 1. VERIFICA CLI (esperto-cli)
[Inserire sintesi output esperto-cli]

---

## 🤖 2. VERIFICA INTEGRAZIONE LLM (esperto-llm)
[Inserire sintesi output esperto-llm]

---

## 🔒 3. AUDIT SICUREZZA (esperto-sicurezza)
[Inserire sintesi output esperto-sicurezza]

---

## 💻 4. REVIEW CODICE (esperto-programmatore)
[Inserire sintesi output esperto-programmatore]

---

## 🎯 RACCOMANDAZIONI PRIORITARIE

### 🔴 Critico (da risolvere immediatamente)
1. [azione] — [agente responsabile]

### 🟡 Medio (da risolvere questa settimana)
1. [azione] — [agente responsabile]

### 🟢 Basso (miglioramenti futuri)
1. [azione] — [agente responsabile]

---

## ✅ CHECKLIST IMPLEMENTAZIONE

- [ ] Fix critici sicurezza
- [ ] Ottimizzazione LLM integration
- [ ] Miglioramenti UX CLI
- [ ] Refactoring codice
- [ ] Test post-modifiche
```

## Comando di Invocazione

Quando viene chiamato `/visual-coordinator` o simile:

1. Leggi il percorso della CLI da verificare (workspace corrente o specificato)
2. Lancia i 4 agenti in parallelo usando i task template sopra
3. Attendi tutti i risultati
4. Compila il report finale seguendo il formato Output Atteso
5. Presenta il report all'utente
