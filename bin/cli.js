#!/usr/bin/env node

import '../src/utils/load-env.js'; // load .env before anything reads process.env
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  readLocalPackage,
  checkForUpdate,
  checkForUpdateSync,
  COLD_CHECK_TIMEOUT_MS,
  describeInstall,
  formatBanner,
  planAutoUpdate,
  runUpdate,
} from '../src/cli/update.js';

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
  .version(packageJson.version, '-V, --version', 'Print the ETTORE version and exit')
  .option('-m, --model <model>', 'Model to use')
  .option('--no-stream', 'Disable streaming')
  .option('-c, --context <dir>', 'Working directory')
  .option('--api-key <key>', 'Deprecated: prefer provider environment variables or /connect')
  .option('-p, --provider <name>', 'Provider (openai/anthropic/ollama)')
  .option('-i, --image <path>', 'Attach an image (repeatable; JPEG, PNG, GIF, WebP)', collect, [])
  .option('--debug', 'Enable debug trace logs')
  .option('--verbose-tokens', 'Print per-turn input/output token counts and cumulative cost to stderr')
  .option('--no-update-check', 'Skip the npm version check at startup')
  .option('--auto-update', 'Install a newer version automatically at startup (the default)')
  .option('--no-auto-update', 'Never install automatically at startup')
  .argument('[prompt...]', 'Run a one-shot prompt (non-interactive)')
  .action(async (promptArgs, options) => {
    // ETTORE <version>. Print BEFORE the agent starts so the user can
    // confirm the build they think they're running. In a TTY the line
    // is dimmed; in a non-TTY (CI, piped output) it is plain text.
    const dim = process.stdout.isTTY ? '\x1b[2m' : '';
    const reset = process.stdout.isTTY ? '\x1b[0m' : '';
    if (process.stdout.isTTY) {
      process.stdout.write(`${dim}ettore ${packageJson.version}${reset}\n`);
    }

    // The sync check reads the 6h cache and nothing else, so it costs
    // nothing and never delays the first prompt. A cold or stale cache
    // gives back `latest: null` and simply prints no banner; the refresh
    // that fills the cache runs inside the TUI (native-ui.js), which is
    // the only mode where the process lives long enough for an npm call
    // to land. Doing it here as well would keep a one-shot run alive for
    // the npm timeout after the answer was already printed.
    let updateStatus = null;
    if (options.updateCheck !== false) {
      updateStatus = checkForUpdateSync();
    }

    // On by default. 1.3.0 made it opt-in, on the strength of a poisoned
    // version cache that had claimed the latest release was `2.88.2` — but two
    // other guards shipped in that same release, and either one alone stops
    // that: the cache now names the package it describes, and a new major is
    // never installed unattended. The opt-in was a third net over a hazard
    // already caught twice, and its cost was the thing the feature exists for:
    // an install that has to be told to update is one that stays behind.
    // `--no-auto-update` and ETTORE_AUTO_UPDATE=0 still turn it off, and a
    // flag outranks the environment so a scripted run can refuse what a shell
    // profile enabled.
    const autoUpdateOptIn = options.autoUpdate !== false
      && process.env.ETTORE_AUTO_UPDATE !== '0';
    const autoUpdateWanted = options.updateCheck !== false
      && autoUpdateOptIn
      && Boolean(process.stdout.isTTY)
      && !process.env.ETTORE_AUTO_UPDATE_DONE;

    // The sync check only ever reads a fresh cache, so a first run after an
    // install found nothing and did no work — the update landed on the
    // SECOND launch, which is not what "update when I run ettore" means.
    // When the cache has nothing usable, pay one short, bounded registry
    // call here. It costs at most COLD_CHECK_TIMEOUT_MS, once per cache
    // lifetime rather than per launch, and only when the answer could
    // actually be acted on — a checkout is asked first, so a dev copy never
    // pays for a call whose result it would refuse anyway.
    if (autoUpdateWanted && !updateStatus?.latest && describeInstall().updatable) {
      updateStatus = await checkForUpdate({ timeoutMs: COLD_CHECK_TIMEOUT_MS });
    }

    // Install a newer release BEFORE anything else loads, then hand over to
    // it by re-executing. npm replaces files under the running process and
    // this CLI imports modules lazily for the whole session (the TUI, tools,
    // providers), so swapping them mid-session would mix old and new code in
    // one process. Install-then-restart is the only safe shape, and it is
    // why the update cannot be applied to the session that discovers it.
    const autoPlan = planAutoUpdate({
      status: updateStatus,
      enabled: autoUpdateOptIn,
    });
    if (autoPlan.run) {
      process.stdout.write(`↻ ETTORE ${autoPlan.from} → ${autoPlan.to}: installing…\n`);
      try {
        const result = await runUpdate({ target: 'latest', stream: true });
        if (result.installed && result.installed !== autoPlan.from && result.isRunningCopy) {
          process.stdout.write(`${dim}✓ ${result.installed} installed — restarting${reset}\n`);
          const { spawnSync } = await import('node:child_process');
          const relaunch = spawnSync(process.execPath, process.argv.slice(1), {
            stdio: 'inherit',
            env: { ...process.env, ETTORE_AUTO_UPDATE_DONE: '1' },
          });
          process.exit(relaunch.status ?? 0);
        }
        // npm succeeded but the copy on PATH is not the one it wrote: this
        // machine has a second install, or a prefix whose bin/ is not on
        // PATH. Say so, with both paths, instead of claiming an update.
        process.stderr.write(
          `${dim}auto-update: npm installed ${result.installed || 'an unknown version'} in ${result.installedAt || 'the global prefix'}, `
          + `but you are running ${process.argv[1]} (${autoPlan.from}). Continuing on ${autoPlan.from}.${reset}\n`,
        );
      } catch (error) {
        // Never block the session on this: a failed install (no network, a
        // prefix that needs sudo) leaves the working build in place.
        process.stderr.write(`${dim}auto-update skipped: ${error.message}${reset}\n`);
      }
    } else if (updateStatus?.outdated || updateStatus?.deprecated) {
      // Not updating automatically — fall back to telling the user. A
      // deprecated release is worth saying out loud even when no newer
      // version is published, so it is not gated on `outdated` alone.
      const banner = formatBanner(updateStatus);
      if (banner && process.stdout.isTTY) {
        process.stdout.write(`${banner}\n`);
      }
      // Someone who asked for auto-update and did not get it is owed the
      // reason without having to rerun under --debug; for everyone else this
      // would just be noise about a feature they never turned on.
      if (autoPlan.reason && (autoUpdateOptIn || options.debug)) {
        process.stderr.write(`${dim}auto-update: ${autoPlan.reason}${reset}\n`);
      }
    }

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
    // Carry the version + sync update status into the TUI so the
    // sidebar header can show the running build and propose
    // `ettore update` when npm has a newer release.
    const tuiOptions = {
      ...cliOptions,
      version: packageJson.version,
      updateStatus,
      // --no-update-check has to reach the TUI too: it is the TUI that
      // runs the background refresh, so honouring the flag only here
      // would still hit the registry.
      updateCheck: options.updateCheck !== false,
    };
    await startApp(tuiOptions);
  }
  });

