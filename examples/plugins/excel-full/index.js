// excel-full plugin
//
// Full Excel coverage: read, write, edit, create, formulas, styles,
// charts (bar / line / pie / scatter), and a "report" tool that combines
// sheets + formulas + an embedded chart into a one-page deliverable.
//
// Two optional dependencies:
//   xlsx        (SheetJS Community) — workbook I/O
//   pureimage   — synthetic PNG charts (no native bindings, ~150KB)
//
// The plugin never throws raw exceptions to the agent: every handler
// returns either a structured result or a string starting with
// "Error: " so the LLM can surface the message to the user.

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// ── Lazy dependency loaders ─────────────────────────────────────────────
/** A message when the path is unusable, or null. */
function missingFile(path) {
  if (!path || typeof path !== 'string') return 'Error: `path` is required.';
  if (!existsSync(path)) return `Error: no such file: ${path}`;
  return null;
}

// `require` does not exist in an ES module, so every `try { require(...) }`
// below threw ReferenceError and the catch reported it as a missing optional
// dependency — the plugin said xlsx was not installed whether or not it was,
// and no tool here could ever open a workbook. `createRequire` gives a real
// one, synchronous, so the callers stay as they are.
const requirePeer = createRequire(import.meta.url);

/**
 * A formula cell SheetJS will actually write.
 *
 * A cell carrying only `f` is dropped by the writer — it needs a cached value
 * alongside the formula, which is what a spreadsheet stores anyway. Zero is a
 * placeholder: Excel and LibreOffice recalculate on open, so the number is
 * never seen. Without it every formula this plugin produced silently vanished
 * from the file it had just written.
 */
/**
 * A cell value ExcelJS writes as a formula.
 *
 * The leading `=` is how a user types it and not part of the expression, so it
 * is stripped once here rather than at each call site.
 */
function formulaCell(expr) {
  return { formula: String(expr).replace(/^=/, '') };
}

/**
 * ExcelJS, in place of SheetJS.
 *
 * The community build of `xlsx` cannot write cell styles or embed images —
 * both are paid features — so `excel_set_style` reported success while writing
 * nothing, and charts were drawn and then dropped. It also carries two
 * high-severity advisories with no fix available, because SheetJS left npm and
 * 0.18.5 is the last version published there. ExcelJS is maintained, writes
 * what it is given, and reads it back.
 */
function loadExcel() {
  try { return requirePeer('exceljs'); }
  catch (err) {
    // Present but failing to load is a different problem from absent, and
    // "run npm install" would send the reader nowhere.
    if (err?.code !== 'MODULE_NOT_FOUND') throw err;
    throw new Error('optional dependency "exceljs" is not installed. Run `npm install` (or `npm install exceljs`) to enable the excel-full plugin.');
  }
}

/** Opens an existing workbook, or reports why it could not. */
async function openWorkbook(path) {
  const ExcelJS = loadExcel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

/** The named sheet, or an Error message naming the ones that exist. */
function pickSheet(wb, name) {
  if (!name) return wb.worksheets[0] || null;
  return wb.getWorksheet(name) || null;
}

function sheetNames(wb) {
  return wb.worksheets.map(ws => ws.name);
}
function loadPureimage() {
  try { return requirePeer('pureimage'); }
  catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND') throw err;
    throw new Error('optional dependency "pureimage" is not installed. Run `npm install pureimage` to enable chart generation. Other tools work without it.');
  }
}

// ── Coordinate helpers ──────────────────────────────────────────────────
function colToLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
function letterToCol(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) {
    if (ch < 'A' || ch > 'Z') break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}
function parseRange(range) {
  // Accepts "A1:F50" or "B2" (single cell). Returns { r1, c1, r2, c2 } (1-based).
  const m = String(range || '').trim().toUpperCase().match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  if (!m) throw new Error(`Invalid A1 range: ${range}`);
  const c1 = letterToCol(m[1]);
  const r1 = Number(m[2]);
  if (m[3]) return { r1, c1, r2: Number(m[4]), c2: letterToCol(m[3]) };
  return { r1, c1, r2: r1, c2: c1 };
}
function cellRef(r, c) { return `${colToLetter(c)}${r}`; }
function addrToRC(addr) {
  const m = String(addr).toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error(`Invalid cell ref: ${addr}`);
  return { r: Number(m[2]), c: letterToCol(m[1]) };
}

// ── Style helpers ────────────────────────────────────────────────────────
// SheetJS style object uses keys like font: { bold: true, color: { rgb: 'FFFF0000' } },
// fill: { fgColor: { rgb: 'FFFFFF00' } }, alignment: { horizontal: 'center' }, etc.
// We accept a friendlier shape and translate.
/**
 * A colour ExcelJS accepts: eight hex digits, alpha first.
 *
 * Callers write `#RRGGBB` or `RRGGBB`; SheetJS took `rgb` and tolerated six.
 * Left-padding with FF makes the colour opaque, which is what someone writing
 * a hex colour means.
 */
function toArgb(value) {
  const hex = String(value || '').replace('#', '').toUpperCase();
  if (hex.length >= 8) return hex.slice(0, 8);
  return `FF${hex.padStart(6, '0').slice(0, 6)}`;
}

