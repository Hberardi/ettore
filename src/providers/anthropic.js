import Anthropic from '@anthropic-ai/sdk';

export class AnthropicProvider {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey, timeout: 180_000, maxRetries: 2 });
    this.name = 'anthropic';
  }
  
  async listModels() {
    // Only reached when `models.list()` fails, so it must not offer models the
    // API would refuse: every Claude 3.x snapshot has been retired, and the
    // previous list was made entirely of those. Aliases are preferred over
    // pinned snapshots because they never go stale.
    const fallback = [
      { id: 'claude-opus-5',     description: 'Claude Opus 5 — most capable' },
      { id: 'claude-sonnet-5',   description: 'Claude Sonnet 5 — balanced' },
      { id: 'claude-haiku-4-5',  description: 'Claude Haiku 4.5 — fastest' },
      { id: 'claude-opus-4-8',   description: 'Claude Opus 4.8' },
      { id: 'claude-opus-4-7',   description: 'Claude Opus 4.7' },
      { id: 'claude-opus-4-6',   description: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', description: 'Claude Sonnet 4.6' },
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
        { id: 'claude-opus-5', description: 'Claude Opus 5' },
        { id: 'claude-sonnet-5', description: 'Claude Sonnet 5' },
        { id: 'claude-opus-4-8', description: 'Claude Opus 4.8' },
        { id: 'claude-haiku-4-5', description: 'Claude Haiku 4.5' }
      ]
    };
  }
}