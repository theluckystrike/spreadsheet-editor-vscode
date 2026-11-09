'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { CsvDoc, splitRecord } = require('../src/core/csvdoc');
const { Grid } = require('../src/core/grid');
const { encode, EncodeError } = require('../src/core/codec');

function rowsOf(doc) { return doc.grid.order.map(id => doc.grid.row(id)); }

test('untouched file saves byte for byte (BOM, CRLF, quotes, ragged rows, no final newline)', () => {
  const buf = Buffer.from('﻿a,b,c\r\n"1, x",2,3\r\n4,"he said ""hi""",6\r\n7,8\r\n9,10,11,12', 'utf8');
  const d = new CsvDoc(buf, {});
  assert.equal(d.describe().bom, true);
  assert.deepEqual(rowsOf(d)[1], ['1, x', '2', '3']);
  assert.deepEqual(rowsOf(d)[2], ['4', 'he said "hi"', '6']);
  assert.ok(d.toBuffer().equals(buf));
});

test('editing one cell in a 1,000,000-row file changes only that row; every other byte is identical', () => {
  const parts = ['id,date,city,qty,price,status\n'];
  const cities = ['Paris', 'Berlin', 'Lagos', '"Lima, PE"'];
  for (let i = 1; i <= 1000000; i++) parts.push(`${i},2026-${String((i % 12) + 1).padStart(2, '0')}-01,${cities[i % 4]},${i % 9},${(i % 997) / 10},${i % 3 ? 'paid' : 'open'}${i % 1000 === 0 ? '\r\n' : '\n'}`);
  const buf = Buffer.from(parts.join(''), 'utf8');
  const t0 = Date.now();
  const d = new CsvDoc(buf, {});
  const indexMs = Date.now() - t0;
  assert.equal(d.rowCount, 1000001);
  const target = 500001; // id of data row 500,001
  assert.equal(d.grid.cell(target, 0), '500001');
  d.grid.apply({ t: 'set', cells: [[target, 4, '123.45']] });
  const t1 = Date.now();
  const out = d.toBuffer();
  const saveMs = Date.now() - t1;
  const s = d.index.starts[target], e = d.index.starts[target + 1];
  const oldRow = buf.subarray(s, e).toString();
  const newRow = oldRow.replace(/,[^,]*,(paid|open)\n$/, ',123.45,$1\n');
  assert.notEqual(oldRow, newRow);
  assert.ok(out.subarray(0, s).equals(buf.subarray(0, s)), 'bytes before the row are identical');
  assert.equal(out.subarray(s, s + Buffer.byteLength(newRow)).toString(), newRow);
  assert.ok(out.subarray(s + Buffer.byteLength(newRow)).equals(buf.subarray(e)), 'bytes after the row are identical');
  assert.ok(indexMs < 5000, `index took ${indexMs} ms`);
  assert.ok(saveMs < 5000, `save took ${saveMs} ms`);
});

test('Windows-1252 file: an edited row is written in Windows-1252, others are copied', () => {
  const text = 'name,city\r\nJosé,Montréal\r\nZoë,Zürich\r\n';
  const buf = encode(text, 'windows-1252');
  const d = new CsvDoc(Buffer.from(buf), {});
  assert.equal(d.encoding, 'windows-1252');
  assert.equal(d.grid.cell(1, 1), 'Montréal');
  d.grid.apply({ t: 'set', cells: [[2, 1, 'Genève €']] });
  const out = d.toBuffer();
  assert.ok(out.equals(Buffer.from(encode('name,city\r\nJosé,Montréal\r\nZoë,Genève €\r\n', 'windows-1252'))));
  assert.equal(out.indexOf(0x80) > 0, true, 'euro sign is byte 0x80 in Windows-1252');
});

test('a character the encoding cannot hold stops the save with a clear error', () => {
  const d = new CsvDoc(Buffer.from(encode('a\r\nb\r\n', 'windows-1252')), { encoding: 'windows-1252' });
  d.grid.apply({ t: 'set', cells: [[1, 0, 'カ']] });
  assert.throws(() => d.checkEncodable(), err => err instanceof EncodeError && /UTF-8/.test(err.message));
  const utf8 = d.toBuffer({ encoding: 'utf-8' }).toString('utf8');
  assert.equal(utf8, 'a\r\nカ\r\n');
});

