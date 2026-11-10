'use strict';
// Checks every message from the webview before the host acts on it. Anything unknown or malformed is dropped.

const { CSV_ENCODINGS } = require('./encoding');

const MAX_PAGE = 2000;
const MAX_TEXT = 10 * 1024 * 1024; // one cell
const MAX_PASTE_CELLS = 2000000;
const MAX_IDS = 5000000;
const MAX_FILTER = 2000;

function int(v, lo, hi) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) return null;
  return n;
}
function str(v, max) { return typeof v === 'string' && v.length <= max ? v : null; }
function bool(v) { return v === true; }
function idList(a) {
  if (!Array.isArray(a) || a.length > MAX_IDS) return null;
  const out = [];
  for (const x of a) { const n = int(x, 0, 2 ** 31); if (n === null) return null; out.push(n); }
  return out;
}

function validateQuery(q) {
  if (!q || typeof q !== 'object') return null;
  const find = str(q.find, MAX_FILTER);
  if (find === null || find === '') return null;
  return {
    find,
    regex: bool(q.regex), matchCase: bool(q.matchCase), wholeCell: bool(q.wholeCell), backwards: bool(q.backwards),
    pos: int(q.pos, 0, 2 ** 31) ?? 0, col: int(q.col, -1, 1e6) ?? -1,
  };
}

function validateEdit(e) {
  if (!e || typeof e !== 'object') return null;
  switch (e.kind) {
    case 'set': {
      if (!Array.isArray(e.cells) || !e.cells.length || e.cells.length > MAX_PASTE_CELLS) return null;
      const cells = [];
      for (const c of e.cells) {
        const id = int(c && c.id, 0, 2 ** 31), col = int(c && c.col, 0, 1e6), value = str(c && c.value, MAX_TEXT);
        if (id === null || col === null || value === null) return null;
        cells.push({ id, col, value });
      }
      return { kind: 'set', cells };
    }
    case 'header': {
      const col = int(e.col, 0, 1e6), value = str(e.value, 100000);
      return col === null || value === null ? null : { kind: 'header', col, value };
    }
    case 'insertRows': {
      const anchor = e.anchor === null ? null : int(e.anchor, 0, 2 ** 31);
      const count = int(e.count, 1, 100000);
      if ((anchor === null && e.anchor !== null) || count === null) return null;
      return { kind: 'insertRows', anchor, below: bool(e.below), count };
    }
    case 'deleteRows': { const ids = idList(e.ids); return ids && ids.length ? { kind: 'deleteRows', ids } : null; }
    case 'moveRows': {
      const ids = idList(e.ids);
      if (!ids || !ids.length || (e.dir !== 1 && e.dir !== -1)) return null;
      return { kind: 'moveRows', ids, dir: e.dir };
    }
    case 'insertCol': { const col = int(e.col, 0, 1e6); return col === null ? null : { kind: 'insertCol', col, right: bool(e.right) }; }
    case 'deleteCols': {
      if (!Array.isArray(e.cols) || !e.cols.length || e.cols.length > 100000) return null;
      const cols = e.cols.map(c => int(c, 0, 1e6));
      return cols.includes(null) ? null : { kind: 'deleteCols', cols };
    }
    case 'moveCol': {
      const col = int(e.col, 0, 1e6);
      if (col === null || (e.dir !== 1 && e.dir !== -1)) return null;
      return { kind: 'moveCol', col, dir: e.dir };
    }
    case 'paste': {
      const anchor = e.anchor === null ? null : int(e.anchor, 0, 2 ** 31), col = int(e.col, 0, 1e6);
      if (col === null || !Array.isArray(e.rows) || !e.rows.length) return null;
      let cells = 0;
      const rows = [];
      for (const r of e.rows) {
        if (!Array.isArray(r)) return null;
        cells += r.length;
        if (cells > MAX_PASTE_CELLS) return null;
        const row = [];
        for (const v of r) { const s = str(v, MAX_TEXT); if (s === null) return null; row.push(s); }
        rows.push(row);
      }
      return { kind: 'paste', anchor, col, rows };
    }
    case 'fillDown': {
      const ids = idList(e.ids), c0 = int(e.c0, 0, 1e6), c1 = int(e.c1, 0, 1e6);
      if (!ids || c0 === null || c1 === null || c1 < c0) return null;
      return { kind: 'fillDown', ids, c0, c1 };
    }
    case 'clear': {
      const ids = idList(e.ids), c0 = int(e.c0, 0, 1e6), c1 = int(e.c1, 0, 1e6);
      if (!ids || c0 === null || c1 === null || c1 < c0) return null;
      return { kind: 'clear', ids, c0, c1 };
    }
    case 'replaceAll': {
      const q = validateQuery(e);
      const replace = str(e.replace, MAX_FILTER);
      if (!q || replace === null) return null;
      const out = { kind: 'replaceAll', ...q, replace };
      if (e.sel) {
        const s = e.sel;
        const r0 = int(s.r0, 0, 2 ** 31), r1 = int(s.r1, 0, 2 ** 31), c0 = int(s.c0, 0, 1e6), c1 = int(s.c1, 0, 1e6);
        if ([r0, r1, c0, c1].includes(null) || r1 < r0 || c1 < c0) return null;
        out.sel = { r0, r1, c0, c1 };
      }
      return out;
    }
    default: return null;
  }
}

