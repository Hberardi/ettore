import Conf from 'conf';
import { homedir } from 'os';
import { join, resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { constants } from 'fs';
import { connectionManager } from '../providers/index.js';
import { getModelCapability } from '../providers/model_capability.js';

const store = new Conf({
  projectName: 'ettore-cli',
  defaults: {
    model: 'gpt-4-turbo',
    stream: true,
    workdir: homedir(),
    activeProvider: 'openai',
    activeModel: 'gpt-4-turbo'
  }
});

// Markers per rilevare la root del progetto
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', '.ettore'];

/**
 * Rileva la root del progetto partendo da una directory
 * @param {string} dir - Directory di partenza
 * @returns {Promise<string|null>} Path della root del progetto o null
 */
export async function detectProjectRoot(dir = process.cwd()) {
  let current = resolve(dir);
  while (true) {
    for (const marker of PROJECT_MARKERS) {
      try {
        await access(join(current, marker), constants.F_OK);
        return current;
      } catch {}
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Ottiene il percorso del config locale per il progetto corrente
 * @returns {Promise<string|null>} Path di .ettore/config.json o null
 */
export async function getLocalConfigPath() {
  const projectRoot = await detectProjectRoot(process.cwd());
  if (!projectRoot) return null;
  return join(projectRoot, '.ettore', 'config.json');
}

/**
 * Carica la configurazione locale del progetto
 * @returns {Promise<Object>} Config locale o oggetto vuoto
 */
export async function loadLocalConfig() {
  const localPath = await getLocalConfigPath();
  if (!localPath) return {};

  try {
    const content = await readFile(localPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Salva la configurazione locale del progetto
 * @param {string} key - Chiave da salvare
 * @param {*} value - Valore da salvare
 * @returns {Promise<void>}
 */
export async function saveLocalConfig(key, value) {
  const localPath = await getLocalConfigPath();
  if (!localPath) {
    throw new Error('Not in a project directory. Could not find project root (looked for: .git, package.json, .ettore, etc.)');
  }

  // Crea la directory .ettore se non esiste
  const configDir = dirname(localPath);
  try {
    await mkdir(configDir, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create .ettore directory: ${err.message}`);
  }

  // Carica config esistente o inizializza
  let config = {};
  if (existsSync(localPath)) {
    try {
      const content = await readFile(localPath, 'utf-8');
      config = JSON.parse(content);
    } catch {
      // Se il file esiste ma è corrotto, sovrascriviamo
    }
  }

  // Aggiorna la chiave
  config[key] = value;

  // Salva il file
  await writeFile(localPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Carica la configurazione completa
 * Precedenza: options > local config > global config > defaults
 * @param {Object} options - Opzioni da linea di comando
 * @returns {Promise<Object>} Configurazione completa
 */
export async function loadConfig(options = {}) {
  const active = connectionManager.getActive();
  const localConfig = await loadLocalConfig();

  // LLM model parameters (opzionali, provider-agnostici). undefined = omesso dalla request.
  // Precedenza: options (CLI) > localConfig (.ettore/config.json) > store (Conf globale).
  const numFrom = (key) => {
    const v = options[key] ?? localConfig[key] ?? store.get(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const boolFrom = (key, fallback) => {
    const value = options[key] ?? localConfig[key] ?? store.get(key);
    return typeof value === 'boolean' ? value : fallback;
  };
  const stringFrom = (key, fallback) => {
    const value = options[key] ?? localConfig[key] ?? store.get(key);
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };

  // Determina provider e modello con priorità:
  // 1. Opzioni CLI > 2. Config locale > 3. Connection manager > 4. Config globale > 5. Defaults
  let provider = options.provider
    || localConfig.activeProvider
    || (active ? connectionManager.activeProvider : 'openai');

  let model = options.model
    || localConfig.activeModel
    || connectionManager.activeModel
    || store.get('activeModel')
    || 'gpt-4o';

  const config = {
    model,
    stream: options.stream !== undefined
      ? options.stream
      : (localConfig.stream ?? store.get('stream')),
    workdir: options.context || process.cwd(),
    provider,
    apiKey: connectionManager.isConnected(provider)
      // Keyless providers (ollama, claude-code) expose no SDK client at all.
      ? connectionManager.getProvider(provider)?.getClient?.()?.apiKey
      : null,
    // LLM model parameters (opzionali; undefined = omesso dalle request)
    temperature: numFrom('temperature'),
    top_p: numFrom('top_p'),
    maxTokens: numFrom('maxTokens'),
    // Safety limit on tool-calls per turn. Raise in .ettore/config.json for
    // complex multi-file tasks; lower to surface runaway loops earlier.
    maxIterations: numFrom('maxIterations'),
    maxToolCallsPerTurn: numFrom('maxToolCallsPerTurn'),
    // How many times the TUI silently re-prompts the model to finish an
    // unfinished task before handing control back to the user.
    maxAutoResumes: numFrom('maxAutoResumes'),
    // Dynamic routing reduces tool-schema tokens and malformed calls by only
    // exposing tools relevant to the current request.
    dynamicToolRouting: boolFrom('dynamicToolRouting', true),
    maxToolsPerRequest: numFrom('maxToolsPerRequest'),
    // Live directory panel in the sidebar. It holds a filesystem watch on the
    // working directory for as long as the session runs, so it is switchable
    // off for anyone who would rather it did not.
    fileTree: boolFrom('fileTree', true),
    // safe: workspace-only; balanced: external paths require approval;
    // autonomous: external reads allowed, external writes still approved.
    safetyProfile: stringFrom('safetyProfile', 'balanced'),
    // Flag per indicare se c'è config locale
    hasLocalConfig: Object.keys(localConfig).length > 0,
    projectRoot: await detectProjectRoot(process.cwd()),
    // Riferimenti ai config per debug
    _sources: {
      local: localConfig,
      global: {
        model: store.get('activeModel'),
        stream: store.get('stream'),
        provider: store.get('activeProvider')
      }
    }
  };

  const modelsResult = connectionManager.isConnected(provider)
    ? connectionManager.listModels(provider)
    : { success: false, models: [] };
  const activeModelObj = modelsResult.success
    ? modelsResult.models.find(m => (typeof m === 'string' ? m : m.id) === model)
    : null;
  config.modelCapability = getModelCapability(model, activeModelObj || {});

  return config;
}

// =============================================================================
// FUNZIONI SINCRONE (Retrocompatibilità)
// =============================================================================

/**
 * Salva una configurazione GLOBALE (sincrono, per retrocompatibilità)
 * Per salvare in project-local, usa saveConfigAsync
 * @param {string} key - Chiave da salvare
 * @param {*} value - Valore da salvare
 */
export function saveConfig(key, value) {
  store.set(key, value);
}

/**
 * Ottiene una configurazione GLOBALE (sincrona, per retrocompatibilità)
 * Per leggere da project-local, usa getConfigAsync
 * @param {string} key - Chiave da leggere
 * @returns {*} Valore della configurazione
 */
export function getConfig(key) {
  return store.get(key);
}

// =============================================================================
// FUNZIONI ASINCRONE (Supporto Project-Local)
// =============================================================================

/**
 * Salva una configurazione (asincrono, supporta project-local)
 * @param {string} key - Chiave da salvare
 * @param {*} value - Valore da salvare
 * @param {Object} opts - Opzioni
 * @param {boolean} opts.local - Se true, salva in .ettore/config.json, altrimenti globale
 * @returns {Promise<void>}
 */
export async function saveConfigAsync(key, value, opts = {}) {
  if (opts.local) {
    await saveLocalConfig(key, value);
  } else {
    store.set(key, value);
  }
}

/**
 * Ottiene una configurazione (asincrono, supporta project-local)
 * @param {string} key - Chiave da leggere
 * @param {Object} opts - Opzioni
 * @param {boolean} opts.local - Se true, legge da .ettore/config.json, altrimenti globale
 * @returns {Promise<*>} Valore della configurazione
 */
export async function getConfigAsync(key, opts = {}) {
  if (opts.local) {
    const localConfig = await loadLocalConfig();
    return localConfig[key];
  }
  return store.get(key);
}

/**
 * Ottiene la configurazione effettiva (asincrono, con supporto project-local)
 * Precedenza: local > global
 * @param {string} key - Chiave da leggere
 * @returns {Promise<*>} Valore effettivo (locale se presente, altrimenti globale)
 */
export async function getEffectiveConfigValue(key) {
  const localConfig = await loadLocalConfig();
  return localConfig[key] ?? store.get(key);
}

/**
 * Ottiene tutta la configurazione effettiva (local + global)
 * @returns {Promise<Object>} Configurazione effettiva
 */
export async function getEffectiveConfig() {
  const localConfig = await loadLocalConfig();
  return {
    ...store.store,           // globale (base)
    ...localConfig            // locale (override)
  };
}

// =============================================================================
// ALIAS E UTILITY
// =============================================================================

export function setActiveModel(model) {
  store.set('activeModel', model);
}

export function setActiveProvider(provider) {
  store.set('activeProvider', provider);
}

export function resetConfig() {
  store.clear();
}

/**
 * Inizializza il progetto con una directory .ettore
 * Crea .ettore/config.json e .ettore/memory.md
 * @returns {Promise<string>} Path del progetto inizializzato
 */
export async function initProject() {
  const projectRoot = await detectProjectRoot(process.cwd());
  if (!projectRoot) {
    throw new Error('Could not detect project root. Create a git repo (git init) or .ettore file first.');
  }

  const ettoreDir = join(projectRoot, '.ettore');
  const configPath = join(ettoreDir, 'config.json');

  // Crea directory
  await mkdir(ettoreDir, { recursive: true });

  // Crea config.json se non esiste
  if (!existsSync(configPath)) {
    const defaultConfig = {
      activeProvider: 'openai',
      activeModel: 'gpt-4o',
      stream: true,
      theme: 'default',
      initialized: new Date().toISOString()
    };
    await writeFile(configPath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf-8');
  }

  return projectRoot;
}

/**
 * Rimuove la configurazione locale del progetto corrente
 * @returns {Promise<boolean>} True se rimossa con successo
 */
export async function removeLocalConfig() {
  const localPath = await getLocalConfigPath();
  if (!localPath || !existsSync(localPath)) {
    return false;
  }

  try {
    const { unlink } = await import('fs/promises');
    await unlink(localPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifica se il progetto corrente ha una configurazione locale
 * @returns {Promise<boolean>}
 */
export async function hasLocalConfig() {
  const localPath = await getLocalConfigPath();
  return localPath ? existsSync(localPath) : false;
}
