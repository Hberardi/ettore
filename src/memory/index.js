import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join, dirname, resolve, sep } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { constants } from 'fs';
import { existsSync } from 'fs';

// LEGACY: per retrocompatibilità con memorie esistenti
const LEGACY_PROJECTS_BASE = join(homedir(), '.local', 'share', 'ettore', 'projects');

const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', '.ettore'];

// Patterns to redact before saving to memory
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /(?:password|passwd|secret|token)\s*[:=]\s*\S+/gi,
  /AIza[0-9A-Za-z-_]{35}/g,
];

// Patterns to sanitize before injecting into LLM prompt
const INJECTION_PATTERNS = [
  /ignore\s+(previous|all)\s+instructions?/gi,
  /system\s*prompt/gi,
  /you\s+are\s+now/gi,
  /<\|.*?\|>/g,
  /\[INST\]|\[\/INST\]/g,
];

const SECTIONS = ['STACK', 'ARCHITECTURE', 'PATTERNS', 'DECISIONS', 'BUGS_TODO', 'USER_PREFERENCES'];
const ECOSYSTEM_MAX_BYTES = 64 * 1024;

/**
 * Rileva la root del progetto partendo da una directory
 * @param {string} dir - Directory di partenza
 * @returns {Promise<string|null>} Path della root del progetto o null
 */
