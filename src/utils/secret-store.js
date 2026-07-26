// Encrypted on-disk store for "studio" API keys (MiniMax, Gemini, OpenAI,
// Anthropic, etc.) that users may want to persist between sessions.
//
// Storage layout (one file under the ETTORE config dir):
//   { "v": 1, "salt": "<hex>", "items": { "<providerId>": { "iv": "<hex>", "ct": "<hex>", "tag": "<hex>" } } }
//
// Crypto: AES-256-GCM, key derived from PBKDF2-SHA256(machineMaterial, salt, 200_000, 32).
// The machine material is `hostname + username + ettoreFingerprint` — stable for
// the user, not a password prompt. This is OBFUSCATION, not a real password
// manager: anyone with read access to the file AND the source code can derive
// the same key. The honest threat model is "raise the bar above plaintext
// ~/.config dumps" — for stronger guarantees use a real keychain (TODO: wire
// to libsecret/Keychain via OS integration).
//
// The file is written with 0600 permissions inside the 0700 ETTORE_CONFIG_DIR.

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { homedir, hostname, userInfo } from 'os';
import { join } from 'path';
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'crypto';

const STORE_VERSION = 1;
// Salt is per-install, not per-secret — derived from a random 16 bytes on first
// write and pinned in the file so the key stays stable across sessions.
const SALT_BYTES = 16;
const IV_BYTES = 12;        // GCM standard
const KEY_BYTES = 32;       // AES-256
const PBKDF2_ITERS = 200_000;
const ALGO = 'aes-256-gcm';

// Domain-separation string mixed into the PBKDF2 password. Anyone reading this
// file alone cannot derive the key without also knowing this constant. Not a
// real secret — but it stops `strings ~/.config/ettore/secrets.json` from
// becoming an immediate plaintext dump.
const FINGERPRINT = 'ettore-cli/studio-secret-store/v1';

const CONFIG_DIR = () => process.env.ETTORE_CONFIG_DIR || join(homedir(), '.config', 'ettore');
const STORE_FILE = () => join(CONFIG_DIR(), 'studio-secrets.json');

function ensureDir() {
  const dir = CONFIG_DIR();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch {}
  }
}

function machineMaterial() {
  const id = `${hostname()}|${userInfo().username || ''}|${FINGERPRINT}`;
  return id;
}

function deriveKey(salt) {
  // PBKDF2 is fine here — the entropy comes from the (stable) password, not
  // the salt, and the salt pins the install. We pay the iteration cost once
  // per process and cache.
  const pw = Buffer.from(machineMaterial(), 'utf-8');
  return pbkdf2Sync(pw, salt, PBKDF2_ITERS, KEY_BYTES, 'sha256');
}

// Cached derivation: same process → same key without re-paying PBKDF2 each call.
let cached = null; // { saltHex, key }

function getKey(saltHex) {
  if (cached && cached.saltHex === saltHex) return cached.key;
  const salt = Buffer.from(saltHex, 'hex');
  const key = deriveKey(salt);
  cached = { saltHex, key };
  return key;
}

function readStore() {
  ensureDir();
  try {
    const file = STORE_FILE();
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf-8');
    const obj = JSON.parse(text);
    if (!obj || obj.v !== STORE_VERSION) return null;
    return obj;
  } catch {
    return null;
  }
}

function writeStore(obj) {
  ensureDir();
  writeFileSync(STORE_FILE(), JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { chmodSync(STORE_FILE(), 0o600); } catch {}
}

function loadOrInit() {
  let store = readStore();
  if (store) return store;
  store = {
    v: STORE_VERSION,
    salt: randomBytes(SALT_BYTES).toString('hex'),
    items: {},
  };
  writeStore(store);
  return store;
}

function encrypt(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), ct: ct.toString('hex'), tag: tag.toString('hex') };
}

function decrypt(key, ivHex, ctHex, tagHex) {
  const iv = Buffer.from(ivHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf-8');
}

function maskSecret(secret) {
  const s = String(secret || '');
  if (!s) return '';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

// Validate a provider id: short, lowercase, alphanumeric+dash+underscore. Keeps
// the on-disk file from being abused as a generic key/value store.
function isValidProviderId(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(id);
}

/**
 * Save (or overwrite) a secret for a provider.
 * @param {string} provider
 * @param {string} secret  API key value
 * @returns {{provider: string, masked: string}}
 */
export function saveSecret(provider, secret) {
  if (!isValidProviderId(provider)) throw new Error(`invalid provider id: ${provider}`);
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error(`empty secret for provider ${provider}`);
  }
  const store = loadOrInit();
  const key = getKey(store.salt);
  store.items[provider] = encrypt(key, secret);
  writeStore(store);
  return { provider, masked: maskSecret(secret) };
}

/**
 * Read a secret for a provider. Returns null when absent or unreadable.
 */
export function getSecret(provider) {
  if (!isValidProviderId(provider)) return null;
  const store = readStore();
  if (!store) return null;
  const item = store.items?.[provider];
  if (!item) return null;
  try {
    const key = getKey(store.salt);
    return decrypt(key, item.iv, item.ct, item.tag);
  } catch {
    // Corrupted / wrong-key entry — treat as absent so the caller can re-save.
    return null;
  }
}

/**
 * Remove a saved secret. Returns true when something was removed.
 */
export function deleteSecret(provider) {
  if (!isValidProviderId(provider)) return false;
  const store = readStore();
  if (!store || !store.items?.[provider]) return false;
  delete store.items[provider];
  writeStore(store);
  return true;
}

/**
 * Inventory of all saved providers, with masked values for the UI.
 * Returns { provider: { hasKey: true, masked: 'sk-...1234' } }.
 * Values are never returned in plaintext.
 */
export function listSecrets() {
  const store = readStore();
  if (!store) return {};
  const out = {};
  for (const [provider, item] of Object.entries(store.items)) {
    try {
      const key = getKey(store.salt);
      const plain = decrypt(key, item.iv, item.ct, item.tag);
      out[provider] = { hasKey: true, masked: maskSecret(plain) };
    } catch {
      out[provider] = { hasKey: false, masked: '', corrupted: true };
    }
  }
  return out;
}

/** Storage file path — exposed for tests and diagnostics. */
export const _internal = {
  STORE_FILE: () => STORE_FILE(),
  CONFIG_DIR: () => CONFIG_DIR(),
  isValidProviderId,
  maskSecret,
};