function normalizeStyle(style = {}) {
  if (!style || typeof style !== 'object') return {};
  const out = {};
  if (style.bold || style.italic || style.underline) {
    out.font = out.font || {};
    if (style.bold) out.font.bold = true;
    if (style.italic) out.font.italic = true;
    if (style.underline) out.font.underline = true;
  }
  if (style.font_color || style.color) {
    out.font = out.font || {};
    out.font.color = { argb: toArgb(style.font_color || style.color) };
  }
  if (style.bg_color || style.fill) {
    // ExcelJS needs the pattern type as well as the colour, and drops a fill
    // that omits it.
    out.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: toArgb(style.bg_color || style.fill) } };
  }
  if (style.align) out.alignment = { horizontal: style.align };
  if (style.vertical) out.alignment = { ...(out.alignment || {}), vertical: style.vertical };
  if (style.wrap) out.alignment = { ...(out.alignment || {}), wrapText: true };
  if (style.number_format || style.numFmt) out.numFmt = String(style.number_format || style.numFmt);
  if (style.border) {
    out.border = {};
    for (const side of ['top', 'bottom', 'left', 'right']) {
      if (style.border[side]) {
        out.border[side] = { style: style.border[side].style || 'thin', color: { argb: toArgb(style.border[side].color || '000000') } };
      }
    }
  }
  return out;
}
function applyStyleToRange(ws, range, style) {
  const { r1, c1, r2, c2 } = parseRange(range);
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const cell = ws.getCell(r, c);
      // Assigned property by property: ExcelJS exposes font, fill, alignment,
      // border and numFmt as separate accessors, and replacing `cell.style`
      // wholesale would drop whatever the cell already had.
      if (style.font) cell.font = { ...(cell.font || {}), ...style.font };
      if (style.fill) cell.fill = style.fill;
      if (style.alignment) cell.alignment = { ...(cell.alignment || {}), ...style.alignment };
      if (style.border) cell.border = { ...(cell.border || {}), ...style.border };
      if (style.numFmt) cell.numFmt = style.numFmt;
    }
  }
}

// ── Markdown rendering (for excel_read) ─────────────────────────────────
function cellToMd(value) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : Number(value.toFixed(4)).toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  let s = String(value);
  if (s.length > 200) s = s.slice(0, 197) + '…';
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
/**
 * A sheet as a markdown table.
 *
 * A formula cell reads back as `{ formula, result }` in ExcelJS, so the
 * rendered value is the cached result where there is one and the formula text
 * otherwise — showing `[object Object]` would be worse than either.
 */
function sheetToMarkdown(sheet, { maxRows = 200, maxCols = 40 } = {}) {
  const lastRow = Math.min(sheet.rowCount || 0, maxRows);
  const lastCol = Math.min(sheet.columnCount || 0, maxCols);
  if (!lastRow || !lastCol) return '(empty sheet)';
  const header = ['Cell', ...Array.from({ length: lastCol }, (_, i) => colToLetter(i + 1))];
  const lines = ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |'];
  for (let r = 1; r <= lastRow; r++) {
    const cells = [String(r)];
    for (let c = 1; c <= lastCol; c++) cells.push(cellToMd(readCellValue(sheet.getCell(r, c))));
    lines.push('| ' + cells.join(' | ') + ' |');
  }
  if ((sheet.rowCount || 0) > lastRow) lines.push(`| … | ${sheet.rowCount - lastRow} more rows |`);
  return lines.join('\n');
}

/** The same table, bounded to an explicit A1 range. */
function sheetRangeToMarkdown(sheet, { r1, c1, r2, c2 }, { maxRows = 200, maxCols = 40 } = {}) {
  const lastRow = Math.min(r2, r1 + maxRows - 1);
  const lastCol = Math.min(c2, c1 + maxCols - 1);
  const header = ['Cell', ...Array.from({ length: lastCol - c1 + 1 }, (_, i) => colToLetter(c1 + i))];
  const lines = ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |'];
  for (let r = r1; r <= lastRow; r++) {
    const cells = [String(r)];
    for (let c = c1; c <= lastCol; c++) cells.push(cellToMd(readCellValue(sheet.getCell(r, c))));
    lines.push('| ' + cells.join(' | ') + ' |');
  }
  return lines.join('\n');
}

/** The value of a cell, resolving the shapes ExcelJS uses for formulas and links. */
function readCellValue(cell) {
  const v = cell?.value;
  if (v == null) return null;
  if (typeof v === 'object') {
    if ('result' in v) return v.result;
    if ('formula' in v) return `=${v.formula}`;
    if ('text' in v) return v.text;                       // hyperlink
    if ('richText' in v) return v.richText.map(t => t.text).join('');
    if (v instanceof Date) return v;
    if ('error' in v) return v.error;
  }
  return v;
}

