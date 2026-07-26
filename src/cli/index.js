// One-shot (non-interactive) mode
import { connectionManager } from '../providers/index.js';
import { loadConfig } from '../config/index.js';
import { createClient } from '../llm/client.js';
import { Agent } from '../agents/index.js';
import { EventEmitter } from 'events';
import { getModelPricing, calcCost } from '../utils/pricing.js';
import { loadImageAttachments } from '../utils/images.js';
import { cleanOutput } from '../utils/output.js';

// Mirror of NON_METERED_PROVIDERS in src/app/native-ui.js: providers whose
// token counts we still log but whose cost we can't price from the public
// per-million tables. Keeping the list local avoids a circular import with
// the TUI module.
const NON_METERED_PROVIDERS = new Set(['ollama', 'nvidia', 'minimax']);

// Attaches a listener that writes a per-turn usage line to stderr. Extracted
// from runPrompt so it can be unit-tested in isolation without spinning up a
// full provider/agent stack. The listener resolves the active provider/model
// fresh on every event so that /connect and /use mid-session are reflected
// immediately in subsequent lines.
export function attachVerboseTokenLogger(em) {
  let inputTotal = 0;
  let outputTotal = 0;
  let costTotal = 0;
  let turn = 0;
  em.on('usage', ({ inputTokens, outputTokens }) => {
    const inN = Number(inputTokens) || 0;
    const outN = Number(outputTokens) || 0;
    inputTotal += inN;
    outputTotal += outN;
    turn += 1;
    const provider = connectionManager.activeProvider || '';
    const modelId = connectionManager.activeModel || '';
    const cost = NON_METERED_PROVIDERS.has(provider)
      ? null
      : calcCost(inN, outN, modelId);
    if (cost !== null) costTotal += cost;
    const costStr = cost === null ? 'n/a' : `$${cost.toFixed(4)}`;
    process.stderr.write(
      `📊 turn ${turn}: in=${inN} out=${outN}  ·  session in=${inputTotal} out=${outputTotal} cost=$${costTotal.toFixed(4)} (this turn: ${costStr})\n`,
    );
  });
  return { turn: () => turn, inputTotal: () => inputTotal, outputTotal: () => outputTotal, costTotal: () => costTotal };
}

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
  let showedInteractiveHint = false;

  em.on('token', (text) => process.stdout.write(text));
  em.on('error', (message) => {
    hadError = true;
    process.stderr.write(`\n${cleanOutput(`Error: ${String(message || 'Unknown error')}`, { maxBytes: 5_000 })}\n`);
  });
  em.on('cancelled', () => {
    hadError = true;
    process.stderr.write('\nCancelled.\n');
  });
  em.on('toolStart', ({ name, args }) => {
    const preview = Object.values(args || {})[0];
    process.stderr.write(`\n⚙ ${name}(${cleanOutput(String(preview || '').slice(0, 60), { maxBytes: 200 })})\n`);
  });
  em.on('toolEnd', ({ output }) => {
    const text = String(output || '');
    const cleaned = cleanOutput(text, { maxBytes: 8_000 });
    const lines = cleaned.split('\n').slice(0, 5);
    process.stderr.write(lines.map(l => `│ ${l}`).join('\n') + '\n');
    if (!showedInteractiveHint && /requires interactive confirmation/i.test(text)) {
      showedInteractiveHint = true;
      process.stderr.write('Hint: run "ettore" for interactive confirmations, then re-run the command.\n');
    }
  });
  em.on('debug', (line) => {
    process.stderr.write(`[debug] ${cleanOutput(String(line), { maxBytes: 2_000 })}\n`);
  });

  if (options.verboseTokens) {
    const verbose = attachVerboseTokenLogger(em);
    void verbose; // listener is attached for the lifetime of `em`
  }

  let imageAttachments = [];
  try {
    imageAttachments = await loadImageAttachments(options.images, { cwd: config.workdir });
  } catch (error) {
    process.stderr.write(`Image error: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  await agent.run(prompt, em, { imageAttachments });
  if (hadError) process.exitCode = 1;
  process.stdout.write('\n');
}
