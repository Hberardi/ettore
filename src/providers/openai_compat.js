import OpenAI from 'openai';
import { getModelCapability } from './model_capability.js';

export function makeOpenAICompatProvider(name, baseURL) {
  return class {
    constructor(apiKey) {
      this.client = new OpenAI({ apiKey, baseURL, timeout: 180_000, maxRetries: 2 });
      this.name = name;
    }

    async listModels() {
      try {
        const res = await this.client.models.list();
        const isOpenRouter = name === 'openrouter';
        const models = res.data
          .map(m => {
            const model = { id: m.id };
            if (isOpenRouter) {
              if (m.pricing) {
                const promptPrice = parseFloat(m.pricing.prompt ?? m.pricing.input ?? '1');
                const completionPrice = parseFloat(m.pricing.completion ?? m.pricing.output ?? '1');
                if (promptPrice === 0 && completionPrice === 0) model.free = true;
              }
              // OpenRouter also marks free models with the :free suffix in the model ID
              if (!model.free && m.id.endsWith(':free')) model.free = true;
              // Detect tool-use capability from API metadata + naming heuristics
              model.capability = getModelCapability(m.id, m);
            }
            return model;
          })
          .sort((a, b) => a.id.localeCompare(b.id));
        return { success: true, models };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    async validateKey() {
      try {
        await this.client.models.list();
        return { valid: true };
      } catch (e) {
        return { valid: false, error: e.message };
      }
    }

    getClient() {
      return this.client;
    }

    static getInfo() {
      return { name, description: `${name} (${baseURL})`, models: [] };
    }
  };
}

// Dynamic provider: user supplies base URL + API key at runtime
export class DynamicOpenAICompatProvider {
  constructor(baseURL, apiKey) {
    // Chat client: long timeout for large models (70B+ can take 2-3 min)
    this.client         = new OpenAI({ apiKey, baseURL, timeout: 180_000, maxRetries: 1 });
    // Validation client: short timeout — only used for /models probe
    this._validClient   = new OpenAI({ apiKey, baseURL, timeout: 15_000, maxRetries: 0 });
    this.name    = 'openai-compat';
    this.baseURL = baseURL;
  }

  async listModels() {
    try {
      const res = await this._validClient.models.list();
      const models = res.data
        .map(m => ({ id: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { success: true, models };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async validateKey() {
    try {
      await this._validClient.models.list();
      return { valid: true };
    } catch (e) {
      // Network errors or auth failures → connection is not valid
      const isNetworkError = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|network/i.test(e.message);
      const isAuthError = e.status === 401 || e.status === 403;
      if (isNetworkError || isAuthError) {
        return { valid: false, error: e.message };
      }
      // HTTP 404 on /models (or timeout) is acceptable — endpoint exists but doesn't expose model list
      return { valid: true, warning: e.message };
    }
  }

  getClient() {
    return this.client;
  }
}