// ── Chart rendering via pureimage ──────────────────────────────────────
//
// The chart renderer reads its data from a sheet range in the workbook
// itself, so the agent only has to describe the type, title, and target
// cells — not provide the numeric data twice. The rendered PNG is
// embedded back into the workbook at `image_cell`.
async function renderChart({ wb, sheet, dataRange, type, title, xLabel, yLabel, width = 800, height = 500, palette }) {
  const PI = loadPureimage();
  const ws = wb.getWorksheet(sheet);
  if (!ws) throw new Error(`sheet "${sheet}" not found`);
  if (!ws.rowCount) throw new Error('sheet is empty — nothing to chart');
  const bounds = dataRange
    ? parseRange(dataRange)
    : { r1: 1, c1: 1, r2: ws.rowCount, c2: ws.columnCount };
  // First row = labels (x-axis), first column = optional category labels,
  // remaining cells = values. The convention is the standard pivot:
  //   row 0:        ["",   "Series A", "Series B"]
  //   row 1..N:     ["X1", 10,         20]
  // If the first column has no header, we skip it.
  const raw = [];
  for (let r = bounds.r1; r <= bounds.r2; r++) {
    const row = [];
    for (let c = bounds.c1; c <= bounds.c2; c++) row.push(readCellValue(ws.getCell(r, c)));
    raw.push(row);
  }
  if (raw.length < 2) throw new Error('need at least one header row and one data row');
  const headerRow = raw[0];
  const hasCategoryCol = headerRow[0] === '' || headerRow[0] == null;
  const seriesNames = hasCategoryCol ? headerRow.slice(1) : headerRow;
  const dataRows = raw.slice(1);
  const categories = dataRows.map((r) => String(hasCategoryCol ? r[0] : r[0]));
  const data = dataRows.map((r) => (hasCategoryCol ? r.slice(1) : r));

  const colors = palette && Array.isArray(palette) && palette.length
    ? palette
    : ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f'];

  // pureimage's constructor is `make`; `createCanvas` is the browser/node-canvas
  // name and does not exist here, so every chart threw before drawing a pixel.
  const img = PI.make(width, height);
  const ctx = img.getContext('2d');
  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  // Title
  if (title) {
    ctx.fillStyle = '#000000';
    ctx.font = '24px sans-serif';
    const tw = Math.min(width - 40, 800);
    ctx.fillText(title, (width - tw) / 2, 32);
  }
  // Compute the max value across all data series
  const allValues = data.flat();
  const maxValue = Math.max(1, ...allValues.map((v) => Number(v) || 0));
  const left = 80, right = width - 20, top = 60, bottom = height - 60;
  const plotW = right - left, plotH = bottom - top;

  // Helper: draw axis lines
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottom);
  ctx.lineTo(right, bottom);
  ctx.stroke();

  // Y-axis ticks + labels (5 ticks)
  ctx.fillStyle = '#333';
  ctx.font = '12px sans-serif';
  for (let i = 0; i <= 5; i++) {
    const v = (maxValue * i) / 5;
    const y = bottom - (plotH * i) / 5;
    ctx.fillText(formatTick(v), left - 60, y + 4);
    ctx.strokeStyle = '#eee';
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  // Y label
  if (yLabel) { ctx.save(); ctx.translate(20, (top + bottom) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(yLabel, -60, 0); ctx.restore(); }
  // X label
  if (xLabel) { ctx.fillText(xLabel, (left + right) / 2 - 20, height - 20); }

  if (type === 'bar' || type === 'column') {
    const isBar = type === 'bar';
    const groupCount = categories.length;
    const seriesCount = seriesNames.length;
    const totalSlots = isBar ? groupCount * seriesCount : groupCount;
    const slotW = (isBar ? plotH : plotW) / totalSlots;
    const innerW = slotW * 0.7;
    for (let gi = 0; gi < groupCount; gi++) {
      for (let si = 0; si < seriesCount; si++) {
        const v = Number(data[gi][si]) || 0;
        const h = (plotH * v) / maxValue;
        const w = (plotW * v) / maxValue;
        ctx.fillStyle = colors[si % colors.length];
        if (isBar) {
          const x = left + 6 + gi * slotW;
          const y = bottom - h;
          ctx.fillRect(x, y, innerW, h);
        } else {
          const x = left + gi * slotW;
          const y = bottom - h;
          ctx.fillRect(x, y, innerW, h);
        }
      }
      // Category label
      ctx.fillStyle = '#333';
      const labelX = isBar ? bottom + 14 : left + gi * slotW + (slotW * seriesCount) / 2 - 20;
      const labelY = isBar ? 0 : bottom + 14;
      if (isBar) { ctx.save(); ctx.translate(bottom + 14, left + gi * slotW + 4); ctx.rotate(Math.PI / 2); ctx.fillText(truncate(categories[gi], 20), 0, 0); ctx.restore(); }
      else { ctx.fillText(truncate(categories[gi], 20), labelX, labelY); }
    }
  } else if (type === 'line') {
    const seriesCount = seriesNames.length;
    for (let si = 0; si < seriesCount; si++) {
      ctx.strokeStyle = colors[si % colors.length];
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let gi = 0; gi < categories.length; gi++) {
        const v = Number(data[gi][si]) || 0;
        const x = left + (plotW * gi) / Math.max(1, categories.length - 1);
        const y = bottom - (plotH * v) / maxValue;
        if (gi === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // Markers
      for (let gi = 0; gi < categories.length; gi++) {
        const v = Number(data[gi][si]) || 0;
        const x = left + (plotW * gi) / Math.max(1, categories.length - 1);
        const y = bottom - (plotH * v) / maxValue;
        ctx.fillStyle = colors[si % colors.length];
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // X labels
    ctx.fillStyle = '#333';
    for (let gi = 0; gi < categories.length; gi++) {
      const x = left + (plotW * gi) / Math.max(1, categories.length - 1);
      ctx.fillText(truncate(categories[gi], 12), x - 20, bottom + 14);
    }
  } else if (type === 'pie') {
    // Single-series pie. We average across all series.
    const values = data.flat().map((v) => Math.max(0, Number(v) || 0));
    const total = Math.max(1e-9, values.reduce((a, b) => a + b, 0));
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const radius = Math.min(plotW, plotH) / 2 - 20;
    let angle = -Math.PI / 2;
    for (let i = 0; i < values.length; i++) {
      const slice = (values[i] / total) * Math.PI * 2;
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, angle, angle + slice);
      ctx.closePath();
      ctx.fill();
      // Label outside the slice
      const mid = angle + slice / 2;
      const lx = cx + Math.cos(mid) * (radius + 12);
      const ly = cy + Math.sin(mid) * (radius + 12);
      ctx.fillStyle = '#000';
      ctx.font = '12px sans-serif';
      const pct = ((values[i] / total) * 100).toFixed(0);
      ctx.fillText(`${truncate(categories[i] || '', 12)} ${pct}%`, lx - 30, ly);
      angle += slice;
    }
  } else if (type === 'scatter') {
    const seriesCount = seriesNames.length;
    for (let si = 0; si < seriesCount; si++) {
      ctx.fillStyle = colors[si % colors.length];
      for (let gi = 0; gi < categories.length; gi++) {
        const v = Number(data[gi][si]) || 0;
        const x = left + (plotW * gi) / Math.max(1, categories.length - 1);
        const y = bottom - (plotH * v) / maxValue;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else {
    throw new Error(`unknown chart type "${type}". Use one of: bar, column, line, pie, scatter`);
  }

  // Legend
  const legendY = height - 30;
  let lx = left;
  ctx.font = '12px sans-serif';
  for (let si = 0; si < seriesNames.length; si++) {
    ctx.fillStyle = colors[si % colors.length];
    ctx.fillRect(lx, legendY - 8, 12, 12);
    ctx.fillStyle = '#000';
    ctx.fillText(String(seriesNames[si] || ''), lx + 16, legendY + 2);
    lx += 24 + String(seriesNames[si] || '').length * 7;
  }

  // Render to a buffer
  // pureimage encodes to a stream, not to a buffer — `encodePNGToBuffer` does
  // not exist, so chart generation threw at the last step after doing all the
  // drawing work.
  const { PassThrough } = await import('node:stream');
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  await PI.encodePNGToStream(img, out);
  return Buffer.concat(chunks);
}
function formatTick(v) {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v * 100) / 100);
}
function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ── Report builder ──────────────────────────────────────────────────────
//
// A "report" is a workbook that combines: a summary sheet, a detail
// sheet, totals via formulas, and an embedded chart. The agent passes
// a `template` name (which selects the layout) and the actual data;
// the plugin wires it up.
const REPORT_TEMPLATES = {
  simple: ({ title, rows, groupBy }) => ({
    Summary: [
      [title || 'Report', '', '', ''],
      ['Generated', new Date().toISOString().slice(0, 10), '', ''],
      ['', '', '', ''],
      ['Group', 'Count', 'Total', 'Average'],
      ...aggregate(rows, groupBy, ['count', 'sum:Amount', 'avg:Amount']),
    ],
    Detail: rows.length ? [['#', ...Object.keys(rows[0] || {})], ...rows.map((r, i) => [i + 1, ...Object.values(r || {})])] : [['#', '(no rows)']],
  }),
  sales: ({ title, rows, currency = 'EUR' }) => {
    const totalRow = rows.length;
    return {
      Summary: [
        [title || 'Sales Report', '', '', ''],
        ['Currency', currency, '', ''],
        ['Generated', new Date().toISOString().slice(0, 10), '', ''],
        ['', '', '', ''],
        ['Metric', 'Value', '', ''],
        ['Total rows', { f: `COUNTA(Detail!A2:A${totalRow + 1})` }, '', ''],
        ['Sum of Amount', { f: `SUM(Detail!D2:D${totalRow + 1})` }, '', ''],
        ['Average', { f: `AVERAGE(Detail!D2:D${totalRow + 1})` }, '', ''],
        ['Min', { f: `MIN(Detail!D2:D${totalRow + 1})` }, '', ''],
        ['Max', { f: `MAX(Detail!D2:D${totalRow + 1})` }, '', ''],
      ],
      Detail: [['Row', 'Date', 'Category', 'Amount', 'Status'], ...rows.map((r, i) => [i + 1, r.Date || '', r.Category || '', r.Amount || 0, r.Status || ''])],
    };
  },
};
function aggregate(rows, groupBy, ops) {
  const groups = new Map();
  for (const r of rows) {
    const k = groupBy ? String(r[groupBy] || '(empty)') : 'all';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].map(([k, items]) => {
    const row = [k, items.length];
    for (const op of ops) {
      const [kind, field] = op.split(':');
      const nums = items.map((r) => Number(r[field]) || 0).filter((n) => Number.isFinite(n));
      if (kind === 'count') row.push(items.length);
      else if (kind === 'sum') row.push(nums.reduce((a, b) => a + b, 0));
      else if (kind === 'avg') row.push(nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0);
      else if (kind === 'min') row.push(nums.length ? Math.min(...nums) : 0);
      else if (kind === 'max') row.push(nums.length ? Math.max(...nums) : 0);
    }
    return row;
  });
}

// ── Tools ───────────────────────────────────────────────────────────────
export const tools = {
  excel_info: {
    description: 'Get workbook metadata: sheet names, dimensions per sheet, defined names, and creator. Use this as the first call to understand a file before editing.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async ({ path } = {}) => {
      // Checked before the optional dependency: a typo'd path answered with
      // "install xlsx" sends the reader after the wrong problem, and the file
      // being missing is knowable without the library.
      const missing = missingFile(path);
      if (missing) return missing;
      const wb = await openWorkbook(path);
      return {
        path,
        sheet_count: wb.worksheets.length,
        sheets: wb.worksheets.map(ws => ({ sheet: ws.name, rows: ws.rowCount, cols: ws.columnCount })),
        defined_names: Object.keys(wb.definedNames?.matrixMap || {}),
        creator: wb.creator || null,
        modified: wb.modified ? new Date(wb.modified).toISOString() : null,
      };
    },
  },

  excel_read: {
    description: 'Return a sheet as a markdown table. Columns are A, B, C, …; first column is the row number.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string', description: 'Sheet name. Default: first.' },
        range: { type: 'string', description: 'A1 range like "A1:F50". Default: full sheet.' },
        max_rows: { type: 'integer', default: 200, minimum: 1, maximum: 5000 },
        max_cols: { type: 'integer', default: 40, minimum: 1, maximum: 200 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async ({ path, sheet, range, max_rows = 200, max_cols = 40 } = {}) => {
      const missing = missingFile(path);
      if (missing) return missing;
      const wb = await openWorkbook(path);
      const ws = pickSheet(wb, sheet);
      if (!ws) return `Error: sheet "${sheet}" not found. Available: ${sheetNames(wb).join(', ')}`;
      // A range narrows what is rendered rather than what is read: ExcelJS has
      // the whole sheet in memory either way, and slicing here keeps one code
      // path instead of two.
      if (range) {
        const { r1, c1, r2, c2 } = parseRange(range);
        return sheetRangeToMarkdown(ws, { r1, c1, r2, c2 }, { maxRows: max_rows, maxCols: max_cols });
      }
      return sheetToMarkdown(ws, { maxRows: max_rows, maxCols: max_cols });
    },
  },

  excel_search: {
    description: 'Search a substring across all sheets. Returns sheet!cell references with their value.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        query: { type: 'string' },
        max_results: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
      },
      required: ['path', 'query'],
      additionalProperties: false,
    },
    handler: async ({ path, query, max_results = 50 } = {}) => {
      const missing = missingFile(path);
      if (missing) return missing;
      const wb = await openWorkbook(path);
      const needle = String(query).toLowerCase();
      const out = [];
      for (const ws of wb.worksheets) {
        // eachRow skips empty rows, so a sparse sheet costs its used cells
        // rather than its declared dimensions.
        ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          if (out.length >= max_results) return;
          row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            if (out.length >= max_results) return;
            const value = readCellValue(cell);
            if (value == null) return;
            if (String(value).toLowerCase().includes(needle)) {
              out.push({ sheet: ws.name, cell: cellRef(rowNumber, colNumber), value: cellToMd(value) });
            }
          });
        });
      }
      return out.length ? `${out.length} match(es):\n` + out.map((m) => `  ${m.sheet}!${m.cell}  →  ${m.value}`).join('\n') : `No matches for "${query}".`;
    },
  },

  excel_create: {
    description: 'Create a new .xlsx workbook. `sheets` is an array of { name, headers, rows, formulas? } objects. `formulas` is an optional { cell: formula } map. Cells whose value starts with "=" are treated as formulas automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Destination path. Will be created (parent dirs too).' },
        sheets: { type: 'array', description: 'Array of sheet definitions.' },
        sheet: { type: 'object', description: 'Convenience: if `sheets` is empty, build a single sheet from this object.' },
        title: { type: 'string', description: 'Optional workbook title (saved as a custom property).' },
      },
      additionalProperties: false,
    },
    handler: async ({ path, sheets, sheet, title } = {}) => {
      const ExcelJS = loadExcel();
      const defs = sheets && sheets.length ? sheets : (sheet ? [sheet] : []);
      if (!defs.length) return 'Error: provide either `sheets` (array) or `sheet` (single object).';
      const wb = new ExcelJS.Workbook();
      for (const def of defs) {
        if (!def || !def.name) return 'Error: every sheet needs a name';
        const headers = def.headers || [];
        const rows = def.rows || [];
        const ws = wb.addWorksheet(String(def.name).slice(0, 31));
        // Written row by row so a cell whose text starts with "=" becomes a
        // formula rather than a string that merely looks like one.
        for (const source of [headers, ...rows]) {
          if (!Array.isArray(source)) continue;
          ws.addRow(source.map(v => (typeof v === 'string' && v.startsWith('=') ? formulaCell(v) : v)));
        }
        // Optional explicit formula map: { "A1": "=SUM(B1:B10)" }. It may name a
        // cell past the rows it was given — a totals line under the data is the
        // obvious case — and ExcelJS grows the sheet to meet it, where the
        // previous library dropped anything outside the declared range.
        if (def.formulas && typeof def.formulas === 'object') {
          for (const [addr, formula] of Object.entries(def.formulas)) {
            const rc = addrToRC(addr);
            ws.getCell(rc.r, rc.c).value = formulaCell(formula);
          }
        }
      }
      if (title) wb.title = title;
      mkdirSync(dirname(path), { recursive: true });
      await wb.xlsx.writeFile(path);
      return `Created ${defs.length}-sheet workbook at ${path} (${sheetNames(wb).join(', ')}).`;
    },
  },

  excel_update_cells: {
    description: 'Update a range of cells. `values` is a 2D array of strings/numbers/formulas (cells starting with "=" become Excel formulas). Existing file is required; use excel_create for new files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string' },
        range: { type: 'string', description: 'Top-left of the range, e.g. "B2". If `values` is a single row, range can be a single cell.' },
        values: { type: 'array', description: '2D array (rows × cols) of values.' },
        style: { type: 'object', description: 'Optional style to apply to the written range. See excel_set_style.' },
      },
      required: ['path', 'sheet', 'range', 'values'],
      additionalProperties: false,
    },
    handler: async ({ path, sheet, range, values, style } = {}) => {
      const missing = missingFile(path);
      if (missing) return missing;
      const wb = await openWorkbook(path);
      const ws = pickSheet(wb, sheet);
      if (!ws) return `Error: sheet "${sheet}" not found. Available: ${sheetNames(wb).join(', ')}`;
      if (!Array.isArray(values) || !values.length) return 'Error: values must be a non-empty 2D array';
      const top = parseRange(range);
      const rowCount = values.length;
      const colCount = Math.max(...values.map(r => (Array.isArray(r) ? r.length : 1)));

      for (let r = 0; r < rowCount; r++) {
        for (let c = 0; c < colCount; c++) {
          const raw = Array.isArray(values[r]) ? values[r][c] : values[r];
          const cell = ws.getCell(top.r1 + r, top.c1 + c);
          if (raw == null) cell.value = null;
          else if (typeof raw === 'string' && raw.startsWith('=')) cell.value = formulaCell(raw);
          else cell.value = raw;
        }
      }
      if (style && typeof style === 'object') {
        const endRef = `${cellRef(top.r1, top.c1)}:${cellRef(top.r1 + rowCount - 1, top.c1 + colCount - 1)}`;
        applyStyleToRange(ws, endRef, normalizeStyle(style));
      }
      await wb.xlsx.writeFile(path);
      return `Wrote ${rowCount}×${colCount} cells into ${ws.name}!${range}.`;
    },
  },

  excel_append_rows: {
    description: 'Append one or more rows at the end of a sheet. Each row is an array of values. Existing file required.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string' },
        rows: { type: 'array', description: 'Array of arrays (each inner array is a row).' },
      },
      required: ['path', 'sheet', 'rows'],
      additionalProperties: false,
    },
    handler: async ({ path, sheet, rows } = {}) => {
      const missing = missingFile(path);
      if (missing) return missing;
      if (!Array.isArray(rows) || !rows.length) return 'Error: rows must be a non-empty array';
      const wb = await openWorkbook(path);
      const ws = pickSheet(wb, sheet);
      if (!ws) return `Error: sheet "${sheet}" not found. Available: ${sheetNames(wb).join(', ')}`;
      const startRow = ws.rowCount + 1;
      for (const row of rows) {
        const source = Array.isArray(row) ? row : [row];
        ws.addRow(source.map(v => (typeof v === 'string' && v.startsWith('=') ? formulaCell(v) : v)));
      }
      await wb.xlsx.writeFile(path);
      return `Appended ${rows.length} row(s) to ${ws.name} starting at row ${startRow}.`;
    },
  },

  excel_delete_rows: {
    description: 'Delete a range of rows from a sheet. Rows are referenced by 1-based row number (e.g. "5-8" or just "5" for one row).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string' },
        start_row: { type: 'integer', minimum: 1 },
        end_row: { type: 'integer', minimum: 1, description: 'Optional. Default: same as start_row.' },
      },
      required: ['path', 'sheet', 'start_row'],
      additionalProperties: false,
    },
    handler: async ({ path, sheet, start_row, end_row } = {}) => {
      const missing = missingFile(path);
      if (missing) return missing;
      const wb = await openWorkbook(path);
      const ws = pickSheet(wb, sheet);
      if (!ws) return `Error: sheet "${sheet}" not found. Available: ${sheetNames(wb).join(', ')}`;
      const start = Number(start_row);
      const end = Number(end_row || start_row);
      if (!Number.isFinite(start) || start < 1) return 'Error: start_row must be a row number, 1 or greater';
      if (end < start) return 'Error: end_row cannot be before start_row';
      if (start > ws.rowCount) return `Error: sheet has ${ws.rowCount} rows; nothing at row ${start}`;
      const count = Math.min(end, ws.rowCount) - start + 1;
      // spliceRows shifts everything below up and takes the formulas with it,
      // which the previous implementation had to do by hand — and got wrong at
      // the boundary, leaving the sheet one row longer than it should be.
      ws.spliceRows(start, count);
      await wb.xlsx.writeFile(path);
      return `Deleted ${count} row(s) from ${ws.name} (rows ${start}-${start + count - 1}). ${ws.rowCount} row(s) remain.`;
    },
  },

  excel_add_sheet: {
    description: 'Add a new sheet to an existing workbook. `data` is an array of rows, `headers` is the first row.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet_name: { type: 'string', description: 'Name of the new sheet (max 31 chars).' },
        headers: { type: 'array' },
        data: { type: 'array' },
      },
      required: ['path', 'sheet_name'],
      additionalProperties: false,
    },
    handler: async ({ path, sheet_name, headers = [], data = [] } = {}) => {
      const missing = missingFile(path);
      if (missing) return missing;
      const wb = await openWorkbook(path);
      const name = String(sheet_name || '').slice(0, 31);
      if (!name) return 'Error: sheet_name is required';
      if (sheetNames(wb).includes(name)) return `Error: sheet "${name}" already exists`;
      const ws = wb.addWorksheet(name);
      for (const source of [headers, ...data]) {
        if (!Array.isArray(source) || !source.length) continue;
        ws.addRow(source.map(v => (typeof v === 'string' && v.startsWith('=') ? formulaCell(v) : v)));
      }
      await wb.xlsx.writeFile(path);
      return `Added sheet "${name}" with ${data.length} row(s).`;
    },
  },

  excel_remove_sheet: {
    description: 'Remove a sheet from a workbook.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, sheet: { type: 'string' } },
      required: ['path', 'sheet'],
      additionalProperties: false,
    },
    handler: async ({ path, sheet } = {}) => {
      const missing = missingFile(path);
      if (missing) return missing;
      const wb = await openWorkbook(path);
      const ws = pickSheet(wb, sheet);
      if (!ws) return `Error: sheet "${sheet}" not found. Available: ${sheetNames(wb).join(', ')}`;
      if (wb.worksheets.length === 1) return 'Error: cannot remove the last sheet in a workbook';
      wb.removeWorksheet(ws.id);
      await wb.xlsx.writeFile(path);
      return `Removed sheet "${sheet}". Remaining: ${sheetNames(wb).join(', ')}.`;
    },
  },

  excel_rename_sheet: {
    description: 'Rename a sheet. Name must be 1-31 characters and not collide with an existing sheet.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, sheet: { type: 'string' }, new_name: { type: 'string' } },
      required: ['path', 'sheet', 'new_name'],
      additionalProperties: false,
    },
    handler: async ({ path, sheet, new_name } = {}) => {
      const missing = missingFile(path);
      if (missing) return missing;
      const wb = await openWorkbook(path);
      const ws = pickSheet(wb, sheet);
      if (!ws) return `Error: sheet "${sheet}" not found. Available: ${sheetNames(wb).join(', ')}`;
      const next = String(new_name || '').slice(0, 31);
      if (!next) return 'Error: new_name is required';
      if (sheetNames(wb).includes(next)) return `Error: sheet "${next}" already exists`;
      ws.name = next;
      await wb.xlsx.writeFile(path);
      return `Renamed "${sheet}" → "${next}".`;
    },
  },

  excel_set_style: {
    description: 'Apply styling to a range. Style options: bold, italic, underline, color (RRGGBB or #RRGGBB), bg_color, align (left/center/right), vertical (top/middle/bottom), wrap, number_format (e.g. "#,##0.00" or "0.00%"), border ({ top, bottom, left, right } each with style+color).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string' },
        range: { type: 'string' },
        style: { type: 'object' },
      },
      required: ['path', 'sheet', 'range', 'style'],
      additionalProperties: false,
    },
    handler: async ({ path, sheet, range, style } = {}) => {
      const missing = missingFile(path);
      if (missing) return missing;
      const wb = await openWorkbook(path);
      const ws = pickSheet(wb, sheet);
      if (!ws) return `Error: sheet "${sheet}" not found. Available: ${sheetNames(wb).join(', ')}`;
      const normalized = normalizeStyle(style);
      if (!Object.keys(normalized).length) return 'Error: style is empty. See the tool description for the supported keys.';
      applyStyleToRange(ws, range, normalized);
      await wb.xlsx.writeFile(path);
      // The previous library reported this same success and wrote nothing:
      // cell styling is a paid feature there, so the file came back unstyled.
      return `Applied style to ${ws.name}!${range}: ${Object.keys(normalized).join(', ')}.`;
    },
  },

  excel_make_chart: {
    description: 'Generate a chart from a sheet range and embed it as a PNG image in the workbook. Chart types: bar, column, line, pie, scatter. The range must follow the convention: row 0 = ["", series1, series2, …], rows 1..N = [category, value1, value2, …] (or [label, value, value, …] if there is no category column).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string' },
        type: { type: 'string', enum: ['bar', 'column', 'line', 'pie', 'scatter'] },
        title: { type: 'string' },
        x_label: { type: 'string' },
        y_label: { type: 'string' },
        data_range: { type: 'string', description: 'A1 range to read the chart data from. Default: the full sheet.' },
        image_cell: { type: 'string', description: 'Top-left cell where the PNG will be anchored (the image takes ~16 rows below the anchor).' },
        width: { type: 'integer', default: 800, minimum: 200, maximum: 2000 },
        height: { type: 'integer', default: 500, minimum: 200, maximum: 2000 },
        palette: { type: 'array', description: 'Array of hex colors for the series. Default: a palette tuned for readability.' },
      },
      required: ['path', 'sheet', 'type', 'image_cell'],
      additionalProperties: false,
    },
    handler: async ({ path, sheet, type, title, x_label, y_label, data_range, image_cell, width = 800, height = 500, palette } = {}) => {
      const missing = missingFile(path);
      if (missing) return missing;
      const wb = await openWorkbook(path);
      const ws = pickSheet(wb, sheet);
      if (!ws) return `Error: sheet "${sheet}" not found. Available: ${sheetNames(wb).join(', ')}`;
      const buf = await renderChart({ wb, sheet: ws.name, dataRange: data_range, type, title, xLabel: x_label, yLabel: y_label, width, height, palette });
      const rc = addrToRC(image_cell);
      // A real embed, which the previous library could not do: images are a
      // paid feature there, so the PNG was drawn, attached to a structure the
      // writer ignored, and lost on save.
      const imageId = wb.addImage({ buffer: buf, extension: 'png' });
      ws.addImage(imageId, {
        tl: { col: rc.c - 1, row: rc.r - 1 },
        ext: { width, height },
      });
      await wb.xlsx.writeFile(path);
      return `Inserted ${type} chart at ${ws.name}!${image_cell} (${width}×${height}px).`;
    },
  },

  excel_report: {
    description: 'Generate a one-page report workbook from a data array. Templates: "simple" (group-by summary + detail) or "sales" (totals via formulas + detail). Output is written to `output_path`.',
    parameters: {
      type: 'object',
      properties: {
        output_path: { type: 'string' },
        template: { type: 'string', enum: ['simple', 'sales'], default: 'simple' },
        title: { type: 'string' },
        rows: { type: 'array', description: 'Array of row objects. Each object is one row; keys are column headers.' },
        group_by: { type: 'string', description: 'For template=simple, the field to group rows by.' },
        currency: { type: 'string', default: 'EUR' },
      },
      required: ['output_path', 'rows'],
      additionalProperties: false,
    },
    handler: async ({ output_path, template = 'simple', title, rows = [], group_by, currency } = {}) => {
      const ExcelJS = loadExcel();
      const tmpl = REPORT_TEMPLATES[template];
      if (!tmpl) return `Error: unknown template "${template}". Use one of: ${Object.keys(REPORT_TEMPLATES).join(', ')}`;
      const sheets = tmpl({ title, rows, groupBy: group_by, currency });
      const wb = new ExcelJS.Workbook();
      for (const [name, data] of Object.entries(sheets)) {
        const ws = wb.addWorksheet(name);
        for (const row of data) {
          // The templates express a formula as `{ f: 'SUM(...)' }`; ExcelJS
          // wants `{ formula: ... }`, and a string beginning with "=" is a
          // formula too.
          ws.addRow((row || []).map((v) => {
            if (v && typeof v === 'object' && v.f) return formulaCell(v.f);
            if (typeof v === 'string' && v.startsWith('=')) return formulaCell(v);
            return v;
          }));
        }
      }
      mkdirSync(dirname(output_path), { recursive: true });
      await wb.xlsx.writeFile(output_path);
      return `Wrote ${template} report to ${output_path} (${rows.length} row(s), sheets: ${Object.keys(sheets).join(', ')}).`;
    },
  },
};

export const hooks = {
  onLoad: async (api) => {
    const missing = [];
    // `resolve` rather than a load: this only reports what is available, and
    // importing a large workbook library to answer that would be wasteful.
    try { requirePeer.resolve('exceljs'); } catch { missing.push('exceljs'); }
    try { requirePeer.resolve('pureimage'); } catch { missing.push('pureimage'); }
    if (missing.length === 2) {
      api.log('warn', 'excel-full loaded but no dependency is installed. Run `npm install` to enable all features.');
    } else if (missing.length) {
      api.log('warn', `excel-full missing optional dep(s): ${missing.join(', ')}. Run \`npm install ${missing.join(' ')}\` to enable those features.`);
    } else {
      api.log('info', 'excel-full loaded — 12 tools (read/write/edit/formulas/styles/charts/reports)');
    }
  },
};
