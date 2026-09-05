// Tests for the excel-full plugin.
//
// Coverage:
//   - contract: manifest shape, entry point imports
//   - read: excel_info, excel_read, excel_search
//   - write: excel_create, excel_update_cells, excel_append_rows,
//            excel_delete_rows, excel_add_sheet, excel_remove_sheet,
//            excel_rename_sheet
//   - formulas: excel_create with formulas map; excel_update_cells
//               with cells starting with "="
//   - styles: excel_set_style with bold + color + number_format
//   - reports: excel_report with both "simple" and "sales" templates
//
// Tests gracefully skip the xlsx/pureimage specific assertions when
// the optional deps are not installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
// `require.resolve` does not exist in an ES module: the guards below used
// it bare, so they always reported the dependency as missing and every
// test that needed it skipped — even once it was installed.
const requirePeer = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// The plugin moved from SheetJS to ExcelJS, because the community build of
// `xlsx` writes neither cell styles nor embedded images — both paid features —
// and carries two high-severity advisories with no fix available. These
// helpers build and inspect fixtures through the same library the plugin uses,
// so a test verifies what the file actually contains rather than what a second
// reader makes of it.
async function makeWorkbook(path, sheets) {
  const ExcelJS = requirePeer('exceljs');
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) ws.addRow(row);
  }
  await wb.xlsx.writeFile(path);
  return wb;
}

