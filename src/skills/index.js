import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class SkillSystem {
  constructor() {
    this.skills = new Map();
  }
  
  async loadSkill(name, skillPath) {
    try {
      const skillModule = await import(skillPath);
      const skill = skillModule.default || skillModule;
      
      this.skills.set(name, {
        name,
        description: skill.description || '',
        instructions: skill.instructions || '',
        tools: skill.tools || []
      });
      
      return { success: true, skill: this.skills.get(name) };
    } catch (error) {
      return { error: error.message };
    }
  }
  
  async loadAllSkills(skillsDir = null) {
    const dir = skillsDir || join(__dirname, '../skills');
    const files = await readdir(dir).catch(() => []);
    
    for (const file of files) {
      if (file.endsWith('.js') || file.endsWith('.mjs')) {
        const name = file.replace(/\.(js|mjs)$/, '');
        await this.loadSkill(name, join(dir, file));
      }
    }
  }
  
  getSkill(name) {
    return this.skills.get(name);
  }
  
  getAllSkills() {
    return Array.from(this.skills.values());
  }
  
  getSystemPrompt() {
    const skills = this.getAllSkills();
    if (skills.length === 0) return '';
    
    const skillDescriptions = skills.map(s => 
      `- ${s.name}: ${s.description}`
    ).join('\n');
    
    return `\n\nAvailable skills:\n${skillDescriptions}`;
  }
  
  getSkillInstructions(name) {
    const skill = this.skills.get(name);
    return skill?.instructions || '';
  }
}

export const defaultSkills = `
Skills available:
- code: Specializzato in scrittura e analisi codice
- debug: Analisi e risoluzione bug
- refactor: Refactoring e miglioramento codice
- explore: Esplorazione codebase
`;
