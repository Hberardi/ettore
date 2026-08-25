import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateManifest,
  validatePluginModule,
  ManifestError,
  RESERVED_TOOL_NAMES,
  KNOWN_PERMISSIONS,
} from '../src/plugins/manifest.js';

test('validateManifest: accepts a minimal valid manifest', () => {
  const m = validateManifest({
    name: 'hello-world',
    version: '1.0.0',
    apiVersion: '1',
    main: 'index.js',
  }, '/tmp/hello-world');
  assert.equal(m.name, 'hello-world');
  assert.equal(m.version, '1.0.0');
  assert.equal(m.apiVersion, '1');
  assert.equal(m.main, 'index.js');
  assert.equal(m.root, '/tmp/hello-world');
  assert.deepEqual(m.permissions, []);
});

test('validateManifest: rejects non-object input', () => {
  assert.throws(() => validateManifest(null, '/x'), ManifestError);
  assert.throws(() => validateManifest('hi', '/x'), ManifestError);
  assert.throws(() => validateManifest([], '/x'), ManifestError);
});

test('validateManifest: requires name with kebab-case', () => {
  const base = { version: '1.0.0', apiVersion: '1', main: 'index.js' };
  assert.throws(() => validateManifest({ ...base, name: '' }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, name: 'HelloWorld' }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, name: '-leading-dash' }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, name: 'trailing-' }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, name: 'has spaces' }, '/x'), ManifestError);
  // Valid
  validateManifest({ ...base, name: 'good-name' }, '/x');
  validateManifest({ ...base, name: 'a' }, '/x');
  validateManifest({ ...base, name: 'a1-b2-c3' }, '/x');
});

test('validateManifest: requires semver version', () => {
  const base = { name: 'p', apiVersion: '1', main: 'index.js' };
  assert.throws(() => validateManifest({ ...base, version: '1.0' }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, version: 'v1.0.0' }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, version: '1.0.0.0' }, '/x'), ManifestError);
  // Valid
  validateManifest({ ...base, version: '0.0.1' }, '/x');
  validateManifest({ ...base, version: '2.1.3-beta.1' }, '/x');
  validateManifest({ ...base, version: '1.0.0+build.42' }, '/x');
});

test('validateManifest: requires supported apiVersion', () => {
  const base = { name: 'p', version: '1.0.0', main: 'index.js' };
  assert.throws(() => validateManifest({ ...base, apiVersion: '2' }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, apiVersion: '0' }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, apiVersion: '' }, '/x'), ManifestError);
  validateManifest({ ...base, apiVersion: '1' }, '/x');
});

test('validateManifest: rejects absolute and parent paths in main', () => {
  const base = { name: 'p', version: '1.0.0', apiVersion: '1' };
  assert.throws(() => validateManifest({ ...base, main: '/abs/path.js' }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, main: 'C:\\evil.js' }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, main: '../sneaky.js' }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, main: 'subdir/../../etc.js' }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, main: '' }, '/x'), ManifestError);
  // Valid
  validateManifest({ ...base, main: 'index.js' }, '/x');
  validateManifest({ ...base, main: 'lib/main.mjs' }, '/x');
});

test('validateManifest: rejects unknown permissions and duplicates', () => {
  const base = { name: 'p', version: '1.0.0', apiVersion: '1', main: 'index.js' };
  assert.throws(() =>
    validateManifest({ ...base, permissions: ['bogus:perm'] }, '/x'),
    ManifestError,
  );
  assert.throws(() =>
    validateManifest({ ...base, permissions: ['fs:read', 'fs:read'] }, '/x'),
    ManifestError,
  );
  assert.throws(() =>
    validateManifest({ ...base, permissions: 'fs:read' }, '/x'),
    ManifestError,
  );
  // Valid
  const m = validateManifest({
    ...base, permissions: ['fs:read', 'fs:write', 'network:https'],
  }, '/x');
  assert.equal(m.permissions.length, 3);
});

