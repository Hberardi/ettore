// One-shot (non-interactive) mode
import { connectionManager } from '../providers/index.js';
import { loadConfig } from '../config/index.js';
import { createClient } from '../llm/client.js';
import { Agent } from '../agents/index.js';
import { EventEmitter } from 'events';
import { getModelPricing } from '../utils/pricing.js';

export async function runPrompt(prompt, options = {}) {
  if (options.apiKey) {
    console.error('Warning: --api-key can expose secrets in shell history and process lists. Prefer provider environment variables or interactive /connect.');
  }

  const connections = connectionManager.listConnections();
  if (connections.length > 0 && !connectionManager.activeProvider) {
    connectionManager.setActive(connections[0].provider, null);
  }

  if (!connectionManager.getActive()) {
    console.error(`Not connected.
Run "ettore" to open the interactive TUI, then use /connect.
For local models, start Ollama and run /connect ollama.`);
    process.exit(1);
  }

  const config = await loadConfig(options);
  config.contextWindow = getModelPricing(config.model).ctx || 128000;
  const client = createClient(config);
  const agent = new Agent(client, config);
  const em = new EventEmitter();
  let hadError = false;

  em.on('token', (text) => process.stdout.write(text));
  em.on('error', (message) => {
    hadError = true;
    process.stderr.write(`\nError: ${String(message || 'Unknown error')}\n`);
  });
  em.on('cancelled', () => {
    hadError = true;
    process.stderr.write('\nCancelled.\n');
  });
  em.on('toolStart', ({ name, args }) => {
    const preview = Object.values(args || {})[0];
    process.stderr.write(`\n⚙ ${name}(${String(preview || '').slice(0, 60)})\n`);
  });
  em.on('toolEnd', ({ output }) => {
    const lines = String(output || '').split('\n').slice(0, 5);
    process.stderr.write(lines.map(l => `│ ${l}`).join('\n') + '\n');
  });

  await agent.run(prompt, em);
  if (hadError) process.exitCode = 1;
  process.stdout.write('\n');
}