// `ettore version` — same as `--version` but prints extra info: the
// latest npm version, whether the install is up to date, and the
// cache path used by the periodic check.
program
  .command('version')
  .description('Print version information and check for updates')
  .option('--no-fetch', 'Use the cached value only, do not call npm view')
  .action(async (options) => {
    const { name, version: current } = readLocalPackage();
    const dim = process.stdout.isTTY ? '\x1b[2m' : '';
    const reset = process.stdout.isTTY ? '\x1b[0m' : '';
    const green = process.stdout.isTTY ? '\x1b[32m' : '';
    const yellow = process.stdout.isTTY ? '\x1b[33m' : '';
    process.stdout.write(`${name} ${current}\n`);
    if (options.fetch !== false) {
      const status = await checkForUpdate({ force: true });
      if (status.error || !status.latest) {
        process.stdout.write(`${dim}could not reach the npm registry (${status.error || 'unknown'})${reset}\n`);
      } else if (status.outdated) {
        process.stdout.write(`${yellow}↻ update available: ${status.latest} — run \`ettore update\`${reset}\n`);
      } else {
        process.stdout.write(`${green}✓ up to date${reset}\n`);
      }
    } else {
      const cached = checkForUpdateSync();
      if (cached.latest) {
        if (cached.outdated) {
          process.stdout.write(`${yellow}↻ update available: ${cached.latest} (cached) — run \`ettore update\`${reset}\n`);
        } else {
          process.stdout.write(`${green}✓ up to date (cached)${reset}\n`);
        }
      } else {
        process.stdout.write(`${dim}no cached version info — run without --no-fetch to check now${reset}\n`);
      }
    }
  });

