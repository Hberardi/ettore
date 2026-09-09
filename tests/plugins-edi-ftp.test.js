// Tests for the edi-ftp plugin.
//
// The protocol client is exercised against a fake FTP server started inside
// the test process: no network, no fixtures, but the real code path —
// greeting, login, FEAT, passive-mode negotiation, data transfer, QUIT.
// SFTP needs the optional `ssh2` dependency and is not covered here; its
// listing/attribute mapping is pure and small enough to read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PLUGIN_DIR = join(REPO_ROOT, 'examples', 'plugins', 'edi-ftp');

async function loadPlugin() {
  const entry = join(PLUGIN_DIR, 'index.js');
  return import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}`);
}

// ── manifest ──────────────────────────────────────────────────────────────

test('edi-ftp: manifest is well-formed and declares the transports it uses', async () => {
  const json = JSON.parse(readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf-8'));
  assert.equal(json.name, 'edi-ftp');
  assert.equal(json.apiVersion, '1');
  assert.match(json.version, /^\d+\.\d+\.\d+/);
  assert.ok(json.permissions.includes('network:ftp'));
  assert.ok(json.permissions.includes('network:ssh'));
  assert.ok(json.permissions.includes('fs:write'));
});

test('edi-ftp: the core loader accepts the manifest and the module', async () => {
  const { validateManifest, validatePluginModule } = await import('../src/plugins/manifest.js');
  const manifest = validateManifest(JSON.parse(readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf-8')), PLUGIN_DIR);
  assert.equal(manifest.name, 'edi-ftp');
  const validated = validatePluginModule(await loadPlugin());
  assert.equal(Object.keys(validated.tools).length, 11);
  assert.ok(validated.commands.edi);
  assert.equal(typeof validated.hooks.onLoad, 'function');
});

// ── connection targets ────────────────────────────────────────────────────

test('edi-ftp: specFromUrl reads user, port and base directory', async () => {
  const { _internal } = await loadPlugin();
  const spec = _internal.specFromUrl('ftps://mario%40acme:pw@edi.example.com:2121/out/edi');
  assert.equal(spec.protocol, 'ftps');
  assert.equal(spec.host, 'edi.example.com');
  assert.equal(spec.port, 2121);
  assert.equal(spec.user, 'mario@acme');
  assert.equal(spec.password, 'pw');
  assert.equal(spec.baseDir, '/out/edi');
  assert.equal(spec.implicit, false);
});

test('edi-ftp: port 990 means implicit FTPS, and defaults fill in per protocol', async () => {
  const { _internal } = await loadPlugin();
  assert.equal(_internal.specFromUrl('ftps://u@h:990/x').implicit, true);
  assert.equal(_internal.buildSpec({ url: 'ftp://u@h' }).port, 21);
  assert.equal(_internal.buildSpec({ url: 'sftp://u@h' }).port, 22);
  assert.equal(_internal.buildSpec({ url: 'ftps://u@h:990/' }).port, 990);
  assert.throws(() => _internal.buildSpec({ url: 'http://u@h' }), /unsupported protocol/);
  assert.throws(() => _internal.buildSpec({}), /either "profile" or "url"/);
});

test('edi-ftp: remotePath joins onto the base dir but an absolute path wins', async () => {
  const { _internal } = await loadPlugin();
  const spec = _internal.buildSpec({ url: 'ftp://u@h/out' });
  assert.equal(_internal.remotePath(spec, 'A.EDI'), '/out/A.EDI');
  assert.equal(_internal.remotePath(spec, '/altro/A.EDI'), '/altro/A.EDI');
  assert.equal(_internal.remotePath(spec, ''), '/out');
});

test('edi-ftp: redact strips the live password and anything shaped like one', async () => {
  const { _internal } = await loadPlugin();
  assert.equal(_internal.redact('530 Login failed for hunter2', 'hunter2'), '530 Login failed for ********');
  assert.equal(_internal.redact('PASS hunter2: timed out', ''), 'PASS ******** timed out');
  assert.match(_internal.redact('ftp://mario:hunter2@host/', ''), /ftp:\/\/mario:\*{8}@host\//);
});

// ── protocol plumbing ─────────────────────────────────────────────────────

test('edi-ftp: extractResponse handles single, multiline and partial replies', async () => {
  const { _internal } = await loadPlugin();
  const one = _internal.extractResponse('220 hello\r\n331 next\r\n');
  assert.equal(one.code, 220);
  assert.equal(one.text, '220 hello');
  assert.equal(one.rest, '331 next\r\n');

  // A multiline reply ends at a line opening with the SAME code and a space.
  // The "211 " inside the feature list must not be mistaken for the end.
  const feat = _internal.extractResponse('211-Features:\r\n MLSD\r\n EPSV\r\n211 End\r\n');
  assert.equal(feat.code, 211);
  assert.match(feat.text, /MLSD/);
  assert.equal(feat.rest, '');

  assert.equal(_internal.extractResponse('220 incomplete'), null);
  assert.equal(_internal.extractResponse('211-open\r\n still going\r\n'), null);
});

test('edi-ftp: parseListing reads Unix and DOS listings, parseMlsd reads facts', async () => {
  const { _internal } = await loadPlugin();
  const unix = _internal.parseListing([
    'total 12',
    'drwxr-xr-x 2 edi edi 4096 Jan 31 09:12 archivio',
    '-rw-r--r-- 1 edi edi 2048 Jan 31 09:13 BOLLE_20240131.EDI',
    'lrwxrwxrwx 1 edi edi   12 Jan 31 09:14 ultimo.edi -> BOLLE_20240131.EDI',
  ].join('\r\n'));
  assert.equal(unix.length, 3);
  assert.deepEqual(unix[0], { name: 'archivio', type: 'dir', size: 4096, modified: 'Jan 31 09:12' });
  assert.equal(unix[1].size, 2048);
  assert.equal(unix[2].name, 'ultimo.edi');

  const dos = _internal.parseListing('01-31-24  09:13AM              2048 BOLLE.EDI\r\n01-31-24  09:12AM       <DIR>          archivio');
  assert.equal(dos[0].size, 2048);
  assert.equal(dos[1].type, 'dir');

  const mlsd = _internal.parseMlsd('type=file;size=2048;modify=20240131091300; BOLLE.EDI\r\ntype=dir;modify=20240131091200; archivio\r\ntype=cdir; .\r\n');
  assert.equal(mlsd.length, 2);
  assert.equal(mlsd[0].modified, '2024-01-31T09:13:00Z');
  assert.equal(mlsd[1].type, 'dir');
});

// ── the client, against a fake server ─────────────────────────────────────

const FILE_BODY = '01ACME0001 20240131\r\n02RIGA0001 000000012345\r\n';

// Minimal FTP server: enough of RFC 959 for the client's happy path, plus
// the two failure modes worth asserting (bad password, missing file).
function startFakeFtp({ password = 'segreto' } = {}) {
  const conns = new Set();
  const server = createServer((sock) => {
    conns.add(sock);
    sock.setEncoding('latin1');
    let buf = '';
    let dataServer = null;
    let dataSock = null;
    let dataWaiter = null;

    const openDataServer = () => new Promise((res) => {
      dataServer = createServer((ds) => {
        dataSock = ds;
        if (dataWaiter) { dataWaiter(ds); dataWaiter = null; }
      });
      dataServer.listen(0, '127.0.0.1', () => res(dataServer.address().port));
    });
    const waitData = () => (dataSock ? Promise.resolve(dataSock) : new Promise((res) => { dataWaiter = res; }));
    const serveData = async (payload) => {
      sock.write('150 opening data connection\r\n');
      const ds = await waitData();
      ds.end(payload);
      dataSock = null;
      try { dataServer.close(); } catch {}
      sock.write('226 transfer complete\r\n');
    };

    sock.write('220 fake ettore ftp ready\r\n');
    sock.on('error', () => {});
    sock.on('close', () => conns.delete(sock));
    sock.on('data', async (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = line.split(' ')[0].toUpperCase();
        const arg = line.slice(cmd.length + 1);
        if (cmd === 'USER') sock.write('331 password required\r\n');
        else if (cmd === 'PASS') sock.write(arg === password ? '230 logged in\r\n' : '530 login incorrect\r\n');
        else if (cmd === 'TYPE') sock.write('200 type set\r\n');
        else if (cmd === 'FEAT') sock.write('211-Features:\r\n MLSD\r\n EPSV\r\n211 End\r\n');
        else if (cmd === 'EPSV') { const port = await openDataServer(); sock.write(`229 Entering Extended Passive Mode (|||${port}|)\r\n`); }
        else if (cmd === 'MLSD') await serveData('type=file;size=48;modify=20240131091300; BOLLE.EDI\r\n');
        else if (cmd === 'RETR') {
          if (arg.endsWith('BOLLE.EDI')) await serveData(FILE_BODY);
          else { sock.write('550 no such file\r\n'); try { dataServer.close(); } catch {} }
        } else if (cmd === 'SIZE') sock.write(`213 ${FILE_BODY.length}\r\n`);
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('502 not implemented\r\n');
      }
    });
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => res({
      port: server.address().port,
      close: () => { for (const c of conns) c.destroy(); server.close(); },
    }));
  });
}

test('edi-ftp: the client logs in, lists with MLSD, and downloads a file', async () => {
  const { _internal } = await loadPlugin();
  const srv = await startFakeFtp();
  try {
    const spec = _internal.buildSpec({ url: `ftp://edi@127.0.0.1:${srv.port}/out`, password: 'segreto' });
    const client = new _internal.FtpClient(spec);
    await client.connect(null);

    const entries = await client.list('/out');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'BOLLE.EDI');
    assert.equal(entries[0].size, 48);

    const buf = await client.download('/out/BOLLE.EDI');
    assert.equal(buf.toString('latin1'), FILE_BODY);
    assert.equal(await client.size('/out/BOLLE.EDI'), FILE_BODY.length);
    await client.close();
  } finally {
    srv.close();
  }
});

