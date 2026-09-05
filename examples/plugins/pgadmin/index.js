// pgadmin plugin
//
// A "pgadmin-lite" inside ETTORE. Tools cover the common DBA workflow:
//
//   discovery        pg_list_databases, pg_list_schemas, pg_list_tables,
//                    pg_describe_table, pg_list_indexes, pg_list_constraints,
//                    pg_list_views, pg_list_functions, pg_list_users
//   introspection    pg_database_size, pg_table_stats, pg_explain
//   arbitrary SQL    pg_query (no read-only guard — this plugin is
//                    explicitly the DBA escape hatch)
//   backup/restore   pg_dump, pg_restore
//
// Connection model: every tool takes a `connection` URL
// (postgres://user:pass@host:port/db or postgresql://…). A tiny LRU
// pool caches up to 4 live clients per URL for 60s, so back-to-back
// calls reuse the same socket instead of paying the TCP handshake
// every time. Use the `pg_close_pool` tool to force-evict.
//
// `pg_query` is the only tool that accepts arbitrary SQL — the
// discovery / introspection tools are read-only by construction
// (they all hit information_schema / pg_catalog SELECTs).
//
// `pg_dump` and `pg_restore` shell out to the system CLI when it is
// available, so a fresh `pg_dump`-less install still gets a friendly
// error pointing to the missing binary.

import { spawn, execFile } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { platform } from 'node:os';

const execFileAsync = promisify(execFile);

const POOL_MAX = 4;
const POOL_IDLE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

// `require` does not exist in an ES module, so `try { require('pg') }` threw
// ReferenceError every time and the catch reported it as "pg is not installed"
// — the plugin claimed a missing dependency whether or not it was there, and
// every tool that touches Postgres failed the same way. `createRequire` gives
// a real one, and keeps the load synchronous so callers stay unchanged.
const requirePeer = createRequire(import.meta.url);

function loadPg() {
  try { return requirePeer('pg'); }
  catch (err) {
    // A module that is present but fails to load is not a missing one, and
    // saying "run npm install" would send the reader nowhere.
    if (err?.code !== 'MODULE_NOT_FOUND') throw err;
    throw new Error('optional dependency "pg" is not installed. Run `npm install` (or `npm install pg`) to enable the pgadmin plugin.');
  }
}

// Tiny LRU keyed by connection URL.
const pool = new Map(); // url -> { client, lastUsed }

/**
 * Checks a connection string, returning a message rather than throwing.
 *
 * A bad `connection` is the model getting an argument wrong, not the database
 * failing, and the two want different handling: a returned string reaches the
 * model as the tool's own answer and says what to fix, where a throw arrives
 * wrapped in `plugin "pgadmin" tool "pg_query" failed: …` with the useful part
 * buried at the end. Genuine runtime failures still throw.
 */
function connectionProblem(connection) {
  if (!connection) return 'Error: connection string is required (postgres://user:pass@host:port/db)';
  if (!/^postgres(?:ql)?:\/\//i.test(connection)) {
    return 'Error: connection must start with postgres:// or postgresql://';
  }
  return null;
}

function getClient(connection) {
  const problem = connectionProblem(connection);
  // Kept as a backstop for any path that reaches here without checking first.
  if (problem) throw new Error(problem.replace(/^Error: /, ''));
  const now = Date.now();
  // Evict idle clients
  for (const [key, entry] of pool.entries()) {
    if (now - entry.lastUsed > POOL_IDLE_MS) {
      try { entry.client.end(); } catch {}
      pool.delete(key);
    }
  }
  // Evict oldest if at capacity and not the same URL
  if (!pool.has(connection) && pool.size >= POOL_MAX) {
    const oldestKey = pool.keys().next().value;
    const oldest = pool.get(oldestKey);
    try { oldest.client.end(); } catch {}
    pool.delete(oldestKey);
  }
  if (pool.has(connection)) {
    const entry = pool.get(connection);
    entry.lastUsed = now;
    return entry.client;
  }
  const { Client } = loadPg();
  const client = new Client({ connectionString: connection, statement_timeout: DEFAULT_TIMEOUT_MS });
  // Lazily connect on first use; the actual connect is awaited in runQuery.
  // We just store the client and connect on demand.
  client.__ettoreConnectionString = connection;
  pool.set(connection, { client, lastUsed: now });
  return client;
}

async function ensureConnected(client) {
  if (!client._connected) await client.connect();
  client._connected = true;
}

