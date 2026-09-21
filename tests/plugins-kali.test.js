// The kali plugin: installed security tools, gated behind an authorisation
// scope. These tests never run a real scanner — they exercise the gate, the
// target parsing and the loader, which is where the safety lives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'plugins', 'kali');

// A fresh module each time so the process-local scope does not bleed between
// tests.
async function freshPlugin() {
  const entry = join(PLUGIN_DIR, 'index.js');
  return import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}`);
}

test('kali: the core loader accepts the manifest and the module', async () => {
  const { validateManifest, validatePluginModule } = await import('../src/plugins/manifest.js');
  const manifest = validateManifest(JSON.parse(readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf-8')), PLUGIN_DIR);
  assert.equal(manifest.name, 'kali');
  const validated = validatePluginModule(await freshPlugin());
  assert.ok(validated.tools.kali_scope, 'exposes the scope tool');
  assert.ok(validated.tools.kali_portscan, 'exposes a scanning tool');
  assert.ok(validated.commands.kali);
  assert.equal(typeof validated.hooks.onLoad, 'function');
});

test('kali: no scanning tool will run before an authorisation scope is set', async () => {
  const mod = await freshPlugin();
  const targetTools = ['kali_portscan', 'kali_web_fingerprint', 'kali_web_scan', 'kali_dns_enum', 'kali_tls_scan'];
  for (const name of targetTools) {
    await assert.rejects(
      () => mod.tools[name].handler({ target: '10.0.0.5', url: 'http://10.0.0.5', domain: 'x.test' }),
      /authorisation scope/i,
      `${name} must refuse before a scope is set`,
    );
  }
});

test('kali: a target outside the scope is refused, one inside is admitted', async () => {
  const { _internal } = await freshPlugin();
  const { addToScope, requireInScope, parseTarget } = _internal;
  addToScope(['192.168.56.0/24', 'scanme.nmap.org']);

  // In scope: no throw.
  requireInScope(parseTarget('192.168.56.101'));
  requireInScope(parseTarget('scanme.nmap.org:443'));

  // Out of scope: refused, and the message names the host.
  assert.throws(() => requireInScope(parseTarget('8.8.8.8')), /"8\.8\.8\.8" is not in the authorisation scope/);
  assert.throws(() => requireInScope(parseTarget('192.168.57.1')), /not in the authorisation scope/);
});

test('kali: a target that carries shell metacharacters is rejected as a target', async () => {
  const { _internal } = await freshPlugin();
  for (const bad of ['10.0.0.5; rm -rf /', '$(whoami)', 'host && curl evil', 'a`id`b', 'x|y']) {
    assert.throws(() => _internal.parseTarget(bad), /invalid target/, `"${bad}" must not parse as a target`);
  }
});

test('kali: a URL target maps to its host for the scope check but keeps the raw form', async () => {
  const { _internal } = await freshPlugin();
  const t = _internal.parseTarget('https://example.com:8443/admin/login');
  assert.equal(t.host, 'example.com', 'the host is what the scope checks');
  assert.equal(t.raw, 'https://example.com:8443/admin/login', 'the tool keeps the full URL');
});

test('kali: set replaces the scope, add extends it, clear empties it', async () => {
  const mod = await freshPlugin();
  await mod.tools.kali_scope.handler({ action: 'set', targets: ['10.0.0.1'], note: 'lab' });
  let shown = await mod.tools.kali_scope.handler({ action: 'show' });
  assert.match(shown.scope, /10\.0\.0\.1/);
  assert.equal(shown.note, 'lab');

  await mod.tools.kali_scope.handler({ action: 'add', targets: ['10.0.0.2'] });
  shown = await mod.tools.kali_scope.handler({ action: 'show' });
  assert.match(shown.scope, /10\.0\.0\.1/);
  assert.match(shown.scope, /10\.0\.0\.2/);

  await mod.tools.kali_scope.handler({ action: 'set', targets: ['10.9.9.9'] });
  shown = await mod.tools.kali_scope.handler({ action: 'show' });
  assert.doesNotMatch(shown.scope, /10\.0\.0/, 'set replaces, it does not extend');

  await mod.tools.kali_scope.handler({ action: 'clear' });
  shown = await mod.tools.kali_scope.handler({ action: 'show' });
  assert.equal(shown.empty, true);
});

test('kali: an off-by-one CIDR boundary is respected', async () => {
  const { _internal } = await freshPlugin();
  const { addToScope, requireInScope, parseTarget } = _internal;
  addToScope(['10.10.10.0/30']); // .0 .1 .2 .3 only
  requireInScope(parseTarget('10.10.10.1'));
  requireInScope(parseTarget('10.10.10.3'));
  assert.throws(() => requireInScope(parseTarget('10.10.10.4')), /not in the authorisation scope/);
});
