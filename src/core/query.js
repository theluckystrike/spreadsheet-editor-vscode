'use strict';
// SQL WHERE filter (Pro). A small own parser, no dependencies, no eval.
//
//   fare > 20 AND (city = 'Paris' OR city LIKE 'Lon%')
//   WHERE tip IS NOT NULL AND payment IN ('card', 'cash') AND day BETWEEN '2024-01-01' AND '2024-01-31'
//   NOT (status = 'done') AND "trip distance" >= 2.5 AND fare > tip
//
// Operators: = == != <> < <= > >=, [NOT] LIKE / ILIKE (% and _, case-insensitive), [NOT] IN (...),
// [NOT] BETWEEN a AND b, IS [NOT] NULL, AND, OR, NOT, parentheses.
// Values: numbers, 'text' ('' for a quote), TRUE, FALSE, NULL, and other columns.
// Columns: bare names, "double quoted", `backticks` or [brackets]. Names match exactly, then
// case-insensitively. Comparisons with NULL are unknown, as in SQL (three-valued logic).
// An empty cell counts as NULL, so "city IS NULL" finds blank CSV cells.
// Not supported: arithmetic, functions, SELECT, ORDER BY (click a header to sort).

const { formatValue } = require('./table');

const MAX_QUERY_LEN = 2000;
const MAX_DEPTH = 64;
const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'LIKE', 'ILIKE', 'IN', 'BETWEEN', 'IS', 'NULL', 'TRUE', 'FALSE', 'WHERE']);

class QueryError extends Error {
  constructor(message, pos) { super(message); this.code = 'QUERY'; this.pos = pos; }
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    if (ch === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= n) throw new QueryError(`Text that starts at character ${start + 1} has no closing quote.`, start);
        if (src[i] === "'") {
          if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
          i++;
          break;
        }
        s += src[i++];
      }
      toks.push({ t: 'str', v: s, pos: start });
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let s = '';
      i++;
      for (;;) {
        if (i >= n) throw new QueryError(`Column name that starts at character ${start + 1} has no closing ${close}.`, start);
        if (src[i] === close) {
          if (close !== ']' && src[i + 1] === close) { s += close; i += 2; continue; }
          i++;
          break;
        }
        s += src[i++];
      }
      toks.push({ t: 'id', v: s, quoted: true, pos: start });
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 64));
    if (num && !/[A-Za-z_]/.test(src[i + num[0].length] || '')) {
      toks.push({ t: 'num', v: Number(num[0]), pos: start });
      i += num[0].length;
      continue;
    }
    if (ch === '-' && /[\d.]/.test(src[i + 1] || '')) {
      const m = /^-(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 64));
      const prev = toks[toks.length - 1];
      // Only a sign where a value may start (not after a value: "a -1" is not valid anyway).
      if (m && (!prev || prev.t === 'op' || prev.t === '(' || prev.t === ',' || (prev.t === 'kw' && prev.v !== 'NULL' && prev.v !== 'TRUE' && prev.v !== 'FALSE'))) {
        toks.push({ t: 'num', v: Number(m[0]), pos: start });
        i += m[0].length;
        continue;
      }
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=' || two === '<>' || two === '==') {
      toks.push({ t: 'op', v: two === '<>' ? '!=' : two === '==' ? '=' : two, pos: start });
      i += 2;
      continue;
    }
    if (ch === '<' || ch === '>' || ch === '=') { toks.push({ t: 'op', v: ch, pos: start }); i++; continue; }
    if (ch === '(' || ch === ')' || ch === ',') { toks.push({ t: ch, pos: start }); i++; continue; }
    const word = /^[\p{L}_][\p{L}\p{N}_$.]*/u.exec(src.slice(i));
    if (word) {
      const up = word[0].toUpperCase();
      if (KEYWORDS.has(up)) toks.push({ t: 'kw', v: up, pos: start });
      else toks.push({ t: 'id', v: word[0], quoted: false, pos: start });
      i += word[0].length;
      continue;
    }
    throw new QueryError(`Unexpected "${ch}" at character ${i + 1}.`, i);
  }
  return toks;
}

