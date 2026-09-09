// edi-ftp plugin — read EDI files off an FTP / FTPS / SFTP server and turn a
// fixed-width or delimited "tracciato" into structured records.
//
// The workflow this is built around:
//
//   1. /edi profile add prod ftps://user@edi.example.com/out   (once)
//   2. edi_list      — what is on the server right now
//   3. edi_read      — look at the first lines of a file, decide what it is
//   4. edi_inspect   — analyse an unknown tracciato and get a DRAFT layout
//   5. edi_layout_save — keep the corrected layout under a name
//   6. edi_parse     — file + layout → records (JSON / CSV / table)
//
// Transports
//   ftp://   plain FTP, passive mode
//   ftps://  FTP over TLS: explicit (AUTH TLS on port 21, the default) or
//            implicit (port 990, or `implicit: true`)
//   sftp://  SFTP over SSH — needs the optional `ssh2` dependency
//
// The FTP/FTPS client is implemented here on node:net + node:tls rather than
// pulled from npm: FTP is a small line protocol, and the parts that actually
// bite (passive-mode host substitution, TLS session reuse on the data
// channel, multiline responses) are the parts a dependency would hide.
//
// Nothing here trusts the server's own numbers: a transfer is capped by
// `maxBytes`, every socket carries a timeout, and the passive-mode data
// connection goes back to the host we dialled, never to the address the
// server advertises.

import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync,
  readdirSync, unlinkSync, statSync,
} from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join, dirname, resolve as resolvePath, basename, isAbsolute } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync, createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const requirePeer = createRequire(import.meta.url);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;   // 10 MB — EDI files are small
const DEFAULT_ENCODING = 'latin1';            // never throws, preserves bytes 1:1
const PREVIEW_LINES = 20;

// ─────────────────────────────────────────────────────────────────────────
// Config directory, profile store, and the password-at-rest scheme
// ─────────────────────────────────────────────────────────────────────────

const CONFIG_DIR = () => process.env.ETTORE_CONFIG_DIR || join(homedir(), '.config', 'ettore');
const PLUGIN_DIR = () => join(CONFIG_DIR(), 'edi-ftp');
const PROFILES_FILE = () => join(PLUGIN_DIR(), 'profiles.json');
const LAYOUTS_DIR = () => join(PLUGIN_DIR(), 'layouts');

// Same scheme as ETTORE's own studio secret store: AES-256-GCM under a key
// derived from stable machine material, so a stored password survives a
// restart without a master prompt. This is OBFUSCATION, not a password
// manager — anyone holding both the file and this source can re-derive the
// key. It buys one thing: `cat ~/.config/ettore/edi-ftp/profiles.json` is
// not a credential dump. Prefer `passwordEnv` for anything that matters.
const FINGERPRINT = 'ettore-cli/edi-ftp/profile-store/v1';
const PBKDF2_ITERS = 200_000;

let keyCache = null; // { saltHex, key }

function deriveKey(saltHex) {
  if (keyCache && keyCache.saltHex === saltHex) return keyCache.key;
  const material = `${hostname()}|${userInfo().username || ''}|${FINGERPRINT}`;
  const key = pbkdf2Sync(Buffer.from(material, 'utf-8'), Buffer.from(saltHex, 'hex'), PBKDF2_ITERS, 32, 'sha256');
  keyCache = { saltHex, key };
  return key;
}

function encryptSecret(saltHex, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(saltHex), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf-8'), cipher.final()]);
  return { iv: iv.toString('hex'), ct: ct.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

function decryptSecret(saltHex, box) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(saltHex), Buffer.from(box.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(box.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(box.ct, 'hex')), decipher.final()]).toString('utf-8');
  } catch {
    // Wrong machine, rotated hostname, or a tampered file. A stored password
    // that cannot be decrypted is a missing password, not a crash.
    return null;
  }
}

function ensurePluginDir() {
  const dir = PLUGIN_DIR();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else { try { chmodSync(dir, 0o700); } catch {} }
  return dir;
}

function readStore() {
  const file = PROFILES_FILE();
  if (!existsSync(file)) return { v: 1, salt: randomBytes(16).toString('hex'), profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return {
      v: 1,
      salt: typeof parsed.salt === 'string' && parsed.salt ? parsed.salt : randomBytes(16).toString('hex'),
      profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
    };
  } catch (err) {
    throw new Error(`profile store at ${file} is unreadable: ${err.message}`);
  }
}

function writeStore(store) {
  ensurePluginDir();
  const file = PROFILES_FILE();
  writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}

// A profile as the rest of the plugin sees it: connection fields plus a
// resolved password. `password` is never returned to the model — only the
// connection layer reads it.
function loadProfile(name) {
  const store = readStore();
  const raw = store.profiles[name];
  if (!raw) {
    const known = Object.keys(store.profiles);
    throw new Error(
      `no profile named "${name}". ${known.length ? `Known: ${known.join(', ')}` : 'Create one with edi_profile_save.'}`,
    );
  }
  return { ...raw, name, password: resolvePassword(raw, store.salt) };
}

// Password resolution order, most explicit first:
//   1. the env var the profile names        (passwordEnv)
//   2. the encrypted blob stored on disk    (secret)
//   3. ETTORE_EDI_PASSWORD                  (one-off, whole-process)
// A profile with none of these is an anonymous / key-only login.
function resolvePassword(raw, saltHex) {
  if (raw.passwordEnv && process.env[raw.passwordEnv]) return process.env[raw.passwordEnv];
  if (raw.secret && raw.secret.ct) {
    const plain = decryptSecret(saltHex, raw.secret);
    if (plain != null) return plain;
  }
  if (process.env.ETTORE_EDI_PASSWORD) return process.env.ETTORE_EDI_PASSWORD;
  return '';
}

// Redact anything that looks like the live password before a message goes
// anywhere. Server error text quotes the command it rejected, and `PASS …`
// in a transcript is the one failure mode worth engineering against.
function redact(text, password) {
  let out = String(text ?? '');
  if (password) out = out.split(password).join('********');
  return out.replace(/(\bPASS\s+)\S+/gi, '$1********').replace(/(:\/\/[^:@\s]+):[^@\s]+@/g, '$1:********@');
}

// ─────────────────────────────────────────────────────────────────────────
// Connection targets
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_PORTS = { ftp: 21, ftps: 21, 'ftps-implicit': 990, sftp: 22 };

// Build a connection spec from either a saved profile name or a URL, with
// per-call overrides on top. Exactly one of `profile` / `url` is required.
function buildSpec({ profile, url, ...over } = {}) {
  let base;
  if (profile) {
    base = loadProfile(profile);
  } else if (url) {
    base = specFromUrl(url);
  } else {
    throw new Error('either "profile" or "url" is required (e.g. url: "ftps://user@host/out")');
  }

  const spec = {
    protocol: String(over.protocol || base.protocol || 'ftp').toLowerCase(),
    host: over.host || base.host,
    port: over.port || base.port || null,
    user: over.user || base.user || 'anonymous',
    password: over.password || base.password || '',
    implicit: over.implicit ?? base.implicit ?? false,
    insecure: over.insecure ?? base.insecure ?? false,
    baseDir: over.baseDir || base.baseDir || '',
    encoding: over.encoding || base.encoding || DEFAULT_ENCODING,
    privateKeyPath: over.privateKeyPath || base.privateKeyPath || '',
    passphrase: over.passphrase || base.passphrase || '',
    timeoutMs: Number(over.timeoutMs || base.timeoutMs || DEFAULT_TIMEOUT_MS),
    label: profile ? `profile "${profile}"` : `${base.protocol}://${base.host}`,
  };
  if (!spec.host) throw new Error('no host in the connection target');
  if (!['ftp', 'ftps', 'sftp'].includes(spec.protocol)) {
    throw new Error(`unsupported protocol "${spec.protocol}" — use ftp, ftps or sftp`);
  }
  if (!spec.port) {
    spec.port = spec.protocol === 'ftps' && spec.implicit ? DEFAULT_PORTS['ftps-implicit'] : DEFAULT_PORTS[spec.protocol];
  }
  return spec;
}

function specFromUrl(raw) {
  let u;
  try { u = new URL(String(raw)); }
  catch { throw new Error(`not a valid URL: ${raw}`); }
  const protocol = u.protocol.replace(/:$/, '').toLowerCase();
  return {
    protocol,
    host: u.hostname,
    port: u.port ? Number(u.port) : null,
    user: u.username ? decodeURIComponent(u.username) : 'anonymous',
    // A password in the URL works, but it travels through the conversation
    // and the shell history. The profile store exists so it does not have to.
    password: u.password ? decodeURIComponent(u.password) : '',
    // Port 990 is implicit FTPS by convention; anything else is explicit.
    implicit: protocol === 'ftps' && Number(u.port) === 990,
    baseDir: u.pathname && u.pathname !== '/' ? decodeURIComponent(u.pathname) : '',
  };
}

// Join the profile's base directory with a caller-supplied path. An absolute
// path wins outright — the base is a convenience, not a jail (the server's
// own permissions are the jail).
function remotePath(spec, path) {
  const p = String(path ?? '').trim();
  if (!p || p === '.') return spec.baseDir || '.';
  if (p.startsWith('/')) return p;
  if (!spec.baseDir) return p;
  return `${spec.baseDir.replace(/\/+$/, '')}/${p}`;
}

// ─────────────────────────────────────────────────────────────────────────
// FTP / FTPS client
// ─────────────────────────────────────────────────────────────────────────

class FtpError extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = 'FtpError';
    this.code = code;
  }
}

