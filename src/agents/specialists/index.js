import { Agent } from '../index.js';
import { toolHandlers } from '../../tools/index.js';

export class ExplorerAgent extends Agent {
  constructor(client, config) {
    super(client, config);
    this.systemPrompt = `Sei un esploratore di codebase esperto. Il tuo compito è:
1. Analizzare la struttura del progetto
2. Trovare file rilevanti usando glob/grep
3. Leggere e comprendere il codice
4. Rispondere a domande sulla struttura e il funzionamento

Usa sempre \`glob\` per trovare file e \`read\` per leggere il contenuto.
Includi i path dei file nelle risposte.`;
  }
  
  async explore(prompt) {
    return this.run(`[EXPLORE MODE]\n${prompt}`, this.config);
  }
  
  async findFiles(pattern, path = process.cwd()) {
    return toolHandlers.glob({ pattern, path });
  }
  
  async searchCode(pattern, path = process.cwd()) {
    return toolHandlers.grep({ pattern, path });
  }
}

export class CodeReviewerAgent extends Agent {
  constructor(client, config) {
    super(client, config);
    this.systemPrompt = `Sei un esperto code reviewer. Il tuo compito è:
1. Leggere e analizzare il codice
2. Identificare bug, vulnerabilità, code smells
3. Proporre migliorie e best practices
4. Verificare che il codice segua le convenzioni

Sii critico ma costruttivo. Includi esempi concreti nelle review.`;
  }
  
  async review(prompt) {
    return this.run(`[CODE REVIEW MODE]\n${prompt}`, this.config);
  }
  
  async checkSecurity(code) {
    const issues = [];
    
    if (code.includes('eval(') || code.includes('exec(')) {
      issues.push('uso di eval/exec - potenziale vulnerabilità');
    }
    if (code.includes('password') && !code.includes('env')) {
      issues.push('password hardcoded rilevata');
    }
    if (code.includes('API_KEY') && !code.includes('process.env')) {
      issues.push('API key hardcoded');
    }
    
    return issues;
  }
}

export class DebugAgent extends Agent {
  constructor(client, config) {
    super(client, config);
    this.systemPrompt = `Sei un debugger esperto. Il tuo approccio:
1. Leggi e analizza il codice sorgente
2. Riproduci il bug se possibile
3. Identifica la causa radice
4. Proponi e implementa una fix
5. Verifica che funzioni

Usa il tool \`bash\` per eseguire test e comandi.`;
  }
  
  async debug(prompt) {
    return this.run(`[DEBUG MODE]\n${prompt}`, this.config);
  }
}

export class RefactorAgent extends Agent {
  constructor(client, config) {
    super(client, config);
    this.systemPrompt = `Sei un esperto refactoring. Il tuo compito è:
1. Analizzare il codice esistente
2. Identificare opportunità di miglioramento
3. Refactoring senza cambiare comportamento
4. Applicare design patterns dove appropriato
5. Migliorare leggibilità e manutenibilità

Mantieni la retrocompatibilità quando possibile.`;
  }
  
  async refactor(prompt) {
    return this.run(`[REFACTOR MODE]\n${prompt}`, this.config);
  }
}