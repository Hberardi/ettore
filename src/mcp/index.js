import { EventEmitter } from 'events';
import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class MCPServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = options.name || 'ettore-mcp';
    this.version = options.version || '1.0.0';
    this.tools = new Map();
    this.resources = new Map();
    this.prompts = new Map();
    this.serverInfo = {
      name: this.name,
      version: this.version
    };
  }
  
  initialize(_initializeParams = {}) {
    return {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: this.tools.size > 0,
        resources: this.resources.size > 0,
        prompts: this.prompts.size > 0
      },
      serverInfo: this.serverInfo
    };
  }
  
  registerTool(name, handler, schema = {}) {
    this.tools.set(name, { handler, schema });
  }
  
  registerResource(uri, handler, mimeType = 'text/plain') {
    this.resources.set(uri, { handler, mimeType });
  }
  
  registerPrompt(name, template, description = '') {
    this.prompts.set(name, { template, description });
  }
  
  async listTools() {
    return Array.from(this.tools.keys()).map(name => ({
      name,
      description: this.tools.get(name).schema.description || ''
    }));
  }
  
  async callTool(name, args = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return tool.handler(args);
  }
  
  async listResources() {
    return Array.from(this.resources.keys()).map(uri => ({
      uri,
      mimeType: this.resources.get(uri).mimeType
    }));
  }
  
  async readResource(uri) {
    const resource = this.resources.get(uri);
    if (!resource) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return resource.handler(uri);
  }
  
  async listPrompts() {
    return Array.from(this.prompts.keys()).map(name => ({
      name,
      description: this.prompts.get(name).description
    }));
  }
  
  async getPrompt(name, args = {}) {
    const prompt = this.prompts.get(name);
    if (!prompt) {
      throw new Error(`Prompt not found: ${name}`);
    }
    
    let template = prompt.template;
    for (const [key, value] of Object.entries(args)) {
      template = template.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    
    return {
      messages: [{ role: 'user', content: { type: 'text', text: template } }]
    };
  }
  
  async loadServers(serversDir) {
    const dir = serversDir || join(__dirname, '../../mcp/servers');
    const files = await readdir(dir).catch(() => []);
    
    for (const file of files) {
      if (file.endsWith('.js') || file.endsWith('.mjs')) {
        try {
          const server = await import(join(dir, file));
          if (server.register) {
            server.register(this);
          }
        } catch (e) {
          console.error(`Failed to load MCP server ${file}:`, e.message);
        }
      }
    }
  }
}

export function createMCPTool(name, handler, schema = {}) {
  return { name, handler, schema };
}

export class MCPClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
  }
  
  async request(method, params = {}) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(this.serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`MCP server returned HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json();
    } catch (e) {
      throw new Error(`MCP request failed (${this.serverUrl}): ${e.message}`);
    } finally {
      clearTimeout(tid);
    }
  }
  
  async listTools() {
    return this.request('tools/list');
  }
  
  async callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }
  
  async listResources() {
    return this.request('resources/list');
  }
  
  async readResource(uri) {
    return this.request('resources/read', { uri });
  }
}
