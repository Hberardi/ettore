import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { PROVIDER_REGISTRY } from './registry.js';
import { getProviderEnvKey } from './env.js';
import { redactSecrets } from '../utils/secrets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_DIR = process.env.ETTORE_CONFIG_DIR || join(homedir(), '.config', 'ettore');
const KEYS_FILE = join(CONFIG_DIR, 'keys.json');
// Active window: refresh aggressively while the CLI is running (provider
// catalogs can change mid-session and the user might add a new model).
const MODELS_REFRESH_TTL_MS = 5 * 60 * 1000;
// Note: the on-disk cache (keys.json) is durable across sessions, so even
// without an explicit stale TTL the next launch reuses the last good
// fetch. A failed boot refresh does NOT reset the timestamp — the next
// /models or listModels() call will retry within the active window.

if (!existsSync(CONFIG_DIR)) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
} else {
  try { chmodSync(CONFIG_DIR, 0o700); } catch {}
}

// Build providers map from registry
const providers = {};
for (const entry of PROVIDER_REGISTRY) {
  providers[entry.id] = entry.Class;
}

// Providers that authenticate without an API key — either a local runtime
// (Ollama) or an existing login elsewhere on the machine (Claude Code). They
// are constructed with no argument and never persist a key.
const KEYLESS_PROVIDERS = new Set(
  PROVIDER_REGISTRY.filter(entry => entry.requiresKey === false).map(entry => entry.id),
);

export function isKeylessProvider(name) {
  return KEYLESS_PROVIDERS.has(String(name || '').toLowerCase());
}