// Pull one complete server response off the front of the buffer.
//
// FTP replies are either `250 text` or a multiline block that opens with
// `250-` and closes with a line starting `250 `. Reading a fixed number of
// lines gets this wrong on every server that greets you with a banner, so
// the terminator is matched explicitly.
function extractResponse(buf) {
  const m = /^(\d{3})([ -])/.exec(buf);
  if (!m) {
    // Junk ahead of a status line (stray CRLF from some servers). Drop the
    // line rather than deadlock waiting for a code that will never parse.
    const nl = buf.indexOf('\n');
    if (nl === -1) return null;
    return { skip: true, rest: buf.slice(nl + 1) };
  }
  if (m[2] === ' ') {
    const nl = buf.indexOf('\n');
    if (nl === -1) return null;
    return { code: Number(m[1]), text: buf.slice(0, nl).replace(/\r$/, ''), rest: buf.slice(nl + 1) };
  }
  const term = new RegExp(`(?:^|\\n)${m[1]} [^\\n]*(?:\\n|$)`);
  const t = term.exec(buf);
  if (!t) return null;
  const end = t.index + t[0].length;
  return { code: Number(m[1]), text: buf.slice(0, end).replace(/\r?\n$/, ''), rest: buf.slice(end) };
}

class FtpClient {
  constructor(spec) {
    this._spec = spec;
    this._control = null;
    this._buf = '';
    this._responses = [];
    this._waiters = [];
    this._closing = false;
    this._protP = false;
    this._features = new Set();
    this._openSockets = new Set();
  }

  get encoding() { return this._spec.encoding; }

  async connect(signal) {
    const { host, port, protocol, implicit, insecure, timeoutMs } = this._spec;
    const useImplicitTls = protocol === 'ftps' && implicit;
    const sock = useImplicitTls
      ? tlsConnect({ host, port, servername: host, rejectUnauthorized: !insecure })
      : netConnect({ host, port });
    this._track(sock);
    await waitForEvent(sock, useImplicitTls ? 'secureConnect' : 'connect', timeoutMs, signal, `connect to ${host}:${port}`);
    sock.setTimeout(timeoutMs);
    this._attachControl(sock);

    const greeting = await this._read();
    expectCode(greeting, [220], 'server greeting');

    if (protocol === 'ftps' && !useImplicitTls) await this._upgradeToTls();
    await this._login();

    // Binary mode: an EDI file with a stray 0x0D handled as "text" comes back
    // with its line endings rewritten, which silently shifts every offset in
    // a fixed-width record.
    expectCode(await this._cmd('TYPE I'), [200], 'TYPE I');
    await this._loadFeatures();
    return this;
  }

  async _upgradeToTls() {
    expectCode(await this._cmd('AUTH TLS'), [234, 334], 'AUTH TLS');
    const plain = this._control;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    plain.removeAllListeners('timeout');
    const secure = tlsConnect({
      socket: plain,
      servername: this._spec.host,
      rejectUnauthorized: !this._spec.insecure,
    });
    this._track(secure);
    await waitForEvent(secure, 'secureConnect', this._spec.timeoutMs, null, 'TLS handshake');
    secure.setTimeout(this._spec.timeoutMs);
    this._attachControl(secure);
    // PBSZ 0 then PROT P is what turns the data channel private too. Without
    // PROT P the login is encrypted and the file itself crosses in the clear.
    expectCode(await this._cmd('PBSZ 0'), [200], 'PBSZ 0');
    expectCode(await this._cmd('PROT P'), [200], 'PROT P');
    this._protP = true;
  }

  async _login() {
    const { user, password } = this._spec;
    const userRes = await this._cmd(`USER ${user}`);
    if (userRes.code === 331 || userRes.code === 332) {
      const passRes = await this._cmd(`PASS ${password}`, { redactArg: true });
      expectCode(passRes, [230, 202], 'PASS');
    } else {
      expectCode(userRes, [230, 202], 'USER');
    }
  }

  async _loadFeatures() {
    try {
      const res = await this._cmd('FEAT');
      if (res.code !== 211) return;
      for (const line of res.text.split(/\r?\n/).slice(1)) {
        const feat = line.trim().split(/\s+/)[0];
        if (feat && !/^\d{3}/.test(feat)) this._features.add(feat.toUpperCase());
      }
    } catch {
      // FEAT is optional (RFC 2389). A server without it just means no MLSD.
    }
  }

  _attachControl(sock) {
    this._control = sock;
    sock.on('data', (chunk) => {
      this._buf += chunk.toString('latin1');
      this._drain();
    });
    sock.on('error', (err) => this._fail(err));
    sock.on('timeout', () => this._fail(new FtpError(`control connection idle for ${this._spec.timeoutMs}ms`)));
    sock.on('close', () => {
      if (!this._closing) this._fail(new FtpError('control connection closed by the server'));
    });
  }

  _drain() {
    for (;;) {
      const res = extractResponse(this._buf);
      if (!res) return;
      this._buf = res.rest;
      if (res.skip) continue;
      const waiter = this._waiters.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(res); }
      else this._responses.push(res);   // unsolicited (e.g. a 421 timeout notice)
    }
  }

  _fail(err) {
    const e = err instanceof FtpError ? err : new FtpError(redact(err?.message || String(err), this._spec.password));
    const waiters = this._waiters.splice(0);
    for (const w of waiters) { clearTimeout(w.timer); w.reject(e); }
    this._lastError = e;
  }

  _read(timeoutMs = this._spec.timeoutMs) {
    if (this._responses.length) return Promise.resolve(this._responses.shift());
    if (this._lastError) return Promise.reject(this._lastError);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this._waiters.indexOf(waiter);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new FtpError(`timed out after ${timeoutMs}ms waiting for a server reply`));
      }, timeoutMs);
      this._waiters.push(waiter);
    });
  }

  async _cmd(command, { redactArg = false } = {}) {
    if (!this._control || this._control.destroyed) throw new FtpError('not connected');
    this._control.write(`${command}\r\n`);
    try {
      return await this._read();
    } catch (err) {
      const shown = redactArg ? command.split(/\s+/)[0] : command;
      throw new FtpError(`${shown}: ${err.message}`, { code: err.code });
    }
  }

  _track(sock) {
    this._openSockets.add(sock);
    sock.once('close', () => this._openSockets.delete(sock));
  }

  // Open a passive-mode data connection. EPSV first (one port, IPv6-safe),
  // PASV as the fallback for servers that predate it.
  async _openData(signal) {
    let port = null;
    const epsv = await this._cmd('EPSV');
    if (epsv.code === 229) {
      const m = /\((.)\1\1(\d+)\1\)/.exec(epsv.text);
      if (m) port = Number(m[2]);
    }
    if (!port) {
      const pasv = await this._cmd('PASV');
      expectCode(pasv, [227], 'PASV');
      const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(pasv.text);
      if (!m) throw new FtpError(`cannot parse the passive-mode reply: ${pasv.text}`);
      port = Number(m[5]) * 256 + Number(m[6]);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new FtpError(`server asked for an impossible data port: ${port}`);
    }

    // Deliberately the control host, not the address in the reply. A server
    // behind NAT hands out an unroutable one, and a hostile server hands out
    // somebody else's — this is the standard defence against both.
    const raw = netConnect({ host: this._spec.host, port });
    this._track(raw);
    await waitForEvent(raw, 'connect', this._spec.timeoutMs, signal, `data connection to port ${port}`);
    raw.setTimeout(this._spec.timeoutMs);
    if (!this._protP) return raw;

    // Reusing the control connection's TLS session is not an optimisation:
    // vsftpd and FileZilla Server both refuse a data connection that cannot
    // prove it belongs to the same session.
    const secure = tlsConnect({
      socket: raw,
      servername: this._spec.host,
      rejectUnauthorized: !this._spec.insecure,
      session: typeof this._control.getSession === 'function' ? this._control.getSession() : undefined,
    });
    this._track(secure);
    await waitForEvent(secure, 'secureConnect', this._spec.timeoutMs, signal, 'data channel TLS handshake');
    secure.setTimeout(this._spec.timeoutMs);
    return secure;
  }

  // Run a command whose payload arrives on the data connection.
  async _transfer(command, { maxBytes = DEFAULT_MAX_BYTES, signal = null } = {}) {
    const data = await this._openData(signal);
    const collected = collectStream(data, { maxBytes, timeoutMs: this._spec.timeoutMs, signal });
    const start = await this._cmd(command);
    if (![125, 150].includes(start.code)) {
      data.destroy();
      await collected.catch(() => {});
      throw new FtpError(`${command} rejected: ${start.text}`, { code: start.code });
    }
    let buf;
    try {
      buf = await collected;
    } catch (err) {
      // Drain the completion reply so the control channel stays in sync for
      // the next command instead of returning a stale code.
      this._read(2000).catch(() => {});
      throw err;
    }
    const done = await this._read();
    expectCode(done, [226, 250], command.split(/\s+/)[0]);
    return buf;
  }

  async list(path, { signal = null } = {}) {
    const target = String(path || '.');
    // MLSD is the only listing format with a specification behind it. LIST
    // output is whatever the server's `ls` felt like printing, so it is the
    // fallback, not the first choice.
    if (this._features.has('MLSD')) {
      try {
        const buf = await this._transfer(`MLSD ${target}`, { signal });
        return parseMlsd(buf.toString(this.encoding));
      } catch (err) {
        if (!/rejected/.test(err.message)) throw err;
      }
    }
    const buf = await this._transfer(`LIST ${target}`, { signal });
    return parseListing(buf.toString(this.encoding));
  }

  async download(path, { maxBytes = DEFAULT_MAX_BYTES, signal = null } = {}) {
    return this._transfer(`RETR ${path}`, { maxBytes, signal });
  }

  async size(path) {
    try {
      const res = await this._cmd(`SIZE ${path}`);
      if (res.code === 213) return Number(res.text.slice(3).trim()) || null;
    } catch {}
    return null;
  }

  async close() {
    this._closing = true;
    try { if (this._control && !this._control.destroyed) this._control.write('QUIT\r\n'); } catch {}
    for (const sock of this._openSockets) { try { sock.destroy(); } catch {} }
    this._openSockets.clear();
    this._control = null;
  }
}

