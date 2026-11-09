'use strict';
// Streaming CSV/TSV parser (RFC 4180 plus common variants).
// Feed decoded text with push(), call end() at the end. Rows go to onRow(fields).

const CANDIDATES = [',', '\t', ';', '|'];

/** Guess the delimiter from a text sample: the candidate with the most consistent count per line. */
function detectDelimiter(sample, fallback = ',') {
  const lines = [];
  let inQ = false;
  let start = 0;
  for (let i = 0; i < sample.length && lines.length < 20; i++) {
    const ch = sample[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === '\n') { lines.push(sample.slice(start, i)); start = i + 1; }
  }
  if (lines.length === 0 && sample.length) lines.push(sample);
  let best = fallback;
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = lines.map(l => countOutsideQuotes(l, d));
    const first = counts[0] || 0;
    if (first === 0) continue;
    const same = counts.filter(c => c === first).length;
    const score = (same / counts.length) * 1000 + first;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function countOutsideQuotes(line, d) {
  let n = 0;
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === d) n++;
  }
  return n;
}

class CsvParser {
  constructor(delimiter, onRow) {
    this.d = delimiter;
    this.onRow = onRow;
    this.buf = '';
    this.field = '';
    this.row = [];
    this.inQuotes = false;
    this.afterQuote = false;
    this.stopped = false;
  }

  stop() { this.stopped = true; }

  push(text) {
    if (this.stopped) return;
    const s = this.buf + text;
    this.buf = '';
    const d = this.d;
    const n = s.length;
    let i = 0;
    let field = this.field;
    let row = this.row;
    let inQ = this.inQuotes;
    let afterQuote = this.afterQuote;
    while (i < n) {
      if (inQ) {
        const q = s.indexOf('"', i);
        if (q === -1) { field += s.slice(i); i = n; break; }
        field += s.slice(i, q);
        if (q + 1 >= n) { this.buf = '"'; i = n; break; } // need the next char to decide
        if (s[q + 1] === '"') { field += '"'; i = q + 2; continue; }
        inQ = false; afterQuote = true; i = q + 1; continue;
      }
      const ch = s[i];
      if (ch === d) { row.push(field); field = ''; afterQuote = false; i++; continue; }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r') {
          if (i + 1 >= n) { this.buf = '\r'; i = n; break; }
          if (s[i + 1] === '\n') i++;
        }
        row.push(field); field = ''; afterQuote = false;
        this.onRow(row);
        row = [];
        i++;
        if (this.stopped) break;
        continue;
      }
      if (ch === '"' && field === '' && !afterQuote) { inQ = true; i++; continue; }
      // plain run up to the next special char
      let j = i + 1;
      while (j < n) {
        const c = s[j];
        if (c === d || c === '\n' || c === '\r') break;
        j++;
      }
      field += s.slice(i, j);
      i = j;
    }
    this.field = field;
    this.row = row;
    this.inQuotes = inQ;
    this.afterQuote = afterQuote;
  }

  end() {
    if (this.stopped) return;
    if (this.buf === '"') { this.buf = ''; this.inQuotes = false; this.afterQuote = true; }
    if (this.buf === '\r') this.buf = '';
    if (this.field !== '' || this.row.length > 0 || this.afterQuote) {
      this.row.push(this.field);
      this.onRow(this.row);
    }
    this.field = '';
    this.row = [];
  }
}

/** Parse a whole string. Returns an array of rows. */
function parseCsv(text, delimiter) {
  const d = delimiter || detectDelimiter(text.slice(0, 64 * 1024));
  const rows = [];
  const p = new CsvParser(d, r => rows.push(r));
  p.push(text);
  p.end();
  return rows;
}

module.exports = { CsvParser, parseCsv, detectDelimiter };