test('edi-ftp: a wrong password fails at login, a missing file fails at RETR', async () => {
  const { _internal } = await loadPlugin();
  const srv = await startFakeFtp();
  try {
    const bad = new _internal.FtpClient(_internal.buildSpec({ url: `ftp://edi@127.0.0.1:${srv.port}/`, password: 'sbagliata' }));
    await assert.rejects(() => bad.connect(null), /PASS failed: 530/);
    await bad.close();

    const ok = new _internal.FtpClient(_internal.buildSpec({ url: `ftp://edi@127.0.0.1:${srv.port}/out`, password: 'segreto' }));
    await ok.connect(null);
    await assert.rejects(() => ok.download('/out/MANCANTE.EDI'), /550/);
    await ok.close();
  } finally {
    srv.close();
  }
});

test('edi-ftp: a transfer over maxBytes is cut off, not buffered', async () => {
  const { _internal } = await loadPlugin();
  const srv = await startFakeFtp();
  try {
    const client = new _internal.FtpClient(_internal.buildSpec({ url: `ftp://edi@127.0.0.1:${srv.port}/out`, password: 'segreto' }));
    await client.connect(null);
    await assert.rejects(() => client.download('/out/BOLLE.EDI', { maxBytes: 8 }), /exceeds maxBytes/);
    await client.close();
  } finally {
    srv.close();
  }
});

