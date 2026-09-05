// Tests for the pgadmin plugin.
//
// The plugin uses node-postgres (optional dep). When the dep is
// missing the manifest / hook check tests still pass, but every
// handler test self-skips with a clear message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
// `require.resolve` does not exist in an ES module: the guards below used
// it bare, so they always reported the dependency as missing and every
// test that needed it skipped — even once it was installed.
const requirePeer = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

function hasPg() { try { requirePeer.resolve('pg'); return true; } catch { return false; } }
async function loadPlugin() {
  const entry = join(REPO_ROOT, 'examples', 'plugins', 'pgadmin', 'index.js');
  const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}`);
  return (mod.default && typeof mod.default === 'object') ? mod.default : mod;
}

test('pgadmin: manifest is well-formed', () => {
  const p = join(REPO_ROOT, 'examples', 'plugins', 'pgadmin', 'plugin.json');
  const json = JSON.parse(readFileSync(p, 'utf-8'));
  assert.equal(json.name, 'pgadmin');
  assert.match(json.version, /^\d+\.\d+\.\d+/);
  assert.equal(json.apiVersion, '1');
  assert.ok(json.permissions.includes('fs:read'));
  assert.ok(json.permissions.includes('fs:write'));
  assert.ok(json.permissions.includes('shell:exec'));
});

test('pgadmin: entry point imports and declares the 15 tools', async () => {
  const bag = await loadPlugin();
  for (const name of [
    'pg_list_databases', 'pg_list_schemas', 'pg_list_tables',
    'pg_describe_table', 'pg_list_indexes', 'pg_list_constraints',
    'pg_list_views', 'pg_list_functions', 'pg_list_users',
    'pg_query', 'pg_explain', 'pg_database_size', 'pg_table_stats',
    'pg_dump', 'pg_restore', 'pg_close_pool',
  ]) {
    assert.ok(bag.tools[name], `missing tool: ${name}`);
  }
  assert.equal(typeof bag.hooks.onLoad, 'function');
  assert.equal(typeof bag.hooks.onUnload, 'function');
});

test('pgadmin: pg_query returns a clear error when the connection string is invalid', async () => {
  const bag = await loadPlugin();
  const out = await bag.tools.pg_query.handler({ connection: 'not-a-url', sql: 'SELECT 1' });
  assert.match(String(out), /Error|postgres:\/\//i);
});

test('pgadmin: pg_query rejects connection strings that are not postgres', async () => {
  const bag = await loadPlugin();
  // Skip when pg is not present — the validation path lives before the
  // pg.Client is constructed, so it can be exercised either way.
  const out = await bag.tools.pg_query.handler({ connection: 'mysql://localhost/x', sql: 'SELECT 1' });
  assert.match(String(out), /Error|postgres:\/\//i);
});

test('pgadmin: pg_dump returns a friendly error when pg_dump binary is missing', async () => {
  const bag = await loadPlugin();
  // We point the plugin at a tmp file so the "output_path" check passes
  // and the plugin proceeds to findTool('pg_dump'). The plugin's
  // findTool scans a few well-known paths; we cannot control PATH
  // portably, so we just assert that the result string contains the
  // expected install hint OR a successful invocation message.
  const tmp = mkdtempSync(join(tmpdir(), 'pgadmin-dump-'));
  try {
    const out = await bag.tools.pg_dump.handler({
      connection: 'postgres://u:p@localhost:5432/x',
      output_path: join(tmp, 'dump.sql'),
    });
    assert.ok(/pg_dump/.test(String(out)), 'output should reference pg_dump');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('pgadmin: pg_restore returns a clear error when the dump file is missing', async () => {
  const bag = await loadPlugin();
  const out = await bag.tools.pg_restore.handler({
    connection: 'postgres://u:p@localhost:5432/x',
    dump_path: '/no/such/dump.sql',
  });
  assert.match(String(out), /Error|dump file not found|pg_restore/);
});

// Integration tests below require a running PostgreSQL. We attempt to
// spin up an ephemeral server using the @databases/pg-test package
// when available; otherwise the test self-skips. The setup is
// deliberately conservative — we only run the connection / read paths.
test('pgadmin: live integration — list_schemas on a real PostgreSQL', { skip: !hasPg() }, async () => {
  // Try the well-known "test only" library. If it is not installed
  // we skip — the user can run these locally with `docker run
  // postgres` or by setting PGTEST_URL.
  const connStr = process.env.PGADMIN_TEST_URL;
  if (!connStr) {
    try { requirePeer.resolve('@databases/pg-test'); }
    catch { return; } // self-skip
  }
  const url = connStr || 'postgres://postgres:postgres@localhost:5432/postgres';
  const bag = await loadPlugin();
  const out = await bag.tools.pg_list_schemas.handler({ connection: url });
  assert.match(String(out), /schema/);
  // pg_database_size is read-only and works on any DB
  const size = await bag.tools.pg_database_size.handler({ connection: url });
  assert.match(String(size), /Database/);
  // pg_query SELECT 1
  const q = await bag.tools.pg_query.handler({ connection: url, sql: 'SELECT 1 AS one' });
  assert.match(String(q), /one/);
  // Close the pool so the test exits cleanly
  await bag.tools.pg_close_pool.handler({ connection: url });
});

