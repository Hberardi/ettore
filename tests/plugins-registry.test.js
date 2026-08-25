import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry, PluginConflictError } from '../src/plugins/registry.js';

function fakePlugin(name, tools = {}, commands = {}, hooks = {}) {
  return {
    manifest: {
      name,
      version: '1.0.0',
      apiVersion: '1',
      main: 'index.js',
      description: '',
      author: '',
      license: '',
      permissions: [],
      root: `/tmp/${name}`,
    },
    tools,
    commands,
    hooks,
    loadedAt: new Date().toISOString(),
  };
}

test('PluginRegistry: seeds reserved names from built-in handlers', () => {
  const reg = new PluginRegistry({
    builtInHandlers: { bash: () => {}, write: () => {} },
  });
  const plugin = fakePlugin('p', {
    bash: { description: 'tries to override', handler: () => 'no' },
  });
  const conflicts = reg.validate(plugin);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].name, 'bash');
  assert.match(conflicts[0].reason, /reserved/);
});

test('PluginRegistry: detects collision with another enabled plugin', () => {
  const reg = new PluginRegistry();
  reg.register(fakePlugin('a', { greet: { description: 'x', handler: () => '' } }));
  const conflicts = reg.validate(fakePlugin('b', {
    greet: { description: 'x', handler: () => '' },
  }));
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].reason, /already registered by plugin "a"/);
});

test('PluginRegistry: rejects register() when conflicts exist', () => {
  const reg = new PluginRegistry();
  reg.register(fakePlugin('a', { greet: { description: 'x', handler: () => '' } }));
  assert.throws(() =>
    reg.register(fakePlugin('b', { greet: { description: 'x', handler: () => '' } })),
    PluginConflictError,
  );
});

test('PluginRegistry: unregister() releases reserved names', () => {
  const reg = new PluginRegistry();
  reg.register(fakePlugin('a', { greet: { description: 'x', handler: () => '' } }));
  reg.unregister('a');
  // Now another plugin can take the name.
  const conflicts = reg.validate(fakePlugin('b', {
    greet: { description: 'x', handler: () => '' },
  }));
  assert.equal(conflicts.length, 0);
  reg.register(fakePlugin('b', { greet: { description: 'x', handler: () => '' } }));
});

test('PluginRegistry: refuses double register of same plugin', () => {
  const reg = new PluginRegistry();
  const p = fakePlugin('a', { greet: { description: 'x', handler: () => '' } });
  reg.register(p);
  assert.throws(() => reg.register(p), PluginConflictError);
});

test('PluginRegistry: getAllToolDefinitions merges built-ins and plugins', () => {
  const reg = new PluginRegistry({
    builtInTools: [
      { type: 'function', function: { name: 'bash', description: 'shell' } },
    ],
  });
  reg.register(fakePlugin('p', {
    say_hello: { description: 'hi', handler: () => 'hi' },
  }));
  const defs = reg.getAllToolDefinitions();
  const names = defs.map((d) => d.function.name);
  assert.ok(names.includes('bash'));
  assert.ok(names.includes('say_hello'));
});

test('PluginRegistry: plugin tool handlers are wrapped in safe context', async () => {
  const reg = new PluginRegistry();
  let captured = null;
  reg.register(fakePlugin('p', {
    echo: {
      description: 'echo',
      handler: async (args, ctx) => {
        captured = ctx;
        return `echo:${args.value}`;
      },
    },
  }));
  const handlers = reg.getAllToolHandlers();
  const out = await handlers.echo({ value: 'x' }, { signal: 'SIG' });
  assert.equal(out, 'echo:x');
  assert.equal(captured.plugin, 'p');
  assert.equal(captured.tool, 'echo');
  assert.equal(captured.signal, 'SIG');
});

test('PluginRegistry: plugin handler errors are converted to Error: strings', async () => {
  const reg = new PluginRegistry();
  reg.register(fakePlugin('p', {
    boom: {
      description: 'boom',
      handler: async () => { throw new Error('nope'); },
    },
  }));
  const handlers = reg.getAllToolHandlers();
  const out = await handlers.boom({}, {});
  assert.match(out, /^Error: plugin "p" tool "boom" failed: nope$/);
});

test('PluginRegistry: plugin tool returning an object is JSON-serialized', async () => {
  const reg = new PluginRegistry();
  reg.register(fakePlugin('p', {
    obj: {
      description: 'returns object',
      handler: async () => ({ ok: true, value: 42 }),
    },
  }));
  const handlers = reg.getAllToolHandlers();
  const out = await handlers.obj({}, {});
  assert.deepEqual(JSON.parse(out), { ok: true, value: 42 });
});

test('PluginRegistry: runHook invokes onLoad across all plugins, isolates errors', async () => {
  const reg = new PluginRegistry();
  reg.register(fakePlugin('a', {}, {}, { onLoad: async () => { throw new Error('a-broken'); } }));
  reg.register(fakePlugin('b', {}, {}, { onLoad: async () => 'b-ok' }));
  reg.register(fakePlugin('c', {}, {}, { /* no onLoad */ }));
  const results = await reg.runHook('onLoad');
  assert.equal(results.length, 2); // a + b; c has no onLoad
  const a = results.find((r) => r.plugin === 'a');
  const b = results.find((r) => r.plugin === 'b');
  assert.match(a.error, /a-broken/);
  assert.equal(b.error, null);
});

test('PluginRegistry: getAllCommands merges built-ins and plugins with origin tag', () => {
  const reg = new PluginRegistry({
    builtInCommands: { help: { description: 'show help', handler: async () => '' } },
  });
  reg.register(fakePlugin('p', {}, {
    greet: { description: 'say hi', handler: async () => '' },
  }));
  const cmds = reg.getAllCommands();
  assert.equal(cmds.help.plugin, null);
  assert.equal(cmds.greet.plugin, 'p');
  assert.equal(cmds.greet.description, 'say hi');
});
