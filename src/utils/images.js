import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_TURN = 4;

const EXTENSION_MIME = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

export function detectImageMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export function isSupportedImagePath(filePath) {
  return EXTENSION_MIME.has(extname(String(filePath || '')).toLowerCase());
}

export function extractImageReferences(input) {
  const paths = [];
  const text = String(input || '').replace(/@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g, (match, doubleQuoted, singleQuoted, plain) => {
    const candidate = doubleQuoted || singleQuoted || plain || '';
    if (!isSupportedImagePath(candidate)) return match;
    paths.push(candidate);
    return '';
  }).replace(/[ \t]{2,}/g, ' ').trim();
  return { text, paths };
}

export async function loadImageAttachments(paths, options = {}) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (list.length > MAX_IMAGES_PER_TURN) {
    throw new Error(`Too many images: maximum ${MAX_IMAGES_PER_TURN} per message.`);
  }

  const cwd = options.cwd || process.cwd();
  const maxBytes = options.maxBytes || MAX_IMAGE_BYTES;
  const images = [];

  for (const requestedPath of list) {
    if (!isSupportedImagePath(requestedPath)) {
      throw new Error(`Unsupported image format: ${requestedPath}. Use JPEG, PNG, GIF, or WebP.`);
    }
    const absolutePath = resolve(cwd, requestedPath);
    const info = await stat(absolutePath).catch(() => null);
    if (!info?.isFile()) throw new Error(`Image not found: ${requestedPath}`);
    if (info.size > maxBytes) {
      throw new Error(`Image too large: ${requestedPath} (${(info.size / 1024 / 1024).toFixed(1)} MiB; maximum ${maxBytes / 1024 / 1024} MiB).`);
    }

    const data = await readFile(absolutePath);
    if (data.length > maxBytes) {
      throw new Error(`Image too large: ${requestedPath} (${(data.length / 1024 / 1024).toFixed(1)} MiB; maximum ${maxBytes / 1024 / 1024} MiB).`);
    }
    const mimeType = detectImageMime(data);
    const expectedMime = EXTENSION_MIME.get(extname(absolutePath).toLowerCase());
    if (!mimeType || mimeType !== expectedMime) {
      throw new Error(`Invalid image data or mismatched extension: ${requestedPath}`);
    }
    images.push({
      path: absolutePath,
      name: basename(absolutePath),
      mimeType,
      data: data.toString('base64'),
    });
  }

  return images;
}

export function buildVisionContent(text, images = []) {
  const label = images.length
    ? `Attached image${images.length === 1 ? '' : 's'}: ${images.map(image => image.name).join(', ')}`
    : '';
  const prompt = String(text || '').trim();
  const blocks = [{ type: 'text', text: [prompt || 'Analyze the attached image.', label].filter(Boolean).join('\n\n') }];
  for (const image of images) {
    blocks.push({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.data}`, detail: 'auto' },
    });
  }
  return blocks;
}

// Models known to read images. The list is deliberately an allowlist of
// families rather than a blocklist: a new text-only model appearing is the
// common case, and treating the unknown as "cannot see" would be wrong for
// every model released after this line was written.
//
// So the answer has three states, and the caller says "may not" for `unknown`.
// ETTORE attaches a base64 image to whatever model is active, and a model that
// cannot read it either errors after a long wait or — worse — answers around
// it without saying the image was ignored.
const VISION_MODEL_PATTERNS = [
  /gpt-4o/i, /gpt-4\.1/i, /gpt-4-turbo/i, /gpt-5/i, /\bo[134]\b/i,
  /claude/i,
  /gemini/i,
  /llava/i, /bakllava/i, /moondream/i, /minicpm-v/i,
  /vision/i, /-vl\b/i, /\bvl-/i,
  /pixtral/i,
  /step-1v/i,
  /grok.*vision/i,
  /internvl/i,
];

/**
 * @returns {'yes'|'unknown'} whether the model is known to accept images.
 */
export function modelVisionSupport(model) {
  const name = String(model || '');
  if (!name) return 'unknown';
  return VISION_MODEL_PATTERNS.some(re => re.test(name)) ? 'yes' : 'unknown';
}
