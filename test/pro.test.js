'use strict';
// Zovo Pro in the extension host (stub vscode, real worker): nothing at activation or on a normal open, 3 free tries
// per Pro tool counted only after output, Escape keeps a try, then the one panel, Get Zovo Pro opens the USD 19 tier.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const ExcelJS = require('exceljs');
const { loadExtension, openInEditor } = require('./support/vscode-stub');
const { createPro, TRIAL_KEY, FEATURES } = require('../src/pro');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zovo-sheet-pro-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const MB = 1048576;
const CSV_TEXT = 'name,city,qty\nann,Paris,2\nbob,"Rome, IT",5\ncid,Paris,7\n';
let seq = 0;
const csv = (text = CSV_TEXT) => { const p = path.join(dir, `f${++seq}.csv`); fs.writeFileSync(p, text); return p; };
async function xlsx() {
  const p = path.join(dir, `w${++seq}.xlsx`);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.addRow(['name', 'qty']); ws.addRow(['ann', 2]); ws.addRow(['bob', 5]);
  await wb.xlsx.writeFile(p);
  return p;
}
const tries = (s) => s.state.get(TRIAL_KEY) || {};
const PANEL_BUTTONS = ['Get Zovo Pro, USD 19', 'Pay with PayPal', 'I already paid'];

function trapNetwork() {
  const calls = [];
  const saved = { fetch: global.fetch, hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, ncc: net.createConnection };
  global.fetch = async (u) => { calls.push(String(u)); throw new Error('network blocked in test'); };
  http.request = http.get = https.request = https.get = (...a) => { calls.push(String(a[0] && (a[0].href || a[0].host || a[0]))); throw new Error('network blocked in test'); };
  net.connect = net.createConnection = (...a) => { calls.push('net ' + JSON.stringify(a[0])); throw new Error('network blocked in test'); };
  return { calls, restore: () => { global.fetch = saved.fetch; http.request = saved.hr; http.get = saved.hg; https.request = saved.sr; https.get = saved.sg; net.connect = saved.nc; net.createConnection = saved.ncc; } };
}

async function filtered(v, global) {
  const before = v.posted.length;
  await v.send({ type: 'filter', global, columns: {}, query: '' });
  await v.until((m) => m.type === 'meta' && v.posted.indexOf(m) >= before && m.filters && m.filters.global === global);
}

test('activation and a normal open: no network, no message, no status line, no Pro offer; the Pro commands exist', async () => {
  const nw = trapNetwork();
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    for (const c of ['getPro', 'payWithPayPal', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense', 'replaceInFiles', 'saveFilteredRows']) assert.ok(s.commands.has(`spreadsheetEditor.${c}`), c);
    const v = await openInEditor(s, csv());
    const meta = v.posted.find((m) => m.type === 'meta');
    assert.equal(meta.readOnly, false);
    assert.equal(meta.proOffer, undefined);
    const x = await openInEditor(s, await xlsx());
    assert.ok(x.posted.some((m) => m.type === 'meta'));
    assert.ok(!JSON.stringify([...v.posted, ...x.posted]).includes('Zovo'), 'no Pro text in the editor');
    assert.deepEqual(nw.calls, []);
    assert.deepEqual([s.log.info.length, s.log.warn.length, s.log.error.length, s.log.status.length], [0, 0, 0, 0]);
    assert.deepEqual(s.log.external, []);
  } finally { nw.restore(); s.restore(); }
});

test('Save filtered rows: Escape keeps the try; 3 saves use the 3 tries; the 4th click shows the panel', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const file = csv();
    const v = await openInEditor(s, file);
    await filtered(v, 'paris');
    s.ui.save.push(undefined); // Escape in the save dialog
    await s.commands.get('spreadsheetEditor.saveFilteredRows')();
    assert.equal(tries(s)['save-filtered'], undefined, 'Escape uses no try');
    for (let i = 1; i <= 3; i++) {
      const out = path.join(dir, `out${i}.csv`);
      s.ui.save.push(s.vscode.Uri.file(out));
      await s.commands.get('spreadsheetEditor.saveFilteredRows')();
      assert.equal(fs.readFileSync(out, 'utf8'), 'name,city,qty\nann,Paris,2\ncid,Paris,7\n');
      assert.equal(tries(s)['save-filtered'], i);
      assert.match(s.log.status.at(-1), new RegExp(`^Zovo Pro: free try ${i} of 3 of "Save filtered rows as a new file" used`));
    }
    assert.equal(fs.readFileSync(file, 'utf8'), CSV_TEXT, 'the open file is never written');
    assert.equal(s.log.info.filter((m) => /part of Zovo Pro/.test(m.text)).length, 0, 'no panel while tries are left');
    const out4 = path.join(dir, 'out4.csv');
    s.ui.save.push(s.vscode.Uri.file(out4));
    await s.commands.get('spreadsheetEditor.saveFilteredRows')(); // panel, then Cancel (no button picked)
    const panel = s.log.info.find((m) => /part of Zovo Pro/.test(m.text));
    assert.match(panel.text, /^Save filtered rows as a new file is part of Zovo Pro/);
    assert.equal(panel.opts.modal, true);
    assert.deepEqual(panel.buttons.slice(0, 3), PANEL_BUTTONS);
    assert.match(panel.opts.detail, /You used the 3 free tries/);
    assert.match(panel.opts.detail, /USD 19/);
    assert.match(panel.opts.detail, /Find and Replace in CSV Files/);
    assert.match(panel.opts.detail, /Everything that is free today stays free/);
    assert.ok(!/refund/i.test(panel.opts.detail));
    assert.ok(!fs.existsSync(out4), 'Cancel on the panel writes nothing');
    assert.equal(tries(s)['save-filtered'], 3);
  } finally { s.restore(); }
});