/** Parse to an AST. Throws QueryError with a plain message. */
function parse(src) {
  const text = String(src || '');
  if (text.length > MAX_QUERY_LEN) throw new QueryError(`The query is longer than ${MAX_QUERY_LEN} characters.`, 0);
  const toks = tokenize(text);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isKw = (v, k = peek()) => k && k.t === 'kw' && k.v === v;
  const where = k => (k ? `at character ${k.pos + 1}` : 'at the end');
  const expect = (t, what) => {
    const k = peek();
    if (!k || k.t !== t) throw new QueryError(`Expected ${what} ${where(k)}.`, k ? k.pos : text.length);
    p++;
    return k;
  };
  const enter = () => { if (++depth > MAX_DEPTH) throw new QueryError('The query is nested too deep.', 0); };

  if (isKw('WHERE')) p++;
  if (!toks.length || p >= toks.length) return null;

  function orExpr() {
    enter();
    let left = andExpr();
    while (isKw('OR')) { p++; left = { k: 'or', a: left, b: andExpr() }; }
    depth--;
    return left;
  }
  function andExpr() {
    let left = notExpr();
    while (isKw('AND')) { p++; left = { k: 'and', a: left, b: notExpr() }; }
    return left;
  }
  function notExpr() {
    if (isKw('NOT')) { p++; enter(); const e = { k: 'not', a: notExpr() }; depth--; return e; }
    return predicate();
  }
  function value() {
    const k = peek();
    if (!k) throw new QueryError('Expected a column or a value at the end.', text.length);
    if (k.t === 'num' || k.t === 'str') { p++; return { k: 'lit', v: k.v }; }
    if (k.t === 'id') { p++; return { k: 'col', name: k.v, quoted: k.quoted, pos: k.pos }; }
    if (isKw('NULL')) { p++; return { k: 'lit', v: null }; }
    if (isKw('TRUE') || isKw('FALSE')) { p++; return { k: 'lit', v: k.v === 'TRUE' }; }
    throw new QueryError(`Expected a column or a value ${where(k)}.`, k.pos);
  }
  function literal() {
    const v = value();
    if (v.k !== 'lit') throw new QueryError('IN lists take values, not columns.', v.pos || 0);
    return v.v;
  }
  function predicate() {
    const k = peek();
    if (k && k.t === '(') {
      p++;
      const e = orExpr();
      expect(')', 'a closing )');
      return e;
    }
    const left = value();
    const op = peek();
    if (op && op.t === 'op') { p++; return { k: 'cmp', op: op.v, a: left, b: value() }; }
    if (isKw('IS')) {
      p++;
      let neg = false;
      if (isKw('NOT')) { p++; neg = true; }
      if (!isKw('NULL')) throw new QueryError(`Expected NULL after IS ${where(peek())}.`, peek() ? peek().pos : text.length);
      p++;
      return { k: 'isnull', a: left, neg };
    }
    let neg = false;
    if (isKw('NOT')) { p++; neg = true; }
    if (isKw('LIKE') || isKw('ILIKE')) {
      p++;
      return { k: 'like', a: left, b: value(), neg };
    }
    if (isKw('IN')) {
      p++;
      expect('(', 'a ( after IN');
      const list = [literal()];
      while (peek() && peek().t === ',') { p++; list.push(literal()); }
      expect(')', 'a closing ) for the IN list');
      return { k: 'in', a: left, list, neg };
    }
    if (isKw('BETWEEN')) {
      p++;
      const lo = value();
      if (!isKw('AND')) throw new QueryError(`Expected AND in BETWEEN ${where(peek())}.`, peek() ? peek().pos : text.length);
      p++;
      return { k: 'between', a: left, lo, hi: value(), neg };
    }
    if (neg) throw new QueryError(`Expected LIKE, IN or BETWEEN after NOT ${where(peek())}.`, peek() ? peek().pos : text.length);
    // A bare column or value is true when it is a true boolean or a non-zero number.
    return { k: 'truthy', a: left };
  }

  const ast = orExpr();
  if (p < toks.length) {
    const k = toks[p];
    throw new QueryError(`Unexpected ${k.t === 'kw' ? k.v : k.t === 'id' ? `"${k.v}"` : k.v !== undefined ? JSON.stringify(k.v) : k.t} at character ${k.pos + 1}. Join conditions with AND or OR.`, k.pos);
  }
  return ast;
}

// ---------- evaluation ----------

function isNull(v) { return v === null || v === undefined; }

/** Number for a value, or null when it is not a number. */
function asNumber(v) {
  switch (typeof v) {
    case 'number': return Number.isNaN(v) ? null : v;
    case 'bigint': return Number(v);
    case 'boolean': return v ? 1 : 0;
    case 'string': {
      const t = v.trim();
      if (!t || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
      return Number(t);
    }
    default: return null;
  }
}

/** Text for a value (dates as ISO; date-only columns as YYYY-MM-DD). */
function asText(v, type) {
  if (typeof v === 'string') return v;
  const s = formatValue(v, type);
  return s === null ? null : s;
}

/** Compare two non-null values: numbers when both are numbers, else text. Returns -1, 0, 1. */
function compare(a, ta, b, tb) {
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const x = typeof a === 'boolean' ? a : asBool(a);
    const y = typeof b === 'boolean' ? b : asBool(b);
    if (x !== null && y !== null) return x === y ? 0 : x ? 1 : -1;
  }
  const na = asNumber(a), nb = asNumber(b);
  if (na !== null && nb !== null && (typeof a !== 'string' || typeof b !== 'string')) return na < nb ? -1 : na > nb ? 1 : 0;
  const sa = asText(a, ta), sb = asText(b, tb);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') { const l = v.toLowerCase(); if (l === 'true') return true; if (l === 'false') return false; }
  return null;
}

