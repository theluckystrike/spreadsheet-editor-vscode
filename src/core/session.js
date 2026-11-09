'use strict';
// Worker-side document session: one document, any number of views (editor tabs) on it.
// Views have their own sort, filters and Excel sheet. Edits go to the document, are kept on an undo stack
// that mirrors VS Code's, and every view is told to fetch its rows again.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CsvDoc } = require('./csvdoc');
const { tableFromStringColumns } = require('./table');
const { computeStats } = require('./stats');
const { opSize } = require('./grid');

const MAX_CELL_CHARS = 2000;
const MAX_FULL_CELL = 1000000;

function colLetter(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function plural(n, one, many) { return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`; }

class EditError extends Error { constructor(m) { super(m); this.code = 'EDIT'; } }

function createSession({ post, loadXlsx }) {
  let doc = null;
  let format = null;
  let ext = '';
  let source = null;
  let options = {};
  let readOnly = false;
  let readOnlyReason = '';
  let baseHash = null;
  let undo = [];
  let redo = [];
  let log = []; // ops in effect, in the order they were applied (backup, Excel save)
  const views = new Map();
  let notices = [];

  const isXlsx = () => format === 'xlsx';
  const sheetOf = v => (isXlsx() ? doc.sheet(v.sheet) : null);
  const gridOf = v => (isXlsx() ? sheetOf(v).grid : doc.grid);
  const headerOn = () => (isXlsx() ? !!options.header : doc.header);

  function readSource(src) {
    if (src.path) return fs.readFileSync(src.path);
    return Buffer.from(src.bytes);
  }

  async function load(src, opts) {
    const buf = readSource(src);
    if (format === 'xlsx') {
      const d = await loadXlsx(buf, { ext, maxCells: opts.maxCells, header: opts.header === true });
      d.header = opts.header === true;
      return d;
    }
    return new CsvDoc(buf, { encoding: opts.encoding, delimiter: opts.delimiter, quote: opts.quote, header: opts.header, commentPrefix: opts.commentPrefix, ext });
  }

  function hashOf(d) { return crypto.createHash('sha1').update(d.buf).digest('hex'); }

  // ---- row lists -------------------------------------------------------------------------------------
  const dataCache = new WeakMap(); // grid -> {sv, header, ids, headerId}
  function dataIds(grid) {
    const h = headerOn();
    let c = dataCache.get(grid);
    if (c && c.sv === grid.structVersion && c.header === h) return c;
    const ids = [];
    let headerId = null;
    for (const id of grid.order) {
      if (grid.isComment(id)) continue;
      if (h && headerId === null) { headerId = id; continue; }
      ids.push(id);
    }
    c = { sv: grid.structVersion, header: h, ids, headerId, pos: null };
    dataCache.set(grid, c);
    return c;
  }

  /** Position (1-based) of each data row in the file, by id. Built when first needed. */
  function rowNumbers(grid) {
    const c = dataIds(grid);
    if (!c.pos) {
      c.pos = new Int32Array(grid.nextId + 1);
      for (let i = 0; i < c.ids.length; i++) c.pos[c.ids[i]] = i + 1;
    }
    return c.pos;
  }

  function columnNames(grid) {
    const w = grid.width;
    const out = [];
    const hid = headerOn() ? dataIds(grid).headerId : null;
    const hr = hid === null ? null : grid.row(hid);
    for (let c = 0; c < w; c++) {
      const name = hr && hr[c] !== undefined && hr[c] !== '' ? hr[c] : null;
      out.push({ name: name === null ? (hr ? `column ${c + 1}` : colLetter(c)) : name, letter: colLetter(c) });
    }
    return out;
  }

  function viewIds(v) {
    const grid = gridOf(v);
    if (v.index && v.indexGrid === grid) return v.index;
    v.index = null;
    return dataIds(grid).ids;
  }

  // ---- sort and filter -------------------------------------------------------------------------------
  function snapshot(v) {
    const grid = gridOf(v);
    const ids = dataIds(grid).ids;
    const names = columnNames(grid).map(c => c.name);
    const w = grid.width;
    const cols = [];
    for (let c = 0; c < w; c++) cols.push(new Array(ids.length));
    for (let i = 0; i < ids.length; i++) {
      const r = grid.row(ids[i]);
      for (let c = 0; c < w; c++) { const x = r[c]; cols[c][i] = x === undefined || x === null ? '' : x; }
    }
    const table = tableFromStringColumns(names, cols, ids.length);
    return { table, ids };
  }

  function applyViewState(v) {
    const grid = gridOf(v);
    const active = v.sort || v.filters.global || v.filters.query || Object.keys(v.filters.columns).length;
    if (!active) { v.index = null; v.indexGrid = null; return; }
    const { table, ids } = snapshot(v);
    if (v.filters.global || v.filters.query || Object.keys(v.filters.columns).length) table.setFilters(v.filters);
    if (v.sort) table.setSort(v.sort.col, v.sort.dir);
    else table.rebuild();
    const idx = table.index;
    const out = new Array(idx ? idx.length : ids.length);
    if (idx) for (let i = 0; i < idx.length; i++) out[i] = ids[idx[i]];
    else for (let i = 0; i < ids.length; i++) out[i] = ids[i];
    v.index = out;
    v.indexGrid = grid;
  }

  /** Keep each sorted or filtered view in step with rows added or removed by an edit. */
  function patchViews(op, inv, grid) {
    const added = [];
    const removed = new Set();
    const walk = (o, i) => {
      if (o.t === 'multi') { for (let k = 0; k < o.ops.length; k++) walk(o.ops[k], i.ops[i.ops.length - 1 - k]); return; }
      if (o.t === 'put') for (const [, id] of o.items) added.push(id);
      if (o.t === 'drop') for (const [, id] of i.items) removed.add(id);
    };
    walk(op, inv);
    if (!added.length && !removed.size) return;
    for (const v of views.values()) {
      if (!v.index || v.indexGrid !== grid) continue;
      let idx = removed.size ? v.index.filter(id => !removed.has(id)) : v.index.slice();
      if (added.length) {
        const where = new Map();
        idx.forEach((id, i) => where.set(id, i));
        const order = grid.order;
        const posInOrder = new Map();
        const addSet = new Set(added);
        order.forEach((id, i) => { if (addSet.has(id)) posInOrder.set(id, i); });
        for (const id of added) {
          if (removed.has(id)) continue;
          // Put the new row right after the row above it in the file, when that row is in the view.
          let p = posInOrder.get(id);
          let at = -1;
          while (p > 0) { p--; const prev = order[p]; if (where.has(prev)) { at = where.get(prev) + 1; break; } }
          if (at < 0) at = 0;
          idx.splice(at, 0, id);
          where.clear();
          idx.forEach((x, i) => where.set(x, i));
        }
      }
      v.index = idx;
    }
  }

  // ---- messages to views ------------------------------------------------------------------------------
  function meta(v) {
    const grid = gridOf(v);
    const ids = viewIds(v);
    const out = {
      type: 'meta', view: v.id, format, readOnly, readOnlyReason,
      columns: columnNames(grid),
      viewCount: ids.length,
      totalRows: dataIds(grid).ids.length,
      header: headerOn(),
      sort: v.sort, filters: v.filters,
      version: grid.version,
      canUndo: undo.length > 0, canRedo: redo.length > 0,
      notices,
    };
    if (isXlsx()) { out.workbook = doc.describe(); out.sheet = sheetOf(v).name; } else { out.csv = doc.describe(); }
    return out;
  }

  function broadcast() { for (const v of views.values()) post(meta(v)); }

  function rows(v, start, count) {
    const grid = gridOf(v);
    const ids = viewIds(v);
    const nums = rowNumbers(grid);
    const end = Math.min(ids.length, start + count);
    const out = [];
    for (let p = Math.max(0, start); p < end; p++) {
      const id = ids[p];
      const r = grid.row(id);
      const cells = new Array(grid.width);
      for (let c = 0; c < grid.width; c++) {
        let s = r[c];
        if (s === undefined || s === null) s = '';
        if (s.length > MAX_CELL_CHARS) s = s.slice(0, MAX_CELL_CHARS) + '…';
        cells[c] = s;
      }
      const row = { id, n: nums[id] || 0, c: cells };
      const ch = grid.changedCols(id);
      if (ch && ch.length) row.m = ch;
      if (id >= grid.base.count) row.added = true;
      if (isXlsx()) {
        const fx = [];
        for (let c = 0; c < grid.width; c++) if (!grid.mod.has(id) || grid.cell(id, c) === grid.baseCell(id, c)) { if (doc.formula(v.sheet, id, c)) fx.push(c); }
        if (fx.length) row.f = fx;
      }
      out.push(row);
    }
    return out;
  }

  // ---- edits ------------------------------------------------------------------------------------------
  function requireEditable() {
    if (readOnly) throw new EditError(readOnlyReason || 'This file is open read-only.');
  }

  function orderPos(grid, id) {
    const p = grid.order.indexOf(id);
    if (p < 0) throw new EditError('That row is no longer in the file.');
    return p;
  }

  function checkCol(grid, c) {
    if (!Number.isInteger(c) || c < 0 || c >= grid.width) throw new EditError('That column is no longer in the file.');
  }

  /** Turn an edit from a view into an op. Returns {op, label}. */
  function buildOp(v, e) {
    const grid = gridOf(v);
    switch (e.kind) {
      case 'set': {
        const cells = [];
        for (const x of e.cells) {
          checkCol(grid, x.col);
          if (grid.cell(x.id, x.col) !== x.value) cells.push([x.id, x.col, x.value]);
        }
        if (!cells.length) return null;
        return { op: { t: 'set', cells }, label: cells.length === 1 ? 'Edit cell' : `Edit ${plural(cells.length, 'cell', 'cells')}` };
      }
      case 'header': {
        checkCol(grid, e.col);
        const hid = dataIds(grid).headerId;
        if (hid === null) throw new EditError('Turn on "Header row" to rename a column.');
        if (grid.cell(hid, e.col) === e.value) return null;
        return { op: { t: 'set', cells: [[hid, e.col, e.value]] }, label: 'Rename column' };
      }
      case 'insertRows': {
        const n = e.count;
        let pos;
        if (e.anchor === null) {
          pos = grid.order.length;
        } else {
          pos = orderPos(grid, e.anchor) + (e.below ? 1 : 0);
        }
        const hid = dataIds(grid).headerId;
        if (hid !== null && pos <= grid.order.indexOf(hid)) pos = grid.order.indexOf(hid) + 1;
        const ids = grid.newIds(n);
        const items = ids.map((id, k) => [pos + k, id]);
        return { op: { t: 'put', items, rows: ids.map(id => [id, []]) }, label: n === 1 ? 'Insert row' : `Insert ${plural(n, 'row', 'rows')}` };
      }
      case 'deleteRows': {
        const pos = e.ids.map(id => grid.order.indexOf(id)).filter(p => p >= 0);
        if (!pos.length) return null;
        return { op: { t: 'drop', pos }, label: pos.length === 1 ? 'Delete row' : `Delete ${plural(pos.length, 'row', 'rows')}` };
      }
      case 'moveRows': {
        if (v.sort) throw new EditError('Clear the sort to move rows. The sort only changes the view, not the file.');
        const posOf = new Map();
        grid.order.forEach((id, i) => posOf.set(id, i));
        const ps = e.ids.map(id => posOf.get(id)).filter(p => p !== undefined).sort((a, b) => a - b);
        if (!ps.length) return null;
        const hid = dataIds(grid).headerId;
        const isData = id => !grid.isComment(id) && id !== hid;
        const p0 = ps[0], p1 = ps[ps.length - 1];
        let q;
        if (e.dir < 0) { q = p0 - 1; while (q >= 0 && !isData(grid.order[q])) q--; if (q < 0) return null; }
        else { q = p1 + 1; while (q < grid.order.length && !isData(grid.order[q])) q++; if (q >= grid.order.length) return null; }
        const nid = grid.order[q];
        // Move the neighbour row to the other side of the block: the block moves by one row.
        const target = e.dir < 0 ? p1 : p0;
        return { op: { t: 'multi', ops: [{ t: 'drop', pos: [q] }, { t: 'put', items: [[target, nid]] }] }, label: e.dir < 0 ? 'Move rows up' : 'Move rows down' };
      }
      case 'insertCol': {
        const at = Math.max(0, Math.min(grid.width, e.col + (e.right ? 1 : 0)));
        const ops = [{ t: 'icol', at }];
        const hid = dataIds(grid).headerId;
        if (hid !== null) ops.push({ t: 'set', cells: [[hid, at, e.name || 'new column']] });
        return { op: ops.length === 1 ? ops[0] : { t: 'multi', ops }, label: 'Insert column' };
      }
      case 'deleteCols': {
        const cols = Array.from(new Set(e.cols)).filter(c => c >= 0 && c < grid.width).sort((a, b) => b - a);
        if (!cols.length) return null;
        if (cols.length >= grid.width) throw new EditError('A table needs at least one column.');
        const ops = cols.map(at => ({ t: 'dcol', at }));
        return { op: ops.length === 1 ? ops[0] : { t: 'multi', ops }, label: cols.length === 1 ? 'Delete column' : `Delete ${plural(cols.length, 'column', 'columns')}` };
      }
      case 'moveCol': {
        checkCol(grid, e.col);
        const to = e.col + e.dir;
        if (to < 0 || to >= grid.width) return null;
        return { op: { t: 'mcol', from: e.col, to }, label: e.dir < 0 ? 'Move column left' : 'Move column right' };
      }
      case 'paste': {
        const ids = viewIds(v);
        let start = ids.indexOf(e.anchor);
        if (start < 0) start = ids.length;
        const block = e.rows;
        if (!block.length) return null;
        const width = Math.max(...block.map(r => r.length));
        const ops = [];
        const need = e.col + width - grid.width;
        for (let k = 0; k < need; k++) ops.push({ t: 'icol', at: grid.width + k });
        const extra = Math.max(0, start + block.length - ids.length);
        const newIds = extra ? grid.newIds(extra) : [];
        if (extra) {
          const base = grid.order.length;
          ops.push({ t: 'put', items: newIds.map((id, k) => [base + k, id]), rows: newIds.map(id => [id, []]) });
        }
        const cells = [];
        for (let r = 0; r < block.length; r++) {
          const id = start + r < ids.length ? ids[start + r] : newIds[start + r - ids.length];
          for (let c = 0; c < block[r].length; c++) {
            const col = e.col + c;
            if (col < grid.width && grid.cell(id, col) === block[r][c]) continue;
            cells.push([id, col, block[r][c]]);
          }
        }
        if (cells.length) ops.push({ t: 'set', cells });
        if (!ops.length) return null;
        return { op: ops.length === 1 ? ops[0] : { t: 'multi', ops }, label: `Paste ${block.length}×${width}` };
      }
      case 'fillDown': {
        if (e.ids.length < 2) return null;
        const src = e.ids[0];
        const cells = [];
        for (let c = e.c0; c <= e.c1; c++) {
          checkCol(grid, c);
          const val = grid.cell(src, c);
          for (let k = 1; k < e.ids.length; k++) if (grid.cell(e.ids[k], c) !== val) cells.push([e.ids[k], c, val]);
        }
        if (!cells.length) return null;
        return { op: { t: 'set', cells }, label: 'Fill down' };
      }
      case 'clear': {
        const cells = [];
        for (const id of e.ids) for (let c = e.c0; c <= e.c1; c++) if (c < grid.width && grid.cell(id, c) !== '') cells.push([id, c, '']);
        if (!cells.length) return null;
        return { op: { t: 'set', cells }, label: cells.length === 1 ? 'Clear cell' : `Clear ${plural(cells.length, 'cell', 'cells')}` };
      }
      case 'replaceAll': {
        const re = matcher(e, true);
        const ids = viewIds(v);
        const sel = e.sel;
        const r0 = sel ? sel.r0 : 0, r1 = sel ? Math.min(sel.r1, ids.length - 1) : ids.length - 1;
        const c0 = sel ? sel.c0 : 0, c1 = sel ? Math.min(sel.c1, grid.width - 1) : grid.width - 1;
        const cells = [];
        for (let p = r0; p <= r1; p++) {
          const id = ids[p];
          const r = grid.row(id);
          for (let c = c0; c <= c1; c++) {
            const s = r[c] === undefined ? '' : r[c];
            re.lastIndex = 0;
            if (!re.test(s)) continue;
            re.lastIndex = 0;
            const out = s.replace(re, e.regex ? e.replace : () => e.replace);
            if (out !== s) cells.push([id, c, out]);
          }
        }
        if (!cells.length) return { op: null, label: '', count: 0 };
        return { op: { t: 'set', cells }, label: `Replace ${plural(cells.length, 'cell', 'cells')}`, count: cells.length };
      }
      default:
        throw new EditError('Unknown edit.');
    }
  }

  function matcher(e, global) {
    let src = e.regex ? e.find : e.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (e.wholeCell) src = `^(?:${src})$`;
    try {
      return new RegExp(src, (global ? 'g' : '') + (e.matchCase ? '' : 'i') + 'u');
    } catch (err) {
      throw new EditError(`The search pattern is not valid: ${err.message}`);
    }
  }

  function tag(op, v) {
    if (isXlsx()) op.sheet = sheetOf(v).name;
    return op;
  }

  function gridForOp(op) { return isXlsx() ? doc.sheet(op.sheet).grid : doc.grid; }

  function applyOp(op) {
    const grid = gridForOp(op);
    const inv = grid.apply(op);
    if (isXlsx()) inv.sheet = op.sheet;
    patchViews(op, inv, grid);
    return inv;
  }

  function edit(v, e) {
    requireEditable();
    const b = buildOp(v, e);
    if (!b || !b.op) return { changed: false, count: b ? b.count : 0 };
    const op = tag(b.op, v);
    const inv = applyOp(op);
    undo.push({ op, inv, label: b.label });
    redo = [];
    log.push(op);
    broadcast();
    return { changed: true, label: b.label, size: opSize(op), count: b.count };
  }

  function doUndo() {
    const u = undo.pop();
    if (!u) return false;
    const fwd = applyOp(u.inv);
    u.op = fwd;
    redo.push(u);
    log.pop();
    broadcast();
    return true;
  }

  function doRedo() {
    const r = redo.pop();
    if (!r) return false;
    r.inv = applyOp(r.op);
    undo.push(r);
    log.push(r.op);
    broadcast();
    return true;
  }

  // ---- find -------------------------------------------------------------------------------------------
  function find(v, q) {
    const re = matcher(q, false);
    const grid = gridOf(v);
    const ids = viewIds(v);
    const n = ids.length, w = grid.width;
    if (!n) return { found: false };
    const dir = q.backwards ? -1 : 1;
    let p = Math.min(Math.max(0, q.pos), n - 1), c = q.col + dir;
    let wrapped = false;
    for (let steps = 0; steps <= n; steps++) {
      const r = grid.row(ids[p]);
      while (c >= 0 && c < w) {
        const s = r[c] === undefined ? '' : r[c];
        if (re.test(s)) return { found: true, pos: p, col: c, id: ids[p], wrapped };
        c += dir;
      }
      p += dir;
      if (p >= n) { p = 0; wrapped = true; }
      if (p < 0) { p = n - 1; wrapped = true; }
      c = dir > 0 ? 0 : w - 1;
    }
    return { found: false };
  }

  function countMatches(v, q) {
    const re = matcher(q, false);
    const grid = gridOf(v);
    const ids = viewIds(v);
    let count = 0;
    for (const id of ids) {
      const r = grid.row(id);
      for (let c = 0; c < grid.width; c++) if (re.test(r[c] === undefined ? '' : r[c])) count++;
    }
    return count;
  }

  // ---- save, backup, revert --------------------------------------------------------------------------
  function writeAtomic(target, chunksIter) {
    let real = target;
    try { real = fs.realpathSync(target); } catch { /* new file */ }
    if (fs.existsSync(real)) fs.accessSync(real, fs.constants.W_OK); // a read-only file is never replaced (EACCES, nothing written) (EXEC6)
    const dir = path.dirname(real);
    const tmp = path.join(dir, `.${path.basename(real)}.${process.pid}.${Date.now()}.zovo-tmp`);
    let mode = null;
    try { mode = fs.statSync(real).mode & 0o777; } catch { /* new file */ }
    const fd = fs.openSync(tmp, 'w', mode || 0o644);
    try {
      for (const chunk of chunksIter) {
        let off = 0;
        while (off < chunk.length) off += fs.writeSync(fd, chunk, off, chunk.length - off);
      }
      fs.fsyncSync(fd);
    } catch (e) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
    fs.closeSync(fd);
    try {
      fs.renameSync(tmp, real);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
    const st = fs.statSync(real);
    return { size: st.size, mtimeMs: st.mtimeMs };
  }

  async function save(msg) {
    const t0 = Date.now();
    if (isXlsx()) {
      const bytes = await doc.save(log);
      if (msg.path) return { ...writeAtomic(msg.path, [bytes]), ms: Date.now() - t0 };
      return { bytes, ms: Date.now() - t0 };
    }
    const o = msg.encoding ? { encoding: msg.encoding, bom: !!msg.bom } : {};
    if (!o.encoding) doc.checkEncodable();
    if (msg.path) return { ...writeAtomic(msg.path, doc.chunks(o)), ms: Date.now() - t0 };
    return { bytes: doc.toBuffer(o), ms: Date.now() - t0 };
  }

  function backup(msg) {
    if (!baseHash) baseHash = hashOf(doc);
    const data = JSON.stringify({ v: 1, format, baseHash, baseSize: doc.buf.length, options, log });
    fs.mkdirSync(path.dirname(msg.path), { recursive: true });
    fs.writeFileSync(msg.path, data);
    return { bytes: data.length };
  }

  async function restore(backupPath) {
    let data;
    try { data = JSON.parse(fs.readFileSync(backupPath, 'utf8')); } catch { return 'The unsaved edits from the last session could not be read.'; }
    if (!data || data.v !== 1 || data.format !== format || !Array.isArray(data.log)) return 'The unsaved edits from the last session are in an unknown format.';
    if (data.options && typeof data.options === 'object') {
      const o = data.options;
      if (JSON.stringify(o) !== JSON.stringify(options)) { options = { ...options, ...o }; doc = await load(source, options); }
    }
    if (doc.buf.length !== data.baseSize || hashOf(doc) !== data.baseHash) {
      return 'The file changed on disk after the last session, so its unsaved edits were not applied. The file is shown as it is on disk.';
    }
    baseHash = data.baseHash;
    for (const op of data.log) { applyOp(op); log.push(op); }
    return null;
  }

  async function open(msg) {
    format = msg.format;
    ext = msg.ext || '';
    source = msg.source;
    options = msg.options || {};
    readOnly = !!msg.readOnly;
    readOnlyReason = msg.readOnlyReason || '';
    doc = await load(source, options);
    notices = [];
    if (msg.backup) {
      const note = await restore(msg.backup);
      if (note) notices.push(note);
    }
    if (!isXlsx() && doc.warnings.length) notices.push(...doc.warnings.slice(0, 3));
    return { rows: isXlsx() ? doc.sheets.reduce((n, s) => n + s.grid.order.length, 0) : doc.rowCount, restored: log.length };
  }

  async function revert(msg) {
    if (msg && msg.source) source = msg.source;
    doc = await load(source, options);
    undo = []; redo = []; log = []; baseHash = null; notices = [];
    for (const v of views.values()) { v.index = null; v.indexGrid = null; if (isXlsx() && !doc.sheets.some(s => s.name === v.sheet)) v.sheet = doc.sheets[0].name; }
    broadcast();
    return {};
  }

  /** New CSV options (delimiter, encoding, quote, header, comments): read the file again with them. */
  async function reparse(msg) {
    if (log.length) throw new EditError('Save or undo your edits first. The file is read again with the new settings.');
    const next = { ...options, ...msg.options };
    if (isXlsx()) {
      options = next;
      doc.header = next.header === true;
    } else {
      const d = await load(source, next);
      doc = d;
      options = next;
    }
    undo = []; redo = [];
    for (const v of views.values()) { v.index = null; v.indexGrid = null; v.sort = null; }
    broadcast();
    return { options };
  }

  function view(id) {
    let v = views.get(id);
    if (!v) {
      v = { id, sort: null, filters: { global: '', columns: {}, query: '' }, index: null, indexGrid: null, sheet: isXlsx() ? doc.sheets.find(s => s.state === 'visible')?.name || doc.sheets[0].name : null };
      views.set(id, v);
    }
    return v;
  }

  function cellFull(v, id, col) {
    const grid = gridOf(v);
    const s = grid.cell(id, col);
    const out = { id, col, value: s.length > MAX_FULL_CELL ? s.slice(0, MAX_FULL_CELL) : s, length: s.length, truncated: s.length > MAX_FULL_CELL };
    if (isXlsx() && (!grid.mod.has(id) || grid.cell(id, col) === grid.baseCell(id, col))) {
      const f = doc.formula(v.sheet, id, col);
      if (f) out.formula = f;
    }
    return out;
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'open': return open(msg);
      case 'revert': return revert(msg);
      case 'reparse': return reparse(msg);
      case 'save': return save(msg);
      case 'backup': return backup(msg);
      case 'undo': return { done: doUndo() };
      case 'redo': return { done: doRedo() };
      case 'dirtyInfo': return { ops: log.length };
      case 'describe': return isXlsx() ? doc.describe() : doc.describe();
      case 'closeView': views.delete(msg.view); return {};
      default: break;
    }
    const v = view(msg.view);
    switch (msg.type) {
      case 'hello': post(meta(v)); return {};
      case 'getRows': post({ type: 'rows', view: v.id, reqId: msg.reqId, start: msg.start, version: gridOf(v).version, rows: rows(v, msg.start, msg.count) }); return {};
      case 'sort': v.sort = msg.col === null ? null : { col: msg.col, dir: msg.dir }; applyViewState(v); post(meta(v)); return {};
      case 'filter': v.filters = { global: msg.global || '', columns: msg.columns || {}, query: msg.query || '' }; applyViewState(v); post(meta(v)); return {};
      case 'sheet': if (isXlsx()) { v.sheet = doc.sheet(msg.name).name; v.sort = null; v.filters = { global: '', columns: {}, query: '' }; v.index = null; } post(meta(v)); return {};
      case 'refreshView': applyViewState(v); post(meta(v)); return {};
      case 'edit': return edit(v, msg.edit);
      case 'find': return find(v, msg.query);
      case 'count': return { count: countMatches(v, msg.query) };
      case 'getCell': return cellFull(v, msg.id, msg.col);
      case 'stats': {
        const { table, ids } = snapshot(v);
        const vi = viewIds(v);
        if (vi !== dataIds(gridOf(v)).ids) {
          const pos = new Map(); ids.forEach((id, i) => pos.set(id, i));
          table.index = Uint32Array.from(vi.map(id => pos.get(id)).filter(x => x !== undefined));
        }
        const st = computeStats(table, { columns: [msg.col], top: 3 });
        return st;
      }
      case 'copy': {
        const grid = gridOf(v);
        const ids = viewIds(v);
        const lines = [];
        for (let p = msg.r0; p <= Math.min(msg.r1, ids.length - 1); p++) {
          const r = grid.row(ids[p]);
          const cells = [];
          for (let c = msg.c0; c <= Math.min(msg.c1, grid.width - 1); c++) cells.push(tsvField(r[c] === undefined ? '' : r[c]));
          lines.push(cells.join('\t'));
          if (lines.length >= msg.max) break;
        }
        return { text: lines.join('\n'), rows: lines.length };
      }
      default: throw new Error(`Unknown message ${msg.type}`);
    }
  }

  return { handle, _state: () => ({ doc, undo, redo, log, views }) };
}

/**
 * Find and replace in one CSV file on disk (multi-file replace, Pro). Rows that do not change are copied byte
 * for byte. apply=false only counts. The header row and comment lines are not changed.
 */
function replaceInFile(msg) {
  const st = fs.statSync(msg.path);
  if (st.size > msg.maxBytes) return { path: msg.path, skipped: `larger than ${Math.round(msg.maxBytes / 1048576)} MB` };
  const doc = new CsvDoc(fs.readFileSync(msg.path), { ext: msg.path.toLowerCase().endsWith('.tsv') ? 'tsv' : 'csv' });
  const q = msg.query;
  let src = q.regex ? q.find : q.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (q.wholeCell) src = `^(?:${src})$`;
  const re = new RegExp(src, 'g' + (q.matchCase ? '' : 'i') + 'u');
  const g = doc.grid;
  const cells = [];
  let headerSeen = !doc.header;
  for (const id of g.order) {
    if (g.isComment(id)) continue;
    if (!headerSeen) { headerSeen = true; continue; }
    const r = g.row(id);
    for (let c = 0; c < r.length; c++) {
      const v = r[c] || '';
      re.lastIndex = 0;
      if (!re.test(v)) continue;
      re.lastIndex = 0;
      const out = v.replace(re, q.regex ? msg.replace : () => msg.replace);
      if (out !== v) cells.push([id, c, out]);
    }
  }
  if (!msg.apply || !cells.length) return { path: msg.path, count: cells.length };
  g.apply({ t: 'set', cells });
  doc.checkEncodable();
  const tmp = `${msg.path}.${process.pid}.${Date.now()}.zovo-tmp`;
  const fd = fs.openSync(tmp, 'w', st.mode & 0o777);
  try {
    for (const chunk of doc.chunks()) { let off = 0; while (off < chunk.length) off += fs.writeSync(fd, chunk, off, chunk.length - off); }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, msg.path);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* closed */ }
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  return { path: msg.path, count: cells.length, written: true };
}

function tsvField(s) {
  if (/[\t\n\r"]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

module.exports = { createSession, colLetter, EditError, replaceInFile };