async function runQuery(connection, sql, { params = [], maxRows = 1000, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const client = getClient(connection);
  await ensureConnected(client);
  const startedAt = Date.now();
  const res = await client.query({ text: sql, values: params, statement_timeout: timeoutMs });
  const durationMs = Date.now() - startedAt;
  if (!res.fields) {
    // Non-row statement (INSERT/UPDATE/CREATE/…). Return a tiny summary.
    return {
      columns: ['result'],
      rows: [[`${res.command || 'OK'}: ${res.rowCount ?? 0} row(s) affected`]],
      rowCount: res.rowCount ?? 0,
      durationMs,
      truncated: false,
    };
  }
  const columns = res.fields.map((f) => f.name);
  const rows = res.rows || [];
  const truncated = rows.length > maxRows;
  return {
    columns,
    rows: truncated ? rows.slice(0, maxRows) : rows,
    rowCount: rows.length,
    durationMs,
    truncated,
  };
}

function rowsToMarkdown(columns, rows, { maxRows = 200 } = {}) {
  if (!rows.length) return '(no rows)';
  const truncated = rows.length > maxRows;
  const slice = truncated ? rows.slice(0, maxRows) : rows;
  const header = ['#', ...columns].map((c) => String(c).replace(/\|/g, '\\|'));
  const lines = ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |'];
  for (let i = 0; i < slice.length; i++) {
    const row = [String(i + 1)];
    for (const v of slice[i]) {
      let s;
      if (v == null) s = '';
      else if (typeof v === 'number') s = Number.isInteger(v) ? String(v) : v.toFixed(4);
      else if (v instanceof Date) s = Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 19).replace('T', ' ');
      else if (typeof v === 'object') {
        if (v && typeof v.toISOString === 'function') s = v.toISOString();
        else { try { s = JSON.stringify(v); } catch { s = String(v); } }
      } else s = String(v);
      if (s.length > 200) s = s.slice(0, 197) + '…';
      s = s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      row.push(s);
    }
    lines.push('| ' + row.join(' | ') + ' |');
  }
  if (truncated) lines.push(`… (${rows.length - maxRows} more row(s) — re-run with a larger max_rows)`);
  return lines.join('\n');
}

async function findTool(name) {
  for (const dir of ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', 'C:\\Program Files\\PostgreSQL\\16\\bin', 'C:\\Program Files\\PostgreSQL\\15\\bin', 'C:\\Program Files\\PostgreSQL\\14\\bin']) {
    const p = join(dir, platform() === 'win32' ? `${name}.exe` : name);
    if (existsSync(p)) return p;
  }
  return null;
}

// ── Restore wizard helpers ──────────────────────────────────────────────
//
// The wizard is a small HTTP server bound to 127.0.0.1 that serves the
// static HTML in `web/restore-wizard.html` and a tiny JSON API. The
// plugin's tool handler boots a server per request, opens the user's
// browser, and waits for the user to click "Drop and restore" or
// "Cancel" before resolving.

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_DIR = dirname(__filename);
const WIZARD_HTML = (() => {
  try { return readFileSync(join(PLUGIN_DIR, 'web', 'restore-wizard.html'), 'utf-8'); }
  catch { return '<!doctype html><meta charset="utf-8"><title>wizard missing</title><p style="font:14px sans-serif;color:#900;padding:2rem">The wizard HTML could not be loaded from the plugin directory. Reinstall the pgadmin plugin.</p>'; }
})();

// Process-local state for the currently-active wizard. There is only
// one wizard at a time (the tool handler awaits its completion
// before returning). Multiple parallel tool calls would race; we
// treat that as a programming error.
const wizardState = {
  resolve: null,
  onResult: null,
  server: null,
  context: null,
  timeoutTimer: null,
};

async function detectDumpFormat(filePath) {
  // Cheap heuristic — read the first 8 bytes.
  let head;
  try {
    const fd = await import('node:fs/promises');
    const fh = await fd.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(8);
      await fh.read(buf, 0, 8, 0);
      head = buf;
    } finally { await fh.close(); }
  } catch { return null; }
  // pg_dump custom format: bytes 'PGDMP' (0x50 0x47 0x44 0x4D 0x50) at offset 0
  if (head[0] === 0x50 && head[1] === 0x47 && head[2] === 0x44 && head[3] === 0x4D && head[4] === 0x50) return 'custom';
  // pg_dump tar format: file is a tar archive; magic 'ustar' at offset 257
  try {
    const fd = await import('node:fs/promises');
    const fh = await fd.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(5);
      await fh.read(buf, 0, 5, 257);
      if (buf.toString() === 'ustar') return 'tar';
    } finally { await fh.close(); }
  } catch {}
  // Heuristic: if it starts with a SQL keyword or contains a CREATE/INSERT
  // in the first 4 KB, assume plain.
  try {
    const fd = await import('node:fs/promises');
    const fh = await fd.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, 4096, 0);
      const text = buf.slice(0, bytesRead).toString('utf8').trim();
      if (/^(SET|--|CREATE|INSERT|SELECT|COPY|\\connect|\\\\)/i.test(text)) return 'plain';
    } finally { await fh.close(); }
  } catch {}
  return 'plain';
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf-8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