test('pgadmin: live integration — query with params, EXPLAIN, and connection reuse', { skip: !hasPg() }, async () => {
  const connStr = process.env.PGADMIN_TEST_URL;
  if (!connStr) {
    try { requirePeer.resolve('@databases/pg-test'); } catch { return; }
  }
  const url = connStr || 'postgres://postgres:postgres@localhost:5432/postgres';
  const bag = await loadPlugin();
  // Parameterised query
  const r1 = await bag.tools.pg_query.handler({ connection: url, sql: 'SELECT $1::int AS n, $2::text AS s', params: [42, 'hello'] });
  assert.match(String(r1), /42/);
  assert.match(String(r1), /hello/);
  // EXPLAIN (no ANALYZE)
  const r2 = await bag.tools.pg_explain.handler({ connection: url, sql: 'SELECT 1', analyze: false, format: 'TEXT' });
  assert.match(String(r2), /Result/);
  // Same connection, second call: the LRU pool should hit, not error
  const r3 = await bag.tools.pg_query.handler({ connection: url, sql: 'SELECT 2' });
  assert.match(String(r3), /2/);
  await bag.tools.pg_close_pool.handler({ connection: url });
});

test('pgadmin: the restore wizard opens with no arguments at all', async () => {
  // Both `connection` and `sql_file` used to be required, which forced the
  // model to obtain a dump path it had no way of knowing — so it asked in the
  // terminal, when choosing the file is the wizard's own first screen.
  const bag = await loadPlugin();
  const schema = bag.tools.pg_restore_wizard.parameters;
  assert.deepEqual(schema.required, [], 'the wizard must be callable with nothing');
  for (const key of ['connection', 'sql_file']) {
    assert.ok(schema.properties[key], `${key} should remain available as a pre-fill`);
  }
  // The description has to tell the model not to go asking.
  assert.match(bag.tools.pg_restore_wizard.description, /no arguments|never ask/i);
});

test('pgadmin: the wizard serves a page that can collect both itself', async () => {
  const bag = await loadPlugin();
  try {
    // Port 0: the OS picks a free one and the URL reports it, so the test
    // cannot collide with whatever else is listening on this machine.
    const out = await bag.tools.pg_restore_wizard.handler({ open_browser: false });
    assert.equal(out.status, 'awaiting_browser');
    // The URL carries the access token and used to be reported only once the
    // wizard finished — a headless session was told to open it and never told
    // where, then blocked for ten minutes.
    assert.match(out.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+$/);
    assert.match(out.message, /Open this URL/);

    const html = await fetch(out.url).then(r => r.text());
    for (const field of ['conn-url', 'file-path', 'file-upload']) {
      assert.match(html, new RegExp(`id="${field}"`), `the page cannot collect ${field}`);
    }
  } finally {
    // The wizard leaves its server listening on purpose — that is the page the
    // user still has to open — so the test has to take it down or the runner
    // never exits.
    await bag.hooks.onUnload();
  }
});

test('pgadmin: the documented port option is honoured', async () => {
  // It was documented and ignored — the listen call was hard-coded to 0, so a
  // fixed port could not be used behind an SSH tunnel.
  const bag = await loadPlugin();
  try {
    // Take a free port from the OS, release it, then ask the wizard for it.
    const { createServer } = await import('node:net');
    const probe = createServer();
    const port = await new Promise((res) => {
      probe.listen(0, '127.0.0.1', () => {
        const p = probe.address().port;
        probe.close(() => res(p));
      });
    });
    const out = await bag.tools.pg_restore_wizard.handler({ open_browser: false, port });
    assert.match(out.url, new RegExp(`:${port}/`));
  } finally {
    await bag.hooks.onUnload();
  }
});

test('pgadmin: a busy port is reported, not thrown at the process', async () => {
  // An http.Server with no `error` listener turns a bind failure into an
  // unhandled 'error' event, which takes the whole CLI down. A port already in
  // use killed the session instead of producing a message.
  const { createServer } = await import('node:net');
  const blocker = createServer();
  const port = await new Promise((res) => {
    blocker.listen(0, '127.0.0.1', () => res(blocker.address().port));
  });
  const bag = await loadPlugin();
  try {
    const out = await bag.tools.pg_restore_wizard.handler({ open_browser: false, port });
    assert.equal(typeof out, 'string', 'a bind failure must come back as a message');
    assert.match(out, /already in use/);
    // And it says what to do instead of only what went wrong.
    assert.match(out, /Omit `port`/);
  } finally {
    await new Promise((r) => { blocker.close(() => r()); });
    await bag.hooks.onUnload();
  }
});