// ── layouts ───────────────────────────────────────────────────────────────

const FIXED_LAYOUT = {
  name: 'tracciato-test',
  type: 'fixed',
  base: 1,
  recordType: { start: 1, length: 2 },
  records: {
    '01': {
      name: 'testata',
      fields: [
        { name: 'mittente', start: 3, length: 8 },
        { name: 'data', start: 12, length: 8, type: 'date', format: 'YYYYMMDD' },
      ],
    },
    '02': {
      name: 'riga',
      fields: [
        { name: 'articolo', start: 3, length: 8 },
        { name: 'importo', start: 12, length: 12, type: 'decimal', decimals: 2 },
      ],
    },
  },
};

test('edi-ftp: a fixed-width file parses per record type, with 1-based columns', async () => {
  const { _internal } = await loadPlugin();
  const text = '01ACME0001 20240131\n02RIGA0001 000000012345\n02RIGA0002 000000000099\n';
  const res = _internal.parseWithLayout(text, FIXED_LAYOUT);

  assert.equal(res.stats.matched, 3);
  assert.equal(res.stats.errors, 0);
  assert.deepEqual(res.stats.byType, { '01': 1, '02': 2 });
  assert.equal(res.records[0]._type, '01');
  assert.equal(res.records[0].mittente, 'ACME0001');
  assert.equal(res.records[0].data, '2024-01-31');
  // Implied decimal point: 000000012345 with decimals: 2 is 123.45, not 12345.
  assert.equal(res.records[1].importo, 123.45);
  assert.equal(res.records[2].importo, 0.99);
});