function expectCode(res, codes, what) {
  if (!codes.includes(res.code)) {
    throw new FtpError(`${what} failed: ${res.text}`, { code: res.code });
  }
  return res;
}

// ─────────────────────────────────────────────────────────────────────────
// Socket helpers
// ─────────────────────────────────────────────────────────────────────────

function waitForEvent(emitter, event, timeoutMs, signal, what) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      emitter.removeListener(event, onEvent);
      emitter.removeListener('error', onError);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onEvent = () => { cleanup(); resolve(emitter); };
    const onError = (err) => { cleanup(); reject(new FtpError(`${what} failed: ${err.message}`)); };
    const onAbort = () => { cleanup(); emitter.destroy(); reject(new FtpError(`${what} cancelled`)); };
    const timer = setTimeout(() => {
      cleanup();
      emitter.destroy();
      reject(new FtpError(`${what} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    emitter.once(event, onEvent);
    emitter.once('error', onError);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// Read a data socket to the end, refusing to buffer more than `maxBytes`.
// The cap is enforced as bytes arrive: a server that answers a 4 KB EDI file
// with an endless stream is stopped at the cap, not after it has filled the
// heap.
function collectStream(sock, { maxBytes, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(arg);
    };
    const timer = setTimeout(() => {
      sock.destroy();
      finish(reject, new FtpError(`transfer stalled for ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => { sock.destroy(); finish(reject, new FtpError('transfer cancelled')); };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    sock.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        sock.destroy();
        finish(reject, new FtpError(`transfer exceeds maxBytes (${maxBytes}); raise it or fetch a smaller file`));
        return;
      }
      chunks.push(chunk);
      timer.refresh();
    });
    // 'close' as well as 'end': a TLS data channel that is torn down without
    // close_notify never emits 'end', and that is the normal path on several
    // FTPS servers.
    sock.on('end', () => finish(resolve, Buffer.concat(chunks)));
    sock.on('close', () => finish(resolve, Buffer.concat(chunks)));
    sock.on('error', (err) => finish(reject, new FtpError(`transfer failed: ${err.message}`)));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Directory listing parsers
// ─────────────────────────────────────────────────────────────────────────

// MLSD: `type=file;size=1234;modify=20240131120000; NAME`
function parseMlsd(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const sep = line.indexOf('; ');
    if (sep === -1) continue;
    const facts = {};
    for (const pair of line.slice(0, sep).split(';')) {
      const eq = pair.indexOf('=');
      if (eq > 0) facts[pair.slice(0, eq).toLowerCase()] = pair.slice(eq + 1);
    }
    const name = line.slice(sep + 2);
    if (name === '.' || name === '..') continue;
    out.push({
      name,
      type: facts.type === 'dir' || facts.type === 'cdir' || facts.type === 'pdir' ? 'dir' : 'file',
      size: facts.size != null ? Number(facts.size) : null,
      modified: parseMlsdTime(facts.modify),
    });
  }
  return out;
}

function parseMlsdTime(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

const UNIX_LIST_RE = /^([-dl])([rwxstST-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+(?:\d{4}|\d{2}:\d{2}))\s+(.+)$/;
const DOS_LIST_RE = /^(\d{2}-\d{2}-\d{2,4})\s+(\d{2}:\d{2}(?:[AP]M)?)\s+(<DIR>|\d+)\s+(.+)$/i;

// LIST output has no standard. Two dialects cover effectively everything in
// the wild: Unix `ls -l` and the DOS-style listing IIS still emits. Anything
// else falls through as a bare name, which is enough to fetch the file.
function parseListing(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const unix = UNIX_LIST_RE.exec(line);
    if (unix) {
      const name = unix[1] === 'l' ? unix[5].split(' -> ')[0] : unix[5];
      if (name === '.' || name === '..') continue;
      out.push({
        name,
        type: unix[1] === 'd' ? 'dir' : 'file',
        size: Number(unix[3]),
        modified: unix[4],
      });
      continue;
    }
    const dos = DOS_LIST_RE.exec(line);
    if (dos) {
      const isDir = /^<DIR>$/i.test(dos[3]);
      out.push({
        name: dos[4],
        type: isDir ? 'dir' : 'file',
        size: isDir ? null : Number(dos[3]),
        modified: `${dos[1]} ${dos[2]}`,
      });
      continue;
    }
    if (/^total\s+\d+/i.test(line)) continue;
    out.push({ name: line.trim(), type: 'file', size: null, modified: null, unparsed: true });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// SFTP client (optional `ssh2` dependency)
// ─────────────────────────────────────────────────────────────────────────

function loadSsh2() {
  try { return requirePeer('ssh2'); }
  catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND') throw err;
    throw new Error(
      'SFTP needs the optional dependency "ssh2", which is not installed. Run `npm install ssh2` in the ETTORE install directory, or use ftp:// or ftps:// instead.',
    );
  }
}

class SftpClient {
  constructor(spec) {
    this._spec = spec;
    this._conn = null;
    this._sftp = null;
  }

  get encoding() { return this._spec.encoding; }

  async connect(signal) {
    const { Client } = loadSsh2();
    const { host, port, user, password, privateKeyPath, passphrase, timeoutMs } = this._spec;
    const conn = new Client();
    this._conn = conn;

    const config = { host, port, username: user, readyTimeout: timeoutMs };
    if (privateKeyPath) {
      const keyFile = resolvePath(privateKeyPath.replace(/^~(?=\/|$)/, homedir()));
      try { config.privateKey = readFileSync(keyFile); }
      catch (err) { throw new Error(`cannot read the private key at ${keyFile}: ${err.message}`); }
      if (passphrase) config.passphrase = passphrase;
    }
    if (password) config.password = password;
    if (!config.privateKey && !config.password) {
      throw new Error('SFTP needs a password or a privateKeyPath — neither was set on this target');
    }

    await new Promise((resolve, reject) => {
      const onAbort = () => { conn.end(); reject(new Error('SFTP connection cancelled')); };
      conn.once('ready', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); });
      conn.once('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(new Error(redact(`SFTP connection to ${host}:${port} failed: ${err.message}`, password)));
      });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      conn.connect(config);
    });

    this._sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => (err ? reject(new Error(`cannot open an SFTP session: ${err.message}`)) : resolve(sftp)));
    });
    return this;
  }

  async list(path) {
    const dir = String(path || '.');
    const entries = await new Promise((resolve, reject) => {
      this._sftp.readdir(dir, (err, list) => (err ? reject(new Error(`cannot list ${dir}: ${err.message}`)) : resolve(list)));
    });
    return entries
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => ({
        name: e.filename,
        // 0o040000 is S_IFDIR: ssh2 reports POSIX mode bits, not a type flag.
        type: (e.attrs?.mode & 0o170000) === 0o040000 ? 'dir' : 'file',
        size: e.attrs?.size ?? null,
        modified: e.attrs?.mtime ? new Date(e.attrs.mtime * 1000).toISOString() : null,
      }));
  }

  async download(path, { maxBytes = DEFAULT_MAX_BYTES, signal = null } = {}) {
    const stat = await this.stat(path);
    if (stat && stat.size != null && stat.size > maxBytes) {
      throw new Error(`${path} is ${stat.size} bytes, over maxBytes (${maxBytes}); raise it or fetch a smaller file`);
    }
    const stream = this._sftp.createReadStream(path);
    return collectStream(stream, { maxBytes, timeoutMs: this._spec.timeoutMs, signal });
  }

  async stat(path) {
    return new Promise((resolve) => {
      this._sftp.stat(path, (err, attrs) => resolve(err ? null : { size: attrs.size, mtime: attrs.mtime }));
    });
  }

  async size(path) {
    const st = await this.stat(path);
    return st ? st.size : null;
  }

  async close() {
    try { this._conn?.end(); } catch {}
    this._conn = null;
    this._sftp = null;
  }
}

