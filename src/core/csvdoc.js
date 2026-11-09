'use strict';
// CSV/TSV document: the file bytes stay as they are, and an index of record starts points into them.
// A row is decoded and split only when it is shown, sorted, searched or saved. Saving copies the bytes of
// every row that was not edited, so the delimiter, quoting, encoding, BOM and line endings of the rest of
// the file stay exactly as they were.

const { Grid } = require('./grid');
const { detectEncoding } = require('./encoding');
const { detectDelimiter } = require('./csv');
const { encode, bomLength, TRAIL_CAN_BE_ASCII } = require('./codec');

const LF = 10, CR = 13;
const KIND_DATA = 0, KIND_COMMENT = 1, KIND_LENIENT = 2;

function unitReader(buf, enc) {
  if (enc === 'utf-16le') return { step: 2, at: i => buf[i] | (buf[i + 1] << 8) };
  if (enc === 'utf-16be') return { step: 2, at: i => (buf[i] << 8) | buf[i + 1] };
  return { step: 1, at: i => buf[i] };
}

/** Code unit of a one-character string in the file's encoding, or -1 when it needs more than one. */
function charUnit(ch, enc) {
  if (!ch) return -1;
  if (enc === 'utf-16le' || enc === 'utf-16be') return ch.length === 1 ? ch.charCodeAt(0) : -1;
  try {
    const b = encode(ch, enc);
    return b.length === 1 ? b[0] : -1;
  } catch { return -1; }
}

/**
 * Find the records of a CSV file.
 * @returns {{starts:Float64Array, term:Uint8Array, kind:Uint8Array, count:number, maxFields:number,
 *   eol:{crlf:number, lf:number, cr:number}, endsWithEol:boolean, warnings:string[]}}
 */
function scan(buf, o) {
  const { step, at } = unitReader(buf, o.encoding);
  const D = o.delimUnit, Q = o.quoteUnit; // Q = -1: no quoting
  const skipTrail = TRAIL_CAN_BE_ASCII.has(o.encoding);
  const sjis = o.encoding === 'shift_jis';
  const comment = o.commentUnits; // array of units, or null
  const n = buf.length - ((buf.length - o.bom) % step);
  let cap = Math.max(1024, Math.ceil(n / 40));
  let starts = new Float64Array(cap + 1);
  let term = new Uint8Array(cap);
  let kind = new Uint8Array(cap);
  let count = 0, maxFields = 0;
  const eol = { crlf: 0, lf: 0, cr: 0 };
  const warnings = [];
  const grow = () => {
    cap *= 2;
    const s2 = new Float64Array(cap + 1); s2.set(starts); starts = s2;
    const t2 = new Uint8Array(cap); t2.set(term); term = t2;
    const k2 = new Uint8Array(cap); k2.set(kind); kind = k2;
  };
  let i = o.bom;
  let lenientFrom = -1;
  while (i < n) {
    if (count >= cap) grow();
    const recStart = i;
    starts[count] = recStart;
    let fields = 1;
    let k = KIND_DATA;
    let isComment = false;
    if (comment && i + comment.length * step <= n) {
      isComment = true;
      for (let c = 0; c < comment.length; c++) if (at(i + c * step) !== comment[c]) { isComment = false; break; }
    }
    const lenient = isComment || recStart === lenientFrom;
    if (isComment) k = KIND_COMMENT;
    else if (lenient) k = KIND_LENIENT;
    let inQ = false;
    let fieldStart = true;
    let t = 0;
    let ended = false;
    while (i < n) {
      const u = at(i);
      if (inQ) {
        if (u === Q) {
          if (i + step < n && at(i + step) === Q) { i += 2 * step; continue; }
          inQ = false; fieldStart = false; i += step; continue;
        }
        if (step === 1 && !skipTrail) {
          const q = buf.indexOf(Q, i + 1);
          i = q === -1 || q >= n ? n : q;
          continue;
        }
        if (skipTrail && u >= 0x81 && !(sjis && u >= 0xa1 && u <= 0xdf)) { i += 2; continue; }
        i += step;
        continue;
      }
      if (u === LF) { t = step; eol.lf++; ended = true; break; }
      if (u === CR) {
        if (i + step < n && at(i + step) === LF) { t = 2 * step; eol.crlf++; } else { t = step; eol.cr++; }
        ended = true; break;
      }
      if (!lenient) {
        if (u === D) { fields++; fieldStart = true; i += step; continue; }
        if (u === Q && fieldStart) { inQ = true; i += step; continue; }
      }
      fieldStart = false;
      if (skipTrail && u >= 0x81 && !(sjis && u >= 0xa1 && u <= 0xdf)) { i += 2; continue; }
      i += step;
    }
    if (inQ && !ended) {
      // The file ends inside a quoted field: that quote is a stray one. Read this record again up to its
      // line end without quoting, so the rest of the file is not swallowed into one cell.
      warnings.push(`Row ${count + 1} has a quote that is never closed. It is read up to its line end, as plain text.`);
      i = recStart;
      lenientFrom = recStart;
      continue;
    }
    i += t;
    term[count] = t;
    kind[count] = k;
    if (k !== KIND_COMMENT && fields > maxFields) maxFields = fields;
    count++;
  }
  starts[count] = n;
  const endsWithEol = count > 0 && term[count - 1] > 0;
  return { starts, term, kind, count, maxFields, eol, endsWithEol, warnings };
}

