// Install all bundled plugins from examples/plugins/ into
// ~/.config/ettore/plugins/ and mark each one with an .enabled file.
//
// Usage:
//   node scripts/install-bundled-plugins.js                  # install all
//   node scripts/install-bundled-plugins.js bash-monitor     # one specific
//   node scripts/install-bundled-plugins.js --force          # overwrite copies
//
// What it does for each plugin name in examples/plugins/<name>:
//   1. mkdir -p ~/.config/ettore/plugins/<name>
//   2. Copy every file from examples/plugins/<name> to that dir
//      (refuses to overwrite unless --force)
//   3. Touch .enabled so the runtime loads it on the next boot
//   4. Print a summary table: name, files copied, .enabled written
//
// What it does NOT do:
//   - Install npm dependencies. Run `npm install` separately if the
//     plugin declares optionalDependencies in ETTORE's package.json.
//   - Reload ETTORE. Restart the CLI after this script for the
//     changes to take effect.

import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, statSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const BUNDLED_DIR = join(REPO_ROOT, 'examples', 'plugins');
const PLUGINS_DIR = process.env.ETTORE_PLUGINS_DIR
  || join(homedir(), '.config', 'ettore', 'plugins');

function parseArgs(argv) {
  const out = { names: [], force: false, help: false, dryRun: false, disableInstead: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--disable') out.disableInstead = true;
    else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    } else out.names.push(a);
  }
  return out;
}

function listBundled() {
  if (!existsSync(BUNDLED_DIR)) return [];
  return readdirSync(BUNDLED_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function copyDir(src, dst, { force }) {
  let copied = 0;
  let skipped = 0;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) {
      const sub = copyDir(s, d, { force });
      copied += sub.copied;
      skipped += sub.skipped;
    } else {
      if (existsSync(d) && !force) { skipped++; continue; }
      copyFileSync(s, d);
      copied++;
    }
  }
  return { copied, skipped };
}

function installOne(name, { force, dryRun, disableInstead }) {
  const src = join(BUNDLED_DIR, name);
  if (!existsSync(src)) {
    return { name, status: 'not_found', detail: `${src} does not exist` };
  }
  const manifestPath = join(src, 'plugin.json');
  if (!existsSync(manifestPath)) {
    return { name, status: 'invalid', detail: 'no plugin.json in source' };
  }
  // Quick manifest sanity check (without the full validateManifest from
  // the runtime, but enough to catch the obvious errors).
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); }
  catch (e) { return { name, status: 'invalid', detail: `manifest is not valid JSON: ${e.message}` }; }
  if (manifest.name !== name) {
    return { name, status: 'invalid', detail: `manifest.name (${manifest.name}) does not match directory name (${name})` };
  }
  if (!/^\d+\.\d+\.\d+/.test(String(manifest.version || ''))) {
    return { name, status: 'invalid', detail: `manifest.version (${manifest.version}) is not semver` };
  }
  if (manifest.apiVersion !== '1') {
    return { name, status: 'invalid', detail: `manifest.apiVersion (${manifest.apiVersion}) is not "1"` };
  }

  const dst = join(PLUGINS_DIR, name);
  if (disableInstead) {
    if (dryRun) return { name, status: 'would_disable' };
    const enabledMarker = join(dst, '.enabled');
    if (existsSync(enabledMarker)) rmSync(enabledMarker);
    return { name, status: 'disabled', detail: dst };
  }

  // Copy
  let copyResult;
  if (dryRun) {
    copyResult = { copied: 0, skipped: 0 };
  } else {
    copyResult = copyDir(src, dst, { force });
  }

  // Touch .enabled
  const enabledMarker = join(dst, '.enabled');
  if (dryRun) {
    return {
      name, status: 'would_install',
      detail: { copied: copyResult.copied, skipped: copyResult.skipped, dst },
    };
  }
  writeFileSync(enabledMarker, '');

  return {
    name, status: 'installed',
    detail: { copied: copyResult.copied, skipped: copyResult.skipped, dst, enabled: enabledMarker },
  };
}

function disableAll() {
  if (!existsSync(PLUGINS_DIR)) return [];
  const out = [];
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const marker = join(PLUGINS_DIR, entry.name, '.enabled');
    if (existsSync(marker)) {
      rmSync(marker);
      out.push({ name: entry.name, status: 'disabled' });
    }
  }
  return out;
}

function printResults(results) {
  if (!results.length) {
    console.log('(nothing to do)');
    return;
  }
  const nameW = Math.max(4, ...results.map((r) => (r.name || '').length));
  const statusW = Math.max(6, ...results.map((r) => (r.status || '').length));
  for (const r of results) {
    const name = String(r.name || '').padEnd(nameW);
    const status = String(r.status || '').padEnd(statusW);
    let detail = '';
    if (r.detail) {
      detail = typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail);
    }
    console.log(`  ${name}  ${status}  ${detail}`);
  }
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`Usage:
  node scripts/install-bundled-plugins.js                  install all bundled plugins
  node scripts/install-bundled-plugins.js <name> [<name>…] install specific plugins
  node scripts/install-bundled-plugins.js --disable        remove .enabled from installed plugins
  node scripts/install-bundled-plugins.js --force          overwrite existing copies
  node scripts/install-bundled-plugins.js --dry-run        show what would happen

Plugins live in: ${PLUGINS_DIR}
Bundled source:  ${BUNDLED_DIR}`);
    process.exit(0);
  }

  if (args.disableInstead && args.names.length === 0) {
    const results = disableAll();
    console.log(`Disabled ${results.length} plugin(s) in ${PLUGINS_DIR}:`);
    printResults(results);
    return;
  }

  const names = args.names.length ? args.names : listBundled();
  if (!names.length) {
    console.log(`No bundled plugins found in ${BUNDLED_DIR}`);
    process.exit(1);
  }

  console.log(`${args.dryRun ? '[dry-run] ' : ''}Installing ${names.length} plugin(s) to ${PLUGINS_DIR}:`);
  const results = names.map((n) => installOne(n, args));
  printResults(results);

  const failed = results.filter((r) => r.status === 'not_found' || r.status === 'invalid');
  if (failed.length) {
    console.log(`\n${failed.length} plugin(s) failed validation. Fix the issue and re-run, or open an issue.`);
    process.exit(1);
  }
  if (!args.dryRun) {
    console.log(`\nNext steps:`);
    console.log(`  1. Run \`npm install\` if any plugin declares optionalDependencies.`);
    console.log(`  2. Restart ETTORE. New tools / commands / hooks are picked up at boot.`);
    console.log(`  3. In TUI: /plugins list   (or /plugins info <name> for details).`);
  }
}

main();