// Open the right client for the target and hand it to `fn`, closing it
// afterwards whether or not `fn` threw. Every tool goes through here, so no
// path can leak a live socket.
async function withConnection(spec, signal, fn) {
  const client = spec.protocol === 'sftp' ? new SftpClient(spec) : new FtpClient(spec);
  try {
    await client.connect(signal);
    return await fn(client);
  } catch (err) {
    throw new Error(redact(err?.message || String(err), spec.password));
  } finally {
    try { await client.close(); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Layout engine — fixed-width and delimited records
// ─────────────────────────────────────────────────────────────────────────
//
// A layout is plain JSON, so it can be written from a paper spec, kept in
// git, and handed between machines:
//
//   {
//     "name": "tracciato-bolle",
//     "type": "fixed",
//     "base": 1,                       // column numbers as the spec writes
//     "encoding": "latin1",
//     "recordType": { "start": 1, "length": 2 },
//     "records": {
//       "01": { "name": "testata", "fields": [
//         { "name": "mittente", "start": 3,  "length": 8 },
//         { "name": "data",     "start": 11, "length": 8, "type": "date", "format": "YYYYMMDD" },
//         { "name": "importo",  "start": 19, "length": 11, "type": "decimal", "decimals": 2 }
//       ]},
//       "*": { "name": "sconosciuto", "fields": [] }
//     }
//   }
//
// `base` matters more than it looks: tracciato specifications count columns
// from 1, code counts from 0, and an off-by-one shifts every field on the
// line by one character without ever raising an error.

const FIELD_TYPES = new Set(['string', 'raw', 'int', 'decimal', 'date', 'bool']);
const SHORT_FIELD_POLICIES = new Set(['pad', 'report', 'reject', 'byType']);
// Types where reading half the characters yields a wrong value rather than a
// short one. Text is the only thing that survives truncation as itself.
const TRUNCATION_SENSITIVE = new Set(['int', 'decimal', 'date', 'bool']);

function normalizeLayout(layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    throw new Error('layout must be a JSON object');
  }
  const type = String(layout.type || 'fixed').toLowerCase();
  if (!['fixed', 'delimited'].includes(type)) {
    throw new Error(`layout.type must be "fixed" or "delimited" (got "${layout.type}")`);
  }
  const base = layout.base === 0 ? 0 : 1;
  const onShortField = layout.onShortField || 'byType';
  if (!SHORT_FIELD_POLICIES.has(onShortField)) {
    throw new Error(`layout.onShortField must be one of: ${[...SHORT_FIELD_POLICIES].join(', ')} (got "${layout.onShortField}")`);
  }
  const records = {};

  // `fields` at the top level is the single-record-type shorthand.
  const source = layout.records && typeof layout.records === 'object'
    ? layout.records
    : { '*': { name: layout.name || 'record', fields: layout.fields || [] } };

  for (const [key, def] of Object.entries(source)) {
    if (!def || typeof def !== 'object') throw new Error(`layout.records["${key}"] must be an object`);
    const fields = Array.isArray(def.fields) ? def.fields : [];
    records[key] = {
      name: def.name || key,
      fields: fields.map((f, i) => normalizeField(f, `${key}[${i}]`, type, base)),
    };
  }
  if (!Object.keys(records).length) throw new Error('layout declares no fields');

  return {
    name: layout.name || 'layout',
    description: layout.description || '',
    type,
    base,
    encoding: layout.encoding || DEFAULT_ENCODING,
    delimiter: layout.delimiter || ';',
    quote: layout.quote === null ? null : (layout.quote || '"'),
    header: layout.header === true,
    skipEmptyLines: layout.skipEmptyLines !== false,
    skipPattern: layout.skipPattern ? new RegExp(layout.skipPattern) : null,
    onShortField,
    recordType: layout.recordType || null,
    records,
  };
}

function normalizeField(f, where, layoutType, base) {
  if (!f || typeof f !== 'object') throw new Error(`field ${where} must be an object`);
  if (!f.name || typeof f.name !== 'string') throw new Error(`field ${where} needs a "name"`);
  const type = String(f.type || 'string').toLowerCase();
  if (!FIELD_TYPES.has(type)) {
    throw new Error(`field "${f.name}" has type "${type}" — use one of: ${[...FIELD_TYPES].join(', ')}`);
  }
  const out = { name: f.name, type, trim: f.trim !== false, decimals: Number(f.decimals || 0), format: f.format || 'YYYYMMDD' };
  out.trueValues = Array.isArray(f.trueValues) ? f.trueValues.map(String) : ['1', 'S', 'Y', 'T', 'X'];
  if (f.onShort != null) {
    if (!SHORT_FIELD_POLICIES.has(f.onShort)) {
      throw new Error(`field "${f.name}".onShort must be one of: ${[...SHORT_FIELD_POLICIES].join(', ')} (got "${f.onShort}")`);
    }
    out.onShort = f.onShort;
  }

  if (layoutType === 'delimited') {
    if (!Number.isInteger(f.index) || f.index < 0) {
      throw new Error(`field "${f.name}" needs an "index" (0-based column number) in a delimited layout`);
    }
    out.index = f.index;
    return out;
  }
  if (!Number.isInteger(f.start)) throw new Error(`field "${f.name}" needs a "start" column`);
  const length = Number.isInteger(f.length) ? f.length : (Number.isInteger(f.end) ? f.end - f.start + 1 : null);
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error(`field "${f.name}" needs a "length" (or an "end" column at or after "start")`);
  }
  out.offset = f.start - base;   // to a JS string index
  out.length = length;
  out.start = f.start;
  if (out.offset < 0) throw new Error(`field "${f.name}" starts before column ${base} — check the layout's "base"`);
  return out;
}

function coerce(raw, field) {
  const text = field.trim && field.type !== 'raw' ? raw.trim() : raw;
  switch (field.type) {
    case 'raw':
    case 'string':
      return text;
    case 'int': {
      if (!text) return null;
      const n = Number(text.replace(/^\+/, ''));
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case 'decimal': {
      if (!text) return null;
      // Two conventions live side by side in real tracciati: an implied
      // decimal point ("0000012345" with decimals: 2 → 123.45) and a literal
      // separator. Reading the value decides which, so one layout can carry
      // both without a per-field flag.
      if (/[.,]/.test(text)) {
        const n = Number(text.replace(/\./g, '').replace(',', '.'));
        return Number.isFinite(n) ? n : null;
      }
      const neg = /^-/.test(text) || /-$/.test(text);   // trailing minus is common
      const digits = text.replace(/[^0-9]/g, '');
      if (!digits) return null;
      const n = Number(digits) / 10 ** (field.decimals || 0);
      return neg ? -n : n;
    }
    case 'date':
      return parseDateField(text, field.format);
    case 'bool':
      return field.trueValues.includes(text.toUpperCase());
    default:
      return text;
  }
}

const DATE_FORMATS = {
  YYYYMMDD: { re: /^(\d{4})(\d{2})(\d{2})$/, y: 1, m: 2, d: 3 },
  DDMMYYYY: { re: /^(\d{2})(\d{2})(\d{4})$/, y: 3, m: 2, d: 1 },
  MMDDYYYY: { re: /^(\d{2})(\d{2})(\d{4})$/, y: 3, m: 1, d: 2 },
  YYMMDD: { re: /^(\d{2})(\d{2})(\d{2})$/, y: 1, m: 2, d: 3, century: true },
  DDMMYY: { re: /^(\d{2})(\d{2})(\d{2})$/, y: 3, m: 2, d: 1, century: true },
};

// Returns an ISO date string, or null when the field is blank or does not
// match. A malformed date is reported as an unparsed value rather than
// guessed at — a wrong date in a customs record is worse than a missing one.
function parseDateField(text, format) {
  if (!text || /^[0\s]*$/.test(text)) return null;
  const spec = DATE_FORMATS[String(format || 'YYYYMMDD').toUpperCase()];
  if (!spec) return null;
  const m = spec.re.exec(text);
  if (!m) return null;
  let year = Number(m[spec.y]);
  if (spec.century) year += year >= 70 ? 1900 : 2000;
  const month = Number(m[spec.m]);
  const day = Number(m[spec.d]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Decide what a fixed-width field becomes when the line ends inside it.
 *
 * Senders strip trailing spaces all the time, so the last fields of a record
 * arrive truncated or missing entirely. Whether that is normal or a defect is
 * a property of the tracciato, not of the parser — so it is a setting, read
 * from the field first and the layout second:
 *
 *   "pad"     pad with spaces and read the field. Silent.
 *   "report"  same value, plus a line in the parse report.
 *   "reject"  the field becomes null, plus a line in the parse report.
 *   "byType"  (default) pad text silently, reject numbers and dates.
 *
 * `byType` is the default because the two cases genuinely differ. A truncated
 * name is still a name. A truncated number is a different number: "123456"
 * cut to "1234" with decimals 2 reads as 12,34 instead of 1234,56 — plausible,
 * wrong, and invisible. In a customs record that is the worst outcome
 * available, so it has to be null and it has to be reported.
 *
 * @returns {{ value: any, error: string|null }}
 */
function shortFieldPolicy({ field, raw, line, layout }) {
  const mode = field.onShort || layout.onShortField || 'byType';
  const missing = raw.length === 0;
  const detail = `field "${field.name}" (columns ${field.start}-${field.start + field.length - 1}) `
    + (missing ? 'is missing' : `holds ${raw.length} of ${field.length} characters`)
    + `; the line is ${line.length} characters`;
  const padded = () => coerce(raw.padEnd(field.length, ' '), field);

  switch (mode) {
    case 'pad':
      return { value: padded(), error: null };
    case 'report':
      return { value: padded(), error: detail };
    case 'reject':
      return { value: null, error: detail };
    case 'byType':
    default:
      if (!TRUNCATION_SENSITIVE.has(field.type)) return { value: padded(), error: null };
      return { value: null, error: `${detail} — a truncated ${field.type} cannot be read as a value` };
  }
}

function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}

// Split one delimited line, honouring quotes when the layout declares a
// quote character. Doubled quotes inside a quoted field are an escaped quote.
function splitDelimited(line, delimiter, quote) {
  if (!quote) return line.split(delimiter);
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === quote) {
        if (line[i + 1] === quote) { cur += quote; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === quote) inQuotes = true;
    else if (ch === delimiter) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function recordKeyFor(layout, line, columns) {
  if (!layout.recordType) return '*';
  if (layout.type === 'delimited') {
    const idx = Number(layout.recordType.field ?? layout.recordType.index ?? 0);
    return (columns[idx] ?? '').trim();
  }
  const offset = Number(layout.recordType.start ?? layout.base) - layout.base;
  const length = Number(layout.recordType.length ?? 1);
  return line.substr(offset, length).trim();
}

/**
 * Apply a layout to text. Never throws on bad data: a line that does not fit
 * the layout is reported in `errors` and parsing continues, because the
 * common case is one malformed record in a file of four thousand good ones.
 */
function parseWithLayout(text, rawLayout, { limit = 0, offset = 0 } = {}) {
  const layout = normalizeLayout(rawLayout);
  const lines = splitLines(text);
  const records = [];
  const errors = [];
  const byType = {};
  let lineNo = 0;
  let matched = 0;
  let skipped = 0;

  for (const line of lines) {
    lineNo++;
    if (layout.header && lineNo === 1 && layout.type === 'delimited') { skipped++; continue; }
    if (layout.skipEmptyLines && !line.trim()) { skipped++; continue; }
    if (layout.skipPattern && layout.skipPattern.test(line)) { skipped++; continue; }

    const columns = layout.type === 'delimited' ? splitDelimited(line, layout.delimiter, layout.quote) : null;
    const key = recordKeyFor(layout, line, columns || []);
    const def = layout.records[key] || layout.records['*'];
    if (!def) {
      errors.push({ line: lineNo, error: `no record definition for type "${key}"`, sample: line.slice(0, 60) });
      continue;
    }

    matched++;
    byType[key] = (byType[key] || 0) + 1;
    if (matched <= offset) continue;
    if (limit && records.length >= limit) continue;

    const rec = { _line: lineNo, _type: key === '*' ? def.name : key };
    for (const field of def.fields) {
      try {
        if (layout.type === 'delimited') {
          const raw = columns[field.index];
          if (raw === undefined) {
            errors.push({ line: lineNo, error: `column ${field.index} ("${field.name}") is past the end of the line` });
            rec[field.name] = null;
            continue;
          }
          rec[field.name] = coerce(raw, field);
        } else {
          const available = line.length - field.offset;
          if (available < field.length) {
            const { value, error } = shortFieldPolicy({
              field,
              raw: available > 0 ? line.slice(field.offset) : '',
              line,
              layout,
            });
            if (error) errors.push({ line: lineNo, error });
            rec[field.name] = value;
            continue;
          }
          rec[field.name] = coerce(line.substr(field.offset, field.length), field);
        }
      } catch (err) {
        errors.push({ line: lineNo, error: `field "${field.name}": ${err.message}` });
        rec[field.name] = null;
      }
    }
    records.push(rec);
  }

  return {
    layout: layout.name,
    stats: { lines: lineNo, matched, skipped, returned: records.length, errors: errors.length, byType },
    records,
    // A truncated error list keeps a broken file from filling the context
    // window; the count above still reports the real total.
    errors: errors.slice(0, 50),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Inspector — read an unknown tracciato and propose a layout
// ─────────────────────────────────────────────────────────────────────────

const DELIMITER_CANDIDATES = [';', '|', '\t', ',', '~', '*'];

/**
 * Describe the shape of a file nobody documented.
 *
 * The output is evidence plus a DRAFT layout, never a finished one: column
 * boundaries found by looking at where the spaces are will split a field
 * that happens to be blank in the sample, and only the spec (or the person
 * who has read it) can say what each column means.
 */
function inspectText(text, { sampleLines = 200 } = {}) {
  const allLines = splitLines(text);
  const lines = allLines.filter((l) => l.trim().length > 0);
  const sample = lines.slice(0, sampleLines);
  if (!sample.length) return { empty: true, note: 'the file has no non-empty lines' };

  const eol = /\r\n/.test(text) ? 'CRLF' : (/\r/.test(text) ? 'CR' : 'LF');
  const lengths = new Map();
  for (const l of lines) lengths.set(l.length, (lengths.get(l.length) || 0) + 1);
  const histogram = [...lengths.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([length, count]) => ({ length, count }));
  const dominant = histogram[0];
  const uniform = dominant.count / lines.length >= 0.95;

  // Delimiter evidence: a real delimiter appears the same number of times on
  // nearly every line. A character that merely occurs a lot (a space, a zero)
  // does not.
  const delimiters = [];
  for (const ch of DELIMITER_CANDIDATES) {
    const counts = sample.map((l) => l.split(ch).length - 1);
    const nonZero = counts.filter((c) => c > 0).length;
    if (nonZero < sample.length * 0.9) continue;
    const first = counts[0];
    const consistent = counts.every((c) => c === first);
    delimiters.push({
      char: ch === '\t' ? '\\t' : ch,
      fieldsPerLine: first + 1,
      consistent,
      linesWithIt: nonZero,
    });
  }
  const bestDelimiter = delimiters.find((d) => d.consistent) || null;

  // Record-type markers: a short prefix taking few distinct values across
  // many lines is how multi-record tracciati mark their line types.
  const recordMarkers = [];
  for (const length of [1, 2, 3]) {
    const values = new Map();
    for (const l of sample) {
      const v = l.slice(0, length);
      values.set(v, (values.get(v) || 0) + 1);
    }
    if (values.size <= 12 && values.size < sample.length && [...values.keys()].every((v) => v.trim())) {
      recordMarkers.push({
        start: 1,
        length,
        distinct: values.size,
        values: Object.fromEntries([...values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)),
      });
    }
  }

  const columns = uniform && !bestDelimiter ? guessColumns(sample, dominant.length) : [];
  const looksLike = bestDelimiter ? 'delimited' : (uniform ? 'fixed' : 'unclear');

  return {
    lines: allLines.length,
    nonEmptyLines: lines.length,
    eol,
    lineLength: { uniform, dominant: dominant.length, min: Math.min(...lengths.keys()), max: Math.max(...lengths.keys()), histogram },
    looksLike,
    delimiters,
    recordMarkers,
    columns,
    sample: sample.slice(0, 5).map((l, i) => ({ line: i + 1, text: l.slice(0, 240) })),
    draftLayout: draftLayout({ looksLike, bestDelimiter, columns, recordMarkers, sample }),
    note: looksLike === 'unclear'
      ? 'Line lengths vary and no delimiter is consistent. This may be a multi-record tracciato where each record type has its own length — inspect one record type at a time (filter the file first), or write the layout from the spec.'
      : 'draftLayout is a starting point, not the spec: check every boundary and name before saving it.',
  };
}

// Find field boundaries in a fixed-width sample by looking for columns that
// are blank on every line. Those gaps are where padding sits between fields.
function guessColumns(sample, width) {
  const blank = new Array(width).fill(true);
  for (const line of sample) {
    const padded = line.padEnd(width, ' ');
    for (let i = 0; i < width; i++) {
      if (padded[i] !== ' ') blank[i] = false;
    }
  }
  const runs = [];
  let start = null;
  for (let i = 0; i < width; i++) {
    if (!blank[i] && start === null) start = i;
    if (blank[i] && start !== null) { runs.push([start, i - 1]); start = null; }
  }
  if (start !== null) runs.push([start, width - 1]);

  return runs.map(([from, to], i) => {
    const values = sample.map((l) => l.slice(from, to + 1).trim()).filter(Boolean);
    return {
      // 1-based, matching how a tracciato spec is written.
      start: from + 1,
      end: to + 1,
      length: to - from + 1,
      name: `campo_${i + 1}`,
      guessedType: guessType(values),
      samples: values.slice(0, 3),
    };
  });
}

function guessType(values) {
  if (!values.length) return 'string';
  const allDigits = values.every((v) => /^[+-]?\d+$/.test(v));
  if (allDigits) {
    const width = values[0].length;
    if (width === 8 && values.every((v) => v.length === 8 && parseDateField(v, 'YYYYMMDD'))) return 'date';
    if (width === 6 && values.every((v) => v.length === 6 && parseDateField(v, 'DDMMYY'))) return 'date';
    return 'int';
  }
  if (values.every((v) => /^[+-]?[\d.,]+$/.test(v) && /[.,]/.test(v))) return 'decimal';
  return 'string';
}

function draftLayout({ looksLike, bestDelimiter, columns, recordMarkers, sample }) {
  if (looksLike === 'delimited' && bestDelimiter) {
    const first = splitDelimited(sample[0], bestDelimiter.char === '\\t' ? '\t' : bestDelimiter.char, '"');
    return {
      name: 'draft',
      type: 'delimited',
      delimiter: bestDelimiter.char,
      encoding: DEFAULT_ENCODING,
      records: {
        '*': {
          name: 'record',
          fields: first.map((v, i) => ({ name: `campo_${i + 1}`, index: i, type: guessType([v.trim()].filter(Boolean)) })),
        },
      },
    };
  }
  if (looksLike === 'fixed' && columns.length) {
    const marker = recordMarkers.find((m) => m.length === 2) || recordMarkers[0] || null;
    return {
      name: 'draft',
      type: 'fixed',
      base: 1,
      encoding: DEFAULT_ENCODING,
      ...(marker ? { recordType: { start: marker.start, length: marker.length } } : {}),
      records: {
        '*': {
          name: 'record',
          fields: columns.map((c) => ({
            name: c.name,
            start: c.start,
            length: c.length,
            type: c.guessedType,
            ...(c.guessedType === 'date' ? { format: c.length === 8 ? 'YYYYMMDD' : 'DDMMYY' } : {}),
          })),
        },
      },
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Layout store
// ─────────────────────────────────────────────────────────────────────────

const LAYOUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function layoutFile(name) {
  if (!LAYOUT_NAME_RE.test(String(name || ''))) {
    throw new Error(`"${name}" is not a valid layout name (letters, digits, dot, dash, underscore)`);
  }
  return join(LAYOUTS_DIR(), `${name}.json`);
}

function saveLayoutToDisk(name, layout) {
  normalizeLayout(layout);   // refuse to store something that cannot be used
  const dir = LAYOUTS_DIR();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = layoutFile(name);
  writeFileSync(file, JSON.stringify({ ...layout, name }, null, 2), { mode: 0o600 });
  return file;
}

function listLayoutsOnDisk() {
  const dir = LAYOUTS_DIR();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const name = f.replace(/\.json$/, '');
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        const recordTypes = Object.keys(parsed.records || {});
        return {
          name,
          type: parsed.type || 'fixed',
          description: parsed.description || '',
          recordTypes,
          fields: recordTypes.reduce((n, k) => n + (parsed.records[k].fields?.length || 0), 0),
        };
      } catch (err) {
        return { name, error: `unreadable: ${err.message}` };
      }
    });
}

// A layout can arrive three ways: by stored name, inline as an object, or as
// a path to a JSON file in the workspace.
function resolveLayout(layoutArg, workspace) {
  if (layoutArg && typeof layoutArg === 'object') return layoutArg;
  const name = String(layoutArg || '').trim();
  if (!name) throw new Error('a layout is required: a saved name, a path to a .json file, or an inline layout object');
  if (name.endsWith('.json') || name.includes('/')) {
    const file = resolveLocal(name, workspace, { mustExist: true });
    return JSON.parse(readFileSync(file, 'utf-8'));
  }
  const file = layoutFile(name);
  if (!existsSync(file)) {
    const known = listLayoutsOnDisk().map((l) => l.name);
    throw new Error(`no saved layout named "${name}". ${known.length ? `Known: ${known.join(', ')}` : 'Save one with edi_layout_save.'}`);
  }
  return JSON.parse(readFileSync(file, 'utf-8'));
}

// ─────────────────────────────────────────────────────────────────────────
// Local files and output formatting
// ─────────────────────────────────────────────────────────────────────────

// Every local path a tool touches goes through here. Downloads and parsed
// output stay inside the workspace: a remote filename is attacker-controlled
// input, and "../../.ssh/authorized_keys" is a real filename a server can
// return from LIST.
function resolveLocal(pathLike, workspace, { mustExist = false } = {}) {
  const root = resolvePath(workspace || process.cwd());
  const candidate = isAbsolute(pathLike) ? resolvePath(pathLike) : resolvePath(root, pathLike);
  if (candidate !== root && !candidate.startsWith(root + '/')) {
    throw new Error(`path "${pathLike}" resolves outside the workspace (${root})`);
  }
  if (mustExist && !existsSync(candidate)) throw new Error(`file not found: ${candidate}`);
  return candidate;
}

function safeBasename(remote) {
  const name = basename(String(remote).replace(/\\/g, '/'));
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return clean || 'download.edi';
}

function writeLocal(file, buf) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
  return file;
}

function decode(buf, encoding) {
  const enc = String(encoding || DEFAULT_ENCODING).toLowerCase();
  const alias = { cp1252: 'latin1', 'windows-1252': 'latin1', 'iso-8859-1': 'latin1', ansi: 'latin1' }[enc] || enc;
  try { return buf.toString(alias); }
  catch { return buf.toString('latin1'); }
}

function renderTable(records, { maxRows = 30, maxWidth = 32 } = {}) {
  if (!records.length) return '(no records)';
  const cols = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const rows = records.slice(0, maxRows).map((r) => cols.map((c) => (r[c] == null ? '' : String(r[c]))));
  const widths = cols.map((c, i) => Math.min(maxWidth, Math.max(c.length, ...rows.map((r) => r[i].length))));
  const line = (cells) => cells.map((v, i) => v.slice(0, widths[i]).padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(cols), widths.map((w) => '─'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(r));
  if (records.length > maxRows) out.push(`… ${records.length - maxRows} more record(s)`);
  return out.join('\n');
}

function renderCsv(records, delimiter = ';') {
  if (!records.length) return '';
  const cols = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return s.includes(delimiter) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(delimiter), ...records.map((r) => cols.map((c) => escape(r[c])).join(delimiter))].join('\n');
}

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

// The connection half of a tool's parameter schema. Every tool that talks to
// a server takes the same fields, so they are declared once — a plugin whose
// tools each invent their own connection arguments is one the model gets
// wrong half the time.
const CONNECTION_PROPS = {
  profile: { type: 'string', description: 'Name of a saved connection profile (see edi_profile_list).' },
  url: { type: 'string', description: 'Connection URL instead of a profile: ftp://user@host/dir, ftps://user@host/dir, sftp://user@host/dir.' },
  password: { type: 'string', description: 'Password for this call only. Prefer a profile with passwordEnv — anything passed here is part of the conversation.' },
  encoding: { type: 'string', description: 'Character encoding of the remote files (default latin1, which is the safe choice for EDI).' },
  insecure: { type: 'boolean', description: 'FTPS only: accept a certificate that does not validate. Off by default.' },
  timeoutMs: { type: 'number', description: `Socket timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).` },
};

const SOURCE_PROPS = {
  file: { type: 'string', description: 'Path to a local file in the workspace. Use this instead of the connection fields to work on an already-downloaded file.' },
  remotePath: { type: 'string', description: 'Path of the file on the server, relative to the profile base directory unless it starts with "/".' },
};

// Read the bytes a tool is asked to work on, from wherever they live.
async function readSource(args, ctx) {
  const maxBytes = Number(args.maxBytes || DEFAULT_MAX_BYTES);
  if (args.file) {
    const file = resolveLocal(args.file, ctx.workspace, { mustExist: true });
    const size = statSync(file).size;
    if (size > maxBytes) throw new Error(`${file} is ${size} bytes, over maxBytes (${maxBytes})`);
    return { buffer: readFileSync(file), origin: file, encoding: args.encoding || DEFAULT_ENCODING };
  }
  if (!args.remotePath) throw new Error('either "file" (local) or "remotePath" (with a profile or url) is required');
  const spec = buildSpec(args);
  const buffer = await withConnection(spec, ctx.signal, (client) =>
    client.download(remotePath(spec, args.remotePath), { maxBytes, signal: ctx.signal }));
  return { buffer, origin: `${spec.label}:${args.remotePath}`, encoding: spec.encoding };
}

export const tools = {
  // ── connection profiles ────────────────────────────────────────────────

  edi_profile_save: {
    description: 'Save (or update) a named connection profile for an FTP/FTPS/SFTP server holding EDI files. Passwords are encrypted on disk; passwordEnv is preferred.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Profile name, e.g. "dogana-prod".' },
        url: { type: 'string', description: 'ftp://user@host:21/base-dir, ftps://user@host/base-dir, or sftp://user@host/base-dir.' },
        password: { type: 'string', description: 'Password to store encrypted. Prefer passwordEnv: a password passed here also lands in the conversation transcript.' },
        passwordEnv: { type: 'string', description: 'Name of an environment variable to read the password from at connection time. Nothing secret is stored.' },
        privateKeyPath: { type: 'string', description: 'SFTP only: path to the private key file (~ is expanded).' },
        encoding: { type: 'string', description: 'Default encoding for files on this server (default latin1).' },
        insecure: { type: 'boolean', description: 'FTPS only: accept an unvalidated certificate.' },
        implicit: { type: 'boolean', description: 'FTPS only: implicit TLS (port 990) instead of AUTH TLS on port 21.' },
      },
      required: ['name', 'url'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const name = String(args.name || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        return 'Error: profile name must be letters, digits, dot, dash or underscore.';
      }
      const parsed = specFromUrl(args.url);
      if (!parsed.host) return 'Error: the url has no host.';
      const store = readStore();
      const entry = {
        protocol: parsed.protocol,
        host: parsed.host,
        port: parsed.port || null,
        user: parsed.user,
        baseDir: parsed.baseDir,
        implicit: args.implicit ?? parsed.implicit ?? false,
        insecure: args.insecure === true,
        encoding: args.encoding || DEFAULT_ENCODING,
        privateKeyPath: args.privateKeyPath || '',
        passwordEnv: args.passwordEnv || '',
        secret: null,
        updatedAt: new Date().toISOString(),
      };
      const password = args.password || parsed.password;
      if (password && !args.passwordEnv) entry.secret = encryptSecret(store.salt, password);
      store.profiles[name] = entry;
      writeStore(store);
      return {
        saved: name,
        target: `${entry.protocol}://${entry.user}@${entry.host}:${entry.port || DEFAULT_PORTS[entry.protocol]}${entry.baseDir}`,
        passwordSource: entry.passwordEnv ? `env:${entry.passwordEnv}` : (entry.secret ? 'encrypted on disk' : 'none (anonymous or key-based)'),
        file: PROFILES_FILE(),
      };
    },
  },

  edi_profile_list: {
    description: 'List the saved EDI connection profiles. Never returns passwords.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const store = readStore();
      const names = Object.keys(store.profiles);
      if (!names.length) return 'No profiles saved yet. Create one with edi_profile_save.';
      return names.map((name) => {
        const p = store.profiles[name];
        return {
          name,
          target: `${p.protocol}://${p.user}@${p.host}:${p.port || DEFAULT_PORTS[p.protocol]}${p.baseDir || ''}`,
          encoding: p.encoding,
          passwordSource: p.passwordEnv ? `env:${p.passwordEnv}` : (p.secret ? 'encrypted on disk' : 'none'),
          updatedAt: p.updatedAt,
        };
      });
    },
  },

  edi_profile_delete: {
    description: 'Delete a saved EDI connection profile.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async ({ name }) => {
      const store = readStore();
      if (!store.profiles[name]) return `No profile named "${name}".`;
      delete store.profiles[name];
      writeStore(store);
      return `Deleted profile "${name}".`;
    },
  },

  // ── remote files ───────────────────────────────────────────────────────

  edi_list: {
    description: 'List a directory on the EDI server: name, size, modification time. Supports a glob filter and sorting, so "the newest file matching *.edi" is one call.',
    parameters: {
      type: 'object',
      properties: {
        ...CONNECTION_PROPS,
        path: { type: 'string', description: 'Remote directory. Defaults to the profile base directory.' },
        pattern: { type: 'string', description: 'Glob filter on the file name, e.g. "*.edi" or "BOLLE_*.txt".' },
        sort: { type: 'string', enum: ['name', 'modified', 'size'], description: 'Sort key (default name).' },
        desc: { type: 'boolean', description: 'Reverse the sort — pair with sort:"modified" to get the newest first.' },
        limit: { type: 'number', description: 'Maximum entries to return (default 100).' },
        filesOnly: { type: 'boolean', description: 'Omit directories from the result.' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const spec = buildSpec(args);
      const dir = remotePath(spec, args.path);
      let entries = await withConnection(spec, ctx.signal, (client) => client.list(dir, { signal: ctx.signal }));
      if (args.pattern) {
        const re = globToRegExp(args.pattern);
        entries = entries.filter((e) => re.test(e.name));
      }
      if (args.filesOnly) entries = entries.filter((e) => e.type !== 'dir');
      const key = args.sort || 'name';
      entries.sort((a, b) => {
        if (key === 'size') return (a.size || 0) - (b.size || 0);
        if (key === 'modified') return String(a.modified || '').localeCompare(String(b.modified || ''));
        return a.name.localeCompare(b.name);
      });
      if (args.desc) entries.reverse();
      const limit = Number(args.limit || 100);
      return { directory: dir, total: entries.length, entries: entries.slice(0, limit) };
    },
  },

  edi_read: {
    description: 'Download an EDI file and return its first lines as text, without saving it. Use this to see what a file actually contains before parsing it.',
    parameters: {
      type: 'object',
      properties: {
        ...CONNECTION_PROPS,
        remotePath: SOURCE_PROPS.remotePath,
        lines: { type: 'number', description: `How many lines to return (default ${PREVIEW_LINES}). Use 0 for the whole file.` },
        maxBytes: { type: 'number', description: `Refuse to transfer more than this many bytes (default ${DEFAULT_MAX_BYTES}).` },
      },
      required: ['remotePath'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const spec = buildSpec(args);
      const path = remotePath(spec, args.remotePath);
      const buf = await withConnection(spec, ctx.signal, (client) =>
        client.download(path, { maxBytes: Number(args.maxBytes || DEFAULT_MAX_BYTES), signal: ctx.signal }));
      const text = decode(buf, spec.encoding);
      const all = splitLines(text);
      const want = args.lines === 0 ? all.length : Number(args.lines || PREVIEW_LINES);
      return {
        path,
        bytes: buf.length,
        lines: all.length,
        encoding: spec.encoding,
        shown: Math.min(want, all.length),
        text: all.slice(0, want).join('\n'),
      };
    },
  },

  edi_fetch: {
    description: 'Download an EDI file from the server into the workspace and report where it landed, with its size and SHA-256.',
    parameters: {
      type: 'object',
      properties: {
        ...CONNECTION_PROPS,
        remotePath: SOURCE_PROPS.remotePath,
        dest: { type: 'string', description: 'Destination path inside the workspace (default: edi-in/<remote file name>).' },
        maxBytes: { type: 'number', description: `Refuse to transfer more than this many bytes (default ${DEFAULT_MAX_BYTES}).` },
        overwrite: { type: 'boolean', description: 'Overwrite the destination if it already exists (default false).' },
      },
      required: ['remotePath'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const spec = buildSpec(args);
      const path = remotePath(spec, args.remotePath);
      const dest = resolveLocal(args.dest || join('edi-in', safeBasename(args.remotePath)), ctx.workspace);
      if (existsSync(dest) && !args.overwrite) {
        return `Error: ${dest} already exists. Pass overwrite: true to replace it, or choose another dest.`;
      }
      const buf = await withConnection(spec, ctx.signal, (client) =>
        client.download(path, { maxBytes: Number(args.maxBytes || DEFAULT_MAX_BYTES), signal: ctx.signal }));
      writeLocal(dest, buf);
      const text = decode(buf, spec.encoding);
      return {
        remote: path,
        saved: dest,
        bytes: buf.length,
        lines: splitLines(text).filter((l) => l.trim()).length,
        sha256: createHash('sha256').update(buf).digest('hex'),
        preview: splitLines(text).slice(0, 3).map((l) => l.slice(0, 160)),
      };
    },
  },

  // ── understanding and parsing the tracciato ────────────────────────────

  edi_inspect: {
    description: 'Analyse an EDI file whose format is undocumented — line lengths, delimiters, record-type markers, column boundaries — and propose a draft layout to correct and save. Works on a local file or straight off the server.',
    parameters: {
      type: 'object',
      properties: {
        ...CONNECTION_PROPS,
        ...SOURCE_PROPS,
        sampleLines: { type: 'number', description: 'How many lines to analyse (default 200).' },
        maxBytes: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const { buffer, origin, encoding } = await readSource(args, ctx);
      const report = inspectText(decode(buffer, args.encoding || encoding), {
        sampleLines: Number(args.sampleLines || 200),
      });
      return { source: origin, bytes: buffer.length, ...report };
    },
  },

  edi_layout_save: {
    description: 'Save a layout under a name so edi_parse can reuse it. Validates the layout and refuses to store one that cannot be applied.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Layout name, e.g. "tracciato-bolle".' },
        layout: { type: 'object', description: 'The layout object: { type, base, recordType?, records: { "<key>": { name, fields: [...] } } }.' },
      },
      required: ['name', 'layout'],
      additionalProperties: false,
    },
    handler: async ({ name, layout }) => {
      const file = saveLayoutToDisk(name, layout);
      const normalized = normalizeLayout(layout);
      return {
        saved: name,
        file,
        type: normalized.type,
        recordTypes: Object.keys(normalized.records),
        fields: Object.values(normalized.records).reduce((n, r) => n + r.fields.length, 0),
      };
    },
  },

  edi_layout_list: {
    description: 'List the saved EDI layouts.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const layouts = listLayoutsOnDisk();
      return layouts.length ? layouts : 'No layouts saved yet. Run edi_inspect on a file, correct the draft, then edi_layout_save.';
    },
  },

  edi_layout_show: {
    description: 'Show a saved layout as JSON.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async ({ name }) => {
      const file = layoutFile(name);
      if (!existsSync(file)) return `No layout named "${name}".`;
      return JSON.parse(readFileSync(file, 'utf-8'));
    },
  },

  edi_parse: {
    description: 'Parse an EDI file with a layout and return structured records (JSON, a table, or CSV). Reads a local file or downloads it first. Malformed lines are reported, not fatal.',
    parameters: {
      type: 'object',
      properties: {
        ...CONNECTION_PROPS,
        ...SOURCE_PROPS,
        layout: { type: 'string', description: 'Saved layout name, or path to a layout .json inside the workspace.' },
        layoutInline: { type: 'object', description: 'The layout itself, instead of "layout": use this to parse with a layout that has not been saved yet.' },
        format: { type: 'string', enum: ['json', 'table', 'csv'], description: 'How to return the records (default json).' },
        limit: { type: 'number', description: 'Maximum records to return (default 100; 0 for all). Counting and error reporting still cover the whole file.' },
        offset: { type: 'number', description: 'Skip this many matching records before returning any.' },
        recordType: { type: 'string', description: 'Return only records of this type key.' },
        onShortField: { type: 'string', enum: ['pad', 'report', 'reject', 'byType'], description: 'Override the layout: what a field becomes when the line ends inside it. pad = pad silently, report = pad and flag, reject = null and flag, byType = pad text but reject numbers and dates (default).' },
        out: { type: 'string', description: 'Also write the full result to this path in the workspace (.json or .csv by extension).' },
        maxBytes: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (!args.layout && !args.layoutInline) {
        return 'Error: pass "layout" (a saved name or a .json path) or "layoutInline" (the layout object). Run edi_inspect first if you do not have one yet.';
      }
      const { buffer, origin, encoding } = await readSource(args, ctx);
      let layout = resolveLayout(args.layoutInline || args.layout, ctx.workspace);
      // A per-call override, so a short-line policy can be tried against a
      // real file before it is written into the saved layout.
      if (args.onShortField) layout = { ...layout, onShortField: args.onShortField };
      const text = decode(buffer, args.encoding || layout.encoding || encoding);
      const limit = args.limit === 0 ? 0 : Number(args.limit ?? 100);
      const result = parseWithLayout(text, layout, { limit: 0, offset: Number(args.offset || 0) });

      let records = result.records;
      if (args.recordType) records = records.filter((r) => String(r._type) === String(args.recordType));
      const total = records.length;
      const shown = limit ? records.slice(0, limit) : records;

      // `out` writes the FULL set, not the truncated view: the file is for
      // the next step in the workflow, the returned records are for reading.
      let written = null;
      if (args.out) {
        const file = resolveLocal(args.out, ctx.workspace);
        const body = file.endsWith('.csv') ? renderCsv(records) : JSON.stringify(records, null, 2);
        writeLocal(file, Buffer.from(body, 'utf-8'));
        written = file;
      }

      const base = {
        source: origin,
        layout: result.layout,
        stats: { ...result.stats, matchingFilter: total, returned: shown.length },
        errors: result.errors,
        ...(written ? { written } : {}),
      };
      if (args.format === 'table') return `${renderTable(shown)}\n\n${JSON.stringify(base, null, 2)}`;
      if (args.format === 'csv') return `${renderCsv(shown)}\n\n${JSON.stringify(base, null, 2)}`;
      return { ...base, records: shown };
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// /edi — the same operations from the TUI, without going through the model
// ─────────────────────────────────────────────────────────────────────────

// Split a command line into positional words and --flags, honouring quotes.
function tokenize(input) {
  const words = String(input || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const positional = [];
  const flags = {};
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^["']|["']$/g, '');
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      if (eq > 2) { flags[w.slice(2, eq)] = w.slice(eq + 1); continue; }
      const key = w.slice(2);
      const next = words[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next.replace(/^["']|["']$/g, ''); i++; }
      else flags[key] = true;
    } else positional.push(w);
  }
  return { positional, flags };
}

const EDI_HELP = [
  'edi — read EDI files from an FTP / FTPS / SFTP server',
  '',
  '  /edi profiles                          list saved connection profiles',
  '  /edi profile add <name> <url> [flags]  save a profile',
  '        flags: --env VAR (read the password from an env var, preferred)',
  '               --password X (stored encrypted; also lands in this transcript)',
  '               --key PATH (SFTP private key), --insecure, --encoding latin1',
  '  /edi profile rm <name>                 delete a profile',
  '',
  '  /edi ls <profile> [path] [--pattern "*.edi"] [--newest]',
  '  /edi get <profile> <remotePath> [dest]',
  '  /edi head <profile> <remotePath> [--lines 20]',
  '',
  '  /edi inspect <localFile>               work out the structure of a tracciato',
  '  /edi layouts                           list saved layouts',
  '  /edi parse <localFile> <layout> [--limit 20] [--csv] [--short pad|report|reject|byType]',
  '',
  'URLs: ftp://user@host/dir · ftps://user@host/dir · sftp://user@host/dir',
].join('\n');

export const commands = {
  edi: {
    description: 'Browse an FTP/FTPS/SFTP server and parse the EDI files on it',
    usage: '/edi [profiles|profile|ls|get|head|inspect|layouts|parse] …',
    handler: async (argsLine, ctx) => {
      const { positional, flags } = tokenize(argsLine);
      const sub = (positional.shift() || 'help').toLowerCase();
      const workspace = process.cwd();
      const signal = ctx?.signal || null;

      try {
        switch (sub) {
          case 'help':
            return EDI_HELP;

          case 'profiles': {
            const out = await tools.edi_profile_list.handler({});
            return typeof out === 'string' ? out : formatProfiles(out);
          }

          case 'profile': {
            const action = (positional.shift() || '').toLowerCase();
            if (action === 'rm' || action === 'delete') {
              return tools.edi_profile_delete.handler({ name: positional[0] });
            }
            if (action !== 'add' && action !== 'set') return 'Usage: /edi profile add <name> <url> [--env VAR] [--key PATH]';
            const [name, url] = positional;
            if (!name || !url) return 'Usage: /edi profile add <name> <url> [--env VAR] [--key PATH]';
            const saved = await tools.edi_profile_save.handler({
              name,
              url,
              passwordEnv: typeof flags.env === 'string' ? flags.env : undefined,
              password: typeof flags.password === 'string' ? flags.password : undefined,
              privateKeyPath: typeof flags.key === 'string' ? flags.key : undefined,
              encoding: typeof flags.encoding === 'string' ? flags.encoding : undefined,
              insecure: flags.insecure === true,
            });
            if (typeof saved === 'string') return saved;
            return `Saved profile "${saved.saved}"\n  ${saved.target}\n  password: ${saved.passwordSource}`;
          }

          case 'ls': {
            const [profile, path] = positional;
            if (!profile) return 'Usage: /edi ls <profile> [path] [--pattern "*.edi"] [--newest]';
            const res = await tools.edi_list.handler({
              profile,
              path,
              pattern: typeof flags.pattern === 'string' ? flags.pattern : undefined,
              sort: flags.newest ? 'modified' : 'name',
              desc: flags.newest === true,
              filesOnly: flags.files === true,
            }, { signal, workspace });
            if (typeof res === 'string') return res;
            if (!res.entries.length) return `${res.directory}: empty`;
            const rows = res.entries.map((e) => ({
              name: e.name,
              type: e.type,
              size: e.size == null ? '' : e.size,
              modified: e.modified || '',
            }));
            return `${res.directory} — ${res.total} entr${res.total === 1 ? 'y' : 'ies'}\n\n${renderTable(rows, { maxRows: 100 })}`;
          }

          case 'get': {
            const [profile, remote, dest] = positional;
            if (!profile || !remote) return 'Usage: /edi get <profile> <remotePath> [dest]';
            const res = await tools.edi_fetch.handler({ profile, remotePath: remote, dest, overwrite: flags.force === true }, { signal, workspace });
            if (typeof res === 'string') return res;
            return `Saved ${res.remote} → ${res.saved}\n  ${res.bytes} bytes, ${res.lines} non-empty lines, sha256 ${res.sha256.slice(0, 16)}…`;
          }

          case 'head': {
            const [profile, remote] = positional;
            if (!profile || !remote) return 'Usage: /edi head <profile> <remotePath> [--lines 20]';
            const res = await tools.edi_read.handler({ profile, remotePath: remote, lines: Number(flags.lines || PREVIEW_LINES) }, { signal, workspace });
            if (typeof res === 'string') return res;
            return `${res.path} — ${res.bytes} bytes, ${res.lines} lines (showing ${res.shown})\n\n${res.text}`;
          }

          case 'inspect': {
            const [file] = positional;
            if (!file) return 'Usage: /edi inspect <localFile>';
            const res = await tools.edi_inspect.handler({ file }, { signal, workspace });
            if (typeof res === 'string') return res;
            return formatInspection(res);
          }

          case 'layouts': {
            const res = await tools.edi_layout_list.handler({});
            if (typeof res === 'string') return res;
            return renderTable(res.map((l) => ({ name: l.name, type: l.type, records: (l.recordTypes || []).join(','), fields: l.fields })));
          }

          case 'parse': {
            const [file, layout] = positional;
            if (!file || !layout) return 'Usage: /edi parse <localFile> <layout> [--limit 20] [--csv]';
            const res = await tools.edi_parse.handler({
              file,
              layout,
              limit: Number(flags.limit || 20),
              format: flags.csv ? 'csv' : 'json',
              onShortField: typeof flags.short === 'string' ? flags.short : undefined,
              out: typeof flags.out === 'string' ? flags.out : undefined,
            }, { signal, workspace });
            if (typeof res === 'string') return res;
            const head = `${res.source} — ${res.stats.matched} record(s), ${res.stats.errors} error(s)`;
            const errors = res.errors.length
              ? `\n\nErrors:\n${res.errors.slice(0, 5).map((e) => `  line ${e.line}: ${e.error}`).join('\n')}`
              : '';
            return `${head}\n\n${renderTable(res.records)}${errors}`;
          }

          default:
            return `Unknown subcommand "${sub}".\n\n${EDI_HELP}`;
        }
      } catch (err) {
        return `Error: ${err?.message || String(err)}`;
      }
    },
  },
};

function formatProfiles(list) {
  return renderTable(
    list.map((p) => ({ name: p.name, target: p.target, encoding: p.encoding, password: p.passwordSource })),
    { maxRows: 50, maxWidth: 64 },
  );
}

function formatInspection(res) {
  const out = [`${res.source} — ${res.bytes} bytes, ${res.nonEmptyLines} non-empty lines, ${res.eol} line endings`];
  if (res.empty) return `${out[0]}\n${res.note}`;
  out.push(`Looks like: ${res.looksLike}`);
  out.push(`Line length: ${res.lineLength.uniform ? `uniform at ${res.lineLength.dominant}` : `varies ${res.lineLength.min}–${res.lineLength.max}`}`);
  if (res.delimiters.length) {
    out.push(`Delimiters: ${res.delimiters.map((d) => `"${d.char}" → ${d.fieldsPerLine} fields${d.consistent ? ' (consistent)' : ''}`).join(', ')}`);
  }
  if (res.recordMarkers.length) {
    const m = res.recordMarkers[0];
    out.push(`Record marker candidate: columns ${m.start}–${m.start + m.length - 1}, values ${Object.keys(m.values).map((v) => `"${v}"`).join(' ')}`);
  }
  if (res.columns.length) {
    out.push('', 'Column candidates:', renderTable(res.columns.map((c) => ({
      name: c.name, start: c.start, end: c.end, length: c.length, type: c.guessedType, sample: (c.samples[0] || '').slice(0, 20),
    })), { maxRows: 60 }));
  }
  out.push('', 'Sample:', ...res.sample.map((s) => `  ${String(s.line).padStart(3)} │ ${s.text}`));
  if (res.draftLayout) {
    out.push('', 'Draft layout (check every boundary before saving):', JSON.stringify(res.draftLayout, null, 2));
  }
  out.push('', res.note);
  return out.join('\n');
}

export const hooks = {
  onLoad: (api) => {
    // Say once, at enable time, where the credentials live — a plugin that
    // stores secrets should never be quiet about it.
    api.log('info', `edi-ftp ready — profiles in ${PROFILES_FILE()}, layouts in ${LAYOUTS_DIR()}`);
  },
};

// Exported for the test suite: these are the pieces worth testing without a
// live server (the protocol client is exercised against a fake one).
export const _internal = {
  extractResponse,
  parseListing,
  parseMlsd,
  parseWithLayout,
  normalizeLayout,
  shortFieldPolicy,
  inspectText,
  buildSpec,
  specFromUrl,
  remotePath,
  redact,
  globToRegExp,
  splitDelimited,
  parseDateField,
  resolveLocal,
  FtpClient,
};
