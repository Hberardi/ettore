#!/usr/bin/env node

import '../src/utils/load-env.js'; // load .env before anything reads process.env
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

function collect(value, previous) {
  return [...previous, value];
}

program
  .name('ettore')
  .description('ETTORE — Open source AI coding agent')
  .version(packageJson.version)
  .option('-m, --model <model>', 'Model to use')
  .option('--no-stream', 'Disable streaming')
  .option('-c, --context <dir>', 'Working directory')
  .option('--api-key <key>', 'Deprecated: prefer provider environment variables or /connect')
  .option('-p, --provider <name>', 'Provider (openai/anthropic/ollama)')
  .option('-i, --image <path>', 'Attach an image (repeatable; JPEG, PNG, GIF, WebP)', collect, [])
  .option('--debug', 'Enable debug trace logs')
  .option('--verbose-tokens', 'Print per-turn input/output token counts and cumulative cost to stderr')
  .argument('[prompt...]', 'Run a one-shot prompt (non-interactive)')
  .action(async (promptArgs, options) => {
    const cliOptions = {
      model:   options.model,
      stream:  options.stream,
      context: options.context,
      apiKey:  options.apiKey,
      provider: options.provider,
      images: options.image,
      debug: options.debug === true,
      verboseTokens: options.verboseTokens === true,
    };

  if (promptArgs && promptArgs.length > 0) {
    // One-shot mode
    const { runPrompt } = await import('../src/cli/index.js');
    await runPrompt(promptArgs.join(' '), cliOptions);
  } else {
    // Interactive TUI mode - use native UI instead of Ink
    const { startApp } = await import('../src/app/native-ui.js');
    await startApp(cliOptions);
  }
  });

program.parse();