test('edi-ftp: base decides whether column numbers are 1-based or 0-based', async () => {
  const { _internal } = await loadPlugin();
  const text = '01ACME0001 20240131\n';
  const fields = [{ name: 'mittente', start: 3, length: 8 }];
  const asOne = _internal.parseWithLayout(text, { type: 'fixed', base: 1, fields }).records[0];
  const asZero = _internal.parseWithLayout(text, { type: 'fixed', base: 0, fields }).records[0];
  // The same "start: 3" reads two different fields. Nothing errors either
  // way — this is exactly the mistake that ships silently, so the layout has
  // to say which convention it was written in.
  assert.equal(asOne.mittente, 'ACME0001');
  assert.equal(asZero.mittente, 'CME0001');
});

test('edi-ftp: an unknown record type is an error on that line, not a failed parse', async () => {
  const { _internal } = await loadPlugin();
  const res = _internal.parseWithLayout('01ACME0001 20240131\n99IGNOTO\n', FIXED_LAYOUT);
  assert.equal(res.stats.matched, 1);
  assert.equal(res.stats.errors, 1);
  assert.match(res.errors[0].error, /no record definition for type "99"/);
});

test('edi-ftp: delimited layouts split on the delimiter and honour quotes', async () => {
  const { _internal } = await loadPlugin();
  const layout = {
    name: 'csv-test',
    type: 'delimited',
    delimiter: ';',
    header: true,
    records: {
      '*': {
        name: 'riga',
        fields: [
          { name: 'codice', index: 0 },
          { name: 'descrizione', index: 1 },
          { name: 'quantita', index: 2, type: 'int' },
          { name: 'prezzo', index: 3, type: 'decimal' },
        ],
      },
    },
  };
  const text = 'codice;descrizione;qta;prezzo\nA01;"TESSUTO; misto";12;1.234,56\n';
  const res = _internal.parseWithLayout(text, layout);
  assert.equal(res.records.length, 1);
  assert.equal(res.records[0].descrizione, 'TESSUTO; misto');
  assert.equal(res.records[0].quantita, 12);
  // Italian thousands/decimal convention: 1.234,56 is one thousand two hundred.
  assert.equal(res.records[0].prezzo, 1234.56);
});

test('edi-ftp: dates that do not match the declared format come back null, never guessed', async () => {
  const { _internal } = await loadPlugin();
  assert.equal(_internal.parseDateField('20240131', 'YYYYMMDD'), '2024-01-31');
  assert.equal(_internal.parseDateField('31012024', 'DDMMYYYY'), '2024-01-31');
  assert.equal(_internal.parseDateField('310124', 'DDMMYY'), '2024-01-31');
  assert.equal(_internal.parseDateField('00000000', 'YYYYMMDD'), null);
  assert.equal(_internal.parseDateField('20241332', 'YYYYMMDD'), null);
  assert.equal(_internal.parseDateField('31/01/24', 'DDMMYY'), null);
});

test('edi-ftp: normalizeLayout rejects layouts that would silently misread data', async () => {
  const { _internal } = await loadPlugin();
  assert.throws(() => _internal.normalizeLayout({ type: 'boh', records: {} }), /must be "fixed" or "delimited"/);
  assert.throws(() => _internal.normalizeLayout({ type: 'fixed', fields: [{ start: 1, length: 2 }] }), /needs a "name"/);
  assert.throws(() => _internal.normalizeLayout({ type: 'fixed', fields: [{ name: 'a', start: 1 }] }), /needs a "length"/);
  assert.throws(() => _internal.normalizeLayout({ type: 'fixed', fields: [{ name: 'a', start: 1, length: 2, type: 'money' }] }), /use one of/);
  assert.throws(() => _internal.normalizeLayout({ type: 'delimited', fields: [{ name: 'a' }] }), /needs an "index"/);
  assert.throws(() => _internal.normalizeLayout({ type: 'fixed', base: 1, fields: [{ name: 'a', start: 0, length: 2 }] }), /starts before column 1/);
});

// ── inspector ─────────────────────────────────────────────────────────────