function sendHtml(res, body) {
  const buf = Buffer.from(body, 'utf-8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

function sendText(res, status, body) {
  const buf = Buffer.from(String(body), 'utf-8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': buf.length,
  });
  res.end(buf);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 256 * 1024) {
        req.destroy();
        return reject(new Error('body too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

// Terminate any active connections to a database, then run a query.
// Required before DROP DATABASE — otherwise it fails with
// "database is being accessed by other users".
async function terminateAndRun(connection, sql) {
  const client = getClient(connection);
  await ensureConnected(client);
  // First cancel other backends on the target DB; pg_terminate_backend
  // is the canonical way. We do this from a SEPARATE connection so
  // we are not terminating ourselves.
  const { Client: PgClient } = loadPg();
  const killer = new PgClient({ connectionString: connection });
  await killer.connect();
  try {
    const dbName = new URL(connection).pathname.replace(/^\//, '');
    await killer.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
  } catch {} finally { try { await killer.end(); } catch {} }
  return await client.query(sql);
}

async function performDropAndRestore({ connection, targetDb, targetOwner, sqlFile, dropIfExists }) {
  const steps = [];
  const t0 = Date.now();
  // Parse owner: if user gave a string like 'postgres', use as-is. If
  // 'user@host', strip the host.
  const safeOwner = String(targetOwner || 'postgres').split('@')[0];
  const safeName = String(targetDb).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 63) || targetDb;
  const url = new URL(connection);
  const adminConnection = new URL(connection);
  adminConnection.pathname = '/postgres';
  const psql = await findTool('psql');
  const pgRestore = await findTool('pg_restore');

  if (dropIfExists) {
    const sql = `DROP DATABASE IF EXISTS "${safeName}"`;
    try {
      await terminateAndRun(adminConnection.toString(), sql);
      steps.push({ ok: true, label: `DROP DATABASE IF EXISTS ${safeName}` });
    } catch (err) {
      steps.push({ ok: false, label: `DROP DATABASE IF EXISTS ${safeName}`, detail: err.message });
      return { ok: false, steps, duration_ms: Date.now() - t0 };
    }
  }
  // CREATE DATABASE
  const createSql = `CREATE DATABASE "${safeName}" WITH OWNER = "${safeOwner}"`;
  try {
    await runQuery(adminConnection.toString(), createSql, { timeoutMs: 15000 });
    steps.push({ ok: true, label: `CREATE DATABASE ${safeName} WITH OWNER = ${safeOwner}` });
  } catch (err) {
    steps.push({ ok: false, label: createSql, detail: err.message });
    return { ok: false, steps, duration_ms: Date.now() - t0 };
  }
  // Apply the dump
  const dbConn = new URL(connection);
  dbConn.pathname = `/${safeName}`;
  const detected = await detectDumpFormat(sqlFile);
  if (detected === 'custom' || detected === 'tar' || detected === 'directory') {
    if (!pgRestore) {
      steps.push({ ok: false, label: 'pg_restore', detail: 'pg_restore not installed' });
      return { ok: false, steps, duration_ms: Date.now() - t0 };
    }
    try {
      const env = { ...process.env, PGPASSWORD: decodeURIComponent(dbConn.password || '') };
      await execFileAsync(pgRestore, [
        '-h', dbConn.hostname,
        '-p', dbConn.port || '5432',
        '-U', decodeURIComponent(dbConn.username || ''),
        '-d', safeName,
        '--no-owner',
        sqlFile,
      ], { env, maxBuffer: 64 * 1024 * 1024, timeoutMs: 30 * 60_000 });
      steps.push({ ok: true, label: `pg_restore -d ${safeName} ${sqlFile}` });
    } catch (err) {
      steps.push({ ok: false, label: 'pg_restore', detail: (err.stderr || err.message || '').toString().slice(0, 800) });
      return { ok: false, steps, duration_ms: Date.now() - t0 };
    }
  } else {
    // Plain SQL — apply with psql -f
    if (!psql) {
      steps.push({ ok: false, label: 'psql', detail: 'psql not installed (needed for plain .sql dumps)' });
      return { ok: false, steps, duration_ms: Date.now() - t0 };
    }
    try {
      const env = { ...process.env, PGPASSWORD: decodeURIComponent(dbConn.password || '') };
      await execFileAsync(psql, [
        '-h', dbConn.hostname,
        '-p', dbConn.port || '5432',
        '-U', decodeURIComponent(dbConn.username || ''),
        '-d', safeName,
        '-v', 'ON_ERROR_STOP=1',
        '-f', sqlFile,
      ], { env, maxBuffer: 64 * 1024 * 1024, timeoutMs: 30 * 60_000 });
      steps.push({ ok: true, label: `psql -d ${safeName} -f ${sqlFile}` });
    } catch (err) {
      steps.push({ ok: false, label: 'psql', detail: (err.stderr || err.message || '').toString().slice(0, 800) });
      return { ok: false, steps, duration_ms: Date.now() - t0 };
    }
  }
  return { ok: true, steps, duration_ms: Date.now() - t0, target_db: safeName, target_owner: safeOwner };
}

function startWizardServer({ token, connection, sqlFile, detectedFormat, targetDbName, targetDbOwner, port = 0 }) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const urlToken = url.searchParams.get('token');
        if (urlToken !== token) {
          return sendText(res, 403, 'Forbidden: missing or wrong token.');
        }
        const path = url.pathname;
        if (path === '/' || path === '/index.html') {
          // Inject connection/file/db pre-fills into the URL so the page
          // shows a green dot immediately if the plugin's connection
          // string is good and the file is reachable.
          const params = new URLSearchParams({ token });
          if (connection) params.set('connection', connection);
          if (sqlFile) params.set('file', sqlFile);
          if (targetDbName) params.set('db_name', targetDbName);
          if (targetDbOwner) params.set('db_owner', targetDbOwner);
          if (detectedFormat) params.set('format', detectedFormat);
          const filled = WIZARD_HTML
            .replace('const params = new URLSearchParams(location.search);',
                     'const params = new URLSearchParams(location.search);\n  params.set("token", "' + token + '");');
          return sendHtml(res, filled);
        }
        if (path === '/api/test-connection' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const conn = body.connection || connection;
          try {
            const r = await runQuery(conn, 'SELECT version() AS v, current_database() AS db, inet_server_addr() AS host, inet_server_port() AS port', { maxRows: 5, timeoutMs: 8000 });
            const versionMatch = String(r.rows[0]?.v || '').match(/PostgreSQL\s+([0-9.]+)/i);
            sendJson(res, 200, {
              ok: true,
              server_version: versionMatch ? versionMatch[1] : (r.rows[0]?.v || 'unknown'),
              database: r.rows[0]?.db || 'unknown',
              host: r.rows[0]?.host || new URL(conn).hostname,
              port: r.rows[0]?.port || new URL(conn).port || '5432',
              detected_format: await detectDumpFormat(body.sql_file || sqlFile),
            });
          } catch (err) {
            sendJson(res, 200, { ok: false, error: err.message, detail: err.detail || err.message });
          }
          return;
        }
        if (path === '/api/tables' && req.method === 'GET') {
          try {
            const r = await runQuery(connection,
              `SELECT schemaname AS schema, relname AS name,
                      CASE relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' WHEN 'S' THEN 'sequence' WHEN 'i' THEN 'index' WHEN 't' THEN 'toast' ELSE relkind::text END AS type,
                      n_live_tup AS rows_estimate,
                      pg_size_pretty(pg_total_relation_size(relid)) AS size_pretty
               FROM pg_stat_user_tables
               WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
               ORDER BY schemaname, relname`,
              { maxRows: 1000, timeoutMs: 8000 });
            sendJson(res, 200, { ok: true, tables: r.rows });
          } catch (err) {
            sendJson(res, 200, { ok: false, error: err.message, detail: err.message });
          }
          return;
        }
        if (path === '/api/drop-and-restore' && req.method === 'POST') {
          const body = await readJsonBody(req);
          if (!body.target_db) return sendJson(res, 400, { ok: false, error: 'target_db required' });
          if (!body.sql_file) return sendJson(res, 400, { ok: false, error: 'sql_file required' });
          if (!existsSync(body.sql_file)) return sendJson(res, 400, { ok: false, error: `sql file not found: ${body.sql_file}` });
          const result = await performDropAndRestore({
            connection: body.connection || connection,
            targetDb: body.target_db,
            targetOwner: body.target_owner || 'postgres',
            sqlFile: body.sql_file,
            dropIfExists: body.drop_if_exists !== false,
          });
          sendJson(res, result.ok ? 200 : 500, result);
          return;
        }
        if (path === '/api/cancel' && req.method === 'POST') {
          if (wizardState.onResult) wizardState.onResult({ status: 'cancelled', steps: [], duration_ms: 0 });
          return sendJson(res, 200, { ok: true });
        }
        if (path === '/api/done' && req.method === 'POST') {
          if (wizardState.onResult) wizardState.onResult({ status: 'done', steps: [], duration_ms: 0 });
          return sendJson(res, 200, { ok: true });
        }
        if (path === '/api/upload' && req.method === 'POST') {
          // Accept a base64-encoded file, write it to /tmp under a
          // pgadmin-upload-* name, and return the absolute path. The UI
          // fills the "Path on disk" field with that path so the user
          // can drag-and-drop a dump file from their laptop even when
          // ETTORE is running on a remote host.
          const body = await readJsonBody(req);
          if (!body || !body.name || !body.content_base64) {
            return sendJson(res, 400, { ok: false, error: 'name and content_base64 required' });
          }
          // Cap at 200 MB. The base64 body is ~33% larger than the raw
          // bytes, so we measure the decoded length instead of the body
          // size.
          const rawSize = Math.floor((body.content_base64.length * 3) / 4);
          if (rawSize > 200 * 1024 * 1024) {
            return sendJson(res, 413, { ok: false, error: `file is ${(rawSize / 1024 / 1024).toFixed(0)} MB, max is 200 MB` });
          }
          // Reject path traversal in the original name and shell
          // metacharacters. We derive a server-side path from a random
          // id, NOT from the user-supplied name, so the user cannot
          // influence where the file lands.
          const safeName = String(body.name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'dump.sql';
          const id = randomBytes(8).toString('hex');
          const dir = '/tmp';
          try { mkdirSync(dir, { recursive: true }); } catch {}
          const filePath = join(dir, `pgadmin-${id}-${safeName}`);
          try {
            const bytes = Buffer.from(body.content_base64, 'base64');
            writeFileSync(filePath, bytes);
            return sendJson(res, 200, {
              ok: true,
              path: filePath,
              size: bytes.length,
              original_name: body.name,
            });
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: 'failed to write uploaded file', detail: err.message });
          }
        }
        sendText(res, 404, 'Not found');
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
    });
    // The `port` option was documented and ignored — this call was hard-coded
    // to 0. A fixed port is what makes the wizard reachable through an SSH
    // tunnel, and testable at a known address.
    // Without this, a bind failure reaches an http.Server with no `error`
    // listener, and Node turns that into an unhandled 'error' event that takes
    // the whole CLI down — a busy port killed the session instead of producing
    // a message.
    server.on('error', (err) => {
      if (err?.code === 'EADDRINUSE') {
        reject(new Error(
          `port ${port} is already in use by another process. Omit \`port\` to let the wizard pick a free one, `
          + 'or choose a different number.',
        ));
        return;
      }
      reject(err);
    });
    server.listen(Number(port) || 0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      wizardState.server = server;
      resolve({ port, close: () => new Promise((r) => { server.close(() => r()); }) });
    });
  });
}

