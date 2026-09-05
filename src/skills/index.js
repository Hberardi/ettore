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
// Two was tight: a generic skill with common triggers took one of the slots on
// almost every prompt, leaving one for everything specific.
const MAX_MATCHED_SKILLS = 3;
// A trigger is the skill author saying "this is what I am for", so it outweighs
// anything inferred from prose. The name is a weaker version of the same claim.
const TRIGGER_WEIGHT = 4;
const NAME_WEIGHT = 3;
// Floor on the weighted score. Roughly "one reasonably distinctive word", which
// a single common word cannot reach on its own.
const MIN_SKILL_SCORE = 1.2;
// A candidate must also hold its own against the best one.
const RELATIVE_SKILL_CUTOFF = 0.45;

// Common words are intentionally excluded from matching. A skill should be
// activated by a meaningful project/task term, not by generic Italian prose.
const STOP_WORDS = new Set([
  // English
  'about', 'also', 'and', 'any', 'are', 'been', 'but', 'can', 'did', 'does',
  'doing', 'do', 'for', 'from', 'get', 'has', 'have', 'help', 'here', 'how',
  'into', 'is', 'it', 'its', 'just', 'make', 'me', 'more', 'much', 'my',
  'need', 'not', 'now', 'of', 'on', 'only', 'or', 'other', 'our', 'out',
  'over', 'please', 'so', 'some', 'than', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'to', 'use', 'using', 'very',
  'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'would', 'you', 'your',
  // Italian. The list was thin enough that "che ore sono" scored 2.3 against a
  // security skill: function words are most of a short prompt, so leaving them
  // in means the shortest prompts are the noisiest.
  'agli', 'alla', 'alle', 'allo', 'anche', 'ancora', 'avere', 'aveva', 'che',
  'chi', 'ci', 'come', 'con', 'cosa', 'cui', 'da', 'dal', 'dalla', 'dei',
  'del', 'della', 'delle', 'dello', 'di', 'dove', 'due', 'ecco', 'essere',
  'fare', 'gli', 'ha', 'hai', 'hanno', 'ho', 'il', 'invece', 'la', 'le',
  'lo', 'loro', 'ma', 'mi', 'mio', 'molto', 'ne', 'nel', 'nella', 'nelle',
  'no', 'noi', 'non', 'ora', 'per', 'perche', 'piu', 'poi', 'puoi', 'può',
  'puo', 'qua', 'quale', 'quali', 'quando', 'quanto', 'quel', 'quella',
  'quelle', 'quello', 'questa', 'queste', 'questi', 'questo', 'qui', 'sara',
  'se', 'sei', 'sia', 'siamo', 'solo', 'sono', 'stato', 'su', 'sul', 'sulla',
  'tra', 'tu', 'tuo', 'tutti', 'tutto', 'un', 'una', 'uno', 'usa', 'va',
  'vuoi', 'ancora',
]);

function tokenize(value) {
  return [...new Set(String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 3 && !STOP_WORDS.has(word)))];
}

/** Everything a skill offers for matching, deduplicated. */
function skillTerms(skill) {
  return tokenize(`${skill.name} ${skill.description} ${skill.triggers.join(' ')}`);
}

/**
 * Whether two words look like the same word.
 *
 * Not a stemmer: one has to be a prefix of the other, both long enough that
 * the shared part means something, and close enough in length that `rete`
 * cannot claim `retention`. It exists because prompts here are Italian and
 * skill names are often English — `colori` against `color` shared nothing at
 * all under exact matching.
 */