test('edi-ftp: the inspector recognises a fixed-width tracciato and drafts a layout', async () => {
  const { _internal } = await loadPlugin();
  const lines = [
    '01ACME0001 20240131 MILANO    ',
    '01BETA0002 20240201 ROMA      ',
    '01GAMMA003 20240202 NAPOLI    ',
  ];
  const res = _internal.inspectText(lines.join('\n'));
  assert.equal(res.looksLike, 'fixed');
  assert.equal(res.lineLength.uniform, true);
  assert.ok(res.columns.length >= 3);
  // The blank column between fields is what reveals the boundary.
  assert.equal(res.columns[0].start, 1);
  assert.equal(res.draftLayout.type, 'fixed');
  assert.equal(res.draftLayout.base, 1);
  const dateCol = res.columns.find((c) => c.guessedType === 'date');
  assert.ok(dateCol, 'the 8-digit column should be recognised as a date');
});

test('edi-ftp: the inspector recognises a delimited file and counts its fields', async () => {
  const { _internal } = await loadPlugin();
  const res = _internal.inspectText('A01;TESSUTO;12;1234\nA02;COTONE;3;99\nA03;LANA;7;450\n');
  assert.equal(res.looksLike, 'delimited');
  assert.equal(res.delimiters[0].char, ';');
  assert.equal(res.delimiters[0].fieldsPerLine, 4);
  assert.equal(res.draftLayout.type, 'delimited');
  assert.equal(res.draftLayout.records['*'].fields.length, 4);
});

test('edi-ftp: the inspector says so when it cannot tell, instead of guessing', async () => {
  const { _internal } = await loadPlugin();
  const res = _internal.inspectText('una riga corta\nun altra riga molto piu lunga della precedente\nx\n');
  assert.equal(res.looksLike, 'unclear');
  assert.equal(res.draftLayout, null);
  assert.match(res.note, /multi-record|inspect one record type/);
});

// ── workspace confinement ─────────────────────────────────────────────────

