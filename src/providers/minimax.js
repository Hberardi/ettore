import OpenAI from 'openai';

const MINIMAX_MODELS = [
  { id: 'MiniMax-M3', description: 'M3 - Top reasoning & coding (recommended)', capability: 'full' },
  { id: 'MiniMax-M2.7-highspeed', description: 'M2.7 - Faster inference', capability: 'full' },
  { id: 'MiniMax-M2.7', description: 'M2.7 - Top reasoning & coding', capability: 'full' },
  { id: 'MiniMax-M2.5-highspeed', description: 'M2.5 - Faster inference', capability: 'full' },
  { id: 'MiniMax-M2.5', description: 'M2.5 - Peak performance & value', capability: 'full' },
  { id: 'MiniMax-M2.1-highspeed', description: 'M2.1 - Faster inference', capability: 'full' },
  { id: 'MiniMax-M2.1', description: 'M2.1 - Strong coding capabilities', capability: 'full' },
  { id: 'MiniMax-M2', description: 'M2 - Agentic & reasoning', capability: 'full' },
];

// Default endpoint for the hosted MiniMax API. Overridable via MINIMAX_BASE_URL
// so users on private deployments / regional endpoints / proxies don't have to
// fork the provider. Reading the env at module-eval time would freeze the
// value before tests run with mutated env — read at construction instead.
const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimax.io/v1';
const DEFAULT_VALIDATE_MODELS = ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5'];

export class MiniMaxProvider {
  constructor(apiKey) {
    this.client = new OpenAI({
      apiKey,
      baseURL: process.env.MINIMAX_BASE_URL || DEFAULT_MINIMAX_BASE_URL,
      timeout: 180_000,
      maxRetries: 2
    });
    this.name = 'minimax';
  }

  async listModels() {
    return { success: true, models: MINIMAX_MODELS };
  }

  async validateKey() {
    // Probe with a tiny completion. If the user explicitly selected a model,
    // honor it; otherwise fall back across known-good defaults so a valid key
    // does not fail just because the tier lacks M3.
    const configured = String(process.env.MINIMAX_MODEL || '').trim();
    const probeModels = configured
      ? [configured]
      : DEFAULT_VALIDATE_MODELS.filter((id, idx, arr) => arr.indexOf(id) === idx);
    let lastError = null;

    for (const probeModel of probeModels) {
      try {
        await this.client.chat.completions.create({
          model: probeModel,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }]
        });
        return { valid: true };
      } catch (error) {
        lastError = error;
      }
    }
    return { valid: false, error: lastError?.message || 'MiniMax validation failed' };
  }

  getClient() {
    return this.client;
  }

  static getInfo() {
    return {
      name: 'MiniMax (Token Plan)',
      description: 'MiniMax-M3 — Coding Plan subscription',
      models: MINIMAX_MODELS
    };
  }
}
