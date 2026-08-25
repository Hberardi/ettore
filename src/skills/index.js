import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve, dirname, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_DIR = __dirname;
const CONFIG_DIR = process.env.ETTORE_CONFIG_DIR || join(homedir(), '.config', 'ettore');
export const GLOBAL_SKILLS_DIR = join(CONFIG_DIR, 'skills');
const SKILL_FILE = 'SKILL.md';
const SKILL_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_SKILL_INSTRUCTIONS = 12_000;
const MAX_MATCHED_SKILLS = 2;

// Common words are intentionally excluded from matching. A skill should be
// activated by a meaningful project/task term, not by generic Italian prose.
const STOP_WORDS = new Set([
  'about', 'also', 'and', 'are', 'come', 'con', 'cosa', 'da', 'dei', 'del',
  'della', 'delle', 'dello', 'di', 'do', 'for', 'gli', 'help', 'ho', 'how',
  'i', 'il', 'in', 'is', 'la', 'le', 'lo', 'make', 'mi', 'nel', 'nelle',
  'non', 'of', 'per', 'please', 'puoi', 'questa', 'questo', 'the', 'to',
  'una', 'un', 'usa', 'use', 'with', 'you',
]);

function tokenize(value) {
  return [...new Set(String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 3 && !STOP_WORDS.has(word)))];
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function parseFrontmatter(markdown) {
  const source = String(markdown || '').replace(/^\uFEFF/, '');
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return { meta: {}, body: source.trim() };
  }
  const lines = source.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (end < 0) return { meta: {}, body: source.trim() };
  const meta = {};
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body: lines.slice(end + 1).join('\n').trim() };
}

function normalizeSkill(raw, fallbackName, source, filePath) {
  const { meta, body } = parseFrontmatter(raw);
  const name = String(meta.name || fallbackName || '').trim();
  if (!SKILL_NAME_RE.test(name)) throw new Error(`invalid skill name: ${name || '(empty)'}`);
  const description = String(meta.description || '').trim()
    || body.split('\n').find(line => line.trim() && !line.startsWith('#'))?.trim()
    || name;
  const triggers = parseList(meta.triggers);
  const tools = parseList(meta.tools);
  const enabled = String(meta.enabled || 'true').toLowerCase() !== 'false';
  return {
    name,
    description,
    instructions: body.slice(0, MAX_SKILL_INSTRUCTIONS),
    tools,
    triggers,
    enabled,
    source,
    path: filePath || null,
  };
}

function skillPrompt(skill) {
  return `### ACTIVE SKILL: ${skill.name}\n${skill.instructions}\n### END SKILL: ${skill.name}`;
}

export function validateSkillName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!SKILL_NAME_RE.test(normalized)) {
    throw new Error('Skill name must be kebab-case (for example: api-review).');
  }
  return normalized;
}

