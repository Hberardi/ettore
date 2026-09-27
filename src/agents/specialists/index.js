import { Agent } from '../index.js';
import { toolHandlers } from '../../tools/index.js';

export class ExplorerAgent extends Agent {
  constructor(client, config) {
    super(client, config);
    this.systemPrompt = `You are an expert codebase explorer. Your job is to:
1. Analyse the structure of the project
2. Find the relevant files with glob/grep
3. Read and understand the code
4. Answer questions about how it is structured and how it works

Always use \`glob\` to find files and \`read\` to read them.
Include file paths in your answers.`;
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
    this.systemPrompt = `You are an expert code reviewer. Your job is to:
1. Read and analyse the code
2. Find bugs, vulnerabilities and code smells
3. Suggest improvements and best practices
4. Check the code follows the project's conventions

Be critical but constructive. Include concrete examples in your reviews.`;
  }
  
  async review(prompt) {
    return this.run(`[CODE REVIEW MODE]\n${prompt}`, this.config);
  }
  
  async checkSecurity(code) {
    const issues = [];
    
    if (code.includes('eval(') || code.includes('exec(')) {
      issues.push('eval/exec in use — potential vulnerability');
    }
    if (code.includes('password') && !code.includes('env')) {
      issues.push('hardcoded password found');
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
    this.systemPrompt = `You are an expert debugger. Your approach:
1. Read and analyse the source code
2. Reproduce the bug if you can
3. Find the root cause
4. Propose and implement a fix
5. Check that it works

Use the \`bash\` tool to run tests and commands.`;
  }
  
  async debug(prompt) {
    return this.run(`[DEBUG MODE]\n${prompt}`, this.config);
  }
}

export class RefactorAgent extends Agent {
  constructor(client, config) {
    super(client, config);
    this.systemPrompt = `You are an expert at refactoring. Your job is to:
1. Analyse the existing code
2. Find opportunities to improve it
3. Refactor without changing behaviour
4. Apply design patterns where they fit
5. Improve readability and maintainability

Keep backwards compatibility wherever you can.`;
  }
  
  async refactor(prompt) {
    return this.run(`[REFACTOR MODE]\n${prompt}`, this.config);
  }
}