function sharesStem(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4) return false;
  if (!long.startsWith(short)) return false;
  return long.length - short.length <= 3;
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

  /**
   * Inverse document frequency across the loaded skills.
   *
   * The old score counted shared words, which made a long description more
   * likely to match anything at all: "refactoring del modulo di rete" woke a
   * security skill because `rete` and `refactoring` both appeared somewhere in
   * its prose. Weighting each term by how few skills use it fixes that from
   * the other end — a word every skill contains is worth almost nothing, and a
   * word only one skill uses is worth a lot — and it stops rewarding
   * verbosity, since the weight is per term, not per occurrence.
   */
  _termWeights() {
    const skills = this.getAllSkills().filter(skill => skill.enabled);
    if (this._weightsFor === skills.length && this._weights) return this._weights;
    const docs = skills.length || 1;
    const seen = new Map();
    for (const skill of skills) {
      for (const term of skillTerms(skill)) seen.set(term, (seen.get(term) || 0) + 1);
    }
    const weights = new Map();
    for (const [term, count] of seen) {
      weights.set(term, Math.log((docs + 1) / (count + 0.5)));
    }
    this._weights = weights;
    this._weightsFor = skills.length;
    return weights;
  }

  /**
   * Scores every enabled skill against a prompt. Exposed so the reason a skill
   * did or did not fire can be shown rather than guessed at.
   */
  scoreSkills(prompt) {
    const promptText = String(prompt || '').toLowerCase();
    const promptTerms = tokenize(promptText);
    if (!promptTerms.length) return [];
    const weights = this._termWeights();

    return this.getAllSkills()
      .filter(skill => skill.enabled)
      .map(skill => {
        const terms = skillTerms(skill);
        const matched = [];
        let score = 0;
        let exact = 0;
        // Each word of the prompt contributes at most once, at its best
        // available match. Scoring per skill term instead let one prompt word
        // collect a weight for every spelling of it in a long description.
        for (const word of promptTerms) {
          let bestWeight = 0;
          let label = null;
          for (const term of terms) {
            const weight = weights.get(term) ?? 1;
            if (term === word) {
              if (weight > bestWeight) { bestWeight = weight; label = term; }
            } else if (sharesStem(word, term)) {
              // A prompt in one language against a skill named in another —
              // `colori` against `audit-color` — shares a stem and nothing
              // else. Half weight: a coincidental stem cannot carry a match on
              // its own, but a real one is no longer invisible.
              const half = weight * 0.5;
              if (half > bestWeight) { bestWeight = half; label = `~${term}`; }
            }
          }
          if (label) {
            score += bestWeight;
            matched.push(label);
            if (!label.startsWith('~')) exact += 1;
          }
        }
        // Author intent, stated outright. Substring rather than token, so a
        // multi-word trigger works, and worth more than any inferred signal.
        for (const trigger of skill.triggers) {
          const t = String(trigger || '').toLowerCase().trim();
          if (t && promptText.includes(t)) {
            score += TRIGGER_WEIGHT;
            matched.push(`!${t}`);
          }
        }
        if (promptText.includes(skill.name.toLowerCase())) {
          score += NAME_WEIGHT;
          matched.push(`!${skill.name}`);
        }
        const explicit = matched.some(m => m.startsWith('!'));
        return { skill, score: Number(score.toFixed(3)), matched, explicit, exact };
      })
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  }

  matchSkills(prompt, { maxSkills = MAX_MATCHED_SKILLS } = {}) {
    const scored = this.scoreSkills(prompt);
    if (!scored.length) return [];
    // A stem match is a guess — `funziona` against `funzionale` — and a guess
    // alone is not evidence: "questo non funziona" would otherwise wake a web
    // design skill. It needs a second signal. An exact hit on a term the corpus
    // makes distinctive stands on its own, which is what lets `colori` reach a
    // skill called `audit-color`, and a trigger settles it outright.
    const eligible = scored.filter(item => item.explicit || item.exact >= 1 || item.matched.length >= 2);
    if (!eligible.length) return [];
    const best = eligible[0].score;
    if (best < MIN_SKILL_SCORE) return [];
    // Relative to the best candidate as well as to a floor: on a prompt with
    // an obvious match, a distant second is noise; on a vaguer one, several
    // near-equal skills are all plausible and all get through.
    const cutoff = Math.max(MIN_SKILL_SCORE, best * RELATIVE_SKILL_CUTOFF);
    return eligible
      .filter(item => item.score >= cutoff)
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
