import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { connectionManager, ConnectionManager } from '../providers/index.js';
import { PROVIDER_REGISTRY } from '../providers/registry.js';
import { getProviderEnvVars, listConfiguredEnvProviders } from '../providers/env.js';
import { clearInstallSessionApprovals, listInstallSessionApprovals } from '../tools/index.js';
import { redactSecrets } from '../utils/secrets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class CommandSystem {
  constructor() {
    this.commands = new Map();
    this.aliases = new Map();
  }
  
  register(name, handler, options = {}) {
    this.commands.set(name, {
      name,
      handler,
      description: options.description || '',
      usage: options.usage || '',
      aliases: options.aliases || []
    });
    
    for (const alias of options.aliases || []) {
      this.aliases.set(alias, name);
    }
  }
  
  async loadFromDirectory(commandsDir) {
    const dir = commandsDir || join(__dirname, '../../commands');
    const files = await readdir(dir).catch(() => []);
    
    for (const file of files) {
      if (file.endsWith('.js') || file.endsWith('.mjs')) {
        try {
          const cmd = await import(join(dir, file));
          const name = file.replace(/\.(js|mjs)$/, '');
          this.register(name, cmd.default?.handler || cmd.handler, {
            description: cmd.default?.description || cmd.description || '',
            usage: cmd.default?.usage || cmd.usage || '',
            aliases: cmd.default?.aliases || cmd.aliases || []
          });
        } catch (e) {
          console.error(`Failed to load command ${file}:`, e.message);
        }
      }
    }
  }
  
  get(name) {
    const cmdName = this.aliases.get(name) || name;
    return this.commands.get(cmdName);
  }
  
  has(name) {
    return this.commands.has(name) || this.aliases.has(name);
  }
  
  list() {
    return Array.from(this.commands.values()).map(cmd => ({
      name: cmd.name,
      description: cmd.description,
      usage: cmd.usage,
      aliases: cmd.aliases
    }));
  }
  
  async execute(name, args, context = {}) {
    const cmd = this.get(name);
    if (!cmd) {
      throw new Error(`Command not found: ${name}`);
    }
    
    return cmd.handler(args, context);
  }
}

export function createCommand(name, handler, options = {}) {
  return { name, handler, ...options };
}

function commandLine(cmd) {
  const aliases = cmd.aliases?.length ? ` (${cmd.aliases.join(', ')})` : '';
  const usage = cmd.usage ? `/${cmd.usage}` : `/${cmd.name}`;
  return `  ${usage.padEnd(34)} ${cmd.description || ''}${aliases}`;
}

function setupHint() {
  const connections = connectionManager.listConnections();
  const active = connectionManager.getActive();

  if (active) {
    return `Active: ${connectionManager.activeProvider}/${connectionManager.activeModel || 'default model'}`;
  }

  if (connections.length > 0) {
    return `No active model selected. Use /use to choose one from ${connections.length} saved connection${connections.length === 1 ? '' : 's'}.`;
  }

  return 'No provider connected. Start with /connect, or use /providers to see options.';
}

function providerMeta(providerName) {
  const name = String(providerName || '').toLowerCase();
  return ConnectionManager.getAvailableProviders().find(p => p.name === name)
    || PROVIDER_REGISTRY.find(p => p.id === name);
}

function modelId(model) {
  return typeof model === 'string' ? model : model?.id;
}

function modelDescription(model) {
  if (!model || typeof model === 'string') return '';
  const tags = [];
  if (model.description) tags.push(model.description);
  if (model.free) tags.push('free');
  if (model.capability) tags.push(`cap: ${model.capability}`);
  return tags.length ? ` - ${tags.join(', ')}` : '';
}

async function refreshProviderModels(manager, provider) {
  if (typeof manager.refreshModels !== 'function') return null;
  return manager.refreshModels(provider).catch(() => null);
}

