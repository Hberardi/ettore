import OpenAI from 'openai';

const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export class OllamaProvider {
  constructor() {
    this.client = new OpenAI({
      apiKey: 'ollama',
      baseURL: OLLAMA_BASE_URL
    });
    this.name = 'ollama';
  }

  async listModels() {
    try {
      const response = await this.client.models.list();
      const models = response.data.map(m => ({ id: m.id }));
      return { success: true, models };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async validateKey() {
    try {
      await this.client.models.list();
      return { valid: true };
    } catch (error) {
      return { valid: false, error: `Cannot connect to Ollama at ${OLLAMA_BASE_URL}: ${error.message}` };
    }
  }

  getClient() {
    return this.client;
  }

  static getInfo() {
    return {
      name: 'Ollama',
      description: 'Local models via Ollama (no API key required)',
      models: []
    };
  }
}
