import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { basename, extname } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { MAX_IMAGE_BYTES, detectImageMime } from '../utils/images.js';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const EXTENSION_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

export function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase().split('%')[0];
  const family = isIP(value);
  if (family === 4) return isPrivateIpv4(value);
  if (family !== 6) return true;
  if (value === '::' || value === '::1') return true;
  if (/^(fc|fd)/.test(value) || /^fe[89ab]/.test(value)) return true;
  // Block special-purpose IPv6 ranges, including every IPv4-mapped form.
  // This is deliberately conservative: a web image never needs these ranges.
  if (/^(::ffff:|::|ff|fec|fed|fee|fef|2001:0:|2001:db8:|64:ff9b:)/.test(value)) return true;
  return false;
}

async function resolvePublicImageUrl(rawUrl, options = {}) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('invalid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('only http/https URLs are allowed');
  if (parsed.username || parsed.password) throw new Error('URLs containing credentials are not allowed');

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname.toLowerCase() === 'localhost') throw new Error('private/loopback hosts are not allowed');
  const literalFamily = isIP(hostname);
  if (literalFamily && isPrivateAddress(hostname)) throw new Error('private/loopback hosts are not allowed');

  let addresses;
  if (!literalFamily) {
    const lookupFn = options.lookupFn || lookup;
    addresses = await lookupFn(hostname, { all: true, verbatim: true });
    if (!Array.isArray(addresses) || addresses.length === 0) throw new Error('host did not resolve');
    if (addresses.some(entry => isPrivateAddress(entry.address))) {
      throw new Error('host resolves to a private/loopback address');
    }
  } else {
    addresses = [{ address: hostname, family: literalFamily }];
  }
  return { parsed, address: addresses[0] };
}

export async function validatePublicImageUrl(rawUrl, options = {}) {
  return (await resolvePublicImageUrl(rawUrl, options)).parsed;
}

function pinnedRequest(parsed, address, options = {}) {
  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(parsed, {
      headers: options.headers,
      signal: options.signal,
      servername: parsed.hostname,
      lookup: (_hostname, _lookupOptions, callback) => {
        callback(null, address.address, address.family);
      },
    }, response => {
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        body: response,
        headers: {
          get(name) {
            const value = response.headers[String(name).toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value == null ? null : String(value);
          },
        },
      });
    });
    request.on('error', reject);
  });
}

async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`image exceeds ${maxBytes / 1024 / 1024} MiB limit`);

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`image exceeds ${maxBytes / 1024 / 1024} MiB limit`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }

  if (response.body?.[Symbol.asyncIterator]) {
    const chunks = [];
    let total = 0;
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        response.body.destroy?.();
        throw new Error(`image exceeds ${maxBytes / 1024 / 1024} MiB limit`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }

  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new Error(`image exceeds ${maxBytes / 1024 / 1024} MiB limit`);
  return data;
}

function imageName(url, mimeType) {
  let rawName = '';
  try { rawName = decodeURIComponent(basename(new URL(url).pathname)); } catch {}
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const expectedExtension = EXTENSION_BY_MIME[mimeType];
  return safeName && extname(safeName).toLowerCase() === expectedExtension
    ? safeName
    : `web-image${expectedExtension}`;
}

export function isWebImageResult(value) {
  return value?.__ettoreType === 'web_image' && value.attachment?.data && value.attachment?.mimeType;
}

export async function fetchWebImage(rawUrl, options = {}) {
  const fetchImpl = options.fetchImpl;
  const lookupFn = options.lookupFn || lookup;
  const maxBytes = options.maxBytes || MAX_IMAGE_BYTES;
  const maxRedirects = options.maxRedirects ?? 3;
  let current = String(rawUrl || '');

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const { parsed, address } = await resolvePublicImageUrl(current, { lookupFn });
    const requestOptions = {
      headers: { 'User-Agent': 'Ettore-CLI/1.0', Accept: 'image/jpeg,image/png,image/gif,image/webp' },
      redirect: 'manual',
      signal: options.signal,
    };
    // Production requests are pinned to the address validated above, closing
    // the DNS-rebinding gap between validation and connection establishment.
    const response = fetchImpl
      ? await fetchImpl(parsed.href, requestOptions)
      : await pinnedRequest(parsed, address, requestOptions);

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers?.get?.('location');
      if (!location) throw new Error(`redirect ${response.status} without location`);
      if (redirectCount >= maxRedirects) throw new Error(`too many redirects (maximum ${maxRedirects})`);
      current = new URL(location, parsed).href;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const declaredMime = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (declaredMime && declaredMime !== 'application/octet-stream' && !ALLOWED_MIME.has(declaredMime)) {
      throw new Error(`unsupported content type: ${declaredMime}`);
    }
    const data = await readLimitedBody(response, maxBytes);
    const detectedMime = detectImageMime(data);
    if (!detectedMime || !ALLOWED_MIME.has(detectedMime)) throw new Error('response is not a supported JPEG, PNG, GIF, or WebP image');
    if (ALLOWED_MIME.has(declaredMime) && declaredMime !== detectedMime) {
      throw new Error(`content type mismatch: declared ${declaredMime}, detected ${detectedMime}`);
    }

    const name = imageName(parsed.href, detectedMime);
    return {
      __ettoreType: 'web_image',
      sourceUrl: parsed.href,
      byteLength: data.length,
      attachment: { name, mimeType: detectedMime, data: data.toString('base64') },
      message: `Image fetched: ${name} (${detectedMime}, ${data.length} bytes) from ${parsed.href}`,
    };
  }
  throw new Error('unable to fetch image');
}