test('Save filtered rows to XLSX: header and the rows shown, numbers stay numbers; a view with no rows uses no try', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const v = await openInEditor(s, csv());
    await filtered(v, 'rome');
    const out = path.join(dir, 'rows.xlsx');
    s.ui.save.push(s.vscode.Uri.file(out));
    await s.commands.get('spreadsheetEditor.saveFilteredRows')();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const ws = wb.worksheets[0];
    assert.deepEqual(ws.getRow(1).values.slice(1), ['name', 'city', 'qty']);
    assert.deepEqual(ws.getRow(2).values.slice(1), ['bob', 'Rome, IT', 5]);
    assert.equal(ws.rowCount, 2);
    assert.equal(tries(s)['save-filtered'], 1);
    await filtered(v, 'nobody-matches');
    s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'none.csv')));
    await s.commands.get('spreadsheetEditor.saveFilteredRows')();
    assert.ok(!fs.existsSync(path.join(dir, 'none.csv')));
    assert.equal(tries(s)['save-filtered'], 1, 'no rows, no file, no try');
  } finally { s.restore(); }
});

test('Get Zovo Pro on the panel opens the USD 19 tier (sponsorships?tier_id=679878), never the generic page', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    s.state.set(TRIAL_KEY, { 'multi-file-replace': 3 });
    s.ui.info.push('Get Zovo Pro, USD 19');
    await s.commands.get('spreadsheetEditor.replaceInFiles')();
    assert.deepEqual(s.log.external.filter((u) => /github\.com\/sponsors/.test(u)), ['https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878']);
    assert.equal(s.log.progress.length, 0, 'the tool did not run');
  } finally { s.restore(); }
});

test('Find and Replace in CSV Files: Escape and no match keep the try; a written replacement uses one', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const a = csv(), b = csv('k,v\nx,Paris\n');
    s.vscode.workspace._files = [a, b];
    s.ui.input.push(undefined); // Escape on the first box
    await s.commands.get('spreadsheetEditor.replaceInFiles')();
    s.ui.input.push('Berlin', 'Rome');
    s.ui.quick.push([]);
    await s.commands.get('spreadsheetEditor.replaceInFiles')();
    assert.equal(tries(s)['multi-file-replace'], undefined, 'no match: no try');
    s.ui.input.push('Paris', 'Lyon');
    s.ui.quick.push([], (items) => items);
    await s.commands.get('spreadsheetEditor.replaceInFiles')();
    assert.equal(fs.readFileSync(a, 'utf8'), CSV_TEXT.replace(/Paris/g, 'Lyon'));
    assert.equal(fs.readFileSync(b, 'utf8'), 'k,v\nx,Lyon\n');
    assert.equal(tries(s)['multi-file-replace'], 1);
    assert.match(s.log.status.at(-1), /^Zovo Pro: free try 1 of 3 of "Find and Replace in CSV Files" used, 2 left on this computer\.$/);
  } finally { s.restore(); }
});