test('UTF-16 LE and BE with BOM: read, edit, save', () => {
  for (const enc of ['utf-16le', 'utf-16be']) {
    const body = 'x\ty\r\n1\t2\r\n3\t4\r\n';
    const bom = enc === 'utf-16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]);
    const buf = Buffer.concat([bom, encode(body, enc)]);
    const d = new CsvDoc(buf, {});
    assert.equal(d.encoding, enc);
    assert.equal(d.delimiter, '\t');
    assert.deepEqual(rowsOf(d), [['x', 'y'], ['1', '2'], ['3', '4']]);
    assert.ok(d.toBuffer().equals(buf));
    d.grid.apply({ t: 'set', cells: [[2, 1, 'Ω']] });
    assert.ok(d.toBuffer().equals(Buffer.concat([bom, encode('x\ty\r\n1\t2\r\n3\tΩ\r\n', enc)])));
  }
});

test('Shift_JIS: a trail byte that looks like "|" does not split a pipe-delimited field', () => {
  // ソ is 0x83 0x7C in Shift_JIS: its second byte is the pipe character.
  const text = 'a|b\r\nソ|2\r\n';
  const buf = Buffer.from(encode(text, 'shift_jis'));
  const d = new CsvDoc(buf, { encoding: 'shift_jis', delimiter: '|' });
  assert.deepEqual(rowsOf(d), [['a', 'b'], ['ソ', '2']]);
  d.grid.apply({ t: 'set', cells: [[1, 1, 'ソソ']] });
  assert.ok(d.toBuffer().equals(Buffer.from(encode('a|b\r\nソ|ソソ\r\n', 'shift_jis'))));
});

test('custom delimiter, single-quote quoting and no quoting', () => {
  const d = new CsvDoc(Buffer.from("a~b\n'x~y'~2\n"), { delimiter: '~', quote: "'" });
  assert.deepEqual(rowsOf(d), [['a', 'b'], ['x~y', '2']]);
  d.grid.apply({ t: 'set', cells: [[1, 1, "it's"]] });
  assert.equal(d.toBuffer().toString(), "a~b\n'x~y'~'it''s'\n");
  const n = new CsvDoc(Buffer.from('a,b\n"q",2\n'), { quote: '' });
  assert.deepEqual(rowsOf(n)[1], ['"q"', '2']);
});

test('comment lines stay in place and untouched; they are not rows', () => {
  const buf = Buffer.from('# head\nt,v\n1,2\n# gap\n3,4\n');
  const d = new CsvDoc(buf, { commentPrefix: '#' });
  assert.equal(d.describe().comments, 2);
  assert.equal(d.grid.isComment(0), true);
  d.grid.apply({ t: 'icol', at: 1 });
  assert.equal(d.toBuffer().toString(), '# head\nt,,v\n1,,2\n# gap\n3,,4\n');
});

test('hostile: an unterminated quote does not swallow the rest of the file', () => {
  const buf = Buffer.from('id,name\n1,a\n2,"never closed\n3,c\n4,d\n');
  const d = new CsvDoc(buf, {});
  assert.equal(d.rowCount, 5);
  assert.deepEqual(d.grid.row(2), ['2', '"never closed']);
  assert.deepEqual(d.grid.row(4), ['4', 'd']);
  assert.match(d.warnings[0], /never closed/);
  assert.ok(d.toBuffer().equals(buf));
});

test('hostile: mixed line endings, NUL byte and a 1 MB cell round-trip', () => {
  const big = 'x'.repeat(1024 * 1024);
  const buf = Buffer.from(`a,b\r\n1,\u0000z\n2,3\r4,${big}\r\n`);
  const d = new CsvDoc(buf, {});
  assert.equal(d.rowCount, 4);
  assert.equal(d.describe().mixedEol, true);
  assert.equal(d.grid.cell(1, 1), '\u0000z');
  assert.equal(d.grid.cell(3, 1).length, 1024 * 1024);
  d.grid.apply({ t: 'set', cells: [[2, 0, 'two']] });
  const out = d.toBuffer().toString();
  assert.equal(out, `a,b\r\n1,\u0000z\ntwo,3\r\n4,${big}\r\n`);
});

