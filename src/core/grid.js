'use strict';
// Editable grid over a read-only base (the CSV bytes or one Excel sheet).
//
// Rows have stable ids. Base rows are 0..base.count-1; new rows get ids from nextId upward.
// `order` is the row order of the file. `mod` holds the cells of every changed or new row, in the current
// column space. `colMap` maps current columns to base fields (-1 = a column added here).
// A row that is not in `mod` while colMap is the identity is untouched: the CSV writer copies its bytes.
//
// Every change is an op (plain JSON). apply(op) changes the grid and returns the op that undoes it, so
// undo and redo are apply() calls, and a list of ops can be replayed (hot-exit backup, Excel save).
//   set   {t:'set', cells:[[id, col, text], ...], unmod?:[id]}    cell values
//   put   {t:'put', items:[[pos, id], ...], rows?:[[id, cells]]}   insert rows (pos ascending, final positions)
//   drop  {t:'drop', pos:[...]}                                     delete rows at these positions
//   icol  {t:'icol', at, entry?, vals?:[[id, text]]}                insert a column
//   dcol  {t:'dcol', at}                                            delete a column
//   mcol  {t:'mcol', from, to}                                      move a column
//   multi {t:'multi', ops:[...]}

const BULK = 32;

class Grid {
  /**
   * @param {{count:number, width:number, fields:(id:number)=>string[], isComment?:(id:number)=>boolean}} base
   */
  constructor(base) {
    this.base = base;
    this.order = new Array(base.count);
    for (let i = 0; i < base.count; i++) this.order[i] = i;
    this.mod = new Map();
    this.colMap = [];
    for (let i = 0; i < base.width; i++) this.colMap.push(i);
    this.identity = true;
    this.nextId = base.count;
    this.version = 0; // any change
    this.structVersion = 0; // rows added, removed or moved, or columns changed
  }

  get width() { return this.colMap.length; }

  isComment(id) { return id < this.base.count && !!this.base.isComment && this.base.isComment(id); }

  /** Cells of a row in the current column space. Do not change the returned array. */
  row(id) {
    const m = this.mod.get(id);
    if (m) return m;
    if (id >= this.base.count) return [];
    const f = this.base.fields(id);
    if (this.identity) return f;
    return this.colMap.map(k => (k >= 0 && k < f.length ? f[k] : ''));
  }

  cell(id, col) {
    const r = this.row(id);
    const v = r[col];
    return v === undefined || v === null ? '' : v;
  }

  /** Base text of a cell in the current column space, or null for a new row or a new column. */
  baseCell(id, col) {
    if (id >= this.base.count) return null;
    const k = this.colMap[col];
    if (k === undefined || k < 0) return null;
    const v = this.base.fields(id)[k];
    return v === undefined ? '' : v;
  }

  /** Columns of a row whose text differs from the file as it was read (all, for a new row). */
  changedCols(id) {
    const m = this.mod.get(id);
    if (!m) return null;
    const out = [];
    for (let c = 0; c < this.colMap.length; c++) {
      const b = this.baseCell(id, c);
      const v = m[c] === undefined ? '' : m[c];
      if (b === null ? v !== '' : v !== b) out.push(c);
    }
    return out;
  }

  isUntouched(id) { return this.identity && id < this.base.count && !this.mod.has(id); }

  _materialize(id) {
    let r = this.mod.get(id);
    if (r) return r;
    r = this.row(id).slice();
    this.mod.set(id, r);
    return r;
  }

  _recomputeIdentity() {
    const w = this.base.width;
    let id = this.colMap.length === w;
    for (let i = 0; id && i < w; i++) if (this.colMap[i] !== i) id = false;
    this.identity = id;
  }