async function openBrowser(url) {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    if (platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    // Linux + everything else
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ── Tools ───────────────────────────────────────────────────────────────
export const tools = {
  pg_list_databases: {
    description: 'List databases on the server. Requires connecting to a maintenance DB (usually "postgres"); the connection string must be valid.',
    parameters: {
      type: 'object',
      properties: { connection: { type: 'string' } },
      required: ['connection'],
      additionalProperties: false,
    },
    handler: async ({ connection } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const r = await runQuery(connection,
        `SELECT datname AS database, pg_database_size(datname) AS size_bytes,
                pg_size_pretty(pg_database_size(datname)) AS size_pretty,
                datistemplate AS is_template, datallowconn AS allows_connections,
                datlastsysoid::regclass AS last_sys_oid
         FROM pg_database
         WHERE NOT datistemplate
         ORDER BY datname`,
        { timeoutMs: 10000 });
      return `${r.rowCount} database(s)\n\n` + rowsToMarkdown(r.columns, r.rows);
    },
  },

  pg_list_schemas: {
    description: 'List schemas in the current database. Excludes the system schemas (pg_catalog, information_schema, pg_toast, …) by default.',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        include_system: { type: 'boolean', default: false },
      },
      required: ['connection'],
      additionalProperties: false,
    },
    handler: async ({ connection, include_system = false } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const filter = include_system ? '' : `WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'`;
      const r = await runQuery(connection,
        `SELECT schema_name, schema_owner
         FROM information_schema.schemata
         ${filter}
         ORDER BY schema_name`);
      return `${r.rowCount} schema(s)\n\n` + rowsToMarkdown(r.columns, r.rows);
    },
  },

  pg_list_tables: {
    description: 'List tables and views in a schema. Default schema: "public".',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        schema: { type: 'string', default: 'public' },
        include_views: { type: 'boolean', default: true },
      },
      required: ['connection'],
      additionalProperties: false,
    },
    handler: async ({ connection, schema = 'public', include_views = true } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const types = include_views
        ? `'BASE TABLE', 'VIEW'`
        : `'BASE TABLE'`;
      const r = await runQuery(connection,
        `SELECT table_schema, table_name, table_type
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_type IN (${types})
         ORDER BY table_type, table_name`,
        { params: [schema] });
      return `${r.rowCount} object(s) in schema "${schema}"\n\n` + rowsToMarkdown(r.columns, r.rows);
    },
  },

  pg_describe_table: {
    description: 'Describe a table: columns (name, type, nullable, default), primary key, and indexes. Use the schema-qualified name (e.g. "public.users").',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        table: { type: 'string', description: 'Schema-qualified table name, e.g. "public.users".' },
      },
      required: ['connection', 'table'],
      additionalProperties: false,
    },
    handler: async ({ connection, table } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const [schema, name] = String(table).includes('.') ? String(table).split('.') : ['public', String(table)];
      const cols = await runQuery(connection,
        `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        { params: [schema, name] });
      const pk = await runQuery(connection,
        `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary`,
        { params: [schema, name] });
      const idx = await runQuery(connection,
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2
         ORDER BY indexname`,
        { params: [schema, name] });
      const out = [
        `Table ${schema}.${name}`,
        '',
        `Columns (${cols.rowCount}):`,
        rowsToMarkdown(cols.columns, cols.rows),
        '',
        `Primary key: ${pk.rowCount ? pk.rows.map((r) => r.column_name).join(', ') : '(none)'}`,
        '',
        `Indexes (${idx.rowCount}):`,
        rowsToMarkdown(idx.columns, idx.rows),
      ];
      return out.join('\n');
    },
  },

  pg_list_indexes: {
    description: 'List all indexes of a table with their definitions and sizes.',
    parameters: {
      type: 'object',
      properties: { connection: { type: 'string' }, table: { type: 'string' } },
      required: ['connection', 'table'],
      additionalProperties: false,
    },
    handler: async ({ connection, table } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const [schema, name] = String(table).includes('.') ? String(table).split('.') : ['public', String(table)];
      const r = await runQuery(connection,
        `SELECT indexname, indexdef, pg_size_pretty(pg_relation_size(indexname::regclass)) AS size
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2
         ORDER BY indexname`,
        { params: [schema, name] });
      return `${r.rowCount} index(es) on ${table}\n\n` + rowsToMarkdown(r.columns, r.rows);
    },
  },

  pg_list_constraints: {
    description: 'List all constraints (PK, FK, UNIQUE, CHECK) of a table.',
    parameters: {
      type: 'object',
      properties: { connection: { type: 'string' }, table: { type: 'string' } },
      required: ['connection', 'table'],
      additionalProperties: false,
    },
    handler: async ({ connection, table } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const r = await runQuery(connection,
        `SELECT con.conname, con.contype,
                pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
         WHERE nsp.nspname = $1 AND rel.relname = $2
         ORDER BY con.contype, con.conname`,
        { params: [String(table).includes('.') ? String(table).split('.')[0] : 'public', String(table).includes('.') ? String(table).split('.')[1] : String(table)] });
      return `${r.rowCount} constraint(s) on ${table}\n\n` + rowsToMarkdown(r.columns, r.rows);
    },
  },

  pg_list_views: {
    description: 'List views in a schema with their definitions.',
    parameters: {
      type: 'object',
      properties: { connection: { type: 'string' }, schema: { type: 'string', default: 'public' } },
      required: ['connection'],
      additionalProperties: false,
    },
    handler: async ({ connection, schema = 'public' } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const r = await runQuery(connection,
        `SELECT viewname, viewowner, definition
         FROM pg_views
         WHERE schemaname = $1
         ORDER BY viewname`,
        { params: [schema] });
      return `${r.rowCount} view(s) in schema "${schema}"\n\n` + rowsToMarkdown(r.columns, r.rows);
    },
  },

  pg_list_functions: {
    description: 'List stored functions and procedures in a schema.',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        schema: { type: 'string', default: 'public' },
      },
      required: ['connection'],
      additionalProperties: false,
    },
    handler: async ({ connection, schema = 'public' } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const r = await runQuery(connection,
        `SELECT n.nspname AS schema, p.proname AS name,
                CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' ELSE p.prokind::text END AS kind,
                pg_get_function_arguments(p.oid) AS args,
                pg_get_function_result(p.oid) AS returns,
                pg_size_pretty(pg_relation_size(p.oid)) AS size
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1
         ORDER BY p.proname`,
        { params: [schema] });
      return `${r.rowCount} routine(s) in schema "${schema}"\n\n` + rowsToMarkdown(r.columns, r.rows);
    },
  },

  pg_list_users: {
    description: 'List roles / users on the server with their attributes (superuser, login, etc.).',
    parameters: {
      type: 'object',
      properties: { connection: { type: 'string' } },
      required: ['connection'],
      additionalProperties: false,
    },
    handler: async ({ connection } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const r = await runQuery(connection,
        `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
                rolcanlogin, rolreplication, rolbypassrls
         FROM pg_roles
         ORDER BY rolname`);
      return `${r.rowCount} role(s)\n\n` + rowsToMarkdown(r.columns, r.rows);
    },
  },

  pg_query: {
    description: 'Run an arbitrary SQL query. This is the only tool in the plugin that does not impose a read-only check — it is the DBA escape hatch. Use carefully: a DROP TABLE here will drop the table.',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        sql: { type: 'string' },
        params: { type: 'array', description: 'Optional positional parameters ($1, $2, …) to bind safely.' },
        max_rows: { type: 'integer', default: 1000, minimum: 1, maximum: 100000 },
        timeout_ms: { type: 'integer', default: 30000, minimum: 1000, maximum: 300000 },
      },
      required: ['connection', 'sql'],
      additionalProperties: false,
    },
    handler: async ({ connection, sql, params = [], max_rows = 1000, timeout_ms = 30000 } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const r = await runQuery(connection, sql, { params, maxRows: max_rows, timeoutMs: timeout_ms });
      const md = rowsToMarkdown(r.columns, r.rows, { maxRows: max_rows });
      return `${r.rowCount} row(s) in ${r.durationMs}ms${r.truncated ? ` (truncated to ${max_rows})` : ''}\n\n${md}`;
    },
  },

  pg_explain: {
    description: 'Run EXPLAIN on a query. Add analyze=true to actually execute it (slower, real timing). FORMAT is JSON for machine-readable output or TEXT for human-readable.',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        sql: { type: 'string' },
        analyze: { type: 'boolean', default: false, description: 'If true, actually executes the query (EXPLAIN ANALYZE).' },
        format: { type: 'string', enum: ['TEXT', 'JSON'], default: 'TEXT' },
      },
      required: ['connection', 'sql'],
      additionalProperties: false,
    },
    handler: async ({ connection, sql, analyze = false, format = 'TEXT' } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const r = await runQuery(connection, `EXPLAIN ${analyze ? 'ANALYZE ' : ''}${sql}`, { maxRows: 100 });
      if (format === 'JSON') {
        return JSON.stringify(r.rows.map((row) => row[Object.keys(row)[0]]), null, 2);
      }
      return r.rows.map((row) => Object.values(row)[0]).join('\n');
    },
  },

  pg_database_size: {
    description: 'Show the total size of a database (data + indexes + toast).',
    parameters: {
      type: 'object',
      properties: { connection: { type: 'string' } },
      required: ['connection'],
      additionalProperties: false,
    },
    handler: async ({ connection } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const r = await runQuery(connection, `SELECT current_database() AS database, pg_size_pretty(pg_database_size(current_database())) AS total_size, pg_database_size(current_database()) AS size_bytes`);
      return r.rows[0] ? `Database ${r.rows[0].database}: ${r.rows[0].total_size} (${r.rows[0].size_bytes} bytes)` : 'unknown';
    },
  },

  pg_table_stats: {
    description: 'Get row count estimate, total size, index size, and last-vacuum/analyze timestamps for a table.',
    parameters: {
      type: 'object',
      properties: { connection: { type: 'string' }, table: { type: 'string' } },
      required: ['connection', 'table'],
      additionalProperties: false,
    },
    handler: async ({ connection, table } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const r = await runQuery(connection,
        `SELECT
           schemaname || '.' || relname AS table_name,
           n_live_tup AS row_estimate,
           pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
           pg_size_pretty(pg_relation_size(relid)) AS data_size,
           pg_size_pretty(pg_indexes_size(relid)) AS index_size,
           last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
         FROM pg_stat_user_tables
         WHERE schemaname || '.' || relname = $1`,
        { params: [table], maxRows: 5 });
      return r.rowCount ? rowsToMarkdown(r.columns, r.rows) : `(no stats for ${table} — does the table exist and is the connection user allowed to read pg_stat_user_tables?)`;
    },
  },

  pg_dump: {
    description: 'Run pg_dump against a database and write the SQL to a file. Requires the pg_dump binary on PATH (or in the standard install locations). Pass --schema to limit to one schema, --table to limit to one table, --data-only for inserts only.',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'postgres:// connection URL. Only host/port/db are read; user/password are taken from the URL.' },
        output_path: { type: 'string' },
        schema: { type: 'string' },
        table: { type: 'string' },
        data_only: { type: 'boolean', default: false },
        format: { type: 'string', enum: ['plain', 'custom', 'tar', 'directory'], default: 'plain' },
        extra_args: { type: 'array', description: 'Extra pg_dump args. Pass through unvalidated.' },
      },
      required: ['connection', 'output_path'],
      additionalProperties: false,
    },
    handler: async ({ connection, output_path, schema, table, data_only = false, format = 'plain', extra_args = [] } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const bin = await findTool('pg_dump');
      if (!bin) return 'Error: pg_dump not found. Install PostgreSQL client tools (apt install postgresql-client, brew install libpq, or download from postgresql.org).';
      const url = new URL(connection);
      const args = [
        '-h', url.hostname,
        '-p', url.port || '5432',
        '-U', decodeURIComponent(url.username || ''),
        '-d', (url.pathname || '/').slice(1),
        '-f', output_path,
        '-F', format === 'plain' ? 'p' : format === 'custom' ? 'c' : format === 'tar' ? 't' : 'd',
      ];
      if (schema) args.push('-n', schema);
      if (table) args.push('-t', table);
      if (data_only) args.push('--data-only');
      if (Array.isArray(extra_args)) args.push(...extra_args);
      mkdirSync(dirname(output_path), { recursive: true });
      const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password || '') };
      try {
        const { stdout, stderr } = await execFileAsync(bin, args, { env, maxBuffer: 256 * 1024 * 1024, timeoutMs: 5 * 60_000 });
        const size = existsSync(output_path) ? statSync(output_path).size : 0;
        return `pg_dump → ${output_path} (${size} bytes, ${format} format)${stderr ? `\nstderr (truncated): ${stderr.slice(0, 500)}` : ''}`;
      } catch (err) {
        return `Error: pg_dump failed (code ${err.code}): ${(err.stderr || err.message || '').toString().slice(0, 1000)}`;
      }
    },
  },

  pg_restore: {
    description: 'Run pg_restore against a custom/tar/directory dump file. Requires the pg_restore binary on PATH. --clean drops objects before recreating; --if-exists suppresses "does not exist" errors during --clean.',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        dump_path: { type: 'string' },
        clean: { type: 'boolean', default: false },
        if_exists: { type: 'boolean', default: false },
        jobs: { type: 'integer', default: 1, description: 'Number of parallel jobs for --multi-thread (custom/dir formats only).' },
        extra_args: { type: 'array' },
      },
      required: ['connection', 'dump_path'],
      additionalProperties: false,
    },
    handler: async ({ connection, dump_path, clean = false, if_exists = false, jobs = 1, extra_args = [] } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const bin = await findTool('pg_restore');
      if (!bin) return 'Error: pg_restore not found. Install PostgreSQL client tools.';
      if (!existsSync(dump_path)) return `Error: dump file not found: ${dump_path}`;
      const url = new URL(connection);
      const args = [
        '-h', url.hostname,
        '-p', url.port || '5432',
        '-U', decodeURIComponent(url.username || ''),
        '-d', (url.pathname || '/').slice(1),
        '-j', String(Math.max(1, Number(jobs) || 1)),
        dump_path,
      ];
      if (clean) args.push('--clean');
      if (if_exists) args.push('--if-exists');
      if (Array.isArray(extra_args)) args.push(...extra_args);
      const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password || '') };
      try {
        const { stdout, stderr } = await execFileAsync(bin, args, { env, maxBuffer: 256 * 1024 * 1024, timeoutMs: 10 * 60_000 });
        return `pg_restore completed.${stderr ? `\nstderr (truncated): ${stderr.slice(0, 500)}` : ''}`;
      } catch (err) {
        return `Error: pg_restore failed (code ${err.code}): ${(err.stderr || err.message || '').toString().slice(0, 1000)}`;
      }
    },
  },

  pg_close_pool: {
    description: 'Force-close all pooled PostgreSQL connections. Use this when you changed credentials, hit "too many clients", or want a clean shutdown before running a pg_restore.',
    parameters: {
      type: 'object',
      properties: { connection: { type: 'string', description: 'Optional. If omitted, closes ALL connections in the pool.' } },
      additionalProperties: false,
    },
    handler: async ({ connection } = {}) => {
      const problem = connectionProblem(connection);
      if (problem) return problem;
      const targets = connection ? [connection] : [...pool.keys()];
      for (const url of targets) {
        const entry = pool.get(url);
        if (!entry) continue;
        try { await entry.client.end(); } catch {}
        pool.delete(url);
      }
      return `Closed ${targets.length} connection(s).`;
    },
  },

  // ── pg_restore_wizard ──────────────────────────────────────────────
  // Opens a local web page (http://127.0.0.1:<random>) with a wizard UI
  // that walks the user through a drop-and-recreate. The plugin already
  // knows the connection params, so the green-dot "OK" comes up
  // immediately if the DB is reachable; the user only intervenes when
  // the connection fails (red dot) or when picking the new DB name +
  // owner + dump file. Closes the browser tab and resolves the tool
  // call once the user clicks Done / Cancel / the 10-minute idle
  // timeout fires.
  pg_restore_wizard: {
    description: 'Open the local web wizard for dropping and recreating a PostgreSQL database from a dump. Call it with no arguments: the page is where the connection and the dump file are chosen, and it can browse for the file. Every argument is an optional pre-fill — never ask the user for one, just open the wizard. Requires psql (plain dumps) or pg_restore (custom/tar) on PATH.',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Optional pre-fill for the connection field. Omit it — the page asks, and tests the connection itself.' },
        sql_file: { type: 'string', description: 'Optional pre-fill for the dump path, only when the user already named a file. Omit it otherwise: the page has a file browser and an upload field.' },
        target_db_name: { type: 'string', description: 'Optional pre-fill for the "name" field in the UI. The user can edit it before clicking Drop and restore.' },
        target_db_owner: { type: 'string', description: 'Optional pre-fill for the owner field (default: postgres).' },
        port: { type: 'integer', description: 'Optional fixed port for the wizard server. Default: 0 (random free port).' },
        open_browser: { type: 'boolean', default: true, description: 'Set false to NOT auto-open the browser — useful for headless / SSH sessions where the user opens the URL manually.' },
      },
      // Nothing is required. Both used to be, which forced the model to obtain a
      // dump path it had no way of knowing — so it asked the user for it in the
      // terminal, when picking the file is the wizard's own first screen.
      required: [],
      additionalProperties: false,
    },
    handler: async ({ connection, sql_file, target_db_name, target_db_owner, port, open_browser = true } = {}) => {
      // A supplied connection is still checked, because a wrong one is worth
      // saying immediately; an absent one is not an error, it is the normal
      // case and the page collects it.
      if (connection) {
        const problem = connectionProblem(connection);
        if (problem) return problem;
      }
      if (sql_file && !existsSync(sql_file)) return `Error: SQL file not found: ${sql_file}`;
      // Auto-detect dump format up-front so the UI can show a badge. Only
      // possible when a file was named; otherwise the page detects it after
      // the user chooses one.
      const detectedFormat = sql_file ? await detectDumpFormat(sql_file) : null;
      const portNum = port ? Number(port) : 0;
      const token = randomBytes(16).toString('hex');
      let started;
      try {
        started = await startWizardServer({
          token, connection: connection || '', sqlFile: sql_file || '', detectedFormat,
          targetDbName: target_db_name, targetDbOwner: target_db_owner,
          port: portNum,
        });
      } catch (err) {
        return `Error: could not start the restore wizard — ${err.message}`;
      }
      const { port: actualPort, close } = started;
      const url = `http://127.0.0.1:${actualPort}/?token=${token}`;
      let browserOpened = false;
      if (open_browser) browserOpened = await openBrowser(url);
      // A page nobody can find is not a wizard. The URL carries the access
      // token and was only reported when the wizard finished, so a headless or
      // SSH session — the case `open_browser: false` exists for — was told to
      // open it manually and never told where, then blocked for ten minutes.
      // Hand back the address instead and leave the server up: the user opens
      // it, and the restore runs in the page.
      if (!browserOpened) {
        return {
          status: 'awaiting_browser',
          url,
          message: open_browser
            ? `Could not open a browser automatically. Open this URL to continue: ${url}`
            : `Wizard ready. Open this URL to continue: ${url}`,
        };
      }
      // Wait for the user to finish (or timeout).
      const result = await new Promise((resolve) => {
        const t = setTimeout(() => {
          try { close(); } catch {}
          resolve({ status: 'timeout', url, message: 'No activity for 10 minutes — wizard closed itself.' });
        }, 10 * 60_000);
        wizardState.onResult = (r) => { clearTimeout(t); try { close(); } catch {} resolve({ ...r, url }); };
      });
      return { url, browser_opened: browserOpened, ...result };
    },
  },
};

export const hooks = {
  onLoad: async (api) => {
    let pgOk = false, dumpOk = false, restoreOk = false;
    try { requirePeer.resolve('pg'); pgOk = true; } catch { /* not installed */ }
    try { if (await findTool('pg_dump')) dumpOk = true; } catch {}
    try { if (await findTool('pg_restore')) restoreOk = true; } catch {}
    if (!pgOk) {
      api.log('warn', 'pgadmin loaded but the "pg" module is not installed. Run `npm install` to enable it.');
    } else {
      api.log('info', `pgadmin loaded — pg=${pgOk} pg_dump=${dumpOk} pg_restore=${restoreOk}`);
    }
  },
  onUnload: async () => {
    for (const entry of pool.values()) {
      try { await entry.client.end(); } catch {}
    }
    pool.clear();
    // Close any active wizard server. The browser tab will keep showing
    // "connection refused" if the user navigates back, but the in-memory
    // tool handler is gone.
    if (wizardState.server) {
      try { wizardState.server.close(); } catch {}
      wizardState.server = null;
    }
  },
};