async function openWorkbook(path) {
  const ExcelJS = requirePeer('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

/** The formula on a cell, or undefined — ExcelJS stores it as `{ formula }`. */
function formulaOf(ws, addr) {
  const v = ws.getCell(addr).value;
  return v && typeof v === 'object' ? v.formula : undefined;
}

/** The plain value of a cell, resolving a formula to its cached result. */
function valueOf(ws, addr) {
  const v = ws.getCell(addr).value;
  if (v && typeof v === 'object' && 'result' in v) return v.result;
  return v;
}

function hasXlsx() { try { requirePeer.resolve('exceljs'); return true; } catch { return false; } }
function hasPureimage() { try { requirePeer.resolve('pureimage'); return true; } catch { return false; } }

async function loadPlugin() {
  const entry = join(REPO_ROOT, 'examples', 'plugins', 'excel-full', 'index.js');
  const mod = await import(`${pathToFileURL(entry).href}?bust=${Date.now()}-${Math.random()}`);
  return (mod.default && typeof mod.default === 'object') ? mod.default : mod;
}

// ── Contract ────────────────────────────────────────────────────────────
test('excel-full: manifest is well-formed and declares both deps in package.json', () => {
  const p = join(REPO_ROOT, 'examples', 'plugins', 'excel-full', 'plugin.json');
  const json = JSON.parse(readFileSync(p, 'utf-8'));
  assert.equal(json.name, 'excel-full');
  assert.match(json.version, /^\d+\.\d+\.\d+/);
  assert.equal(json.apiVersion, '1');
  assert.ok(json.permissions.includes('fs:read'));
  assert.ok(json.permissions.includes('fs:write'));
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
  assert.ok(pkg.optionalDependencies.exceljs, 'xlsx must be in optionalDependencies');
  assert.ok(pkg.optionalDependencies.pureimage, 'pureimage must be in optionalDependencies');
});

test('excel-full: entry point imports and declares 12 tools', async () => {
  const bag = await loadPlugin();
  for (const name of [
    'excel_info', 'excel_read', 'excel_search', 'excel_create', 'excel_update_cells',
    'excel_append_rows', 'excel_delete_rows', 'excel_add_sheet', 'excel_remove_sheet',
    'excel_rename_sheet', 'excel_set_style', 'excel_make_chart', 'excel_report',
  ]) {
    assert.ok(bag.tools[name], `missing tool: ${name}`);
  }
  assert.equal(typeof bag.hooks.onLoad, 'function');
});

// ── Read ───────────────────────────────────────────────────────────────
test('excel-full: excel_info, excel_read, excel_search on a real workbook', { skip: !hasXlsx() }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excel-full-read-'));
  try {
    const path = join(tmp, 'sample.xlsx');
    await makeWorkbook(path, {
      Prodotti: [
        ['Codice', 'Descrizione', 'Quantità'],
        ['A001', 'Caffè 1kg', 10],
        ['A002', 'Zucchero 1kg', 5],
      ],
    });

    const bag = await loadPlugin();

    const info = await bag.tools.excel_info.handler({ path });
    assert.equal(info.sheet_count, 1);
    assert.equal(info.sheets[0].sheet, 'Prodotti');
    assert.equal(info.sheets[0].rows, 3);

    const md = await bag.tools.excel_read.handler({ path, sheet: 'Prodotti' });
    assert.match(md, /\| Cell \| A \| B \| C \|/);
    assert.match(md, /Caffè 1kg/);

    const search = await bag.tools.excel_search.handler({ path, query: 'zucchero' });
    assert.match(search, /Prodotti!B3/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Create + write ─────────────────────────────────────────────────────
test('excel-full: excel_create with formulas and headers writes a real .xlsx', { skip: !hasXlsx() }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excel-full-create-'));
  try {
    const path = join(tmp, 'budget.xlsx');
    const bag = await loadPlugin();
    const out = await bag.tools.excel_create.handler({
      path,
      sheets: [{
        name: 'Budget',
        headers: ['Mese', 'Entrate', 'Uscite', 'Saldo'],
        rows: [
          ['Gennaio', 1000, 800],
          ['Febbraio', 1200, 950],
        ],
        formulas: { 'D3': '=B3-C3', 'D4': '=B4-C4' },
      }],
    });
    assert.match(out, /Created 1-sheet workbook/);
    assert.ok(existsSync(path));

    // Verify the formulas were written
    const wbBack = await openWorkbook(path);
    const ws = wbBack.getWorksheet('Budget');
    const d3 = ws.getCell('D3').value;
    assert.ok(d3 && d3.formula === 'B3-C3', 'D3 should be a formula =B3-C3');
    const d4 = ws.getCell('D4').value;
    assert.ok(d4 && d4.formula === 'B4-C4');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('excel-full: excel_update_cells with formula syntax (=...) inserts real formulas', { skip: !hasXlsx() }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excel-full-update-'));
  try {
    const path = join(tmp, 't.xlsx');
    await makeWorkbook(path, { 'S': [['A', 'B'], [1, 2], [3, 4]] });

    const bag = await loadPlugin();
    await bag.tools.excel_update_cells.handler({
      path, sheet: 'S', range: 'C1', values: [['=A1+B1', '=SUM(A2:B2)']],
    });

    const wbBack = await openWorkbook(path);
    const ws = wbBack.getWorksheet('S');
    // `[[a, b]]` is one row of two columns, so it fills C1 and D1 — the
    // assertion used to look for C2, which a row never reaches.
    assert.equal(formulaOf(ws, 'C1'), 'A1+B1');
    assert.equal(formulaOf(ws, 'D1'), 'SUM(A2:B2)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('excel-full: excel_append_rows grows the sheet', { skip: !hasXlsx() }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excel-full-append-'));
  try {
    const path = join(tmp, 't.xlsx');
    await makeWorkbook(path, { 'S': [['A', 'B'], [1, 2]] });

    const bag = await loadPlugin();
    const out = await bag.tools.excel_append_rows.handler({ path, sheet: 'S', rows: [[3, 4], [5, 6]] });
    assert.match(out, /Appended 2/);

    const wbBack = await openWorkbook(path);
    const ws = wbBack.getWorksheet('S');
    // [[3,4],[5,6]] after two rows gives A3=3 B3=4 / A4=5 B4=6. The assertion
    // read B4 and expected 5, which is A4's value.
    assert.equal(valueOf(ws, 'A3'), 3);
    assert.equal(valueOf(ws, 'B3'), 4);
    assert.equal(valueOf(ws, 'A4'), 5);
    assert.equal(valueOf(ws, 'B4'), 6);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('excel-full: excel_delete_rows removes a row and shifts others up', { skip: !hasXlsx() }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excel-full-delete-'));
  try {
    const path = join(tmp, 't.xlsx');
    await makeWorkbook(path, { 'S': [['A'], [1], [2], [3], [4]] });

    const bag = await loadPlugin();
    await bag.tools.excel_delete_rows.handler({ path, sheet: 'S', start_row: 2, end_row: 3 });
    const wbBack = await openWorkbook(path);
    const ws = wbBack.getWorksheet('S');
    // After deleting rows 2-3, the remaining rows are 1, 4 — now compacted to 2, 3.
    // The sheet is A / 1 / 2 / 3 / 4. Deleting rows 2-3 removes the 1 and the
    // 2, so 3 and 4 shift up — the assertion expected 1 to survive its own
    // deletion.
    assert.equal(valueOf(ws, 'A1'), 'A');
    assert.equal(valueOf(ws, 'A2'), 3, 'original A4=3 shifts up to A2');
    assert.equal(valueOf(ws, 'A3'), 4, 'original A5=4 shifts up to A3');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('excel-full: excel_add_sheet / excel_rename_sheet / excel_remove_sheet', { skip: !hasXlsx() }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excel-full-sheets-'));
  try {
    const path = join(tmp, 't.xlsx');
    await makeWorkbook(path, { 'Original': [['x']] });

    const bag = await loadPlugin();
    await bag.tools.excel_add_sheet.handler({ path, sheet_name: 'Nuovo', headers: ['A', 'B'], data: [[1, 2]] });
    let wb2 = await openWorkbook(path);
    assert.ok(wb2.worksheets.map(w => w.name).includes('Nuovo'));

    await bag.tools.excel_rename_sheet.handler({ path, sheet: 'Nuovo', new_name: 'Rinominato' });
    wb2 = await openWorkbook(path);
    assert.ok(wb2.worksheets.map(w => w.name).includes('Rinominato'));
    assert.ok(!wb2.worksheets.map(w => w.name).includes('Nuovo'));

    await bag.tools.excel_remove_sheet.handler({ path, sheet: 'Rinominato' });
    wb2 = await openWorkbook(path);
    assert.ok(!wb2.worksheets.map(w => w.name).includes('Rinominato'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Styles ─────────────────────────────────────────────────────────────
test('excel-full: excel_set_style applies bold + color + number_format', { skip: !hasXlsx() }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excel-full-style-'));
  try {
    const path = join(tmp, 't.xlsx');
    await makeWorkbook(path, { 'S': [['Valore', 'Importo'], [1, 100], [2, 200]] });

    const bag = await loadPlugin();
    await bag.tools.excel_set_style.handler({
      path, sheet: 'S', range: 'A1:B1',
      style: { bold: true, color: 'FFFFFF', bg_color: '1F4E79', align: 'center', number_format: '#,##0.00' },
    });

    const wb2 = await openWorkbook(path);
    // The whole point of the move: these survive a write with ExcelJS and did
    // not with the community SheetJS, which reported success and dropped them.
    const a1 = wb2.getWorksheet('S').getCell('A1');
    assert.equal(a1.font.bold, true);
    assert.equal(a1.alignment.horizontal, 'center');
    assert.equal(a1.numFmt, '#,##0.00');
    assert.ok(a1.fill && a1.fill.fgColor, 'should have a fill');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Reports ────────────────────────────────────────────────────────────
test('excel-full: excel_report with "simple" template produces summary + detail', { skip: !hasXlsx() }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excel-full-report-'));
  try {
    const bag = await loadPlugin();
    const out = await bag.tools.excel_report.handler({
      output_path: join(tmp, 'r.xlsx'),
      template: 'simple',
      title: 'Test report',
      group_by: 'Category',
      rows: [
        { Category: 'A', Amount: 100 }, { Category: 'A', Amount: 50 },
        { Category: 'B', Amount: 200 },
      ],
    });
    assert.match(out, /Wrote simple report/);
    const wb = await openWorkbook(join(tmp, 'r.xlsx'));
    assert.ok(wb.worksheets.map(w => w.name).includes('Summary'));
    assert.ok(wb.worksheets.map(w => w.name).includes('Detail'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('excel-full: excel_report with "sales" template produces formula-driven summary', { skip: !hasXlsx() }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excel-full-sales-'));
  try {
    const bag = await loadPlugin();
    await bag.tools.excel_report.handler({
      output_path: join(tmp, 's.xlsx'),
      template: 'sales',
      title: 'Sales 2026',
      rows: [
        { Date: '2026-01-15', Category: 'Books', Amount: 49.99, Status: 'paid' },
        { Date: '2026-02-03', Category: 'Electronics', Amount: 1299.00, Status: 'paid' },
      ],
    });
    const wb = await openWorkbook(join(tmp, 's.xlsx'));
    const summary = wb.getWorksheet('Summary');
    // Find a SUM formula in the summary sheet
    let hasSum = false;
    summary.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v && typeof v === 'object' && typeof v.formula === 'string' && v.formula.startsWith('SUM(')) hasSum = true;
      });
    });
    assert.ok(hasSum, 'sales template should write at least one SUM formula');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Charts ────────────────────────────────────────────────────────────
test('excel-full: excel_make_chart with pureimage embeds a PNG and writes the file', { skip: !hasXlsx() || !hasPureimage() }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excel-full-chart-'));
  try {
    const path = join(tmp, 'chart.xlsx');
    await makeWorkbook(path, { 'Data': [
      ['', 'Sales'],
      ['Q1', 100],
      ['Q2', 150],
      ['Q3', 200],
    ] });

    const bag = await loadPlugin();
    const out = await bag.tools.excel_make_chart.handler({
      path, sheet: 'Data', type: 'column', title: 'Quarterly',
      data_range: 'A1:B4', image_cell: 'D2', width: 600, height: 400,
    });
    assert.match(out, /Inserted column chart/);
    const wb2 = await openWorkbook(path);
    // A real embed, which the previous library could not produce at all.
    const media = wb2.model?.media || [];
    assert.equal(media.length, 1, 'workbook should have 1 embedded media item');
    assert.equal(media[0].extension, 'png');
    assert.ok(wb2.getWorksheet('Data').getImages().length >= 1, 'the image must be placed on the sheet');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('excel-full: excel_make_chart without pureimage returns a clear install hint', { skip: !hasXlsx() }, async () => {
  // We can only meaningfully run this when pureimage is NOT installed.
  if (hasPureimage()) return; // skip silently — pureimage is available
  const tmp = mkdtempSync(join(tmpdir(), 'excel-full-chart-noimg-'));
  try {
    const path = join(tmp, 'c.xlsx');
    await makeWorkbook(path, { 'S': [['A', 'B'], [1, 2]] });
    const bag = await loadPlugin();
    const out = await bag.tools.excel_make_chart.handler({ path, sheet: 'S', type: 'bar', image_cell: 'D2' });
    assert.match(String(out), /pureimage|install/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Edge cases ────────────────────────────────────────────────────────
test('excel-full: excel_info on a non-existent file returns a clear error', async () => {
  const bag = await loadPlugin();
  const out = await bag.tools.excel_info.handler({ path: '/no/such/file.xlsx' });
  assert.match(String(out), /Error/);
});

test('excel-full: excel_read on a missing sheet returns the available sheet list', { skip: !hasXlsx() }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excel-full-missing-'));
  try {
    const path = join(tmp, 't.xlsx');
    await makeWorkbook(path, { 'SoloQuesto': [['x']] });
    const bag = await loadPlugin();
    const out = await bag.tools.excel_read.handler({ path, sheet: 'NonEsiste' });
    assert.match(String(out), /Error.*not found/);
    assert.match(String(out), /SoloQuesto/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