  /** Allocate ids for new rows. */
  newIds(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.nextId++);
    return out;
  }

  apply(op) {
    const inv = this._apply(op);
    this.version++;
    return inv;
  }

  _apply(op) {
    switch (op.t) {
      case 'set': return this._set(op);
      case 'put': this.structVersion++; return this._put(op);
      case 'drop': this.structVersion++; return this._drop(op);
      case 'icol': this.structVersion++; return this._icol(op);
      case 'dcol': this.structVersion++; return this._dcol(op);
      case 'mcol': {
        this.structVersion++;
        const d = this._dcol({ t: 'dcol', at: op.from });
        this._icol({ t: 'icol', at: op.to, entry: d.entry, vals: d.vals });
        return { t: 'mcol', from: op.to, to: op.from };
      }
      case 'multi': {
        const invs = [];
        for (const o of op.ops) invs.push(this._apply(o));
        return { t: 'multi', ops: invs.reverse() };
      }
      default: throw new Error(`Unknown edit ${op.t}`);
    }
  }

  _set(op) {
    const old = [];
    const unmod = [];
    const seen = new Set();
    for (const [id, col, text] of op.cells) {
      if (!seen.has(id)) { seen.add(id); if (!this.mod.has(id)) unmod.push(id); }
      old.push([id, col, this.cell(id, col)]);
      const r = this._materialize(id);
      while (r.length <= col) r.push('');
      r[col] = String(text);
    }
    if (op.unmod) {
      for (const id of op.unmod) {
        if (id >= this.base.count) continue;
        // The row is back to its base text: drop the copy, so the CSV writer copies the original bytes again.
        this.mod.delete(id);
      }
    }
    return { t: 'set', cells: old.reverse(), unmod };
  }

  _put(op) {
    const items = op.items.slice().sort((a, b) => a[0] - b[0]);
    if (op.rows) for (const [id, cells] of op.rows) this.mod.set(id, cells.map(String));
    for (const [, id] of items) if (id >= this.nextId) this.nextId = id + 1;
    if (items.length <= BULK) {
      for (const [pos, id] of items) this.order.splice(Math.min(pos, this.order.length), 0, id);
    } else {
      const total = this.order.length + items.length;
      const out = new Array(total);
      let k = 0, j = 0;
      for (let p = 0; p < total; p++) {
        if (k < items.length && items[k][0] === p) out[p] = items[k++][1];
        else if (j < this.order.length) out[p] = this.order[j++];
        else out[p] = items[k++][1];
      }
      this.order = out;
    }
    return { t: 'drop', pos: items.map(x => x[0]) };
  }

  _drop(op) {
    const pos = Array.from(new Set(op.pos)).filter(p => p >= 0 && p < this.order.length).sort((a, b) => a - b);
    const items = pos.map(p => [p, this.order[p]]);
    if (pos.length <= BULK) {
      for (let i = pos.length - 1; i >= 0; i--) this.order.splice(pos[i], 1);
    } else {
      const drop = new Set(pos);
      const out = [];
      for (let p = 0; p < this.order.length; p++) if (!drop.has(p)) out.push(this.order[p]);
      this.order = out;
    }
    return { t: 'put', items };
  }

  _icol(op) {
    const at = Math.max(0, Math.min(op.at, this.colMap.length));
    this.colMap.splice(at, 0, op.entry === undefined ? -1 : op.entry);
    if (op.vals) {
      // Undo of a column delete: put the cells back in exactly the rows they came from.
      for (const [id, v] of op.vals) { const r = this.mod.get(id); if (r) r.splice(Math.min(at, r.length), 0, v); }
    } else {
      for (const [, r] of this.mod) if (r.length >= at) r.splice(at, 0, '');
    }
    this._recomputeIdentity();
    return { t: 'dcol', at };
  }

  _dcol(op) {
    const at = op.at;
    if (at < 0 || at >= this.colMap.length) throw new Error('No such column.');
    const entry = this.colMap.splice(at, 1)[0];
    const vals = [];
    for (const [id, r] of this.mod) {
      if (r.length > at) {
        const v = r.splice(at, 1)[0];
        vals.push([id, v === undefined || v === null ? '' : v]);
      }
    }
    this._recomputeIdentity();
    return { t: 'icol', at, entry, vals };
  }
}

/** Number of cells an op touches, for labels and limits. */
function opSize(op) {
  switch (op.t) {
    case 'set': return op.cells.length;
    case 'put': return op.items.length;
    case 'drop': return op.pos.length;
    case 'multi': return op.ops.reduce((n, o) => n + opSize(o), 0);
    default: return 1;
  }
}

module.exports = { Grid, opSize };