test('edi-ftp: local paths cannot escape the workspace', async () => {
  const { _internal } = await loadPlugin();
  const dir = mkdtempSync(join(tmpdir(), 'edi-ftp-'));
  try {
    assert.equal(_internal.resolveLocal('edi-in/A.EDI', dir), join(dir, 'edi-in/A.EDI'));
    assert.throws(() => _internal.resolveLocal('../fuori.edi', dir), /outside the workspace/);
    assert.throws(() => _internal.resolveLocal('/etc/passwd', dir), /outside the workspace/);
    // A remote name is server-controlled input: it must never become a path.
    assert.equal(_internal.resolveLocal(join('edi-in', 'x.edi'), dir), join(dir, 'edi-in', 'x.edi'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edi-ftp: edi_parse reads a local file and can write the full result out', async () => {
  const mod = await loadPlugin();
  const dir = mkdtempSync(join(tmpdir(), 'edi-ftp-'));
  try {
    writeFileSync(join(dir, 'BOLLE.EDI'), '01ACME0001 20240131\n02RIGA0001 000000012345\n', 'latin1');
    const res = await mod.tools.edi_parse.handler(
      { file: 'BOLLE.EDI', layoutInline: FIXED_LAYOUT, out: 'parsed.json' },
      { workspace: dir, signal: null },
    );
    assert.equal(res.stats.matched, 2);
    assert.equal(res.records.length, 2);
    const written = JSON.parse(readFileSync(join(dir, 'parsed.json'), 'utf-8'));
    assert.equal(written.length, 2);
    assert.equal(written[1].importo, 123.45);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edi-ftp: edi_parse without a layout explains what to pass instead of throwing', async () => {
  const mod = await loadPlugin();
  const out = await mod.tools.edi_parse.handler({ file: 'x.edi' }, { workspace: tmpdir(), signal: null });
  assert.match(out, /pass "layout".*or "layoutInline"/s);
});

// ── short-line policy ─────────────────────────────────────────────────────

// The sender stripped the trailing spaces: "data" is missing outright on the
// second line and cut in half on the third.
const SHORT_TEXT = [
  '01ACME0001 20240131',
  '01BETA0002',
  '01GAMMA003 2024',
  '',
].join('\n');

const SHORT_LAYOUT = {
  name: 'short-test',
  type: 'fixed',
  base: 1,
  records: {
    '*': {
      name: 'testata',
      fields: [
        { name: 'mittente', start: 3, length: 8 },
        { name: 'data', start: 12, length: 8, type: 'date', format: 'YYYYMMDD' },
      ],
    },
  },
};

test('edi-ftp: byType is the default — text survives truncation, a date does not', async () => {
  const { _internal } = await loadPlugin();
  const res = _internal.parseWithLayout(SHORT_TEXT, SHORT_LAYOUT);
  assert.equal(res.records.length, 3);
  assert.equal(res.records[0].data, '2024-01-31');
  // Missing and half-present both become null: half a date is a wrong date.
  assert.equal(res.records[1].data, null);
  assert.equal(res.records[2].data, null);
  assert.equal(res.stats.errors, 2);
  assert.match(res.errors[0].error, /is missing/);
  assert.match(res.errors[1].error, /holds 4 of 8 characters/);
  // The text field on the same short lines is padded without complaint.
  assert.equal(res.records[1].mittente, 'BETA0002');
});

test('edi-ftp: onShortField "pad" reads short lines silently', async () => {
  const { _internal } = await loadPlugin();
  const res = _internal.parseWithLayout(SHORT_TEXT, { ...SHORT_LAYOUT, onShortField: 'pad' });
  assert.equal(res.stats.errors, 0);
  assert.equal(res.records[1].data, null);   // padding leaves nothing to parse
  assert.equal(res.records[2].data, null);   // "2024    " is not a date either
});

test('edi-ftp: onShortField "report" keeps the value and still flags the line', async () => {
  const { _internal } = await loadPlugin();
  const layout = {
    ...SHORT_LAYOUT,
    onShortField: 'report',
    records: { '*': { name: 'testata', fields: [{ name: 'citta', start: 3, length: 12 }] } },
  };
  const res = _internal.parseWithLayout('01MILANO\n', layout);
  assert.equal(res.records[0].citta, 'MILANO');
  assert.equal(res.stats.errors, 1);
  assert.match(res.errors[0].error, /holds 6 of 12 characters/);
});

test('edi-ftp: onShortField "reject" nulls every short field, text included', async () => {
  const { _internal } = await loadPlugin();
  const res = _internal.parseWithLayout(SHORT_TEXT, { ...SHORT_LAYOUT, onShortField: 'reject' });
  assert.equal(res.records[1].mittente, 'BETA0002');   // this one is complete
  assert.equal(res.records[1].data, null);
  assert.equal(res.stats.errors, 2);
});

test('edi-ftp: a field can override the layout policy', async () => {
  const { _internal } = await loadPlugin();
  const layout = {
    ...SHORT_LAYOUT,
    onShortField: 'reject',
    records: {
      '*': {
        name: 'testata',
        fields: [
          { name: 'mittente', start: 3, length: 8 },
          // This one is known to be optional in the tracciato.
          { name: 'note', start: 12, length: 20, onShort: 'pad' },
        ],
      },
    },
  };
  const res = _internal.parseWithLayout('01ACME0001 URGENTE\n', layout);
  assert.equal(res.records[0].note, 'URGENTE');
  assert.equal(res.stats.errors, 0);
});

test('edi-ftp: an unknown policy name is rejected at load time, not at parse time', async () => {
  const { _internal } = await loadPlugin();
  assert.throws(
    () => _internal.normalizeLayout({ ...SHORT_LAYOUT, onShortField: 'ignora' }),
    /onShortField must be one of/,
  );
  assert.throws(
    () => _internal.normalizeLayout({ type: 'fixed', fields: [{ name: 'a', start: 1, length: 2, onShort: 'boh' }] }),
    /onShort must be one of/,
  );
});

test('edi-ftp: edi_parse can override the saved layout for one call', async () => {
  const mod = await loadPlugin();
  const dir = mkdtempSync(join(tmpdir(), 'edi-ftp-'));
  try {
    writeFileSync(join(dir, 'CORTO.EDI'), SHORT_TEXT, 'latin1');
    const strict = await mod.tools.edi_parse.handler(
      { file: 'CORTO.EDI', layoutInline: SHORT_LAYOUT },
      { workspace: dir, signal: null },
    );
    const quiet = await mod.tools.edi_parse.handler(
      { file: 'CORTO.EDI', layoutInline: SHORT_LAYOUT, onShortField: 'pad' },
      { workspace: dir, signal: null },
    );
    assert.equal(strict.stats.errors, 2);
    assert.equal(quiet.stats.errors, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
