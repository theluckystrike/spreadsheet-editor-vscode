'use strict';
// Column stats over the current view (Pro): count, nulls, distinct, min, max, and for numbers
// sum and mean, for text the shortest and longest length, plus the most common values.

const { formatValue, sortKey, compareKeys } = require('./table');

const DEFAULT_MAX_DISTINCT = 100000;
const DEFAULT_TOP = 5;

/**
 * @param {import('./table').Table} table
 * @param {{columns?: number[], maxDistinct?: number, top?: number}} [opts]
 * @returns {{rows:number, columns: object[]}}
 */
function computeStats(table, opts = {}) {
  const maxDistinct = opts.maxDistinct || DEFAULT_MAX_DISTINCT;
  const topN = opts.top || DEFAULT_TOP;
  const n = table.viewCount;
  const which = opts.columns || table.columns.map((_c, i) => i);
  const out = [];
  for (const c of which) {
    if (c < 0 || c >= table.columns.length) continue;
    const col = table.columns[c];
    const data = table.data[c];
    const counts = new Map();
    let capped = false;
    let nulls = 0, count = 0;
    let numeric = true, sum = 0, min = null, max = null, minKey = null, maxKey = null;
    let minLen = Infinity, maxLen = 0, anyText = false;
    const fast = data.values instanceof Float64Array ? data.values : null;
    const fastNulls = fast ? data.nulls : null;
    for (let i = 0; i < n; i++) {
      const id = table.rowId(i);
      let v;
      if (fast) {
        if (fastNulls && fastNulls[id]) { nulls++; continue; }
        v = fast[id];
      } else {
        v = table.get(id, c);
        if (v === null || v === undefined) { nulls++; continue; }
      }
      count++;
      const num = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null;
      if (num === null || Number.isNaN(num)) numeric = false;
      else sum += num;
      const key = sortKey(v);
      if (minKey === null || compareKeys(key, minKey) < 0) { minKey = key; min = v; }
      if (maxKey === null || compareKeys(key, maxKey) > 0) { maxKey = key; max = v; }
      const text = typeof v === 'string' ? v : formatValue(v, col.type);
      if (typeof v === 'string') {
        anyText = true;
        if (v.length < minLen) minLen = v.length;
        if (v.length > maxLen) maxLen = v.length;
      }
      const prev = counts.get(text);
      if (prev !== undefined) counts.set(text, prev + 1);
      else if (counts.size < maxDistinct) counts.set(text, 1);
      else capped = true;
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, topN)
      .map(([value, k]) => ({ value: value.length > 200 ? value.slice(0, 200) + '…' : value, count: k }));
    const s = {
      index: c, name: col.name, type: col.type, count, nulls,
      distinct: counts.size, distinctCapped: capped,
      min: count ? clip(formatValue(min, col.type)) : null,
      max: count ? clip(formatValue(max, col.type)) : null,
      top, topApprox: capped,
    };
    if (numeric && count) { s.sum = sum; s.mean = sum / count; }
    if (anyText) { s.minLength = minLen; s.maxLength = maxLen; }
    out.push(s);
  }
  return { rows: n, columns: out };
}

function clip(s) { return s !== null && s.length > 200 ? s.slice(0, 200) + '…' : s; }

module.exports = { computeStats, DEFAULT_MAX_DISTINCT };
