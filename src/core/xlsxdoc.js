'use strict';
// Excel workbook (.xlsx, .xlsm) as editable grids, one per sheet. Saving loads the workbook as it was read,
// replays the edits (cell values, inserted, deleted and moved rows and columns) with exceljs and writes it.
// Cell styles, number formats, merged cells, column widths and the other sheets come through untouched.

const ExcelJS = require('exceljs');
const { Grid } = require('./grid');
const { checkZip, atRisk, namesAtRisk } = require('./zipguard');

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?Z?$/;

function pad(n) { return String(n).padStart(2, '0'); }

function dateText(d) {
  if (Number.isNaN(d.getTime())) return '';
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (!d.getUTCHours() && !d.getUTCMinutes() && !d.getUTCSeconds()) return day;
  return `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Text of a cell value as the grid shows it. */
function valueText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return dateText(v);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text || '').join('');
    if (v.error) return String(v.error);
    if ('formula' in v || 'sharedFormula' in v) return valueText(v.result === undefined ? null : v.result);
    if ('text' in v) return valueText(v.text);
    if ('hyperlink' in v) return String(v.hyperlink);
  }
  return String(v);
}

function formulaOf(v) {
  if (v && typeof v === 'object') {
    if (typeof v.formula === 'string') return v.formula;
    if (typeof v.sharedFormula === 'string') return null; // a copy of a shared formula; the text is on the master cell
  }
  return null;
}

/**
 * The value to write for text typed in the grid. `prev` is the cell's current value (keeps dates as dates).
 */
function textToValue(text, prev) {
  const s = String(text);
  if (s === '') return null;
  if (s.length > 1 && s[0] === '=') return { formula: s.slice(1) };
  if (NUM_RE.test(s) && !(/^[+-]?0\d/.test(s))) {
    const n = Number(s);
    if (Number.isFinite(n) && (Math.abs(n) < 1e15 || !/^[+-]?\d+$/.test(s))) return n;
  }
  const up = s.toUpperCase();
  if (up === 'TRUE' || up === 'FALSE') return up === 'TRUE';
  const m = s.match(ISO_DATE_RE);
  if (m && (prev instanceof Date || (prev && typeof prev === 'object' && prev.result instanceof Date))) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), +(m[7] || 0)));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return s;
}

/** Load a workbook from bytes. Checks the zip first (zip bombs, damaged files). */
async function loadWorkbook(buf) {
  const zip = checkZip(buf);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return { wb, zip };
}

class SheetBase {
  constructor(ws, maxCells) {
    this.name = ws.name;
    this.state = ws.state || 'visible';
    const rows = ws.rowCount;
    const cols = ws.columnCount;
    if (rows * cols > maxCells) throw new Error(`The sheet "${ws.name}" has ${rows.toLocaleString('en-US')} rows and ${cols} columns. That is more than ${maxCells.toLocaleString('en-US')} cells, the limit for editing (setting spreadsheetEditor.maxExcelCells).`);
    this.count = rows;
    this.width = Math.max(1, cols);
    this.cells = new Array(rows);
    this.formulas = new Map(); // "row,col" -> formula text
    this.merged = new Set(); // "row,col" of merged cells that are not the top-left one
    for (let r = 1; r <= rows; r++) {
      const row = ws.getRow(r);
      const out = [];
      let last = 0;
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        if (cell.isMerged && cell.master && cell.master.address !== cell.address) {
          this.merged.add(`${r - 1},${c - 1}`);
          return;
        }
        const v = cell.value;
        while (out.length < c - 1) out.push('');
        out[c - 1] = valueText(v);
        let f = formulaOf(v);
        if (f === null && v && typeof v === 'object' && typeof v.sharedFormula === 'string' && typeof cell.formula === 'string') f = cell.formula;
        if (f !== null) {
          this.formulas.set(`${r - 1},${c - 1}`, f);
          // A formula with no saved result (the file was written by a script, never opened in Excel): show it.
          if (out[c - 1] === '') out[c - 1] = '=' + f;
        }
        if (c > last) last = c;
      });
      this.cells[r - 1] = out;
    }
  }

  fields(id) { return this.cells[id] || []; }
}

class XlsxDoc {
  /**
   * @param {Buffer} buf
   * @param {{maxCells?:number, ext?:string}} opts
   */
  static async load(buf, opts = {}) {
    const doc = new XlsxDoc();
    await doc._init(buf, opts);
    return doc;
  }

  async _init(buf, opts) {
    this.kind = 'xlsx';
    this.buf = buf;
    this.ext = opts.ext || 'xlsx';
    const { wb, zip } = await loadWorkbook(buf);
    this.atRisk = atRisk(zip.entries);
    try { this.atRisk.push(...namesAtRisk(buf, zip.entries)); } catch { /* unreadable workbook.xml: exceljs reports it */ }
    this.sheets = [];
    this.header = opts.header === true;
    const maxCells = opts.maxCells || 5000000;
    let total = 0;
    wb.eachSheet(ws => {
      const base = new SheetBase(ws, maxCells);
      total += base.count * base.width;
      if (total > maxCells) throw new Error(`The workbook has more than ${maxCells.toLocaleString('en-US')} cells, the limit for editing (setting spreadsheetEditor.maxExcelCells).`);
      this.sheets.push({ name: ws.name, state: base.state, base, grid: new Grid(base) });
    });
    if (!this.sheets.length) throw new Error('The workbook has no worksheets.');
    this.hasFormulas = this.sheets.some(s => s.base.formulas.size > 0);
  }

  sheet(name) { return this.sheets.find(s => s.name === name) || this.sheets[0]; }

  describe() {
    return {
      sheets: this.sheets.map(s => ({ name: s.name, hidden: s.state !== 'visible', rows: s.grid.order.length })),
      atRisk: this.atRisk,
      formulas: this.hasFormulas,
      macros: this.atRisk.includes('macros (VBA)') || this.ext === 'xlsm',
    };
  }

  /** Formula text of a base cell (with '='), or null. */
  formula(sheetName, id, col) {
    const s = this.sheet(sheetName);
    if (id >= s.base.count) return null;
    const k = s.grid.colMap[col];
    if (k === undefined || k < 0) return null;
    const f = s.base.formulas.get(`${id},${k}`);
    return f === undefined ? null : '=' + f;
  }

  /**
   * Bytes of the workbook with the edits in `log` (ops in the order they were applied, each with .sheet).
   */
  async save(log) {
    const { wb } = await loadWorkbook(this.buf);
    const orders = new Map(); // sheet name -> row ids in sheet order, for this replay
    const orderOf = name => {
      let o = orders.get(name);
      if (!o) {
        const s = this.sheet(name);
        o = [];
        for (let i = 0; i < s.base.count; i++) o.push(i);
        orders.set(name, o);
      }
      return o;
    };
    const parked = new Map(); // "sheet:id" -> {values, styles, height} of a row taken out by a move
    for (const op of log) {
      const ws = wb.getWorksheet(op.sheet);
      if (!ws) continue;
      replay(ws, op, orderOf(op.sheet), parked, `${op.sheet}:`);
    }
    // Hidden formula results would be stale after an edit: ask Excel to recalculate on open.
    if (log.length) {
      wb.calcProperties = wb.calcProperties || {};
      wb.calcProperties.fullCalcOnLoad = true;
    }
    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out);
  }
}

function rowSnapshot(ws, r) {
  const row = ws.getRow(r);
  const values = [];
  const styles = [];
  row.eachCell({ includeEmpty: true }, (cell, c) => { values[c] = cell.value; styles[c] = cell.style ? JSON.parse(JSON.stringify(cell.style)) : undefined; });
  return { values, styles, height: row.height };
}

function replay(ws, op, order, parked, prefix) {
  switch (op.t) {
    case 'multi':
      for (const o of op.ops) replay(ws, o, order, parked, prefix);
      return;
    case 'set': {
      const pos = new Map();
      order.forEach((id, i) => pos.set(id, i));
      for (const [id, col, text] of op.cells) {
        const p = pos.get(id);
        if (p === undefined) continue;
        const cell = ws.getCell(p + 1, col + 1);
        const prev = cell.value;
        cell.value = textToValue(text, prev);
      }
      return;
    }
    case 'put': {
      const items = op.items.slice().sort((a, b) => a[0] - b[0]);
      const rows = new Map(op.rows || []);
      for (const [p, id] of items) {
        order.splice(p, 0, id);
        const snap = parked.get(prefix + id);
        if (snap) {
          ws.spliceRows(p + 1, 0, []);
          const row = ws.getRow(p + 1);
          snap.values.forEach((v, c) => { if (c > 0) { const cell = row.getCell(c); cell.value = v; if (snap.styles[c]) cell.style = snap.styles[c]; } });
          if (snap.height) row.height = snap.height;
          parked.delete(prefix + id);
        } else {
          const cells = rows.get(id) || [];
          ws.spliceRows(p + 1, 0, cells.map(t => textToValue(t, null)));
        }
      }
      return;
    }
    case 'drop': {
      const ps = Array.from(new Set(op.pos)).sort((a, b) => b - a);
      for (const p of ps) {
        if (p >= order.length) continue;
        const id = order[p];
        parked.set(prefix + id, rowSnapshot(ws, p + 1));
        order.splice(p, 1);
        ws.spliceRows(p + 1, 1);
      }
      return;
    }
    case 'icol':
      ws.spliceColumns(op.at + 1, 0, []);
      if (op.vals) {
        const pos = new Map();
        order.forEach((id, i) => pos.set(id, i));
        for (const [id, text] of op.vals) { const p = pos.get(id); if (p !== undefined && text !== '') ws.getCell(p + 1, op.at + 1).value = textToValue(text, null); }
      }
      return;
    case 'dcol':
      ws.spliceColumns(op.at + 1, 1);
      return;
    case 'mcol': {
      const from = op.from + 1, to = op.to + 1;
      const col = ws.getColumn(from);
      const vals = [];
      const styles = [];
      col.eachCell({ includeEmpty: true }, (cell, r) => { vals[r] = cell.value; styles[r] = cell.style ? JSON.parse(JSON.stringify(cell.style)) : undefined; });
      const width = col.width;
      ws.spliceColumns(from, 1);
      ws.spliceColumns(to, 0, []);
      const nc = ws.getColumn(to);
      if (width) nc.width = width;
      vals.forEach((v, r) => { if (r > 0) { const cell = ws.getCell(r, to); cell.value = v; if (styles[r]) cell.style = styles[r]; } });
      return;
    }
    default:
  }
}

module.exports = { XlsxDoc, textToValue, valueText, dateText, loadWorkbook };
