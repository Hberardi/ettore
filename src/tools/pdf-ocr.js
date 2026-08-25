import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PREPROCESSOR = join(MODULE_DIR, 'pdf_ocr_preprocess.py');
const DEFAULT_MAX_PAGES = 30;
const DEFAULT_DPI = 300;

function commandOptions(signal, timeout = 120000) {
  return {
    maxBuffer: 32 * 1024 * 1024,
    timeout,
    signal: typeof signal === 'function' ? signal(timeout) : signal,
  };
}

function textStats(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const words = text.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word));
  const suspicious = (text.match(/[�]{2,}|[^\p{L}\p{N}\s.,;:!?%€$()/'"+\-]/gu) || []).length;
  return {
    text,
    chars: text.length,
    letters,
    words: words.length,
    suspicious,
  };
}

export function isLikelyUsablePdfText(value) {
  const stats = textStats(value);
  if (stats.chars < 120 || stats.letters < 50 || stats.words < 12) return false;
  if (stats.letters / Math.max(1, stats.chars) < 0.35) return false;
  if (stats.suspicious > Math.max(8, stats.chars * 0.03)) return false;
  return true;
}

export function parsePdfPageCount(pdfInfo) {
  const match = String(pdfInfo || '').match(/^Pages:\s*(\d+)/im);
  return match ? Math.max(1, Number(match[1])) : null;
}

export function parseTesseractTsv(tsv) {
  const lines = String(tsv || '').split('\n');
  const rows = [];
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length < 12 || fields[0] !== '5') continue;
    const word = fields.slice(11).join('\t').trim();
    if (!word) continue;
    const confidence = Number(fields[10]);
    rows.push({
      block: fields[2],
      paragraph: fields[3],
      line: fields[4],
      word,
      confidence: Number.isFinite(confidence) ? confidence : 0,
    });
  }

  const output = [];
  let currentKey = '';
  for (const row of rows) {
    const key = `${row.block}:${row.paragraph}:${row.line}`;
    if (key !== currentKey) {
      if (output.length) output.push('\n');
      currentKey = key;
    } else {
      output.push(' ');
    }
    output.push(row.word);
  }
  const text = output.join('').replace(/\n{3,}/g, '\n\n').trim();
  const confidence = rows.length
    ? rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length
    : 0;
  return { text, confidence, words: rows.length };
}

async function resolveLanguage(requested, signal) {
  const requestedText = String(requested || 'auto').trim().toLowerCase();
  let available = [];
  try {
    const { stdout } = await execFileAsync('tesseract', ['--list-langs'], commandOptions(signal, 15000));
    available = String(stdout || '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^[a-z0-9_]+$/i.test(line) && line !== 'osd');
  } catch {
    return requestedText === 'auto' ? 'eng' : requestedText;
  }

  const availableSet = new Set(available);
  if (requestedText !== 'auto') {
    const selected = requestedText.split('+').filter(Boolean).filter(lang => availableSet.has(lang));
    if (selected.length) return selected.join('+');
  }
  if (availableSet.has('ita') && availableSet.has('eng')) return 'ita+eng';
  if (availableSet.has('ita')) return 'ita';
  if (availableSet.has('eng')) return 'eng';
  return available[0] || 'eng';
}

function scoreCandidate(candidate) {
  const stats = textStats(candidate.text);
  if (!stats.text) return -Infinity;
  const density = stats.letters / Math.max(1, stats.chars);
  return stats.letters + (candidate.confidence * 3) + (stats.words * 2) + (density * 80) - (stats.suspicious * 8);
}

async function preprocessImage(input, output, signal) {
  try {
    await execFileAsync('python3', [PREPROCESSOR, input, output], commandOptions(signal, 45000));
    return output;
  } catch {
    return input;
  }
}

async function ocrImage(imagePath, preparedPath, language, signal) {
  const passes = [
    { image: preparedPath, psm: '6' },
    { image: preparedPath, psm: '11' },
    { image: imagePath, psm: '3' },
  ];
  const candidates = [];
  for (const pass of passes) {
    try {
      const { stdout } = await execFileAsync('tesseract', [
        pass.image,
        'stdout',
        '-l', language,
        '--oem', '1',
        '--psm', pass.psm,
        'tsv',
      ], commandOptions(signal, 120000));
      const parsed = parseTesseractTsv(stdout);
      if (parsed.text) candidates.push(parsed);
    } catch {
      // A single failed layout pass should not discard the other OCR passes.
    }
  }
  return candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a))[0] || { text: '', confidence: 0, words: 0 };
}