test('free size limits are the defaults: 400 MB CSV edits, 600 MB opens read-only, 1.1 GB and 50 MB workbooks are refused', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const ok = csv(); s.sizes.set(ok, 400 * MB);
    assert.equal((await openInEditor(s, ok)).posted.find((m) => m.type === 'meta').readOnly, false);
    s.config.maxEditSizeMB = 4000; // a raised setting does not lift the free limit
    const ro = csv(); s.sizes.set(ro, 600 * MB);
    const r = await openInEditor(s, ro);
    const meta = r.posted.find((m) => m.type === 'meta');
    assert.equal(meta.readOnly, true);
    assert.match(meta.readOnlyReason, /above the 512 MB editing limit/);
    assert.equal(meta.proOffer, 'Open for editing with Zovo Pro (free try, 3 of 3 left)');
    delete s.config.maxEditSizeMB;
    const big = csv(); s.sizes.set(big, 1100 * MB);
    const g = await openInEditor(s, big);
    const f = g.posted.find((m) => m.type === 'fatal');
    assert.match(f.message, /Files up to 1024 MB open here/);
    assert.ok(f.proOffer);
    const huge = csv(); s.sizes.set(huge, 2500 * MB);
    assert.equal((await openInEditor(s, huge)).posted.find((m) => m.type === 'fatal').proOffer, undefined, 'past the Pro limit too: no offer');
    const w = await xlsx(); s.sizes.set(w, 50 * MB);
    const wf = (await openInEditor(s, w)).posted.find((m) => m.type === 'fatal');
    assert.match(wf.message, /Workbooks up to 40 MB/);
    assert.ok(wf.proOffer);
    assert.deepEqual([s.log.info.length, s.log.status.length], [0, 0], 'the offer is a button in the note, no message');
  } finally { s.restore(); }
});

test('large files: the offer reopens the file with the Pro limits and the try counts once it is open; Cancel keeps it', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const file = csv(); s.sizes.set(file, 600 * MB);
    const v = await openInEditor(s, file);
    await v.send({ type: 'proLargeFile' });
    assert.deepEqual(s.log.closed, [file], 'the read-only tab is closed');
    const ow = s.log.commands.find((c) => c[0] === 'vscode.openWith');
    assert.equal(ow[1].fsPath, file);
    assert.equal(ow[2], 'spreadsheetEditor.csv');
    assert.equal(tries(s)['large-files'], undefined, 'not counted before the file is open');
    const again = await openInEditor(s, file); // VS Code opens it again
    assert.equal(again.posted.find((m) => m.type === 'meta').readOnly, false);
    assert.equal(tries(s)['large-files'], 1);
    assert.match(s.log.status.at(-1), /free try 1 of 3 of "Edit files past the free size limits" used, 2 left/);
    const third = await openInEditor(s, file); // a later open is free-tier again
    assert.equal(third.posted.find((m) => m.type === 'meta').readOnly, true);

    const w = await xlsx(); s.sizes.set(w, 50 * MB);
    const x = await openInEditor(s, w);
    await x.send({ type: 'proLargeFile' });
    const x2 = await openInEditor(s, w);
    assert.ok(!x2.posted.some((m) => m.type === 'fatal'));
    assert.equal(tries(s)['large-files'], 2);

    s.state.set(TRIAL_KEY, { 'large-files': 3 });
    const closed = s.log.closed.length;
    const y = await openInEditor(s, file);
    assert.equal(y.posted.find((m) => m.type === 'meta').proOffer, 'Open for editing with Zovo Pro');
    await y.send({ type: 'proLargeFile' }); // panel, then Escape
    const panel = s.log.info.find((m) => /part of Zovo Pro/.test(m.text));
    assert.match(panel.text, /^Edit files past the free size limits is part of Zovo Pro/);
    assert.deepEqual(panel.buttons.slice(0, 3), PANEL_BUTTONS);
    assert.equal(s.log.closed.length, closed, 'Escape: the tab stays as it is');
    assert.equal(tries(s)['large-files'], 3);
  } finally { s.restore(); }
});

test('createPro with a license: Pro tools run without counting tries and without the panel', async () => {
  const state = new Map();
  class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
  const status = [];
  const vscode = { EventEmitter, window: { setStatusBarMessage: (t) => status.push(t) } };
  const context = { subscriptions: [], globalState: { get: (k) => state.get(k), update: async (k, v) => state.set(k, v) } };
  let asked = 0;
  const license = { isPro: () => true, requirePro: async () => { asked++; return false; }, ready: Promise.resolve() };
  const pro = createPro({ vscode, context, license });
  for (const f of Object.keys(FEATURES)) {
    state.set(TRIAL_KEY, { [f]: 3 });
    assert.equal(await pro.allowed(f), true);
    await pro.produced(f);
    assert.equal(state.get(TRIAL_KEY)[f], 3);
  }
  assert.equal(asked, 0);
  assert.deepEqual(status, []);
});
