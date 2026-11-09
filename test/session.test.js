'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { createSession } = require('../src/core/session');
const { XlsxDoc, textToValue } = require('../src/core/xlsxdoc');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zovo-sheet-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function newSession() {
  const posts = [];
  const s = createSession({ post: m => posts.push(m), loadXlsx: (b, o) => XlsxDoc.load(b, o) });
  const lastRows = () => posts.filter(p => p.type === 'rows').pop().rows;
  const lastMeta = () => posts.filter(p => p.type === 'meta').pop();
  return { s, posts, lastRows, lastMeta };
}

async function openCsv(text, opts = {}) {
  const file = path.join(tmp, `f${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(file, text);
  const x = newSession();
  await x.s.handle({ type: 'open', format: 'csv', ext: 'csv', source: { path: file }, options: opts });
  await x.s.handle({ type: 'hello', view: 1 });
  x.file = file;
  x.rows = async () => { await x.s.handle({ type: 'getRows', view: 1, start: 0, count: 100, reqId: 1 }); return x.lastRows(); };
  return x;
}

test('header row names the columns; data rows exclude it', async () => {
  const x = await openCsv('name,qty\nb,2\na,1\n');
  const m = x.lastMeta();
  assert.deepEqual(m.columns.map(c => c.name), ['name', 'qty']);
  assert.equal(m.viewCount, 2);
  assert.deepEqual((await x.rows()).map(r => r.c), [['b', '2'], ['a', '1']]);
});

test('sort is a view: the file keeps its order, and a row inserted while sorted stays next to its neighbour', async () => {
  const x = await openCsv('name,qty\nb,2\na,1\nc,3\n');
  await x.s.handle({ type: 'sort', view: 1, col: 0, dir: 'asc' });
  const rows = await x.rows();
  assert.deepEqual(rows.map(r => r.c[0]), ['a', 'b', 'c']);
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'insertRows', anchor: rows[0].id, below: true, count: 1 } });
  assert.deepEqual((await x.rows()).map(r => r.c[0]), ['a', '', 'b', 'c']);
  await x.s.handle({ type: 'save', path: x.file });
  assert.equal(fs.readFileSync(x.file, 'utf8'), 'name,qty\nb,2\na,1\n,\nc,3\n');
});

test('moving rows is refused while sorted, and works unsorted', async () => {
  const x = await openCsv('h\n1\n2\n3\n');
  await x.s.handle({ type: 'sort', view: 1, col: 0, dir: 'desc' });
  const rows = await x.rows();
  await assert.rejects(x.s.handle({ type: 'edit', view: 1, edit: { kind: 'moveRows', ids: [rows[0].id], dir: 1 } }), /Clear the sort/);
  await x.s.handle({ type: 'sort', view: 1, col: null });
  const r2 = await x.rows();
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'moveRows', ids: [r2[2].id], dir: -1 } });
  assert.deepEqual((await x.rows()).map(r => r.c[0]), ['1', '3', '2']);
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'moveRows', ids: [r2[0].id], dir: -1 } });
  assert.deepEqual((await x.rows()).map(r => r.c[0]), ['1', '3', '2'], 'the first data row does not move above the header');
});

test('paste a block from a spreadsheet: grows rows and columns; one undo takes it back', async () => {
  const x = await openCsv('a,b\n1,2\n');
  const rows = await x.rows();
  const r = await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'paste', anchor: rows[0].id, col: 1, rows: [['x', 'y'], ['z', 'w'], ['p', 'q']] } });
  assert.equal(r.changed, true);
  assert.deepEqual((await x.rows()).map(q => q.c), [['1', 'x', 'y'], ['', 'z', 'w'], ['', 'p', 'q']]);
  await x.s.handle({ type: 'undo' });
  assert.deepEqual((await x.rows()).map(q => q.c), [['1', '2']]);
  await x.s.handle({ type: 'save', path: x.file });
  assert.equal(fs.readFileSync(x.file, 'utf8'), 'a,b\n1,2\n');
  await x.s.handle({ type: 'redo' });
  await x.s.handle({ type: 'save', path: x.file });
  assert.equal(fs.readFileSync(x.file, 'utf8'), 'a,b,\n1,x,y\n,z,w\n,p,q\n');
});

test('find (regex, match case, whole cell) and replace all with groups; replace all is one undo step', async () => {
  const x = await openCsv('id,code\n1,AB-12\n2,ab-7\n3,XY-9\n');
  let f = await x.s.handle({ type: 'find', view: 1, query: { find: 'ab', pos: 0, col: -1 } });
  assert.deepEqual([f.pos, f.col], [0, 1]);
  f = await x.s.handle({ type: 'find', view: 1, query: { find: 'ab', matchCase: true, pos: 0, col: 1 } });
  assert.deepEqual([f.pos, f.col], [1, 1]);
  f = await x.s.handle({ type: 'find', view: 1, query: { find: '7', wholeCell: true, pos: 0, col: -1 } });
  assert.equal(f.found, false);
  const r = await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'replaceAll', find: '([A-Z]+)-(\\d+)', replace: '$2/$1', regex: true, matchCase: false } });
  assert.equal(r.count, 3);
  assert.deepEqual((await x.rows()).map(q => q.c[1]), ['12/AB', '7/ab', '9/XY']);
  await x.s.handle({ type: 'undo' });
  assert.deepEqual((await x.rows()).map(q => q.c[1]), ['AB-12', 'ab-7', 'XY-9']);
});

test('filter and SQL WHERE (from the table viewer) choose the rows; edits go to the right rows', async () => {
  const x = await openCsv('city,price\nParis,12\nLima,5\nParis,30\n');
  await x.s.handle({ type: 'filter', view: 1, global: '', columns: {}, query: "city = 'Paris' AND price > 20" });
  let rows = await x.rows();
  assert.deepEqual(rows.map(q => q.c), [['Paris', '30']]);
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'set', cells: [{ id: rows[0].id, col: 1, value: '31' }] } });
  await x.s.handle({ type: 'filter', view: 1, global: 'li', columns: {}, query: '' });
  rows = await x.rows();
  assert.deepEqual(rows.map(q => q.c), [['Lima', '5']]);
  await x.s.handle({ type: 'save', path: x.file });
  assert.equal(fs.readFileSync(x.file, 'utf8'), 'city,price\nParis,12\nLima,5\nParis,31\n');
});

test('rows report which cells changed; new rows are marked', async () => {
  const x = await openCsv('a,b\n1,2\n');
  const rows = await x.rows();
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'set', cells: [{ id: rows[0].id, col: 1, value: '9' }] } });
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'insertRows', anchor: null, below: true, count: 1 } });
  const r2 = await x.rows();
  assert.deepEqual(r2[0].m, [1]);
  assert.equal(r2[1].added, true);
});

test('hot-exit backup holds the edits; restore applies them to the same file, and refuses a changed file', async () => {
  const x = await openCsv('k,v\na,1\n');
  const rows = await x.rows();
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'set', cells: [{ id: rows[0].id, col: 1, value: 'two' }] } });
  const bk = path.join(tmp, 'backup.json');
  await x.s.handle({ type: 'backup', path: bk });
  const y = newSession();
  const r = await y.s.handle({ type: 'open', format: 'csv', ext: 'csv', source: { path: x.file }, options: {}, backup: bk });
  assert.equal(r.restored, 1);
  const out = path.join(tmp, 'restored.csv');
  await y.s.handle({ type: 'save', path: out });
  assert.equal(fs.readFileSync(out, 'utf8'), 'k,v\na,two\n');
  fs.writeFileSync(x.file, 'k,v\na,changed elsewhere\n');
  const z = newSession();
  const r2 = await z.s.handle({ type: 'open', format: 'csv', ext: 'csv', source: { path: x.file }, options: {}, backup: bk });
  assert.equal(r2.restored, 0);
  await z.s.handle({ type: 'hello', view: 1 });
  assert.match(z.lastMeta().notices[0], /changed on disk/);
});

test('changing the delimiter is refused while there are unsaved edits', async () => {
  const x = await openCsv('a;b\n1;2\n');
  const rows = await x.rows();
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'set', cells: [{ id: rows[0].id, col: 0, value: '5' }] } });
  await assert.rejects(x.s.handle({ type: 'reparse', options: { delimiter: ',' } }), /Save or undo/);
  await x.s.handle({ type: 'undo' });
  await x.s.handle({ type: 'reparse', options: { delimiter: ',' } });
  assert.deepEqual((await x.rows()).map(r => r.c), [['1;2']]);
});

test('a save writes a temp file and renames it: a failed save leaves the old file as it was', async () => {
  const x = await openCsv('a\n1\n');
  const rows = await x.rows();
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'set', cells: [{ id: rows[0].id, col: 0, value: '2' }] } });
  await assert.rejects(x.s.handle({ type: 'save', path: path.join(tmp, 'no-such-dir', 'x.csv') }));
  assert.equal(fs.readFileSync(x.file, 'utf8'), 'a\n1\n');
  assert.equal(fs.readdirSync(tmp).filter(f => f.endsWith('.zovo-tmp')).length, 0);
});

// ---------- Excel ----------

async function makeWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Budget');
  ws.addRow(['Team budget']);
  ws.mergeCells('A1:C1');
  ws.addRow(['Item', 'Q1', 'Total']);
  ws.addRow(['Rent', 3000, { formula: 'B3*2', result: 6000 }]);
  ws.addRow(['Travel', 1250.5, { formula: 'B4*2', result: 2501 }]);
  ws.getCell('B3').numFmt = '#,##0.00';
  ws.getCell('B3').font = { bold: true, color: { argb: 'FFFF0000' } };
  ws.getCell('B4').numFmt = '#,##0.00';
  ws.getColumn(1).width = 22;
  const s2 = wb.addWorksheet('Staff');
  s2.addRow(['Name', 'Start']);
  s2.addRow(['Ana', new Date(Date.UTC(2024, 0, 15))]);
  await wb.xlsx.writeFile(file);
}

test('xlsx: edit values; styles, number formats, merged cells, widths, formulas and other sheets survive', async () => {
  const file = path.join(tmp, 'book.xlsx');
  await makeWorkbook(file);
  const x = newSession();
  await x.s.handle({ type: 'open', format: 'xlsx', ext: 'xlsx', source: { path: file }, options: { header: false } });
  await x.s.handle({ type: 'hello', view: 1 });
  const m = x.lastMeta();
  assert.deepEqual(m.workbook.sheets.map(s => s.name), ['Budget', 'Staff']);
  assert.equal(m.workbook.formulas, true);
  await x.s.handle({ type: 'getRows', view: 1, start: 0, count: 10, reqId: 1 });
  let rows = x.lastRows();
  assert.deepEqual(rows[2].c, ['Rent', '3000', '6000']);
  assert.deepEqual(rows[2].f, [2]);
  const cell = await x.s.handle({ type: 'getCell', view: 1, id: rows[2].id, col: 2 });
  assert.equal(cell.formula, '=B3*2');
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'set', cells: [{ id: rows[2].id, col: 1, value: '3500' }, { id: rows[3].id, col: 0, value: 'Trips' }] } });
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'insertRows', anchor: rows[3].id, below: true, count: 1 } });
  await x.s.handle({ type: 'getRows', view: 1, start: 0, count: 10, reqId: 2 });
  rows = x.lastRows();
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'set', cells: [{ id: rows[4].id, col: 0, value: 'New' }, { id: rows[4].id, col: 1, value: '=B3+1' }] } });
  const out = path.join(tmp, 'book-out.xlsx');
  await x.s.handle({ type: 'save', path: out });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const ws = wb.getWorksheet('Budget');
  assert.equal(ws.getCell('B3').value, 3500);
  assert.equal(ws.getCell('B3').numFmt, '#,##0.00');
  assert.equal(ws.getCell('B3').font.bold, true);
  assert.equal(ws.getCell('A4').value, 'Trips');
  assert.equal(ws.getCell('C3').value.formula, 'B3*2');
  assert.equal(ws.getCell('A5').value, 'New');
  assert.equal(ws.getCell('B5').value.formula, 'B3+1');
  assert.ok(ws.getCell('B1').isMerged, 'merged cells kept');
  assert.equal(ws.getColumn(1).width, 22);
  const staff = wb.getWorksheet('Staff');
  assert.equal(staff.getCell('A2').value, 'Ana');
  assert.ok(staff.getCell('B2').value instanceof Date);
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  assert.match(await zip.file('xl/workbook.xml').async('string'), /fullCalcOnLoad="1"/, 'Excel recalculates formulas on open');
});

test('xlsx: sheets are separate views; undo goes back across sheets', async () => {
  const file = path.join(tmp, 'book2.xlsx');
  await makeWorkbook(file);
  const x = newSession();
  await x.s.handle({ type: 'open', format: 'xlsx', ext: 'xlsx', source: { path: file }, options: { header: true } });
  await x.s.handle({ type: 'sheet', view: 1, name: 'Staff' });
  assert.deepEqual(x.lastMeta().columns.map(c => c.name), ['Name', 'Start']);
  await x.s.handle({ type: 'getRows', view: 1, start: 0, count: 10, reqId: 1 });
  assert.deepEqual(x.lastRows()[0].c, ['Ana', '2024-01-15']);
  await x.s.handle({ type: 'edit', view: 1, edit: { kind: 'set', cells: [{ id: x.lastRows()[0].id, col: 1, value: '2025-02-01' }] } });
  await x.s.handle({ type: 'undo' });
  await x.s.handle({ type: 'getRows', view: 1, start: 0, count: 10, reqId: 1 });
  assert.deepEqual(x.lastRows()[0].c, ['Ana', '2024-01-15']);
});

test('textToValue keeps types: numbers, booleans, formulas, dates, leading zeros as text', () => {
  assert.equal(textToValue('12.5', null), 12.5);
  assert.equal(textToValue('007', null), '007');
  assert.equal(textToValue('TRUE', null), true);
  assert.deepEqual(textToValue('=A1*2', null), { formula: 'A1*2' });
  assert.ok(textToValue('2024-03-01', new Date()) instanceof Date);
  assert.equal(textToValue('2024-03-01', 'text'), '2024-03-01');
  assert.equal(textToValue('', 'x'), null);
  assert.equal(textToValue('12345678901234567890', null), '12345678901234567890');
});

test('replace in files (Pro candidate): counts, then writes; header and untouched rows stay byte for byte', () => {
  const { replaceInFile } = require('../src/core/session');
  const file = path.join(tmp, 'multi.csv');
  fs.writeFileSync(file, 'name,city\r\nAna,"Paris, FR"\r\nBo,Lima\r\n# not a comment here\r\n');
  const q = { find: 'paris', regex: false, matchCase: false, wholeCell: false };
  assert.deepEqual(replaceInFile({ path: file, query: q, replace: 'Lyon', maxBytes: 1e9, apply: false }), { path: file, count: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'name,city\r\nAna,"Paris, FR"\r\nBo,Lima\r\n# not a comment here\r\n');
  const r = replaceInFile({ path: file, query: q, replace: 'Lyon', maxBytes: 1e9, apply: true });
  assert.equal(r.written, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'name,city\r\nAna,"Lyon, FR"\r\nBo,Lima\r\n# not a comment here\r\n');
  const h = replaceInFile({ path: file, query: { ...q, find: 'name' }, replace: 'x', maxBytes: 1e9, apply: false });
  assert.equal(h.count, 0, 'the header row is not changed');
  assert.match(replaceInFile({ path: file, query: q, replace: 'x', maxBytes: 5, apply: false }).skipped, /larger than/);
});