export async function extractPdfTextWithSuperOcr({
  filePath,
  pageFrom = 1,
  pageTo = null,
  lang = 'auto',
  dpi = DEFAULT_DPI,
  maxChars = 20000,
  maxPages = DEFAULT_MAX_PAGES,
  signal,
  onProgress = () => {},
}) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'ettore-pdf-ocr-'));
  const safeFrom = Math.max(1, Number(pageFrom) || 1);
  let pageCount = null;
  try {
    try {
      const { stdout } = await execFileAsync('pdfinfo', [filePath], commandOptions(signal, 30000));
      pageCount = parsePdfPageCount(stdout);
    } catch {}

    const requestedTo = pageTo == null ? (pageCount || safeFrom + maxPages - 1) : Math.max(safeFrom, Number(pageTo) || safeFrom);
    const safeMaxPages = Math.max(1, Math.min(Number(maxPages) || DEFAULT_MAX_PAGES, DEFAULT_MAX_PAGES));
    const effectiveTo = Math.min(requestedTo, safeFrom + safeMaxPages - 1, pageCount || Number.MAX_SAFE_INTEGER);
    const total = Math.max(0, effectiveTo - safeFrom + 1);
    if (!total) return { text: '', pagesRead: 0, pagesSkipped: 0, language: 'eng', warning: '' };

    const language = await resolveLanguage(lang, signal);
    const chunks = [];
    let pagesSkipped = 0;
    for (let page = safeFrom; page <= effectiveTo; page++) {
      const index = page - safeFrom + 1;
      onProgress(`OCR pagina ${index}/${total}: rendering ${language}…`);
      const prefix = join(tempRoot, `page-${page}`);
      try {
        await execFileAsync('pdftoppm', [
          '-f', String(page),
          '-l', String(page),
          '-r', String(Math.max(150, Math.min(Number(dpi) || DEFAULT_DPI, 600))),
          '-png',
          '-singlefile',
          filePath,
          prefix,
        ], commandOptions(signal, 90000));
        const imagePath = `${prefix}.png`;
        const preparedPath = `${prefix}-prepared.png`;
        onProgress(`OCR pagina ${index}/${total}: preprocessing…`);
        await preprocessImage(imagePath, preparedPath, signal);
        onProgress(`OCR pagina ${index}/${total}: riconoscimento…`);
        const result = await ocrImage(imagePath, preparedPath, language, signal);
        if (result.text) chunks.push(`--- Pagina ${page} ---\n${result.text}`);
        else pagesSkipped++;
      } catch {
        pagesSkipped++;
      }
      if (chunks.join('\n\n').length >= maxChars) break;
    }

    const clipped = pageCount != null && effectiveTo < Math.min(pageTo == null ? pageCount : Number(pageTo), safeFrom + safeMaxPages - 1);
    const warning = clipped || pagesSkipped
      ? `OCR: ${pagesSkipped ? `${pagesSkipped} pagina/e non riconosciuta/e` : ''}${clipped ? `${pagesSkipped ? '; ' : ''}limite ${safeMaxPages} pagine per passaggio` : ''}.`
      : '';
    return {
      text: chunks.join('\n\n').trim(),
      pagesRead: total - pagesSkipped,
      pagesSkipped,
      language,
      warning,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}
