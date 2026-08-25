import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLikelyUsablePdfText, parsePdfPageCount, parseTesseractTsv } from '../src/tools/pdf-ocr.js';

test('pdf OCR: detects when native PDF text is too sparse for a scanned document', () => {
  assert.equal(isLikelyUsablePdfText('short text'), false);
  assert.equal(isLikelyUsablePdfText(
    'This is a sufficiently long selectable PDF paragraph with enough words and normal punctuation to be considered reliable native text extraction.'
  ), true);
});

test('pdf OCR: parses page count from pdfinfo output', () => {
  assert.equal(parsePdfPageCount('Title: report\nPages: 42\nEncrypted: no'), 42);
  assert.equal(parsePdfPageCount('Title: report'), null);
});

test('pdf OCR: reconstructs readable lines and confidence from Tesseract TSV', () => {
  const tsv = [
    'level\tpage\tblock\tpar\tline\tword\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t0\t0\t40\t20\t96.5\tHello',
    '5\t1\t1\t1\t1\t2\t45\t0\t40\t20\t92.0\tworld',
    '5\t1\t1\t1\t2\t1\t0\t30\t40\t20\t88.0\tAgain',
  ].join('\n');
  const result = parseTesseractTsv(tsv);
  assert.equal(result.text, 'Hello world\nAgain');
  assert.equal(result.words, 3);
  assert.equal(result.confidence, (96.5 + 92 + 88) / 3);
});