// `ettore update` — install the latest version of ETTORE globally
// through npm and report the outcome. After a successful update the
// CLI prints a one-liner reminding the user to restart the process.
program
  .command('update')
  .description('Update ETTORE to the latest version from npm')
  .option('-t, --target <version>', 'Install a specific version instead of @latest')
  .option('-f, --force', 'Update even from a git checkout (replaces a linked install)')
  .action(async (options) => {
    const { version: current } = readLocalPackage();
    const dim = process.stdout.isTTY ? '\x1b[2m' : '';
    const reset = process.stdout.isTTY ? '\x1b[0m' : '';
    const install = describeInstall();
    if (!install.updatable && !options.force) {
      // Refuse rather than replace a development checkout with a registry
      // copy — the command would "succeed" and disconnect the CLI from the
      // repo it is linked to.
      process.stderr.write(`${install.reason}\n`);
      process.stderr.write(`${dim}Pass --force if you really want to install the published build over it.${reset}\n`);
      process.exit(1);
    }
    process.stdout.write(`Updating ${current} → ${options.target || 'latest'}…\n`);
    try {
      const result = await runUpdate({
        target: options.target || 'latest',
        stream: true,
        force: Boolean(options.force),
      });
      const green = process.stdout.isTTY ? '\x1b[32m' : '';
      const yellow = process.stdout.isTTY ? '\x1b[33m' : '';
      // Report what npm left on disk, not what this process booted with:
      // the running package.json is not the file npm just replaced.
      const installed = result.installed;
      if (!installed) {
        process.stdout.write(`\n${yellow}npm reported success, but no installed version could be read from ${result.installedAt || 'the global prefix'}.${reset}\n`);
      } else if (!result.isRunningCopy) {
        process.stdout.write(`\n${yellow}↻ ${installed} installed in ${result.installedAt}.${reset}\n`);
        process.stdout.write(
          `${yellow}But the command you run is ${process.argv[1]}, which npm did not touch — `
          + `that prefix's bin/ is probably not on your PATH, so you would keep launching ${current}.${reset}\n`,
        );
      } else if (installed === current) {
        process.stdout.write(`\n${green}✓ ${installed} is already the published build — nothing changed.${reset}\n`);
      } else {
        process.stdout.write(`\n${green}✓ ETTORE updated ${current} → ${installed}.${reset}\n`);
      }
      process.stdout.write(`${dim}Restart the CLI to pick up the new build.${reset}\n`);
    } catch (error) {
      const red = process.stdout.isTTY ? '\x1b[31m' : '';
      process.stderr.write(`\n${red}✗ update failed: ${error.message}${reset}\n`);
      const { name } = readLocalPackage();
      process.stderr.write(`Tip: try \`npm install -g ${name}@latest\` directly.\n`);
      process.exit(1);
    }
  });

// `ettore preview <app-id>` — watch what the agent is doing on the
// desktop from a SECOND terminal. It polls the frame the agent writes
// after every action; it deliberately does not talk to the agent
// process, which is what makes it usable from anywhere.
program
  .command('preview [appId]')
  .description('Live ASCII preview of a desktop app the agent is driving (Windows)')
  .option('-i, --interval <ms>', 'Redraw interval in milliseconds', '400')
  .option('-w, --width <cols>', 'Preview width in characters', '80')
  // No short flag: -h stays commander's help alias.
  .option('--height <rows>', 'Preview height in characters', '24')
  .option('--invert', 'Invert the luminance ramp (for light-on-dark apps)')
  .option('--once', 'Render a single frame and exit')
  .action(async (appId, options) => {
    const { livePreview, renderFrame } = await import('../src/cli/preview.js');
    const id = appId || 'default';
    const width = Math.max(20, Math.min(Number(options.width) || 80, 240));
    const height = Math.max(6, Math.min(Number(options.height) || 24, 80));
    const invert = Boolean(options.invert);

    if (options.once) {
      const frame = await renderFrame(id, { width, height, invert });
      if (!frame.ok) {
        process.stderr.write(`${frame.reason}\n`);
        process.exit(1);
      }
      process.stdout.write(`${frame.ascii}\n`);
      return;
    }

    const controller = new AbortController();
    const stop = () => {
      controller.abort();
      process.stdout.write('\x1b[2J\x1b[H');
    };
    process.on('SIGINT', () => { stop(); process.exit(0); });
    await livePreview(id, {
      intervalMs: Number(options.interval) || 400,
      width,
      height,
      invert,
      signal: controller.signal,
    });
  });

program.parse();
