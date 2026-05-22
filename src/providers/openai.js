import OpenAI from 'openai';

export class OpenAIProvider {
  constructor(apiKey) {
    this.client = new OpenAI({ apiKey, timeout: 180_000, maxRetries: 2 });
    this.name = 'openai';
  }
  
  async listModels() {
    const defaults = [
      { id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4-turbo' },
      { id: 'gpt-4' }, { id: 'o1' }, { id: 'o1-mini' }, { id: 'o3-mini' },
      { id: 'o3' }, { id: 'o4-mini' },
    ];
    // Non-chat models to exclude (embeddings, speech, image generation)
    const excludePatterns = ['embedding', 'whisper', 'tts', 'dall-e', 'text-search', 'code-search', 'moderation'];
    try {
      const response = await this.client.models.list();
      const models = response.data
        .filter(m => !excludePatterns.some(p => m.id.includes(p)))
        .map(m => ({ id: m.id, created: m.created, owned_by: m.owned_by }));
      return { success: true, models: models.length ? models : defaults };
    } catch {
      return { success: true, models: defaults };
    }
  }
  
  async validateKey() {
    try {
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
      name: 'OpenAI',
      description: 'GPT-4, GPT-4 Turbo, O1 models',
      models: [
        { id: 'gpt-4o', description: 'GPT-4 Omni' },
        { id: 'gpt-4o-mini', description: 'GPT-4 Omni Mini' },
        { id: 'gpt-4-turbo', description: 'GPT-4 Turbo' },
        { id: 'gpt-4', description: 'GPT-4' },
        { id: 'o1', description: 'O1 (Reasoning)' },
        { id: 'o1-mini', description: 'O1 Mini (Reasoning)' },
        { id: 'o3-mini', description: 'O3 Mini (Reasoning)' }
      ]
    };
  }
}