/** Split one record (no line end) into fields. */
function splitRecord(text, d, q, lenient) {
  const out = [];
  const n = text.length;
  if (lenient || !q) return text.split(d);
  let i = 0;
  let field = '';
  let fieldStart = true;
  while (i <= n) {
    if (i === n) { out.push(field); break; }
    const ch = text[i];
    if (ch === q && fieldStart) {
      // quoted field
      i++;
      for (;;) {
        const j = text.indexOf(q, i);
        if (j === -1) { field += text.slice(i); i = n; break; }
        field += text.slice(i, j);
        if (text[j + 1] === q) { field += q; i = j + 2; continue; }
        i = j + 1;
        break;
      }
      fieldStart = false;
      continue;
    }
    if (ch === d) { out.push(field); field = ''; fieldStart = true; i++; continue; }
    const j = text.indexOf(d, i);
    if (j === -1) { field += text.slice(i); i = n; fieldStart = false; continue; }
    field += text.slice(i, j);
    i = j;
    fieldStart = false;
  }
  return out;
}

const DELIM_NAMES = { ',': 'comma', '\t': 'tab', ';': 'semicolon', '|': 'pipe', ':': 'colon', ' ': 'space' };

class CsvDoc {
  /**
   * @param {Buffer} buf whole file
   * @param {{encoding?:string, delimiter?:string, quote?:string, header?:boolean, commentPrefix?:string, ext?:string}} opts
   */
  constructor(buf, opts = {}) {
    this.kind = 'csv';
    this.buf = buf;
    const enc = opts.encoding && opts.encoding !== 'auto' ? opts.encoding : detectEncoding(buf.subarray(0, 65536));
    this.encoding = enc;
    this.bom = bomLength(buf, enc);
    this.decoder = new TextDecoder(enc, { ignoreBOM: true });
    const head = this.decode(this.bom, Math.min(buf.length, this.bom + 65536));
    let d = opts.delimiter && opts.delimiter !== 'auto' ? opts.delimiter : null;
    if (!d) d = opts.ext === 'tsv' ? '\t' : detectDelimiter(head, opts.ext === 'tsv' ? '\t' : ',');
    this.delimiter = d;
    this.quote = opts.quote === undefined ? '"' : opts.quote;
    this.commentPrefix = opts.commentPrefix || '';
    this.header = opts.header !== false;
    const delimUnit = charUnit(d, enc);
    if (delimUnit < 0 || delimUnit === LF || delimUnit === CR) throw new Error(`The delimiter "${d}" is not one character in ${enc}. Pick another one.`);
    const quoteUnit = this.quote ? charUnit(this.quote, enc) : -1;
    if (this.quote && (quoteUnit < 0 || quoteUnit === delimUnit)) throw new Error(`The quote character "${this.quote}" cannot be used with this file.`);
    let commentUnits = null;
    if (this.commentPrefix) {
      commentUnits = [];
      for (const ch of this.commentPrefix) {
        const u = charUnit(ch, enc);
        if (u < 0) throw new Error(`The comment prefix "${this.commentPrefix}" cannot be used with this encoding.`);
        commentUnits.push(u);
      }
    }
    const s = scan(buf, { encoding: enc, bom: this.bom, delimUnit, quoteUnit, commentUnits });
    this.index = s;
    const { crlf, lf, cr } = s.eol;
    this.eol = crlf >= lf && crlf >= cr && crlf > 0 ? '\r\n' : cr > lf ? '\r' : '\n';
    this.endsWithEol = s.endsWithEol || s.count === 0;
    this.warnings = s.warnings;
    this.quoteAll = this.quote ? this._detectQuoteAll() : false;
    const self = this;
    this.grid = new Grid({
      count: s.count,
      width: Math.max(1, s.maxFields),
      fields: id => self.fields(id),
      isComment: id => s.kind[id] === KIND_COMMENT,
    });
  }

  decode(start, end) {
    if (this.encoding === 'utf-8') return this.buf.toString('utf8', start, end);
    return this.decoder.decode(this.buf.subarray(start, end));
  }

  /** Text of base record `id` without its line end. */
  recordText(id) {
    const s = this.index.starts[id];
    const e = this.index.starts[id + 1] - this.index.term[id];
    return this.decode(s, e);
  }