function likeRegex(pattern) {
  let re = '';
  for (const ch of String(pattern)) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

function resolveColumn(columns, node) {
  let idx = columns.findIndex(c => c.name === node.name);
  if (idx < 0) {
    const low = node.name.toLowerCase();
    const hits = [];
    columns.forEach((c, i) => { if (c.name.toLowerCase() === low) hits.push(i); });
    if (hits.length === 1) idx = hits[0];
  }
  if (idx < 0) {
    const names = columns.slice(0, 12).map(c => c.name).join(', ') + (columns.length > 12 ? ', …' : '');
    throw new QueryError(`No column named "${node.name}". Columns: ${names}. Put names with spaces in "double quotes" and text in 'single quotes'.`, node.pos || 0);
  }
  return idx;
}

/**
 * Compile a query for a table. Returns null for an empty query, else a function rowId -> boolean.
 * @param {string} src
 * @param {{columns:{name:string,type:string}[], get:(row:number,col:number)=>any}} table
 */
function compileQuery(src, table) {
  const ast = parse(src);
  if (!ast) return null;
  const cols = table.columns;

  // Each value node compiles to r => [value, type]; type is the column type for date formatting.
  function val(node) {
    if (node.k === 'lit') { const v = node.v; return () => v; }
    const c = resolveColumn(cols, node);
    // An empty cell counts as NULL: CSV has no other way to write one.
    return r => { const v = table.get(r, c); return v === '' ? null : v; };
  }
  function typ(node) { return node.k === 'col' ? cols[resolveColumn(cols, node)].type : null; }

  // Boolean nodes compile to r => true | false | null (unknown).
  function bool(node) {
    switch (node.k) {
      case 'or': {
        const a = bool(node.a), b = bool(node.b);
        return r => { const x = a(r); if (x === true) return true; const y = b(r); if (y === true) return true; return x === null || y === null ? null : false; };
      }
      case 'and': {
        const a = bool(node.a), b = bool(node.b);
        return r => { const x = a(r); if (x === false) return false; const y = b(r); if (y === false) return false; return x === null || y === null ? null : true; };
      }
      case 'not': {
        const a = bool(node.a);
        return r => { const x = a(r); return x === null ? null : !x; };
      }
      case 'cmp': {
        const a = val(node.a), b = val(node.b), ta = typ(node.a), tb = typ(node.b);
        const test = { '=': c => c === 0, '!=': c => c !== 0, '<': c => c < 0, '<=': c => c <= 0, '>': c => c > 0, '>=': c => c >= 0 }[node.op];
        return r => { const x = a(r), y = b(r); if (isNull(x) || isNull(y)) return null; return test(compare(x, ta, y, tb)); };
      }
      case 'isnull': {
        const a = val(node.a);
        return node.neg ? r => !isNull(a(r)) : r => isNull(a(r));
      }
      case 'like': {
        const a = val(node.a), ta = typ(node.a);
        let match;
        if (node.b.k === 'lit') {
          if (node.b.v === null) return () => null;
          const re = likeRegex(node.b.v);
          match = s => re.test(s);
        } else {
          const b = val(node.b), tb = typ(node.b);
          match = (s, r) => { const pv = b(r); return isNull(pv) ? null : likeRegex(asText(pv, tb)).test(s); };
        }
        return r => {
          const x = a(r);
          if (isNull(x)) return null;
          const m = match(asText(x, ta), r);
          return m === null ? null : node.neg ? !m : m;
        };
      }
      case 'in': {
        const a = val(node.a), ta = typ(node.a);
        const list = node.list.filter(v => v !== null);
        const hasNull = list.length !== node.list.length;
        return r => {
          const x = a(r);
          if (isNull(x)) return null;
          const hit = list.some(v => compare(x, ta, v, null) === 0);
          if (hit) return !node.neg;
          return hasNull ? null : node.neg;
        };
      }
      case 'between': {
        const a = val(node.a), lo = val(node.lo), hi = val(node.hi), ta = typ(node.a), tl = typ(node.lo), th = typ(node.hi);
        return r => {
          const x = a(r), l = lo(r), h = hi(r);
          if (isNull(x) || isNull(l) || isNull(h)) return null;
          const inside = compare(x, ta, l, tl) >= 0 && compare(x, ta, h, th) <= 0;
          return node.neg ? !inside : inside;
        };
      }
      case 'truthy': {
        const a = val(node.a);
        return r => {
          const x = a(r);
          if (isNull(x)) return null;
          const b = asBool(x);
          if (b !== null) return b;
          const n = asNumber(x);
          return n === null ? null : n !== 0;
        };
      }
      default:
        throw new QueryError('Unsupported query.', 0);
    }
  }

  const f = bool(ast);
  return r => f(r) === true;
}

module.exports = { compileQuery, parse, tokenize, likeRegex, QueryError, MAX_QUERY_LEN };
