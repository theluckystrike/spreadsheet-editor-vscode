'use strict';
// Checks an .xlsx/.xlsm zip before a library unpacks it: entry count, declared sizes, and the real inflated
// size of every entry (a zip can lie about its sizes). A zip bomb is refused before it can fill memory.

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50, LOC_SIG = 0x04034b50;

class ZipError extends Error { constructor(m) { super(m); this.code = 'ZIP'; } }

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  return -1;
}

/** Central directory entries: name, method, sizes, local header offset. */
function listEntries(buf) {
  if (buf.length < 22) throw new ZipError('The file is too short to be a workbook.');
  const e = findEocd(buf);
  if (e < 0) throw new ZipError('The file is not a valid .xlsx workbook (no zip directory).');
  const total = buf.readUInt16LE(e + 10);
  let off = buf.readUInt32LE(e + 16);
  const out = [];
  for (let k = 0; k < total; k++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) throw new ZipError('The workbook zip directory is damaged.');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    out.push({ name, method, csize, usize, local });
    off += 46 + nlen + xlen + clen;
  }
  return out;
}

/**
 * Throws ZipError when the workbook is a zip bomb or damaged.
 * @param {Buffer} buf
 * @param {{maxEntries?:number, maxTotal?:number, maxEntry?:number, maxRatio?:number}} [lim]
 * @returns {{entries:object[], total:number}}
 */
function checkZip(buf, lim = {}) {
  const maxEntries = lim.maxEntries || 20000;
  const maxTotal = lim.maxTotal || 1024 * 1024 * 1024;
  const maxEntry = lim.maxEntry || 512 * 1024 * 1024;
  const maxRatio = lim.maxRatio || 400;
  const entries = listEntries(buf);
  if (entries.length > maxEntries) throw new ZipError(`The workbook has ${entries.length} parts. That is more than ${maxEntries}, so it is not opened.`);
  let total = 0;
  for (const en of entries) {
    if (en.usize > maxEntry) throw new ZipError(`The part ${en.name} unpacks to ${Math.round(en.usize / 1048576)} MB. It is not opened, to protect memory.`);
    total += en.usize;
    if (total > maxTotal) throw new ZipError('The workbook unpacks to more than 1 GB. It is not opened, to protect memory.');
    if (en.method !== 0 && en.method !== 8) throw new ZipError(`The part ${en.name} uses an unknown compression.`);
    const lo = en.local;
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOC_SIG) throw new ZipError('The workbook zip is damaged.');
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    if (start + en.csize > buf.length) throw new ZipError('The workbook zip is cut short.');
    if (en.method === 8) {
      if (en.csize > 0 && en.usize / en.csize > maxRatio && en.usize > 16 * 1024 * 1024) {
        throw new ZipError(`The part ${en.name} is packed ${Math.round(en.usize / en.csize)} times. It looks like a zip bomb and is not opened.`);
      }
      // Inflate with a hard cap: a part that is larger than its directory says is refused.
      try {
        zlib.inflateRawSync(buf.subarray(start, start + en.csize), { maxOutputLength: Math.max(1, en.usize) + 1 });
      } catch (err) {
        if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|buffer/i.test(err.message))) {
          throw new ZipError(`The part ${en.name} unpacks to more than its directory says. It looks like a zip bomb and is not opened.`);
        }
        throw new ZipError(`The part ${en.name} is damaged (${err.message}).`);
      }
    }
  }
  return { entries, total };
}

// Parts that the save cannot keep. Shown before the first save of a workbook that has them.
const AT_RISK = [
  [/^xl\/pivotTables\//i, 'pivot tables'],
  [/^xl\/charts\//i, 'charts'],
  [/^xl\/drawings\/(?!_rels)/i, 'shapes and drawings'],
  [/vbaProject\.bin$/i, 'macros (VBA)'],
  [/^xl\/slicers\//i, 'slicers'],
  [/^xl\/timelines\//i, 'timelines'],
  [/^xl\/threadedComments\//i, 'threaded comments'],
  [/^xl\/externalLinks\//i, 'links to other workbooks'],
  [/^xl\/model\//i, 'the data model (Power Pivot)'],
  [/^xl\/ctrlProps\//i, 'form controls'],
  [/^xl\/queryTables\//i, 'query tables'],
  [/^customXml\//i, 'custom XML parts'],
  [/^docProps\/custom\.xml$/i, 'custom document properties (such as sensitivity labels)'],
];

function atRisk(entries) {
  const found = [];
  for (const [re, label] of AT_RISK) if (entries.some(e => re.test(e.name)) && !found.includes(label)) found.push(label);
  return found;
}

// Defined names that the Excel save cannot keep as they are: named constants and formulas (dropped or cut down to
// a plain reference) and sheet-level names (made workbook-level). Plain range names and print settings are kept.
const REF_PART = /^(?:(?:'(?:[^']|'')+'|[^'!,()"=*+\-/^&<> ]+)!)?(?:\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+|#REF!)$/;
function namesAtRisk(buf, entries) {
  const en = entries.find(e => e.name === 'xl/workbook.xml');
  if (!en) return [];
  const start = en.local + 30 + buf.readUInt16LE(en.local + 26) + buf.readUInt16LE(en.local + 28);
  const raw = buf.subarray(start, start + en.csize);
  const xml = (en.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, en.usize) + 1 }) : raw).toString('utf8');
  const unesc = t => t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const out = [];
  for (const m of xml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
    const name = unesc((m[1].match(/\bname="([^"]*)"/) || [])[1] || '');
    if (/^_xlnm\./i.test(name)) continue;
    const ref = unesc(m[2]).trim().split(',').every(part => REF_PART.test(part.trim()));
    if (!ref || /\blocalSheetId="/.test(m[1])) out.push(name);
  }
  return out.length ? [`named formulas, constants and sheet-level names (${out.slice(0, 5).join(', ')}${out.length > 5 ? ', ...' : ''})`] : [];
}

module.exports = { checkZip, listEntries, atRisk, namesAtRisk, ZipError };