const DELIMS = new Set(['auto', ',', '\t', ';', '|', ':', ' ']);

function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return null;
  switch (m.type) {
    case 'ready': case 'undo': case 'redo': case 'save': case 'openSettings': case 'openAsText': case 'refreshView': case 'saveAsUtf8': case 'proLargeFile':
      return { type: m.type };
    case 'getRows': {
      const start = int(m.start, 0, 2 ** 31), count = int(m.count, 0, MAX_PAGE), reqId = int(m.reqId, 0, 2 ** 31);
      return start === null || count === null || reqId === null ? null : { type: 'getRows', start, count, reqId };
    }
    case 'sort': {
      if (m.col === null) return { type: 'sort', col: null, dir: null };
      const col = int(m.col, 0, 1e6);
      return col === null || (m.dir !== 'asc' && m.dir !== 'desc') ? null : { type: 'sort', col, dir: m.dir };
    }
    case 'filter': {
      const columns = {};
      if (m.columns && typeof m.columns === 'object') {
        for (const [k, v] of Object.entries(m.columns)) {
          const c = int(k, 0, 1e6);
          if (c !== null && typeof v === 'string' && v.trim()) columns[c] = v.slice(0, MAX_FILTER);
        }
      }
      return { type: 'filter', global: str(m.global, MAX_FILTER) || '', columns, query: str(m.query, MAX_FILTER) || '' };
    }
    case 'sheet': { const name = str(m.name, 300); return name === null ? null : { type: 'sheet', name }; }
    case 'edit': { const edit = validateEdit(m.edit); return edit ? { type: 'edit', edit, reqId: int(m.reqId, 0, 2 ** 31) ?? 0 } : null; }
    case 'find': case 'count': {
      const query = validateQuery(m.query);
      return query ? { type: m.type, query, reqId: int(m.reqId, 0, 2 ** 31) ?? 0 } : null;
    }
    case 'getCell': {
      const id = int(m.id, 0, 2 ** 31), col = int(m.col, 0, 1e6), reqId = int(m.reqId, 0, 2 ** 31);
      return id === null || col === null || reqId === null ? null : { type: 'getCell', id, col, reqId, purpose: m.purpose === 'edit' ? 'edit' : 'show' };
    }
    case 'stats': { const col = int(m.col, 0, 1e6); return col === null ? null : { type: 'stats', col, reqId: int(m.reqId, 0, 2 ** 31) ?? 0 }; }
    case 'copy': {
      const r0 = int(m.r0, 0, 2 ** 31), r1 = int(m.r1, 0, 2 ** 31), c0 = int(m.c0, 0, 1e6), c1 = int(m.c1, 0, 1e6);
      if ([r0, r1, c0, c1].includes(null) || r1 < r0 || c1 < c0) return null;
      return { type: 'copy', r0, r1, c0, c1, cut: bool(m.cut) };
    }
    case 'csvOptions': {
      const o = {};
      if (m.encoding !== undefined) { if (m.encoding !== 'auto' && !CSV_ENCODINGS.includes(m.encoding)) return null; o.encoding = m.encoding; }
      if (m.delimiter === 'auto') o.delimiter = 'auto';
      else if (m.delimiter !== undefined) {
        const d = str(m.delimiter, 1);
        if (d === null || !(DELIMS.has(d) || (d.length === 1 && d !== '\n' && d !== '\r' && d !== '"'))) return null;
        o.delimiter = d === '' ? 'auto' : d;
      }
      if (m.quote !== undefined) { if (m.quote !== '"' && m.quote !== "'" && m.quote !== '') return null; o.quote = m.quote; }
      if (m.header !== undefined) { if (typeof m.header !== 'boolean') return null; o.header = m.header; }
      if (m.commentPrefix !== undefined) { const c = str(m.commentPrefix, 3); if (c === null || /[\r\n]/.test(c)) return null; o.commentPrefix = c; }
      return { type: 'csvOptions', options: o };
    }
    default: return null;
  }
}

module.exports = { validateWebviewMessage, validateEdit, validateQuery, MAX_PAGE };