function loadKeys() {
  try {
    if (existsSync(KEYS_FILE)) {
      const data = readFileSync(KEYS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {}
  return {};
}

function saveKeys(keys) {
  try {
    writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
    try { chmodSync(KEYS_FILE, 0o600); } catch {}
  } catch (e) {
    console.error('Failed to save keys:', e.message);
  }
}

export class ConnectionManager {
  constructor({ emitter = null } = {}) {
    this.connections = new Map();
    this.activeProvider = null;
    this.activeModel = null;
    this.emitter = emitter;
    this.loadSavedConnections();
  }

  setEmitter(emitter) {
    this.emitter = emitter || null;
  }

  _emitModelsRefreshed(provider, count, opts = {}) {
    const ageMs = opts.ageMs ?? null;
    const forced = opts.forced ?? false;
    const silent = opts.silent ?? false;
    if (silent) return;
    try { this.emitter?.emit('modelsRefreshed', { provider, count, ageMs, forced }); } catch {}
  }
  
  loadSavedConnections() {
    const saved = loadKeys();
    for (const [provider, data] of Object.entries(saved)) {
      if (provider === '_active') continue; // metadata field
      if ((isKeylessProvider(provider) || data.key) && data.valid) {
        try {
          const ProviderClass = providers[provider];
          if (ProviderClass) {
            let instance;
            if (isKeylessProvider(provider)) {
              instance = new ProviderClass();
            } else if (provider === 'openai-compat') {
              instance = new ProviderClass(data.baseUrl || '', data.key);
            } else {
              instance = new ProviderClass(data.key);
            }
            this.connections.set(provider, {
              provider: instance,
              key: data.key || null,
              baseUrl: data.baseUrl || null,
              valid: true,
              models: data.models || [],
              modelsFetchedAt: 0,
            });
            // Best-effort background refresh to avoid stale static lists.
            // Silent: the TUI may attach an emitter milliseconds later and
            // a late emit would surface as spurious "↻ Refreshed" noise
            // before the user did anything.
            this.refreshModels(provider, { force: true, silent: true }).catch(() => {});
          }
        } catch (e) {
          console.warn(`[ettore] Failed to restore provider "${provider}":`, e.message);
        }
      }
    }
    this.loadEnvConnections();
    // Restore last active provider/model
    if (saved._active?.provider && this.connections.has(saved._active.provider)) {
      this.activeProvider = saved._active.provider;
      this.activeModel = saved._active.model || null;
      // If no model saved, pick first from the connection
      if (!this.activeModel) {
        const conn = this.connections.get(this.activeProvider);
        const first = conn?.models?.[0];
        this.activeModel = typeof first === 'string' ? first : first?.id || null;
      }
    } else if (!this.activeProvider) {
      const first = this.connections.keys().next().value;
      if (first) {
        const conn = this.connections.get(first);
        this.activeProvider = first;
        const firstModel = conn?.models?.[0];
        this.activeModel = typeof firstModel === 'string' ? firstModel : firstModel?.id || null;
      }
    }
  }

  loadEnvConnections() {
    for (const entry of PROVIDER_REGISTRY) {
      const name = entry.id;
      if (isKeylessProvider(name) || this.connections.has(name)) continue;
      const envKey = getProviderEnvKey(name);
      if (!envKey) continue;
      try {
        const ProviderClass = providers[name];
        if (!ProviderClass) continue;
        const provider = new ProviderClass(envKey.value);
        const models = entry.Class?.getInfo?.()?.models || [];
        this.connections.set(name, {
          provider,
          key: null,
          envVar: envKey.name,
          valid: true,
          models,
          modelsFetchedAt: 0,
        });
      } catch (e) {
        console.warn(`[ettore] Failed to load env provider "${name}":`, redactSecrets(e.message, [envKey.value]));
      }
    }
  }
  
  async connect(providerName, apiKey, options = {}) {
    const name = providerName.toLowerCase();
    const ProviderClass = providers[name];

    if (!ProviderClass) {
      return {
        success: false,
        error: `Provider not found: ${providerName}. Available: ${Object.keys(providers).join(', ')}`
      };
    }

    let provider;
    if (isKeylessProvider(name)) {
      provider = new ProviderClass();
    } else if (name === 'openai-compat') {
      const baseURL = options.baseURL || '';
      if (!baseURL) return { success: false, error: 'Base URL is required for OpenAI Compatible provider' };
      provider = new ProviderClass(baseURL, apiKey);
    } else {
      provider = new ProviderClass(apiKey);
    }

    const validation = await provider.validateKey();
    if (!validation.valid) {
      return { success: false, error: `Invalid API key: ${redactSecrets(validation.error, [apiKey])}` };
    }

    // Fetch model list; for openai-compat fall back to user-supplied model if endpoint
    // doesn't expose /models.
    let models = [];
    const modelsResult = await provider.listModels();
    if (modelsResult.success && modelsResult.models.length > 0) {
      models = modelsResult.models;
    } else if (name === 'openai-compat' && options.model) {
      models = [{ id: options.model }];
    }

    const conn = {
      provider,
      key: isKeylessProvider(name) ? null : apiKey,
      valid: true,
      models,
      modelsFetchedAt: Date.now(),
    };
    if (name === 'openai-compat') conn.baseUrl = options.baseURL || '';
    this.connections.set(name, conn);

    const saved = loadKeys();
    const savedEntry = {
      key: isKeylessProvider(name) ? null : apiKey,
      valid: true,
      models: models.map(m => typeof m === 'string' ? m : m.id),
    };
    if (name === 'openai-compat') savedEntry.baseUrl = options.baseURL || '';
    saved[name] = savedEntry;
    saveKeys(saved);

    return {
      success: true,
      provider: providerName,
      models: models.map(m => typeof m === 'string' ? m : m.id),
      message: `Connected to ${providerName}! ${models.length} models available.`
    };
  }
  
  async disconnect(providerName) {
    const name = providerName.toLowerCase();
    
    if (!this.connections.has(name)) {
      return { success: false, error: `Not connected to ${providerName}` };
    }
    
    this.connections.delete(name);
    
    if (this.activeProvider === name) {
      this.activeProvider = null;
      this.activeModel = null;
    }
    
    const saved = loadKeys();
    delete saved[name];
    saveKeys(saved);
    
    return { success: true, message: `Disconnected from ${providerName}` };
  }
  
  setActive(providerName, model = null) {
    const name = providerName.toLowerCase();
    const conn = this.connections.get(name);

    if (!conn) {
      return { success: false, error: `Not connected to ${providerName}` };
    }

    this.activeProvider = name;
    const firstModel = conn.models[0];
    const firstModelId = typeof firstModel === 'string' ? firstModel : firstModel?.id;
    this.activeModel = model || firstModelId;

    // Persist the active provider/model so it's restored on next launch
    const saved = loadKeys();
    saved._active = { provider: name, model: this.activeModel };
    saveKeys(saved);

    return { success: true, provider: name, model: this.activeModel };
  }
  
  getActive() {
    if (!this.activeProvider) return null;
    return this.connections.get(this.activeProvider);
  }
  
  listConnections() {
    return Array.from(this.connections.entries()).map(([name, conn]) => ({
      provider: name,
      valid: conn.valid,
      modelsCount: conn.models?.length || 0,
      isActive: name === this.activeProvider,
      source: conn.envVar ? 'env' : 'saved',
      envVar: conn.envVar || null,
    }));
  }

  // Returns one row per connected provider with the age of the cached model
  // list and whether it's still inside the refresh window. `stale` is true
  // when the next access will trigger a network call.
  getModelsCacheStatus() {
    const now = Date.now();
    return Array.from(this.connections.entries()).map(([name, conn]) => {
      const ageMs = conn.modelsFetchedAt ? now - conn.modelsFetchedAt : null;
      const stale = ageMs === null || ageMs > MODELS_REFRESH_TTL_MS;
      return {
        provider: name,
        modelsCount: conn.models?.length || 0,
        fetchedAt: conn.modelsFetchedAt ? new Date(conn.modelsFetchedAt).toISOString() : null,
        ageMs,
        stale,
      };
    });
  }
  
  listModels(providerName) {
    const conn = this.connections.get(providerName.toLowerCase());
    if (!conn) {
      return { success: false, error: `Not connected to ${providerName}` };
    }

    if (!conn.modelsFetchedAt || (Date.now() - conn.modelsFetchedAt) > MODELS_REFRESH_TTL_MS) {
      this.refreshModels(providerName).catch(() => {});
    }

    return { success: true, models: conn.models };
  }

  async refreshModels(providerName, { force = false, silent = false } = {}) {
    const name = providerName.toLowerCase();
    const conn = this.connections.get(name);
    if (!conn) {
      return { success: false, error: `Not connected to ${providerName}` };
    }

    const now = Date.now();
    // Within the active window: skip if cache is fresh.
    if (!force && conn.modelsFetchedAt && (now - conn.modelsFetchedAt) <= MODELS_REFRESH_TTL_MS) {
      return { success: true, models: conn.models, refreshed: false };
    }

    const modelsResult = await conn.provider.listModels();
    if (!modelsResult?.success) {
      // Reset the timestamp so we retry sooner rather than waiting 24h.
      // Failed fetches don't earn the stale-cache grace period.
      return { success: false, error: modelsResult?.error || `Failed to refresh models for ${providerName}` };
    }

    const models = modelsResult.models || [];
    const ageMs = conn.modelsFetchedAt ? now - conn.modelsFetchedAt : null;
    conn.models = models;
    conn.modelsFetchedAt = now;

    // Keep active model valid if it no longer exists.
    if (this.activeProvider === name) {
      const hasActive = models.some(m => (typeof m === 'string' ? m : m.id) === this.activeModel);
      if (!hasActive) {
        const first = models[0];
        this.activeModel = typeof first === 'string' ? first : first?.id || null;
      }
    }

    const saved = loadKeys();
    if (saved[name]) {
      saved[name].models = models.map(m => typeof m === 'string' ? m : m.id);
      if (this.activeProvider === name) {
        saved._active = { provider: name, model: this.activeModel };
      }
      saveKeys(saved);
    }

    // Notify subscribers (TUI, status bar) so they can surface a visible
    // "↻ refreshed N models" message. Skipped silently when no emitter is
    // attached (e.g. one-shot mode) OR when the caller opted out (boot
    // refresh would otherwise leak stale data into a TUI that subscribes
    // milliseconds later).
    this._emitModelsRefreshed(name, models.length, { ageMs, forced: !!force, silent });

    return { success: true, models, refreshed: true };
  }

  async refreshAllModels({ force = false } = {}) {
    const providers = Array.from(this.connections.keys());
    const results = await Promise.all(
      providers.map(async (name) => {
        try {
          return { provider: name, ...(await this.refreshModels(name, { force })) };
        } catch (error) {
          return { provider: name, success: false, error: error?.message || String(error) };
        }
      })
    );
    return results;
  }
  
  getProvider(name) {
    return this.connections.get(name.toLowerCase())?.provider;
  }
  
  isConnected(providerName) {
    return this.connections.has(providerName.toLowerCase());
  }
  
  async updateKey(providerName, newApiKey) {
    const name = providerName.toLowerCase();
    const ProviderClass = providers[name];
    
    if (!ProviderClass) {
      return { success: false, error: `Provider not found: ${providerName}` };
    }
    
    const provider = new ProviderClass(newApiKey);
    const validation = await provider.validateKey();
    
    if (!validation.valid) {
      return { success: false, error: `Invalid API key: ${redactSecrets(validation.error, [newApiKey])}` };
    }
    
    const modelsResult = await provider.listModels();
    const models = modelsResult.success ? modelsResult.models : [];
    
    this.connections.set(name, {
      provider,
      key: newApiKey,
      valid: true,
      models,
      modelsFetchedAt: Date.now(),
    });
    
    if (this.activeProvider === name) {
      const first = models[0];
      this.activeModel = typeof first === 'string' ? first : first?.id || null;
    }

    const saved = loadKeys();
    saved[name] = {
      key: newApiKey,
      valid: true,
      models: models.map(m => typeof m === 'string' ? m : m.id),
    };
    saveKeys(saved);
    
    return { success: true, message: `API key updated for ${providerName}` };
  }
  
  async deleteKey(providerName) {
    const name = providerName.toLowerCase();
    
    if (!this.connections.has(name)) {
      return { success: false, error: `No saved key for ${providerName}` };
    }
    
    this.connections.delete(name);
    
    if (this.activeProvider === name) {
      this.activeProvider = null;
      this.activeModel = null;
    }
    
    const saved = loadKeys();
    delete saved[name];
    saveKeys(saved);
    
    return { success: true, message: `API key deleted for ${providerName}` };
  }
  
  getSavedConnections() {
    const saved = loadKeys();
    return Object.entries(saved)
      .filter(([provider]) => provider !== '_active')
      .map(([provider, data]) => ({
        provider,
        hasKey: !!data.key,
        valid: data.valid,
        modelsCount: data.models?.length || 0
      }));
  }

  static getAvailableProviders() {
    return PROVIDER_REGISTRY.map(entry => ({
      name: entry.id,
      displayName: entry.name,
      description: entry.description,
      icon: entry.icon,
      requiresKey: entry.requiresKey,
      requiresBaseUrl: entry.requiresBaseUrl || false,
      keyHint: entry.keyHint,
      baseUrlHint: entry.baseUrlHint || '',
      modelHint: entry.modelHint || '',
    }));
  }
}

export const connectionManager = new ConnectionManager();
