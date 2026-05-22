import Anthropic from '@anthropic-ai/sdk';

export class AnthropicProvider {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey, timeout: 180_000, maxRetries: 2 });
    this.name = 'anthropic';
  }
  
  async listModels() {
    const fallback = [
      { id: 'claude-opus-4-20250514',      description: 'Claude Opus 4' },
      { id: 'claude-sonnet-4-20250514',    description: 'Claude Sonnet 4' },
      { id: 'claude-3-7-sonnet-20250219',  description: 'Claude 3.7 Sonnet' },
      { id: 'claude-3-5-sonnet-20241022',  description: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-5-haiku-20241022',   description: 'Claude 3.5 Haiku' },
      { id: 'claude-3-5-sonnet-20240620',  description: 'Claude 3.5 Sonnet (June)' },
      { id: 'claude-3-opus-20240229',      description: 'Claude 3 Opus' },
      { id: 'claude-3-sonnet-20240229',    description: 'Claude 3 Sonnet' },
      { id: 'claude-3-haiku-20240307',     description: 'Claude 3 Haiku' },
    ];
    try {
      const response = await this.client.models.list();
      const models = response.data.map(m => ({
        id: m.id,
        description: m.display_name || m.id,
      }));
      return { success: true, models: models.length ? models : fallback };
    } catch {
      return { success: true, models: fallback };
    }
  }
  
  async validateKey() {
    try {
      // Use models.list() — read-only, no credits charged, fast
      await this.client.models.list();
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }
  
  getClient() {
    return this.client;
  }
  
  static getInfo() {
    return {
      name: 'Anthropic',
      description: 'Claude models',
      models: [
        { id: 'claude-sonnet-4-20250514', description: 'Claude Sonnet 4' },
        { id: 'claude-3-5-sonnet-20241022', description: 'Claude 3.5 Sonnet' },
        { id: 'claude-3-opus-20240229', description: 'Claude 3 Opus' },
        { id: 'claude-3-haiku-20240307', description: 'Claude 3 Haiku' }
      ]
    };
  }
}