test('random edits, then undo all: bytes identical; redo all: same result as before', () => {
  const lines = ['h1,h2,h3'];
  for (let i = 0; i < 300; i++) lines.push(`${i},"v ${i}",${i % 7}`);
  const buf = Buffer.from(lines.join('\n') + '\n');
  const d = new CsvDoc(buf, {});
  const g = d.grid;
  let seed = 42;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const done = [];
  for (let k = 0; k < 400; k++) {
    const kind = rnd(7);
    let op;
    if (kind <= 2) op = { t: 'set', cells: [[g.order[rnd(g.order.length)], rnd(g.width), `e${k}`]] };
    else if (kind === 3) { const ids = g.newIds(1 + rnd(3)); const pos = rnd(g.order.length + 1); op = { t: 'put', items: ids.map((id, i) => [pos + i, id]), rows: ids.map(id => [id, []]) }; }
    else if (kind === 4 && g.order.length > 5) op = { t: 'drop', pos: [rnd(g.order.length), rnd(g.order.length)] };
    else if (kind === 5) op = rnd(2) || g.width < 2 ? { t: 'icol', at: rnd(g.width + 1) } : { t: 'dcol', at: rnd(g.width) };
    else if (g.width > 1) op = { t: 'mcol', from: rnd(g.width), to: rnd(g.width) };
    if (!op) continue;
    done.push({ op, inv: g.apply(op) });
  }
  const edited = d.toBuffer();
  for (let i = done.length - 1; i >= 0; i--) done[i].op = g.apply(done[i].inv);
  assert.ok(d.toBuffer().equals(buf), 'undo all gives the original bytes');
  for (const x of done) x.inv = g.apply(x.op);
  assert.ok(d.toBuffer().equals(edited), 'redo all gives the edited bytes');
});

test('splitRecord handles quotes, empty fields and a trailing delimiter', () => {
  assert.deepEqual(splitRecord('a,"b,c",,"d""e",', ',', '"'), ['a', 'b,c', '', 'd"e', '']);
  assert.deepEqual(splitRecord('', ',', '"'), ['']);
});

test('bulk row insert and delete keep the order (fast path)', () => {
  const g = new Grid({ count: 100, width: 1, fields: id => [String(id)] });
  const ids = g.newIds(50);
  const inv = g.apply({ t: 'put', items: ids.map((id, i) => [i * 2, id]) });
  assert.equal(g.order.length, 150);
  assert.equal(g.order[0], 100);
  assert.equal(g.order[1], 0);
  g.apply(inv);
  assert.deepEqual(g.order, Array.from({ length: 100 }, (_, i) => i));
  const inv2 = g.apply({ t: 'drop', pos: Array.from({ length: 40 }, (_, i) => i * 2) });
  assert.equal(g.order.length, 60);
  g.apply(inv2);
  assert.deepEqual(g.order, Array.from({ length: 100 }, (_, i) => i));
});

test('zip guard refuses a workbook whose part inflates past its declared size', () => {
  const { checkZip } = require('../src/core/zipguard');
  const data = zlib.deflateRawSync(Buffer.alloc(20 * 1024 * 1024, 32));
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(8, 8); loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(4096, 22); loc.writeUInt16LE(name.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(4096, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0, 42);
  const cenOff = 30 + name.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(cenOff, 16);
  const zip = Buffer.concat([loc, name, data, cen, name, eocd]);
  assert.throws(() => checkZip(zip), /zip bomb/);
  assert.throws(() => checkZip(Buffer.from('not a zip at all, just text that is long enough')), /not a valid/);
});

test('the save note lists custom XML parts and custom document properties (they do not survive an Excel save)', () => {
  const { atRisk } = require('../src/core/zipguard');
  const names = ['[Content_Types].xml', 'xl/workbook.xml', 'customXml/item1.xml', 'docProps/custom.xml', 'docProps/app.xml'].map(name => ({ name }));
  assert.deepEqual(atRisk(names), ['custom XML parts', 'custom document properties (such as sensitivity labels)']);
  assert.deepEqual(atRisk([{ name: 'xl/workbook.xml' }, { name: 'docProps/core.xml' }]), []);
});

test('the save note lists named constants, named formulas and sheet-level names; plain range names and print areas are not listed', () => {
  const { listEntries, namesAtRisk } = require('../src/core/zipguard');
  const JSZip = require('jszip');
  const wbXml = (names) => `<?xml version="1.0"?><workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets><definedNames>${names}</definedNames></workbook>`;
  const make = async (names) => { const z = new JSZip(); z.file('xl/workbook.xml', wbXml(names)); return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); };
  return (async () => {
    let b = await make('<definedName name="MyRange">Data!$A$1:$A$5</definedName><definedName name="Two">\'My Sheet\'!$A$1,Data!$C:$C</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$C$9</definedName>');
    assert.deepEqual(namesAtRisk(b, listEntries(b)), []);
    b = await make('<definedName name="TaxRate">0.2</definedName><definedName name="Double">Data!$A$1*2</definedName><definedName name="Local" localSheetId="0">Data!$B$1</definedName><definedName name="Ok">Data!$A$1</definedName>');
    assert.deepEqual(namesAtRisk(b, listEntries(b)), ['named formulas, constants and sheet-level names (TaxRate, Double, Local)']);
  })();
});