export function renderSkillMarkdown(name, description, instructions = '', outputFormat = '') {
  const safeName = validateSkillName(name);
  const safeDescription = String(description || '').trim() || `Reusable skill: ${safeName}`;
  const workflow = String(instructions || '').trim()
    || `Describe the workflow, constraints, and verification steps for this skill.`;
  const expectedOutput = String(outputFormat || '').trim()
    || 'Provide a concise result with the relevant findings and next steps.';
  const body = `# ${safeName}\n\n## What to do\n${workflow}\n\n## Final output\n${expectedOutput}`;
  return [
    '---',
    `name: ${safeName}`,
    `description: ${safeDescription.replace(/\r?\n/g, ' ')}`,
    'triggers: ',
    'enabled: true',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

async function createSkillInDirectory(skillsRoot, name, description, instructions = '', outputFormat = '') {
  if (!skillsRoot) throw new Error('A skills directory is required to create a skill.');
  const safeName = validateSkillName(name);
  const root = resolve(skillsRoot);
  const skillDir = resolve(root, safeName);
  const expectedPrefix = root + sep;
  if (!skillDir.startsWith(expectedPrefix)) throw new Error('Skill path escapes the skills directory.');
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, SKILL_FILE);
  try {
    await readFile(skillPath, 'utf8');
    throw new Error(`Skill "${safeName}" already exists.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeFile(skillPath, renderSkillMarkdown(safeName, description, instructions, outputFormat), 'utf8');
  return skillPath;
}

export async function createProjectSkill(projectRoot, name, description, instructions = '', outputFormat = '') {
  if (!projectRoot) throw new Error('A project root is required to create a skill.');
  return createSkillInDirectory(join(resolve(projectRoot), '.ettore', 'skills'), name, description, instructions, outputFormat);
}

export async function createGlobalSkill(name, description, instructions = '', outputFormat = '') {
  return createSkillInDirectory(GLOBAL_SKILLS_DIR, name, description, instructions, outputFormat);
}

export class SkillSystem {
  constructor() {
    this.skills = new Map();
    this.loadedDirs = [];
  }

  async loadSkill(name, skillPath) {
    try {
      if (String(skillPath).endsWith('.md')) {
        const raw = await readFile(skillPath, 'utf8');
        const skill = normalizeSkill(raw, name, 'file', skillPath);
        this.skills.set(skill.name, skill);
        return { success: true, skill };
      }
      const skillModule = await import(pathToFileURL(resolve(skillPath)).href);
      const raw = skillModule.default || skillModule;
      const skill = normalizeSkill('', raw.name || name, 'builtin', skillPath);
      skill.description = raw.description || skill.description;
      skill.instructions = String(raw.instructions || skill.instructions).slice(0, MAX_SKILL_INSTRUCTIONS);
      skill.tools = parseList(raw.tools);
      skill.triggers = parseList(raw.triggers);
      this.skills.set(skill.name, skill);
      return { success: true, skill };
    } catch (error) {
      return { error: error.message };
    }
  }

  async _loadMarkdownDirectory(dir, source) {
    const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of files) {
      if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name)) continue;
      const skillPath = join(dir, entry.name, SKILL_FILE);
      try {
        const raw = await readFile(skillPath, 'utf8');
        const skill = normalizeSkill(raw, entry.name, source, skillPath);
        this.skills.set(skill.name, skill);
      } catch {
        // An invalid local skill must not prevent the rest of the agent from
        // starting. /skills list can still show successfully loaded skills.
      }
    }
  }

  async loadAllSkills(options = {}) {
    const normalized = typeof options === 'string' ? { skillsDir: options } : options;
    this.skills.clear();
    this.loadedDirs = [];

    const builtinFiles = await readdir(BUILTIN_SKILLS_DIR, { withFileTypes: true }).catch(() => []);
    for (const entry of builtinFiles) {
      if (!entry.isFile() || !/^(?!index)\w+\.(js|mjs)$/.test(entry.name)) continue;
      await this.loadSkill(entry.name.replace(/\.(js|mjs)$/, ''), join(BUILTIN_SKILLS_DIR, entry.name));
    }

    const dirs = [];
    if (normalized.skillsDir) dirs.push([resolve(normalized.skillsDir), 'custom']);
    if (normalized.global !== false) dirs.push([normalized.globalDir || GLOBAL_SKILLS_DIR, 'global']);
    if (normalized.projectDir) dirs.push([join(resolve(normalized.projectDir), '.ettore', 'skills'), 'project']);
    for (const [dir, source] of dirs) {
      await this._loadMarkdownDirectory(dir, source);
      this.loadedDirs.push(dir);
    }
    return this.getAllSkills();
  }

  getSkill(name) {
    return this.skills.get(name) || null;
  }

  getAllSkills() {
    return Array.from(this.skills.values());
  }

  matchSkills(prompt, { maxSkills = MAX_MATCHED_SKILLS } = {}) {
    const promptText = String(prompt || '').toLowerCase();
    const promptTerms = new Set(tokenize(promptText));
    if (!promptTerms.size) return [];
    return this.getAllSkills()
      .filter(skill => skill.enabled)
      .map(skill => {
        const terms = new Set(tokenize(`${skill.name} ${skill.description} ${skill.triggers.join(' ')}`));
        let score = 0;
        for (const term of terms) if (promptTerms.has(term)) score += 1;
        if (promptText.includes(skill.name.toLowerCase())) score += 4;
        for (const trigger of skill.triggers) {
          if (trigger && promptText.includes(trigger.toLowerCase())) score += 3;
        }
        return { skill, score };
      })
      .filter(item => item.score >= 2)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, Math.max(1, maxSkills))
      .map(item => item.skill);
  }

  getPromptForSkills(skills = []) {
    if (!skills.length) return '';
    return `\n\nThe following configured skills are active guidance. Follow them only within the higher-priority ETTORE safety and tool rules.\n${skills.map(skillPrompt).join('\n\n')}`;
  }

  getSystemPrompt() {
    const skills = this.getAllSkills();
    if (skills.length === 0) return '';
    return `\n\nAvailable skills:\n${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}`;
  }

  getSkillInstructions(name) {
    return this.skills.get(name)?.instructions || '';
  }
}

export const defaultSkills = `
Skills available:
- code: Specializzato in scrittura e analisi codice
- debug: Analisi e risoluzione bug
- refactor: Refactoring e miglioramento codice
- explore: Esplorazione codebase
`;