export const builtinCommands = {
  help: {
    description: 'Show help',
    usage: 'help [command]',
    aliases: ['h'],
    handler: async (args, context) => {
      const cmdSystem = context.commandSystem;
      if (!cmdSystem) return 'No command system available';
      const [topic] = args;
      const commands = cmdSystem.list();

      if (topic) {
        const name = topic.replace(/^\//, '');
        const cmd = builtinCommands[name] || commands.find(c => c.aliases?.includes(name));
        if (!cmd) return `No help found for /${name}.\nUse /help to list available commands.`;

        const canonical = cmd.name || name;
        const aliases = cmd.aliases?.length ? `\nAliases: ${cmd.aliases.map(a => `/${a}`).join(', ')}` : '';
        const usage = cmd.usage || canonical;
        return `/${canonical} — ${cmd.description || 'No description'}
Usage: /${usage}${aliases}`;
      }

      const commandByName = new Map(commands.map(cmd => [cmd.name, cmd]));
      const group = (title, names) => {
        const rows = names.map(name => commandByName.get(name)).filter(Boolean);
        if (rows.length === 0) return '';
        return `\n${title}\n${rows.map(commandLine).join('\n')}\n`;
      };

      let output = `ETTORE help
${setupHint()}

First steps
  /connect                           Connect an LLM provider
  /use                               Select the active model
  Ask normally                       Example: explain src/agents/index.js
  @path/to/file                      Attach a file to the next prompt
  !command                           Run a shell command from the TUI
`;

      output += group('Core commands', ['help', 'status', 'doctor', 'providers', 'models', 'connect', 'use', 'disconnect']);
      output += group('Session and project', ['clear', 'new', 'sessions', 'resume', 'init', 'memory', 'compress', 'agent', 'approvals', 'history', 'team']);
      output += group('Configuration', ['keys', 'config', 'theme', 'system', 'version', 'exit']);
      output += '\nUse /help <command> for details, for example /help connect.';

      return output.trimEnd();
    }
  },
  
  status: {
    description: 'Show status',
    usage: 'status',
    aliases: ['s'],
    handler: async (_args, context) => {
      const connections = connectionManager.listConnections();
      const active = connectionManager.getActive();
      return `ETTORE v${context.version || '1.0.0'}
Provider: ${connectionManager.activeProvider || context.config?.provider || 'none'}
Model: ${connectionManager.activeModel || context.config?.model || 'none'}
Connection: ${active ? 'active' : 'not connected'}
Saved connections: ${connections.length}
Stream: ${context.config?.stream !== false ? 'enabled' : 'disabled'}
Working dir: ${context.config?.workdir || process.cwd()}

${setupHint()}`;
    }
  },

  doctor: {
    description: 'Diagnose local setup, config, and provider state',
    usage: 'doctor',
    aliases: ['diag'],
    handler: async (_args, context) => {
      const { access, stat } = await import('fs/promises');
      const { constants } = await import('fs');
      const { detectProjectRoot, hasLocalConfig, getEffectiveConfig } = await import('../config/index.js');

      const ok = [];
      const warn = [];
      const fail = [];
      const configDir = process.env.ETTORE_CONFIG_DIR || join(homedir(), '.config', 'ettore');
      const keysFile = join(configDir, 'keys.json');
      const connections = connectionManager.listConnections();
      const active = connectionManager.getActive();
      const envProviders = listConfiguredEnvProviders();
      const nodeMajor = Number(process.versions.node.split('.')[0]);

      if (nodeMajor >= 18) ok.push(`Node.js ${process.versions.node}`);
      else fail.push(`Node.js ${process.versions.node} is unsupported; install Node.js 18+`);

      try {
        await access(process.cwd(), constants.R_OK | constants.W_OK);
        ok.push(`Working directory writable: ${process.cwd()}`);
      } catch {
        fail.push(`Working directory is not writable: ${process.cwd()}`);
      }

      try {
        await access(configDir, constants.R_OK | constants.W_OK);
        ok.push(`Config directory writable: ${configDir}`);
        const info = await stat(configDir);
        const mode = (info.mode & 0o777).toString(8).padStart(3, '0');
        if ((info.mode & 0o077) === 0) ok.push(`Config directory permissions: ${mode}`);
        else warn.push(`Config directory permissions are broad: ${mode}; recommended 700`);
      } catch {
        warn.push(`Config directory not ready or not writable: ${configDir}`);
      }

      try {
        const info = await stat(keysFile);
        const mode = (info.mode & 0o777).toString(8).padStart(3, '0');
        if ((info.mode & 0o077) === 0) ok.push(`Keys file permissions: ${mode}`);
        else warn.push(`Keys file permissions are broad: ${mode}; recommended 600`);
      } catch {
        warn.push(`No saved keys file yet: ${keysFile}`);
      }

      const projectRoot = await detectProjectRoot(process.cwd());
      if (projectRoot) ok.push(`Project root detected: ${projectRoot}`);
      else warn.push('No project root detected from current directory');

      const localConfig = await hasLocalConfig();
      const effectiveConfig = await getEffectiveConfig().catch(() => ({}));
      if (localConfig) ok.push('Project-local config found: .ettore/config.json');
      else warn.push('No project-local config; using global/default settings');

      if (connections.length > 0) {
        ok.push(`Saved provider connections: ${connections.length}`);
      } else {
        warn.push('No provider connected');
      }

      if (envProviders.length > 0) {
        ok.push(`Environment API keys present for: ${envProviders.join(', ')}`);
      } else {
        warn.push('No provider API keys found in environment');
      }

      if (active) {
        ok.push(`Active provider: ${connectionManager.activeProvider}`);
        ok.push(`Active model: ${connectionManager.activeModel || effectiveConfig.activeModel || context.config?.model || 'default'}`);
      } else {
        warn.push('No active provider/model selected');
      }

      const next = [];
      if (!active && connections.length > 0) next.push('Run /use <provider> <model> to select an active model.');
      if (connections.length === 0 && envProviders.length === 0) next.push('Run /connect <provider> <api-key>, export a provider API key, or use /connect ollama for local models.');
      if (!projectRoot) next.push('Run ETTORE from a project directory, or initialize one with /init.');
      if (!localConfig) next.push('Optional: run /config --local to create project-local settings.');

      const section = (title, rows, empty) => `${title}\n${rows.length ? rows.map(r => `  ${r}`).join('\n') : `  ${empty}`}`;
      return [
        'ETTORE doctor',
        `Config dir: ${configDir}`,
        `Keys file:  ${keysFile}`,
        '',
        section('OK', ok.map(r => `✓ ${r}`), 'No passing checks reported'),
        '',
        section('Warnings', warn.map(r => `! ${r}`), 'None'),
        '',
        section('Failures', fail.map(r => `✗ ${r}`), 'None'),
        '',
        section('Next steps', next, 'No immediate action needed'),
      ].join('\n');
    }
  },
  
  clear: {
    description: 'Clear screen',
    usage: 'clear',
    aliases: ['c'],
    handler: async () => {
      return { action: 'clear' };
    }
  },
  
  exit: {
    description: 'Exit interactive mode',
    usage: 'exit',
    aliases: ['.exit', 'quit', 'q'],
    handler: async () => {
      return { action: 'exit' };
    }
  },
  
  connect: {
    description: 'Connect to an LLM provider',
    usage: 'connect [provider] [api-key]',
    aliases: [],
    handler: async (args, context = {}) => {
      const manager = context.connectionManager || connectionManager;
      const [provider, apiKey] = args;
      
      if (!provider) {
        const providers = ConnectionManager.getAvailableProviders();
        let output = 'Available providers:\n';
        for (const p of providers) {
          const connected = manager.isConnected(p.name);
          const envVars = getProviderEnvVars(p.name);
          const envHint = envVars.length ? ` env: ${envVars.join('/')}` : '';
          const auth = p.requiresKey ? ` key: ${p.keyHint || 'required'}` : ' no key required';
          output += `  ${p.name.padEnd(14)} ${p.description} (${auth}${envHint})${connected ? ' [connected]' : ''}\n`;
        }
        output += '\nUsage: /connect <provider> <api-key>';
        output += '\nExamples:';
        output += '\n  /connect openai sk-...';
        output += '\n  /connect anthropic sk-ant-...';
        output += '\n  /connect ollama';
        output += '\n\nRun /doctor if setup still looks wrong.';
        return output;
      }

      const meta = providerMeta(provider);
      if (!meta) {
        return `Provider not found: ${provider}\nRun /providers to list supported providers.`;
      }

      if (meta.requiresKey && !apiKey) {
        const hint = meta.keyHint ? ` Expected format: ${meta.keyHint}` : '';
        return `Please provide API key for ${provider}.${hint}\nUsage: /connect ${provider} <api-key>`;
      }
      
      const result = await manager.connect(provider, apiKey || null);
      
      if (result.success) {
        const models = result.models || [];
        const firstModel = models[0];
        const firstModelId = typeof firstModel === 'string' ? firstModel : firstModel?.id;
        let selected = null;
        if (!manager.getActive?.() && firstModelId && typeof manager.setActive === 'function') {
          const activeResult = manager.setActive(provider, firstModelId);
          if (activeResult?.success) selected = activeResult.model || firstModelId;
        }
        const modelsList = models.slice(0, 5).map(m => typeof m === 'string' ? m : m.id).join(', ');
        const more = models.length > 5 ? `... and ${models.length - 5} more` : '';
        const activeNote = selected
          ? `\n\nActive model selected: ${provider}/${selected}`
          : firstModelId
            ? `\n\nUse /use ${provider} <model> to select a model`
            : '\n\nNo models were returned. Run /models after the provider is available.';
        return `${result.message}\n\nAvailable models:\n${modelsList || '(none)'}${more ? '\n' + more : ''}${activeNote}`;
      }
      
      const next = String(provider).toLowerCase() === 'ollama'
        ? '\nNext: make sure Ollama is running, then retry /connect ollama.'
        : '\nNext: check the key, provider status, or run /doctor.';
      return `Error: ${redactSecrets(result.error, [apiKey])}${next}`;
    }
  },
  
  disconnect: {
    description: 'Disconnect from a provider',
    usage: 'disconnect [provider]',
    aliases: [],
    handler: async (args) => {
      const [provider] = args;
      
      if (!provider) {
        const connections = connectionManager.listConnections();
        if (connections.length === 0) return 'No active connections';
        
        return 'Connected providers:\n' + connections.map(c => 
          `  ${c.provider} - ${c.modelsCount} models${c.isActive ? ' [active]' : ''}`
        ).join('\n');
      }
      
      const result = await connectionManager.disconnect(provider);
      return result.success ? result.message : result.error;
    }
  },
  
  use: {
    description: 'Set active provider and model',
    usage: 'use [provider] [model]',
    aliases: [],
    handler: async (args, context = {}) => {
      const manager = context.connectionManager || connectionManager;
      const [provider, model] = args;
      
      if (!provider) {
        const connections = manager.listConnections();
        if (connections.length === 0) return 'No connections. Use /connect <provider> <api-key>, or /connect ollama.';
        await Promise.all(connections.map(c => refreshProviderModels(manager, c.provider)));
        
        let output = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        output += '  Active Connections\n';
        output += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        
        for (const conn of connections) {
          const models = manager.listModels(conn.provider);
          if (models.success) {
            output += `${conn.provider.toUpperCase()}${conn.isActive ? ' ✓' : ''}:\n`;
            output += models.models.map((m, i) => {
              const id = modelId(m);
              const activeModel = manager.activeModel;
              return `  ${(i + 1).toString().padStart(2)}. ${id}${conn.isActive && id === activeModel ? ' ←' : ''}`;
            }
            ).join('\n') + '\n\n';
          }
        }
        
        output += 'Usage: /use <provider> [model]';
        output += '\nExample: /use openai gpt-4o';
        return output;
      }
      
      if (!manager.isConnected(provider)) {
        const meta = providerMeta(provider);
        const connectHint = meta?.requiresKey === false ? `/connect ${provider}` : `/connect ${provider} <api-key>`;
        return `Not connected to ${provider}. Use ${connectHint} first.`;
      }
      
      if (!model) {
        await refreshProviderModels(manager, provider);
        const models = manager.listModels(provider);
        if (!models.success) return models.error;
        
        let output = `Models for ${provider.toUpperCase()}:\n\n`;
        output += models.models.map((m, i) => 
          `  ${(i + 1).toString().padStart(2)}. ${modelId(m)}${modelDescription(m)}`
        ).join('\n');
        if (models.models.length > 0) {
          output += `\n\nQuick select: /use ${provider} ${modelId(models.models[0])}`;
        }
        output += '\n\nUsage: /use <provider> <model>';
        return output;
      }
      
      const models = manager.listModels(provider);
      if (models.success && models.models.length > 0) {
        const match = models.models.find(m => modelId(m) === model);
        if (!match) {
          const first = models.models.slice(0, 5).map(modelId).join(', ');
          return `Model not found for ${provider}: ${model}\nAvailable: ${first}${models.models.length > 5 ? ', ...' : ''}\nRun /models ${provider} to list all models.`;
        }
      }

      const result = manager.setActive(provider, model);
      if (!result.success) {
        return result.error;
      }
      
      return `✓ Now using: ${result.provider}/${result.model}`;
    }
  },
  
  select: {
    description: 'Select model interactively',
    usage: 'select [provider]',
    aliases: ['sel'],
    handler: async (args) => {
      const [provider] = args;
      
      const conn = provider ? connectionManager.connections.get(provider.toLowerCase()) : connectionManager.getActive();
      
      if (!conn) {
        return 'No active connection. Use /connect first.';
      }
      
      const providerName = provider || connectionManager.activeProvider;
      await connectionManager.refreshModels(providerName).catch(() => null);
      const models = connectionManager.listModels(providerName);
      
      if (!models.success) return models.error;
      
      let output = `Select model for ${providerName.toUpperCase()}:\n\n`;
      output += models.models.map((m, i) => 
        `  ${(i + 1).toString().padStart(2)}. ${m.id}`
      ).join('\n');
      output += '\n\nEnter number to select:';
      
      return output;
    }
  },
  
  providers: {
    description: 'List available LLM providers and their models',
    usage: 'providers',
    aliases: [],
    handler: async () => {
      const providers = ConnectionManager.getAvailableProviders();

      let output = 'Available providers:\n';
      for (const p of providers) {
        const connected = connectionManager.isConnected(p.name);
        const providerEntry = PROVIDER_REGISTRY.find(entry => entry.id === p.name);
        const models = providerEntry?.Class?.getInfo?.()?.models || [];

        output += `\n${p.icon || ''}${p.name.toUpperCase()} - ${p.description}${connected ? ' [connected]' : ''}\n`;
        if (p.keyHint) output += ` Key hint: ${p.keyHint}\n`;
        output += ` Requires key: ${p.requiresKey ? 'Yes' : 'No'}\n`;
        if (models.length > 0) {
          output += ` Models (${models.length}):\n`;
          for (const m of models) {
            output += `   • ${m.id}${m.description ? ` - ${m.description}` : ''}\n`;
          }
        }
      }

      return output;
    }
  },
  
  models: {
    description: 'List available models for current/all providers',
    usage: 'models [provider]',
    aliases: ['lsmodels', 'listmodels'],
    handler: async (args, context = {}) => {
      const manager = context.connectionManager || connectionManager;
      const [provider] = args;
      
      if (provider) {
        if (!manager.isConnected(provider)) {
          const meta = providerMeta(provider);
          if (!meta) return `Provider not found: ${provider}\nRun /providers to list supported providers.`;
          const hint = meta.requiresKey ? `/connect ${provider} <api-key>` : `/connect ${provider}`;
          return `Not connected to ${provider}. Use ${hint} first.`;
        }
        await refreshProviderModels(manager, provider);
        const models = manager.listModels(provider);
        if (!models.success) return `${models.error}\nRun /doctor if the provider should be connected.`;
        return `Models for ${provider}:\n` + models.models.map(m => 
          `  ${modelId(m)}${modelDescription(m)}`
        ).join('\n');
      }
      
      const connections = manager.listConnections();
      if (connections.length === 0) return 'No connected providers. Use /connect <provider> <api-key>, or /connect ollama.';
      await Promise.all(connections.map(c => refreshProviderModels(manager, c.provider)));
      
      let output = 'Available models:\n';
      for (const conn of connections) {
        const models = manager.listModels(conn.provider);
        if (models.success) {
          output += `\n${conn.provider.toUpperCase()}${conn.isActive ? ' ✓' : ''}:\n`;
          output += models.models.map(m => {
            const id = modelId(m);
            const active = conn.isActive && id === manager.activeModel ? ' ← active' : '';
            return `  ${id}${modelDescription(m)}${active}`;
          }).join('\n');
        } else {
          output += `\n${conn.provider.toUpperCase()}:\n  Error: ${models.error}\n`;
        }
      }
      output += '\n\nUse /use <provider> <model> to switch.';
      return output;
    }
  },
  
  theme: {
    description: 'Change UI theme (default/midnight/matrix/forest)',
    usage: 'theme <name>',
    aliases: [],
    handler: async (args) => {
      const [themeName] = args;
      
      if (!themeName) {
        return `Available themes: default, midnight, matrix, forest\nUsage: /theme <name>`;
      }
      
      const validThemes = ['default', 'midnight', 'matrix', 'forest'];
      if (!validThemes.includes(themeName.toLowerCase())) {
        return `Invalid theme. Available: ${validThemes.join(', ')}`;
      }
      
      return { action: 'setTheme', theme: themeName.toLowerCase() };
    }
  },
  
  config: {
    description: 'Show/set configuration. Use --local to save in project directory (.ettore/config.json)',
    usage: 'config [key] [value] [--local|-l]',
    aliases: ['cfg'],
    handler: async (args, context) => {
      const [key, value, ...rest] = args;
      const { loadConfig, saveConfig, saveConfigAsync, hasLocalConfig, initProject, getEffectiveConfig } = await import('../config/index.js');

      // Flag --local
      const isLocal = rest.includes('--local') || rest.includes('-l');

      // /config --local (mostra info su config locale)
      if (key === '--local' || key === '-l') {
        const hasLocal = await hasLocalConfig();
        if (hasLocal) {
          const localConfig = await getEffectiveConfig();
          return `Local configuration (from .ettore/config.json):
provider: ${localConfig.activeProvider || 'not set'}
model: ${localConfig.activeModel || 'not set'}
stream: ${localConfig.stream ?? 'not set'}
theme: ${localConfig.theme || 'not set'}`;
        } else {
          return 'No local configuration found. Use /config --init to create .ettore/config.json in this project.';
        }
      }

      // /config --init (inizializza progetto)
      if (key === '--init') {
        try {
          const projectRoot = await initProject();
          return `Initialized ETTORE project in ${projectRoot}/.ettore/config.json`;
        } catch (e) {
          return `Error: ${e.message}`;
        }
      }

      // /config (senza argomenti) - mostra configurazione attuale
      if (!key) {
        const config = await loadConfig({});
        const hasLocal = await hasLocalConfig();
        let output = `Current configuration${hasLocal ? ' (with local overrides)' : ''}:
provider: ${context.provider || config.provider || 'none'}
model: ${config.model}
stream: ${config.stream}
workdir: ${config.workdir}`;

        if (hasLocal) {
          output += '\n\nLocal config (.ettore/config.json): ✓ active';
        } else {
          output += '\n\nNo local config. Use /config --init to create project-local settings.';
        }
        return output;
      }

      // /config model <value> [--local]
      if (key === 'model' && value) {
        if (isLocal) {
          await saveConfigAsync('activeModel', value, { local: true });
          return `Model set to: ${value} (saved in .ettore/config.json)`;
        } else {
          saveConfig('activeModel', value);
          return `Model set to: ${value} (saved globally)`;
        }
      }

      // /config stream <true|false> [--local]
      if (key === 'stream') {
        const boolVal = value === 'true';
        if (isLocal) {
          await saveConfigAsync('stream', boolVal, { local: true });
          return `Stream set to: ${boolVal} (saved in .ettore/config.json)`;
        } else {
          saveConfig('stream', boolVal);
          return `Stream set to: ${boolVal} (saved globally)`;
        }
      }

      // /config theme <name> [--local]
      if (key === 'theme' && value) {
        if (isLocal) {
          await saveConfigAsync('theme', value, { local: true });
          return `Theme set to: ${value} (saved in .ettore/config.json)`;
        } else {
          saveConfig('theme', value);
          return `Theme set to: ${value} (saved globally)`;
        }
      }

      // /config provider <name> [--local]
      if (key === 'provider' && value) {
        if (isLocal) {
          await saveConfigAsync('activeProvider', value, { local: true });
          return `Provider set to: ${value} (saved in .ettore/config.json)`;
        } else {
          saveConfig('activeProvider', value);
          return `Provider set to: ${value} (saved globally)`;
        }
      }

      return `Usage: /config [key] [value] [--local|-l]

Available keys:
  model <name>     Set the LLM model
  provider <name>  Set the LLM provider
  stream <bool>    Enable/disable streaming
  theme <name>     Set the UI theme

Flags:
  --local, -l      Save configuration in project directory (.ettore/config.json)
  --init           Initialize project-local configuration

Examples:
  /config                          Show current configuration
  /config model gpt-4o             Set model globally
  /config model claude-3-opus --local   Set model for this project only
  /config theme midnight --local     Set theme for this project
  /config --init                   Initialize .ettore/config.json
  /config --local                  Show local configuration`;
    }
  },
  
  history: {
    description: 'Show command history',
    usage: 'history [limit]',
    aliases: ['hist'],
    handler: async (args, context) => {
      const history = context.history || [];
      if (history.length === 0) return 'No history yet';
      
      const limit = parseInt(args[0]) || 20;
      const recent = history.slice(-limit);
      
      return 'Command history:\n' + recent.map((h, i) => 
        `  ${history.length - recent.length + i + 1}. ${h}`
      ).join('\n');
    }
  },
  
  system: {
    description: 'Show system information',
    usage: 'system',
    aliases: ['sys', 'info'],
    handler: async (_args, _context) => {
      const os = await import('os');
      const connections = connectionManager.listConnections();
      const active = connectionManager.getActive();
      
      return `ETTORE System Info
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Version: 1.0.0
  Platform: ${os.platform()} ${os.arch()}
  CPU: ${os.cpus().length} cores
  Memory: ${Math.round(os.freemem() / 1024 / 1024)}MB free
  
  Connections: ${connections.length}
  Active: ${active ? active.provider : 'none'}
  Working Directory: ${process.cwd()}`;
    }
  },
  
  alias: {
    description: 'Manage command aliases',
    usage: 'alias list',
    aliases: [],
    handler: async (args) => {
      const [action] = args;
      
      if (action === 'list') {
        const aliases = await import('../utils/aliases.js').catch(() => ({ default: {} }));
        const list = aliases.default || {};
        if (Object.keys(list).length === 0) return 'No aliases defined';
        return 'Aliases:\n' + Object.entries(list).map(([k, v]) => 
          `  ${k} -> ${v}`
        ).join('\n');
      }
      
      return `Usage: /alias list`;
    }
  },
  
  version: {
    description: 'Show version',
    usage: 'version',
    aliases: ['v', 'ver'],
    handler: async () => {
      return `ETTORE v1.0.0
Advanced AI CLI Assistant`;
    }
  },
  
  keys: {
    description: 'Manage saved API keys',
    usage: 'keys [list|add|remove] [provider] [api-key]',
    aliases: ['apikeys'],
    handler: async (args) => {
      const [action, provider, apiKey] = args;
      
      if (!action || action === 'list') {
        const saved = connectionManager.getSavedConnections();
        if (saved.length === 0) {
          return `No saved API keys.
          
Usage:
  /keys add <provider> <api-key>   Add/update API key
  /keys remove <provider>          Remove API key
  /keys list                      List saved keys`;
        }
        
        let output = `┌─ Saved Connections ─────────────────────────┐
│ Provider    │ Status   │ Models            │
├─────────────┼──────────┼──────────────────┤
`;
        for (const s of saved) {
          const status = s.valid ? '✓ Valid' : '✗ Invalid';
          output += `│ ${s.provider.padEnd(11)} │ ${status.padEnd(8)} │ ${s.modelsCount} models    │\n`;
        }
        output += '└────────────────────────────────────────────┘';
        
        return output;
      }
      
      if (action === 'add' || action === 'update' || action === 'set') {
        if (!provider || !apiKey) {
          return `Usage: /keys add <provider> <api-key>
Example: /keys add openai sk-...`;
        }
        
        const result = await connectionManager.updateKey(provider, apiKey);
        if (result.success) {
          return `✓ ${result.message}`;
        }
        return `✗ ${redactSecrets(result.error, [apiKey])}`;
      }
      
      if (action === 'remove' || action === 'delete' || action === 'del') {
        if (!provider) {
          return `Usage: /keys remove <provider>
Example: /keys remove openai`;
        }
        
        const result = await connectionManager.deleteKey(provider);
        if (result.success) {
          return `✓ ${result.message}`;
        }
        return `✗ ${result.error}`;
      }
      
      return `Unknown action. Use: list, add, remove`;
    }
  },
  
  compress: {
    description: 'Compress conversation context to reduce token usage',
    usage: 'compress [preview|apply|auto|stats|threshold|history|undo]',
    aliases: ['ctx'],
    handler: async (args, context) => {
      const [subcommand, ...rest] = args;
      const agent = context.agent;
      if (!agent?.compressor) return 'Compression not available in this session.';
      const compressor = agent.compressor;
      const messages = agent.messages;

      if (!subcommand || subcommand === 'preview') {
        const preview = await compressor.buildPreview(messages);
        if (!preview.eligible) {
          return `Nothing to compress yet.\n  Current tokens: ~${preview.currentTokens}  Threshold: ${preview.threshold}`;
        }
        return `Context compression preview\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  Messages to compress : ${preview.compressCount} of ${preview.msgCount}\n  Tokens now           : ~${preview.currentTokens}\n  Threshold            : ${preview.threshold}\n\nUse /compress apply to proceed.`;
      }

      if (subcommand === 'apply') {
        const preview = await compressor.buildPreview(messages);
        if (!preview.eligible) return 'Nothing to compress.';
        agent.messages = await compressor.compress(messages, context.emitter);
        const after = Math.round(agent.messages.reduce((a, m) => a + (m.content?.length || 0) / 4, 0));
        return `✓ Context compressed: ~${preview.currentTokens} → ~${after} tokens`;
      }

      if (subcommand === 'auto') {
        const [toggle] = rest;
        if (!toggle || !['on', 'off'].includes(toggle)) {
          return `Auto-compress is: ${compressor.autoEnabled ? 'ON' : 'OFF'}\nUsage: /compress auto on|off`;
        }
        await compressor.setAuto(toggle === 'on');
        return `Auto-compress: ${toggle.toUpperCase()}`;
      }

      if (subcommand === 'stats') {
        const s = compressor.getStats(messages);
        const pct = Math.min(100, Math.round((s.usedTokens / s.maxTokens) * 100));
        const filled = Math.round(pct / 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        return `Context Stats\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  Tokens used     : ~${s.usedTokens} / ${s.maxTokens}  (${pct}%)\n  [${bar}]\n  Compressions run: ${s.compressionCount}\n  Tokens saved    : ~${s.totalSaved}\n  Auto-compress   : ${s.autoEnabled ? 'ON' : 'OFF'}  (threshold: ${s.threshold})`;
      }

      if (subcommand === 'threshold') {
        const n = parseInt(rest[0]);
        if (isNaN(n) || n < 500) return 'Invalid threshold. Must be a number >= 500.';
        await compressor.setThreshold(n);
        return `✓ Compression threshold set to: ${n} tokens`;
      }

      if (subcommand === 'history') {
        const log = compressor.getHistory();
        if (!log.length) return 'No compressions performed yet.';
        return 'Compression history:\n' + log.map((e, i) =>
          `  ${i + 1}. [${e.timestamp}]  ${e.before} → ${e.after} tokens  (-${e.savedPct}%)`
        ).join('\n');
      }

      if (subcommand === 'undo') {
        const result = compressor.undo(messages);
        if (!result.success) return `Cannot undo: ${result.reason}`;
        agent.messages = result.messages;
        return `✓ Compression undone. Context restored to ~${result.restoredTokens} tokens.`;
      }

      return `Usage: /compress [preview|apply|auto on|off|stats|threshold <n>|history|undo]`;
    }
  },

  agent: {
    description: 'Inspect agent runtime memory and optimization stats',
    usage: 'agent [stats|memory|clear]',
    aliases: ['wm'],
    handler: async (args, context) => {
      const [subcommand = 'stats'] = args;
      const agent = context.agent;
      if (!agent?.getWorkingMemorySnapshot) return 'Agent runtime memory is not available in this session.';

      if (subcommand === 'clear' || subcommand === 'reset') {
        agent.clearWorkingMemory?.();
        return 'Agent working memory cleared. Tool cache reset.';
      }

      const snapshot = agent.getWorkingMemorySnapshot();
      const toolRows = Object.entries(snapshot.toolStats || {})
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `  ${name.padEnd(12)} ${count}`)
        .join('\n') || '  no tool calls yet';

      if (subcommand === 'memory' || subcommand === 'show') {
        const files = Object.entries(snapshot.filesSeen || {}).slice(-12);
        const fileRows = files.length
          ? files.map(([path, info]) => {
              const detail = info.lastRead || info.summary || 'seen';
              return `  ${path}\n    ${detail}`;
            }).join('\n')
          : '  no files seen yet';
        const recent = (snapshot.recentTools || []).map(t =>
          `  ${t.name} x${t.count} ${JSON.stringify(t.args || {}).slice(0, 90)}`
        ).join('\n') || '  no recent tools';
        return `Agent Working Memory
Goal: ${snapshot.goal || 'none'}
Next action: ${snapshot.nextAction || 'none'}
Workspace revision: ${snapshot.workspaceRevision}
Updated: ${snapshot.updatedAt || 'n/a'}

Files seen
${fileRows}

Recent tools
${recent}`;
      }

      if (subcommand === 'stats') {
        return `Agent Runtime Stats
Cache entries      : ${snapshot.cacheEntries}
Cache hits         : ${snapshot.cacheHits}
Summarized outputs : ${snapshot.summarizedOutputs}
Duplicate skips    : ${snapshot.duplicateSkips}
Workspace revision : ${snapshot.workspaceRevision}

Tool calls
${toolRows}`;
      }

      return 'Usage: /agent [stats|memory|clear]';
    }
  },

  approvals: {
    description: 'Inspect or clear session approvals for installs/downloads',
    usage: 'approvals [list|clear] [project|system|download]',
    aliases: ['allowances'],
    handler: async (args) => {
      const tokens = args.map(arg => String(arg)).flatMap(arg => arg.split(/\s+/).filter(Boolean));
      const [first = 'list', second = ''] = tokens;
      const kinds = new Set(['project', 'system', 'download']);
      const isKind = (value) => kinds.has(String(value).toLowerCase());
      const kind = isKind(first) ? first.toLowerCase() : (isKind(second) ? second.toLowerCase() : null);
      const subcommand = isKind(first) ? 'list' : first.toLowerCase();

      if (subcommand === 'clear' || subcommand === 'reset') {
        clearInstallSessionApprovals(kind);
        return kind
          ? `Session approvals cleared for kind "${kind}".`
          : 'Session approvals cleared.';
      }

      if (subcommand !== 'list' && subcommand !== 'show') {
        if (isKind(first)) {
          const items = listInstallSessionApprovals(first);
          if (!items.length) return `No session approvals stored for kind "${first}".`;
          return `Session approvals (${first})
${items.map(item => `  - [${item.kind}] ${item.label}`).join('\n')}

Use /approvals clear ${first} to reset them.`;
        }
        return 'Usage: /approvals [list|clear] [project|system|download]';
      }

      const items = listInstallSessionApprovals(kind);
      if (!items.length) {
        return kind
          ? `No session approvals stored for kind "${kind}".`
          : 'No session approvals stored.';
      }

      return `Session approvals${kind ? ` (${kind})` : ''}
${items.map(item => `  - [${item.kind}] ${item.label}`).join('\n')}

Use /approvals clear${kind ? ` ${kind}` : ''} to reset them.`;
    }
  },

  memory: {
    description: 'Manage persistent project memory (show/add/clear/edit/export/path)',
    usage: 'memory [show|add|clear|edit|export|path]',
    aliases: ['mem'],
    handler: async (args, _context) => {
      const [subcommand, ...rest] = args;
      const { writeFile } = await import('fs/promises');
      const { detectProjectRoot, loadProjectMemory, saveProjectMemory, updateMemorySection, getMemoryPath, getProjectName } = await import('../memory/index.js');

      const projectRoot = await detectProjectRoot(process.cwd());

      if (!subcommand || subcommand === 'show') {
        if (!projectRoot) return 'No project detected in current directory (no .git / package.json / etc.)';
        const content = await loadProjectMemory(projectRoot);
        if (!content || !content.trim()) {
          return `No memory for project "${getProjectName(projectRoot)}" yet.\n\nUse /memory add <text> to add a note, or let ETTORE save automatically during sessions.\nFile: ${getMemoryPath(projectRoot)}`;
        }
        if (!subcommand) {
          const lines = content.trim().split('\n').filter(Boolean);
          return `Project: ${getProjectName(projectRoot)} — ${lines.length} lines\nFile: ${getMemoryPath(projectRoot)}\n\nUse /memory show to view full contents.`;
        }
        return `─── Project Memory: ${getProjectName(projectRoot)} ───\n${content}`;
      }

      if (subcommand === 'clear') {
        if (!projectRoot) return 'No project detected.';
        const content = await loadProjectMemory(projectRoot);
        if (!content || !content.trim()) return 'No memory to clear.';
        await saveProjectMemory(projectRoot, '');
        return `✓ Memory cleared for project "${getProjectName(projectRoot)}"`;
      }

      if (subcommand === 'add') {
        if (!projectRoot) return 'No project detected.';
        const text = rest.join(' ').trim();
        if (!text) return 'Usage: /memory add <text>';
        const date = new Date().toISOString().slice(0, 10);
        await updateMemorySection(projectRoot, 'USER_PREFERENCES', `- [${date}] ${text}`, 'append');
        return `[mem] Saved: "${text}"`;
      }

      if (subcommand === 'edit') {
        if (!projectRoot) return 'No project detected.';
        const memPath = getMemoryPath(projectRoot);
        const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
        const { execSync } = await import('child_process');
        try {
          execSync(`${editor} "${memPath}"`, { stdio: 'inherit' });
          return `✓ Memory updated. Changes will be loaded in next session.`;
        } catch (e) {
          return `✗ Could not open editor: ${e.message}\nFile: ${memPath}`;
        }
      }

      if (subcommand === 'export') {
        if (!projectRoot) return 'No project detected.';
        const content = await loadProjectMemory(projectRoot);
        if (!content || !content.trim()) return 'No memory to export.';
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const dest = rest[0] || `${process.cwd()}/ettore_memory_${getProjectName(projectRoot)}_${date}.md`;
        await writeFile(dest, content, 'utf-8');
        return `✓ Memory exported to: ${dest}`;
      }

      if (subcommand === 'path') {
        if (!projectRoot) return 'No project detected.';
        const memPath = getMemoryPath(projectRoot);
        const content = await loadProjectMemory(projectRoot);
        return `Project: ${getProjectName(projectRoot)}\nRoot: ${projectRoot}\nMemory file: ${memPath}\nExists: ${content ? 'yes' : 'no'}`;
      }

      return `Unknown subcommand.\n\nAvailable: show, add <text>, clear, edit, export [file], path`;
    }
  },

  ecosystem: {
    description: 'Manage ETTORE self-learning ecosystem memory (show/prune/export/path)',
    usage: 'ecosystem [show|prune|export|path]',
    aliases: ['eco'],
    handler: async (args) => {
      const [subcommand, ...rest] = args;
      const { writeFile } = await import('fs/promises');
      const {
        detectProjectRoot,
        getProjectName,
        getEcosystemPath,
        loadEcosystemMemory,
        saveEcosystemMemory,
        initEcosystemMemory,
      } = await import('../memory/index.js');

      const projectRoot = await detectProjectRoot(process.cwd());
      if (!projectRoot) return 'No project detected in current directory (no .git / package.json / etc.)';

      if (!subcommand || subcommand === 'show') {
        await initEcosystemMemory(projectRoot);
        const content = await loadEcosystemMemory(projectRoot);
        if (!content || !content.trim()) {
          return `No ecosystem memory for project "${getProjectName(projectRoot)}" yet.\nFile: ${getEcosystemPath(projectRoot)}`;
        }
        if (!subcommand) {
          const lines = content.trim().split('\n').filter(Boolean);
          return `Project: ${getProjectName(projectRoot)} — ${lines.length} lines\nFile: ${getEcosystemPath(projectRoot)}\n\nUse /ecosystem show to view full contents.`;
        }
        return `─── Ecosystem Memory: ${getProjectName(projectRoot)} ───\n${content}`;
      }

      if (subcommand === 'prune') {
        await initEcosystemMemory(projectRoot);
        const content = await loadEcosystemMemory(projectRoot);
        if (!content || !content.trim()) return 'No ecosystem memory to prune.';

        const keepCount = Math.max(10, Math.min(parseInt(rest[0] || '40', 10) || 40, 200));
        const marker = '## LEARNED_EXPERIENCES';
        const idx = content.indexOf(marker);
        if (idx === -1) return 'Ecosystem format invalid: LEARNED_EXPERIENCES section missing.';

        const head = content.slice(0, idx + marker.length);
        const tail = content.slice(idx + marker.length);
        const blocks = tail.split(/\n(?=###\s)/g).map(b => b.trim()).filter(Boolean);
        const kept = blocks.slice(0, keepCount);
        const pruned = `${head}\n\n${kept.join('\n\n')}\n`;
        await saveEcosystemMemory(projectRoot, pruned);
        return `✓ Ecosystem pruned: kept ${kept.length}/${blocks.length} experience entries.`;
      }

      if (subcommand === 'export') {
        await initEcosystemMemory(projectRoot);
        const content = await loadEcosystemMemory(projectRoot);
        if (!content || !content.trim()) return 'No ecosystem memory to export.';
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const dest = rest[0] || `${process.cwd()}/ettore_ecosystem_${getProjectName(projectRoot)}_${date}.md`;
        await writeFile(dest, content, 'utf-8');
        return `✓ Ecosystem exported to: ${dest}`;
      }

      if (subcommand === 'path') {
        await initEcosystemMemory(projectRoot);
        const ecoPath = getEcosystemPath(projectRoot);
        const content = await loadEcosystemMemory(projectRoot);
        return `Project: ${getProjectName(projectRoot)}\nRoot: ${projectRoot}\nEcosystem file: ${ecoPath}\nExists: ${content ? 'yes' : 'no'}`;
      }

      return 'Unknown subcommand.\n\nAvailable: show, prune [keepCount], export [file], path';
    }
  },

  reconnect: {
    description: 'Reconnect to provider with saved key',
    usage: 'reconnect [provider]',
    aliases: ['recon'],
    handler: async (args) => {
      const [provider] = args;
      
      const saved = connectionManager.getSavedConnections();
      const toReconnect = provider 
        ? saved.filter(s => s.provider === provider.toLowerCase())
        : saved;
      
      if (toReconnect.length === 0) {
        return 'No saved keys to reconnect. Use /keys add first.';
      }
      
      let output = '';
      for (const s of toReconnect) {
        output += `Reconnecting to ${s.provider}...\n`;
      }
      
      return output + '\nUse /use <provider> to activate a connection.';
    }
  },

  init: {
    description: 'Re-initialize session and reload project memory',
    usage: 'init',
    aliases: ['restart', 'reset'],
    handler: async (args, context) => {
      const { agent } = context;

      if (!agent) {
        return 'No active session to reinitialize.';
      }

      agent.reset();

      const memInfo = await agent._memoryReady;
      if (memInfo) {
        return `Session reinitialized.\nMemory loaded: ${memInfo.projectName}\nConversation reset — all messages cleared.`;
      } else {
        return `Session reinitialized.\nNo project memory found — conversation reset.`;
      }
    }
  },

  team: {
    description: 'Gestisci team di agenti. /team create <nome> | /team list | /team show <nome> | /team delete <nome> | /team <nome>',
    usage: 'team [create|list|show|delete] [nome]',
    aliases: [],
    handler: async (args, context) => {
      const { mkdir, writeFile, readFile, readdir, unlink, access } = await import('fs/promises');
      const { join, dirname } = await import('path');
      const { fileURLToPath } = await import('url');
      const { uiBridge } = await import('../tools/bridge.js');

      const __dir = dirname(fileURLToPath(import.meta.url));
      const teamsDir = join(__dir, '../../team');

      const askUser = (question) => new Promise((resolve) => {
        uiBridge.emit('askUser', { question, options: [], resolve });
      });

      const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

      const [subCmd, ...rest] = args;

      // ── /team list ──────────────────────────────────────────────────
      if (!subCmd || subCmd === 'list') {
        const files = await readdir(teamsDir).catch(() => []);
        const teams = files.filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
        if (teams.length === 0) {
          return 'Nessun team creato.\nUsa /team create <nome> per crearne uno.\nEsempio: /team create doganale';
        }
        return `Team disponibili (${teams.length}):\n${teams.map(t => `  • ${t}`).join('\n')}\n\nUsa /team <nome> per caricare un team.`;
      }

      // ── /team show <nome> ───────────────────────────────────────────
      if (subCmd === 'show') {
        const name = rest[0];
        if (!name) return 'Uso: /team show <nome>';
        try {
          return await readFile(join(teamsDir, `${name}.md`), 'utf-8');
        } catch {
          return `Team "${name}" non trovato. Usa /team list per vedere i team disponibili.`;
        }
      }

      // ── /team delete <nome> ─────────────────────────────────────────
      if (subCmd === 'delete') {
        const name = rest[0];
        if (!name) return 'Uso: /team delete <nome>';
        try {
          await unlink(join(teamsDir, `${name}.md`));
          return `✓ Team "${name}" eliminato.`;
        } catch {
          return `Team "${name}" non trovato.`;
        }
      }

      // ── /team create <nome> ─────────────────────────────────────────
      if (subCmd === 'create') {
        const teamName = rest[0];
        if (!teamName) {
          return 'Uso: /team create <nome>\nEsempio: /team create doganale';
        }

        const teamFile = join(teamsDir, `${teamName}.md`);
        try {
          await access(teamFile);
          return `Team "${teamName}" esiste già.\nUsa /team show ${teamName} per visualizzarlo.\nUsa /team delete ${teamName} per eliminarlo.`;
        } catch {}

        // Wizard interattivo
        const nStr = await askUser(`Quanti agenti vuoi nel team "${teamName}"? (inserisci un numero, es: 3)`);
        const n = parseInt(nStr);
        if (isNaN(n) || n < 1 || n > 20) {
          return `Numero agenti non valido: "${nStr}". Inserisci un numero tra 1 e 20.`;
        }

        const agents = [];
        for (let i = 1; i <= n; i++) {
          const agentName = await askUser(`[Agente ${i}/${n}] Nome: (es: Analista Doganale)`);
          const agentComp = await askUser(`[Agente ${i}/${n}] Competenze di "${agentName}": (es: analisi bollette, classificazione merci, normativa doganale)`);
          agents.push({ name: agentName.trim(), competencies: agentComp.trim() });
        }

        // Costruisci il file markdown
        const date = new Date().toISOString().slice(0, 10);
        let md = `---\nname: ${teamName}\nagents: ${n}\ncreated: ${date}\n---\n\n`;
        md += `# Team ${capitalize(teamName)}\n\n`;
        md += `## Composizione Team (${n} agenti)\n\n`;
        for (let i = 0; i < agents.length; i++) {
          md += `### ${i + 1}. ${agents[i].name}\n`;
          md += `**Competenze:** ${agents[i].competencies}\n\n`;
        }
        md += `## Workflow\n`;
        md += `Gli agenti lavorano in parallelo sul proprio dominio di competenza.\n`;
        md += `\n## Come usare\n`;
        md += `Carica questo team con: \`/team ${teamName}\`\n`;

        await mkdir(teamsDir, { recursive: true });
        await writeFile(teamFile, md, 'utf-8');

        let summary = `✓ Team "${teamName}" creato con ${n} agenti!\n`;
        summary += `File: team/${teamName}.md\n\n`;
        summary += agents.map((a, i) => `  ${i + 1}. ${a.name} — ${a.competencies}`).join('\n');
        summary += `\n\nUsa /team ${teamName} per caricarlo nell'agente corrente.`;
        return summary;
      }

      // ── /team <nome> o /team/<nome> — carica o crea il team ───────
      const teamName = subCmd;
      const teamFile = join(teamsDir, `${teamName}.md`);

      // Se il file esiste → carica
      try {
        const content = await readFile(teamFile, 'utf-8');
        if (context.agent) {
          context.agent.teamContext = content;
        }
        return `✓ Team "${teamName}" caricato!\n\n${content}`;
      } catch {}

      // File non esiste → wizard di creazione
      const nStr = await askUser(`Team "${teamName}" non esiste. Quanti agenti vuoi? (es: 3)`);
      const n = parseInt(nStr);
      if (isNaN(n) || n < 1 || n > 20) {
        return `Numero agenti non valido: "${nStr}". Inserisci un numero tra 1 e 20.`;
      }

      const agents = [];
      for (let i = 1; i <= n; i++) {
        const agentName = await askUser(`[Agente ${i}/${n}] Nome: (es: Analista Doganale)`);
        const agentComp = await askUser(`[Agente ${i}/${n}] Competenze di "${agentName}": (es: analisi bollette, classificazione merci)`);
        agents.push({ name: agentName.trim(), competencies: agentComp.trim() });
      }

      const date = new Date().toISOString().slice(0, 10);
      let md = `---\nname: ${teamName}\nagents: ${n}\ncreated: ${date}\n---\n\n`;
      md += `# Team ${capitalize(teamName)}\n\n`;
      md += `## Composizione Team (${n} agenti)\n\n`;
      for (let i = 0; i < agents.length; i++) {
        md += `### ${i + 1}. ${agents[i].name}\n`;
        md += `**Competenze:** ${agents[i].competencies}\n\n`;
      }
      md += `## Workflow\nGli agenti lavorano in parallelo sul proprio dominio di competenza.\n`;
      md += `\n## Come usare\nCarica questo team con: \`/team/${teamName}\`\n`;

      await mkdir(teamsDir, { recursive: true });
      await writeFile(teamFile, md, 'utf-8');

      let summary = `✓ Team "${teamName}" creato con ${n} agenti!\n`;
      summary += `File: team/${teamName}.md\n\n`;
      summary += agents.map((a, i) => `  ${i + 1}. ${a.name} — ${a.competencies}`).join('\n');
      summary += `\n\nRichiama il team con: /team/${teamName}`;
      return summary;
    }
  }
};