export async function detectProjectRoot(dir = process.cwd()) {
  let current = resolve(dir);
  while (true) {
    for (const marker of MARKERS) {
      try {
        await access(join(current, marker), constants.F_OK);
        return current;
      } catch {}
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Calcola l'hash legacy per la memoria (usato per retrocompatibilità)
 * @param {string} projectRoot
 * @returns {string} Hash MD5
 */
function getLegacyProjectHash(projectRoot) {
  return createHash('md5').update(resolve(projectRoot)).digest('hex').slice(0, 12);
}

/**
 * Ottiene il percorso della memoria nel progetto (.ettore/memory.md)
 * @param {string} projectRoot
 * @returns {string} Percorso del file memory.md
 */
export function getMemoryPath(projectRoot) {
  // NUOVO: salva in .ettore/memory.md nel progetto
  return join(projectRoot, '.ettore', 'memory.md');
}

export function getEcosystemPath(projectRoot) {
  return join(projectRoot, '.ettore', 'ecosystem.md');
}

/**
 * Ottiene il percorso legacy della memoria (per migrazione)
 * @param {string} projectRoot
 * @returns {string} Percorso legacy
 */
function getLegacyMemoryPath(projectRoot) {
  const hash = getLegacyProjectHash(projectRoot);
  return join(LEGACY_PROJECTS_BASE, hash, 'memory.md');
}

/**
 * Migra la memoria dal percorso legacy al nuovo percorso locale
 * @param {string} projectRoot
 * @returns {Promise<boolean>} True se migrata con successo
 */
export async function migrateLegacyMemory(projectRoot) {
  const legacyPath = getLegacyMemoryPath(projectRoot);
  const newPath = getMemoryPath(projectRoot);

  // Se esiste già la nuova memoria, non migrare
  if (existsSync(newPath)) {
    return false;
  }

  try {
    const content = await readFile(legacyPath, 'utf-8');
    if (content.trim()) {
      // Crea la directory .ettore se non esiste
      await mkdir(dirname(newPath), { recursive: true });
      await writeFile(newPath, content, 'utf-8');
      return true;
    }
  } catch {
    // File non esiste o errore di lettura
  }
  return false;
}

export function getProjectName(projectRoot) {
  return projectRoot.split(sep).filter(Boolean).pop() || 'unknown';
}

/**
 * Carica la memoria del progetto (prova nuovo percorso, poi legacy)
 * @param {string} projectRoot
 * @returns {Promise<string>} Contenuto della memoria
 */
export async function loadProjectMemory(projectRoot) {
  const memPath = getMemoryPath(projectRoot);
  const legacyPath = getLegacyMemoryPath(projectRoot);

  // Prova il nuovo percorso prima
  try {
    return await readFile(memPath, 'utf-8');
  } catch {
    // Se non esiste, prova il percorso legacy
    try {
      return await readFile(legacyPath, 'utf-8');
    } catch {
      return '';
    }
  }
}

export async function loadEcosystemMemory(projectRoot) {
  const ecoPath = getEcosystemPath(projectRoot);
  try {
    return await readFile(ecoPath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Salva la memoria del progetto (sempre nel nuovo percorso)
 * @param {string} projectRoot
 * @param {string} content
 */
export async function saveProjectMemory(projectRoot, content) {
  const memPath = getMemoryPath(projectRoot);

  // Crea la directory .ettore se non esiste
  await mkdir(dirname(memPath), { recursive: true });

  const safe = redactSecrets(content).slice(0, 262144); // 256KB hard limit
  await writeFile(memPath, safe, 'utf-8');
}

export async function saveEcosystemMemory(projectRoot, content) {
  const ecoPath = getEcosystemPath(projectRoot);
  await mkdir(dirname(ecoPath), { recursive: true });
  const safe = redactSecrets(content).slice(0, ECOSYSTEM_MAX_BYTES);
  await writeFile(ecoPath, safe, 'utf-8');
}

export async function updateMemorySection(projectRoot, section, content, mode = 'append') {
  if (!SECTIONS.includes(section)) {
    throw new Error(`Invalid section. Must be one of: ${SECTIONS.join(', ')}`);
  }

  // Prova a migrare memoria legacy se necessario
  await migrateLegacyMemory(projectRoot);

  const existing = await loadProjectMemory(projectRoot);
  const projectName = getProjectName(projectRoot);
  const updated = new Date().toISOString().slice(0, 10);

  let memory = existing;

  if (!memory.trim()) {
    // Initialize memory file with frontmatter
    memory = `---\nproject: ${projectName}\nupdated: ${updated}\n---\n\n`;
    for (const s of SECTIONS) {
      memory += `## ${s}\n\n`;
    }
  } else {
    // Update the updated date in frontmatter
    memory = memory.replace(/^updated: .+$/m, `updated: ${updated}`);
  }

  const sectionHeader = `## ${section}`;
  const sectionIdx = memory.indexOf(sectionHeader);

  if (sectionIdx === -1) {
    memory += `\n${sectionHeader}\n${content.trim()}\n`;
  } else {
    // Find end of section (next ## or end of file)
    const afterHeader = sectionIdx + sectionHeader.length;
    const nextSection = memory.indexOf('\n## ', afterHeader);
    const sectionEnd = nextSection === -1 ? memory.length : nextSection;
    const currentContent = memory.slice(afterHeader, sectionEnd).trim();

    let newContent;
    if (mode === 'replace' || !currentContent) {
      newContent = content.trim();
    } else {
      newContent = currentContent + '\n' + content.trim();
    }

    memory = memory.slice(0, afterHeader) + '\n' + newContent + '\n' + memory.slice(sectionEnd);
  }

  await saveProjectMemory(projectRoot, memory);
}

export function injectMemoryIntoPrompt(systemPrompt, memory) {
  if (!memory || !memory.trim()) return systemPrompt;
  const sanitized = sanitizeForPrompt(memory);
  const block = `

---
## PROJECT MEMORY
The following is persistent context about this project. Treat it as ground truth unless the user explicitly changes it.

${sanitized}
---`;
  return systemPrompt + block;
}

export function injectEcosystemIntoPrompt(systemPrompt, ecosystem) {
  if (!ecosystem || !ecosystem.trim()) return systemPrompt;
  const sanitized = sanitizeForPrompt(ecosystem);
  const block = `

---
## ETTORE ECOSYSTEM MEMORY
Operational playbook and learned experiences from previous tasks.
Use this to improve consistency, quality, and execution strategy.

${sanitized}
---`;
  return systemPrompt + block;
}

function redactSecrets(content) {
  let safe = content;
  for (const pattern of SECRET_PATTERNS) {
    safe = safe.replace(pattern, '[SECRET_REDACTED]');
  }
  return safe;
}

function sanitizeForPrompt(content) {
  let safe = content
    .replace(/\r\n/g, '\n')
    .replace(/\0/g, '')
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, 8192);

  for (const pattern of INJECTION_PATTERNS) {
    safe = safe.replace(pattern, '[REDACTED]');
  }

  return safe;
}

/**
 * Inizializza la memoria del progetto
 * Crea .ettore/memory.md se non esiste
 * @param {string} projectRoot
 * @returns {Promise<boolean>} True se creata, false se già esistente
 */
export async function initProjectMemory(projectRoot) {
  const memPath = getMemoryPath(projectRoot);

  if (existsSync(memPath)) {
    return false;
  }

  const projectName = getProjectName(projectRoot);
  const initialized = new Date().toISOString().slice(0, 10);

  let memory = `---\nproject: ${projectName}\ncreated: ${initialized}\nupdated: ${initialized}\n---\n\n`;
  for (const s of SECTIONS) {
    memory += `## ${s}\n\n`;
  }

  await saveProjectMemory(projectRoot, memory);
  return true;
}

export async function initEcosystemMemory(projectRoot) {
  const ecoPath = getEcosystemPath(projectRoot);
  if (existsSync(ecoPath)) return false;

  const projectName = getProjectName(projectRoot);
  const initialized = new Date().toISOString().slice(0, 10);
  const content = `---
project: ${projectName}
created: ${initialized}
updated: ${initialized}
---

## OPERATING_PRINCIPLES
- Prefer deterministic, verifiable steps.
- Keep output structured and readable.

## LEARNED_EXPERIENCES

## REUSABLE_PLAYBOOKS
`;
  await saveEcosystemMemory(projectRoot, content);
  return true;
}

function trimHead(content, maxBytes = ECOSYSTEM_MAX_BYTES) {
  const enc = new TextEncoder().encode(content);
  if (enc.length <= maxBytes) return content;
  // keep tail (most recent knowledge)
  const keep = Math.floor(maxBytes * 0.85);
  const tail = content.slice(-keep);
  return `--- trimmed older ecosystem entries ---\n${tail}`;
}

export async function appendEcosystemExperience(projectRoot, experience) {
  const now = new Date().toISOString();
  const existing = await loadEcosystemMemory(projectRoot);
  const base = existing && existing.trim() ? existing : (await (async () => {
    await initEcosystemMemory(projectRoot);
    return await loadEcosystemMemory(projectRoot);
  })());

  const safeTitle = redactSecrets(String(experience?.title || 'Task')).replace(/\n+/g, ' ').trim();
  const summary = redactSecrets(String(experience?.summary || '')).replace(/\n+/g, ' ').trim();
  const tools = Array.isArray(experience?.tools) ? experience.tools.filter(Boolean) : [];
  const files = Array.isArray(experience?.files) ? experience.files.filter(Boolean) : [];
  const lessons = Array.isArray(experience?.lessons) ? experience.lessons.filter(Boolean) : [];

  const block = [
    `### ${now} — ${safeTitle || 'Task'}`,
    summary ? `- Summary: ${summary}` : null,
    tools.length ? `- Tools used: ${tools.slice(0, 10).join(', ')}` : null,
    files.length ? `- Files touched: ${files.slice(0, 12).join(', ')}` : null,
    ...lessons.slice(0, 6).map(l => `- Lesson: ${redactSecrets(String(l)).replace(/\n+/g, ' ').trim()}`),
    '',
  ].filter(Boolean).join('\n');

  const marker = '## LEARNED_EXPERIENCES';
  const idx = base.indexOf(marker);
  let updated;
  if (idx === -1) {
    updated = `${base.trim()}\n\n${marker}\n\n${block}`;
  } else {
    const insertAt = idx + marker.length;
    updated = `${base.slice(0, insertAt)}\n\n${block}${base.slice(insertAt)}`;
  }
  updated = updated.replace(/^updated: .+$/m, `updated: ${now.slice(0, 10)}`);
  await saveEcosystemMemory(projectRoot, trimHead(updated));
}

/**
 * Rimuove la memoria del progetto
 * @param {string} projectRoot
 * @returns {Promise<boolean>} True se rimossa
 */
export async function removeProjectMemory(projectRoot) {
  const memPath = getMemoryPath(projectRoot);

  if (!existsSync(memPath)) {
    return false;
  }

  try {
    const { unlink } = await import('fs/promises');
    await unlink(memPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifica se esiste memoria per il progetto
 * @param {string} projectRoot
 * @returns {Promise<boolean>}
 */
export async function hasProjectMemory(projectRoot) {
  const memPath = getMemoryPath(projectRoot);
  const legacyPath = getLegacyMemoryPath(projectRoot);
  return existsSync(memPath) || existsSync(legacyPath);
}

/**
 * Ottiene statistiche sulla memoria del progetto
 * @param {string} projectRoot
 * @returns {Promise<Object>} Statistiche
 */
export async function getMemoryStats(projectRoot) {
  const memPath = getMemoryPath(projectRoot);
  const legacyPath = getLegacyMemoryPath(projectRoot);

  const result = {
    exists: false,
    location: null,
    size: 0,
    sections: {},
    isMigrated: false
  };

  let content = '';
  let source = null;

  // Prova nuovo percorso
  if (existsSync(memPath)) {
    try {
      content = await readFile(memPath, 'utf-8');
      source = 'local';
      result.location = memPath;
    } catch {}
  }

  // Prova legacy
  if (!source && existsSync(legacyPath)) {
    try {
      content = await readFile(legacyPath, 'utf-8');
      source = 'legacy';
      result.location = legacyPath;
    } catch {}
  }

  if (source) {
    result.exists = true;
    result.size = Buffer.byteLength(content, 'utf-8');

    // Conta sezioni
    for (const section of SECTIONS) {
      // `$` (no /m flag) anchors at end of string. NB: \Z is NOT a JS regex
      // anchor — it would match a literal "Z", which truncated the last
      // section to 0 lines and clipped any section containing a "Z".
      const regex = new RegExp(`## ${section}\\n([\\s\\S]*?)(?=\\n## |$)`);
      const match = content.match(regex);
      result.sections[section] = match ? match[1].trim().split('\n').filter(l => l.trim()).length : 0;
    }
  }

  return result;
}