  fields(id) {
    const k = this.index.kind[id];
    if (k === KIND_COMMENT) return [this.recordText(id)];
    return splitRecord(this.recordText(id), this.delimiter, this.quote, k === KIND_LENIENT);
  }

  _detectQuoteAll() {
    // A file whose writer quoted every field (some exporters do): new and edited rows are written the same way.
    const q = this.quote;
    let quoted = 0, total = 0;
    for (let id = 0; id < Math.min(this.index.count, 50); id++) {
      if (this.index.kind[id] !== KIND_DATA) continue;
      const text = this.recordText(id);
      if (!text) continue;
      const parts = splitRaw(text, this.delimiter, q);
      for (const p of parts) { total++; if (p.length >= 2 && p[0] === q && p[p.length - 1] === q) quoted++; }
    }
    return total >= 4 && quoted === total;
  }

  get rowCount() { return this.grid.order.length; }

  describe() {
    const enc = this.encoding;
    return {
      encoding: enc,
      bom: this.bom > 0,
      delimiter: this.delimiter,
      delimiterName: DELIM_NAMES[this.delimiter] || `"${this.delimiter}"`,
      quote: this.quote,
      eol: this.eol === '\r\n' ? 'CRLF' : this.eol === '\r' ? 'CR' : 'LF',
      mixedEol: [this.index.eol.crlf, this.index.eol.lf, this.index.eol.cr].filter(x => x > 0).length > 1,
      commentPrefix: this.commentPrefix,
      comments: countKind(this.index, KIND_COMMENT),
      warnings: this.warnings.slice(0, 5),
    };
  }

  /** One row as text in the file's style, with no line end. */
  serialize(cells) {
    const d = this.delimiter, q = this.quote;
    return cells.map(v => quoteField(v === undefined || v === null ? '' : String(v), d, q, this.quoteAll)).join(d);
  }

  /** Throws EncodeError when an edited cell has a character the file's encoding cannot hold. */
  checkEncodable() {
    if (this.encoding === 'utf-8' || this.encoding.startsWith('utf-16')) return;
    for (const id of this.grid.order) {
      if (this.grid.isUntouched(id) || this.grid.isComment(id)) continue;
      encode(this.serialize(this.grid.row(id)), this.encoding);
    }
  }

  /**
   * The file as it will be saved, in chunks of about `chunkBytes`. Untouched rows are copied byte for byte.
   * @param {{encoding?:string}} [o] another encoding (Save as UTF-8): every row is written again
   */
  *chunks(o = {}, chunkBytes = 1 << 20) {
    const g = this.grid;
    const ix = this.index;
    const enc = o.encoding || this.encoding;
    const same = enc === this.encoding;
    const parts = [];
    let size = 0;
    const push = b => { parts.push(b); size += b.length; };
    const flush = () => { const out = parts.length === 1 ? parts[0] : Buffer.concat(parts, size); parts.length = 0; size = 0; return out; };
    if (same && this.bom) push(this.buf.subarray(0, this.bom));
    else if (!same && o.bom) push(encode('﻿', enc));
    const eolBytes = encode(this.eol, enc);
    const order = g.order;
    const last = order.length - 1;
    for (let p = 0; p <= last; p++) {
      const id = order[p];
      const isLast = p === last;
      if (same && (g.isUntouched(id) || g.isComment(id)) && id < ix.count) {
        const s = ix.starts[id], e = ix.starts[id + 1];
        push(this.buf.subarray(s, e));
        if (ix.term[id] === 0 && !isLast) push(eolBytes);
      } else {
        let cells = g.isComment(id) ? null : g.row(id);
        // A new row gets every column, so the file keeps one column count.
        if (cells && id >= ix.count && cells.length < g.width) { cells = cells.slice(); while (cells.length < g.width) cells.push(''); }
        const text = cells ? this.serialize(cells) : this.recordText(id);
        push(encode(text, enc));
        if (!isLast || this.endsWithEol) push(eolBytes);
      }
      if (size >= chunkBytes) yield flush();
    }
    if (size) yield flush();
  }

  /** The whole file as one Buffer (tests and small files). */
  toBuffer(o) {
    return Buffer.concat(Array.from(this.chunks(o)));
  }
}

function countKind(ix, k) {
  let n = 0;
  for (let i = 0; i < ix.count; i++) if (ix.kind[i] === k) n++;
  return n;
}

/** Fields of a record with their quotes kept (for style detection). */
function splitRaw(text, d, q) {
  const out = [];
  let start = 0, inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === q) inQ = !inQ;
    else if (ch === d && !inQ) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

function quoteField(v, d, q, all) {
  if (!q) return v;
  if (all || v.includes(d) || v.includes(q) || v.includes('\n') || v.includes('\r')) {
    return q + v.split(q).join(q + q) + q;
  }
  return v;
}

module.exports = { CsvDoc, scan, splitRecord, quoteField, KIND_DATA, KIND_COMMENT, KIND_LENIENT };