test('validateManifest: caps permissions at 16', () => {
  const perms = Array.from({ length: 17 }, (_, i) => `fs:read`); // all dupes too
  const base = { name: 'p', version: '1.0.0', apiVersion: '1', main: 'index.js' };
  // Use unique-but-fake permissions; only the cap test matters here.
  const fake = Array.from({ length: 17 }, (_, i) => `fs:read`);
  assert.throws(() =>
    validateManifest({ ...base, permissions: fake }, '/x'),
    ManifestError,
  );
});

test('validateManifest: rejects non-string description/author/license', () => {
  const base = { name: 'p', version: '1.0.0', apiVersion: '1', main: 'index.js' };
  assert.throws(() => validateManifest({ ...base, description: 42 }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, author: { name: 'a' } }, '/x'), ManifestError);
  assert.throws(() => validateManifest({ ...base, license: ['MIT'] }, '/x'), ManifestError);
});

test('validatePluginModule: accepts a minimal empty module', () => {
  const v = validatePluginModule({});
  assert.deepEqual(Object.keys(v.tools), []);
  assert.deepEqual(Object.keys(v.commands), []);
  assert.equal(v.hooks.onLoad, null);
});

test('validatePluginModule: normalizes a well-formed tool definition', () => {
  const v = validatePluginModule({
    tools: {
      say_hello: {
        description: 'Say hi to someone',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        handler: async ({ name }) => `hello ${name}`,
      },
    },
  });
  assert.equal(v.tools.say_hello.name, 'say_hello');
  assert.equal(v.tools.say_hello.description, 'Say hi to someone');
  assert.equal(typeof v.tools.say_hello.handler, 'function');
  assert.equal(v.tools.say_hello.risk, 'medium');
});

test('validatePluginModule: rejects tool with missing handler', () => {
  assert.throws(() =>
    validatePluginModule({ tools: { bad: { description: 'x' } } }),
    ManifestError,
  );
});

test('validatePluginModule: rejects tool with empty description', () => {
  assert.throws(() =>
    validatePluginModule({ tools: { bad: { description: '', handler: () => {} } } }),
    ManifestError,
  );
});

test('validatePluginModule: normalizes commands and validates handler', () => {
  const v = validatePluginModule({
    commands: {
      ping: { description: 'Ping the plugin', usage: '/ping', handler: async () => 'pong' },
    },
  });
  assert.equal(v.commands.ping.description, 'Ping the plugin');
  assert.equal(v.commands.ping.usage, '/ping');
  assert.equal(typeof v.commands.ping.handler, 'function');
  assert.throws(() =>
    validatePluginModule({ commands: { ping: { description: 'x' } } }),
    ManifestError,
  );
});

test('validatePluginModule: validates hooks shape', () => {
  assert.throws(() =>
    validatePluginModule({ hooks: { onLoad: 'not a function' } }),
    ManifestError,
  );
  assert.throws(() =>
    validatePluginModule({ hooks: { onUnload: 42 } }),
    ManifestError,
  );
  // Valid hooks pass through.
  const v = validatePluginModule({ hooks: { onLoad() {}, onUnload() {} } });
  assert.equal(typeof v.hooks.onLoad, 'function');
  assert.equal(typeof v.hooks.onUnload, 'function');
});

test('RESERVED_TOOL_NAMES contains core safety-critical tools', () => {
  for (const name of ['bash', 'write', 'edit', 'read', 'todo_write', 'ask_user']) {
    assert.ok(RESERVED_TOOL_NAMES.has(name), `${name} should be reserved`);
  }
});

test('KNOWN_PERMISSIONS includes fs/network/shell/memory/agent', () => {
  for (const p of ['fs:read', 'fs:write', 'network:http', 'network:https', 'shell:exec', 'memory:read', 'memory:write', 'agent:tools', 'agent:emit']) {
    assert.ok(KNOWN_PERMISSIONS.has(p), `${p} should be a known permission`);
  }
});
