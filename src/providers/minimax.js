import OpenAI from 'openai';

const MINIMAX_MODELS = [
  { id: 'MiniMax-M2.7-highspeed', description: 'M2.7 - Faster inference (recommended)', capability: 'full' },
  { id: 'MiniMax-M2.7', description: 'M2.7 - Top reasoning & coding', capability: 'full' },
  { id: 'MiniMax-M2.5-highspeed', description: 'M2.5 - Faster inference', capability: 'full' },
  { id: 'MiniMax-M2.5', description: 'M2.5 - Peak performance & value', capability: 'full' },
  { id: 'MiniMax-M2.1-highspeed', description: 'M2.1 - Faster inference', capability: 'full' },
  { id: 'MiniMax-M2.1', description: 'M2.1 - Strong coding capabilities', capability: 'full' },
  { id: 'MiniMax-M2', description: 'M2 - Agentic & reasoning', capability: 'full' },
];

export class MiniMaxProvider {
  constructor(apiKey) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.minimax.io/v1',
      timeout: 180_000,
      maxRetries: 2
    });
    this.name = 'minimax';
  }

  async listModels() {
    return { success: true, models: MINIMAX_MODELS };
  }

  async validateKey() {
    try {
      await this.client.chat.completions.create({
        model: 'MiniMax-M2.7',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }]
      });
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
      name: 'MiniMax (Token Plan)',
      description: 'MiniMax-M2.7, M2.5 — Coding Plan subscription',
      models: MINIMAX_MODELS
    };
  }
}
