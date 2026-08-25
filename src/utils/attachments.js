import { stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { isSupportedImagePath, loadImageAttachments, MAX_IMAGE_BYTES } from './images.js';

export const MAX_FILE_ATTACHMENTS = 8;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXTENSION = new Map([
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json'],
  ['.csv', 'text/csv'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/typescript'],
  ['.jsx', 'text/javascript'],
  ['.py', 'text/x-python'],
  ['.java', 'text/x-java-source'],
  ['.go', 'text/x-go'],
  ['.rs', 'text/x-rust'],
  ['.html', 'text/html'],
  ['.css', 'text/css'],
  ['.xml', 'application/xml'],
  ['.yaml', 'text/yaml'],
  ['.yml', 'text/yaml'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'],
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.zip', 'application/zip'],
]);

function cleanRequestedPath(value) {
  return String(value || '').trim().replace(/^(["'])(.*)\1$/, '$2');
}

export function attachmentKind(filePath) {
  const ext = extname(String(filePath || '')).toLowerCase();
  if (isSupportedImagePath(filePath)) return 'image';
  if (MIME_BY_EXTENSION.get(ext)?.startsWith('audio/')) return 'audio';
  if (MIME_BY_EXTENSION.get(ext)?.startsWith('video/')) return 'video';
  if (ext === '.pdf') return 'document';
  if (MIME_BY_EXTENSION.get(ext)?.startsWith('text/') || MIME_BY_EXTENSION.get(ext) === 'application/json') return 'text';
  return 'file';
}

export async function inspectAttachment(requestedPath, options = {}) {
  const rawPath = cleanRequestedPath(requestedPath);
  if (!rawPath) throw new Error('Inserisci il percorso di un file.');

  const cwd = options.cwd || process.cwd();
  const absolutePath = resolve(cwd, rawPath);
  const info = await stat(absolutePath).catch(() => null);
  if (!info) throw new Error(`File non trovato: ${rawPath}`);
  if (!info.isFile()) throw new Error(`Il percorso non è un file: ${rawPath}`);

  const maxBytes = isSupportedImagePath(absolutePath) ? MAX_IMAGE_BYTES : (options.maxBytes || MAX_FILE_BYTES);
  if (info.size > maxBytes) {
    throw new Error(`File troppo grande: ${basename(absolutePath)} (${(info.size / 1024 / 1024).toFixed(1)} MiB; massimo ${(maxBytes / 1024 / 1024).toFixed(0)} MiB).`);
  }

  const extension = extname(absolutePath).toLowerCase();
  return {
    path: absolutePath,
    name: basename(absolutePath),
    size: info.size,
    extension,
    kind: attachmentKind(absolutePath),
    mimeType: MIME_BY_EXTENSION.get(extension) || 'application/octet-stream',
  };
}

export async function loadAttachments(paths, options = {}) {
  const requested = Array.isArray(paths) ? paths : [];
  const unique = [];
  const seen = new Set();
  for (const value of requested) {
    const normalized = cleanRequestedPath(value);
    if (!normalized) continue;
    const absolute = resolve(options.cwd || process.cwd(), normalized);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    unique.push(absolute);
  }
  if (unique.length > MAX_FILE_ATTACHMENTS) {
    throw new Error(`Troppi allegati: massimo ${MAX_FILE_ATTACHMENTS} file per messaggio.`);
  }

  const inspected = [];
  for (const filePath of unique) inspected.push(await inspectAttachment(filePath, options));
  const images = inspected.filter(file => file.kind === 'image');
  const imageData = images.length
    ? await loadImageAttachments(images.map(file => file.path), { cwd: options.cwd, maxBytes: MAX_IMAGE_BYTES })
    : [];
  const imageByPath = new Map(imageData.map(image => [image.path, image]));

  return inspected.map(file => file.kind === 'image' ? { ...file, ...imageByPath.get(file.path) } : file);
}

export function buildAttachmentPrompt(text, files = []) {
  const genericFiles = (Array.isArray(files) ? files : []).filter(file => file.kind !== 'image');
  if (genericFiles.length === 0) return String(text || '').trim();

  const manifest = genericFiles
    .map(file => {
      const instruction = file.extension === '.pdf'
        ? ' — PDF: usa read_pdf; OCR Super automatico se il testo nativo è assente o danneggiato'
        : '';
      return `- ${file.name} (${file.kind}, ${file.mimeType}) — ${file.path}${instruction}`;
    })
    .join('\n');
  return [
    String(text || '').trim(),
    'Allegati locali da usare come materiale di riferimento:',
    manifest,
    'Leggi o analizza gli allegati con il tool appropriato prima di rispondere.',
  ].filter(Boolean).join('\n\n');
}
