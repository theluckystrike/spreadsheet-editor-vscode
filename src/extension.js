'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { validateWebviewMessage } = require('./core/protocol');
const config = require('./config');
const { effectiveLimits, isEnabled } = require('./pro');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const VIEW_TYPE = 'spreadsheetEditor.xlsx'; // .xlsx and .xlsm: default editor
const CSV_VIEW_TYPE = 'spreadsheetEditor.csv'; // .csv and .tsv: an option, unless the user makes it the default
const SECTION = 'spreadsheetEditor';
const SELF_ID = 'zovo.zovo-spreadsheet-editor';
const CSV_OPTIONS_KEY = 'spreadsheetEditor.csvOptions';
const CSV_OPTIONS_MAX = 200;
const EXCEL_NOTE_KEY = 'spreadsheetEditor.excelNoteSeen';
const TEXT_EXT = new Set(['.csv', '.tsv', '.tab', '.psv', '.txt']);
const EXCEL_EXT = new Set(['.xlsx', '.xlsm']);

let rating = { success() {}, failure() {} };
const openDocs = new Set(); // SheetDocuments open in a tab
let license = null; // Zovo Pro facade, only when config.PRO_ENABLED

function settings() {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    maxEditSizeMB: c.get('maxEditSizeMB', 512),
    maxFileSizeMB: c.get('maxFileSizeMB', 1024),
    maxExcelSizeMB: c.get('maxExcelSizeMB', 40),
    maxExcelCells: c.get('maxExcelCells', 5000000),
    maxCopyRows: c.get('maxCopyRows', 200000),
    autoReload: c.get('autoReload', true) !== false,
  };
}

function formatOf(uri) {
  const ext = path.posix.extname(uri.path).toLowerCase();
  if (EXCEL_EXT.has(ext)) return { format: 'xlsx', ext: ext.slice(1) };
  if (TEXT_EXT.has(ext)) return { format: 'csv', ext: ext === '.tsv' || ext === '.tab' ? 'tsv' : ext.slice(1) };
  return null;
}

function mb(n) { return `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`; }

// ---------------------------------------------------------------------------------------------------------
// Document: one worker per open file. Views (tabs) on the same file share it.

class SheetDocument {
  constructor(uri, ctx) {
    this.uri = uri;
    this.ctx = ctx;
    const f = formatOf(uri) || { format: 'csv', ext: 'csv' };
    this.format = f.format;
    this.ext = f.ext;
    this.worker = null;
    this.rpcs = new Map();
    this.rpcSeq = 0;
    this.views = new Map(); // view id -> panel bridge
    this.fatal = null;
    this.readOnly = false;
    this.readOnlyReason = '';
    this.stamp = null; // {size, mtimeMs} of the file as last read or saved
    this.depth = 0; // edits applied minus undone, since open
    this.savedDepth = 0;
    this.conflict = false;
    this.excelNoteShown = false;
    this.opened = null;
    this._onDispose = new vscode.EventEmitter();
    this.onDidDispose = this._onDispose.event;
  }

  get dirty() { return this.depth !== this.savedDepth; }

  notifyDirty() { for (const v of this.views.values()) v.post({ type: 'dirty', dirty: this.dirty }); }

  rpc(type, payload = {}) {
    if (!this.worker) return Promise.reject(new Error(this.fatal || 'The file is not open.'));
    const id = ++this.rpcSeq;
    return new Promise((resolve, reject) => {
      this.rpcs.set(id, { resolve, reject });
      this.worker.postMessage({ ...payload, type, rpc: id });
    });
  }

  send(msg) { if (this.worker) this.worker.postMessage(msg); }

  startWorker() {
    this.worker = new Worker(path.join(this.ctx.extensionPath, 'dist', 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
    this.worker.on('message', m => this.onWorker(m));
    this.worker.on('error', e => this.failAll(`The reader stopped: ${e.message}`));
    this.worker.on('exit', code => {
      const w = this.worker;
      this.worker = null;
      for (const r of this.rpcs.values()) r.reject(new Error('The reader stopped (out of memory?).'));
      this.rpcs.clear();
      if (code !== 0 && w && !this.disposed && !this.closing) this.failAll('The reader ran out of memory or crashed. Your file on disk was not changed.');
    });
  }

  onWorker(m) {
    if (!m) return;
    if (m.type === 'rpc') {
      const r = this.rpcs.get(m.rpc);
      if (!r) return;
      this.rpcs.delete(m.rpc);
      if (m.ok) r.resolve(m.value);
      else { const e = new Error(m.error.message); e.code = m.error.code; r.reject(e); }
      return;
    }
    const v = m.view !== undefined ? this.views.get(m.view) : null;
    if (m.type === 'meta') {
      if (v) v.meta(m);
      return;
    }
    if (v) v.post(m);
  }

  failAll(message) {
    this.fatal = message;
    rating.failure();
    for (const v of this.views.values()) v.post({ type: 'fatal', message });
  }

  async open(openContext) {
    const s = settings();
    const limits = effectiveLimits(s, entitlement(), userSetKeys());
    const uri = this.uri;
    let size = 0;
    try {
      const st = await vscode.workspace.fs.stat(uri);
      size = st.size;
      this.stamp = { size: st.size, mtimeMs: st.mtime };
    } catch (e) {
      this.fatal = `The file could not be read: ${e.message || e}`;
      return;
    }
    if (this.format === 'xlsx' && size > limits.maxExcelSizeMB * 1048576) {
      this.fatal = `This workbook is ${mb(size)}. Workbooks up to ${limits.maxExcelSizeMB} MB open for editing here (setting spreadsheetEditor.maxExcelSizeMB). To look through a larger workbook, open it in a viewer that streams it, such as XLSX Viewer by Zovo.`;
      this.tooBig = true;
      return;
    }
    if (this.format === 'csv' && size > limits.maxFileSizeMB * 1048576) {
      this.fatal = `This file is ${mb(size)}. Files up to ${limits.maxFileSizeMB} MB open here (setting spreadsheetEditor.maxFileSizeMB). Open it as text, or raise the setting.`;
      this.tooBig = true;
      return;
    }
    if (this.format === 'csv' && size > limits.maxEditSizeMB * 1048576) {
      this.readOnly = true;
      this.readOnlyReason = `Read-only: this file is ${mb(size)}, above the ${limits.maxEditSizeMB} MB editing limit (setting spreadsheetEditor.maxEditSizeMB).`;
    }
    if (uri.scheme !== 'file') {
      try { this.bytes = await vscode.workspace.fs.readFile(uri); } catch (e) { this.fatal = `The file could not be read: ${e.message || e}`; return; }
    }
    this.startWorker();
    const options = this.format === 'csv' ? savedCsvOptions(this.ctx, uri.toString()) : { header: false, ...savedCsvOptions(this.ctx, uri.toString()) };
    options.maxCells = s.maxExcelCells;
    let backup = null;
    if (openContext && openContext.backupId) {
      try { backup = vscode.Uri.parse(openContext.backupId).fsPath; } catch { backup = null; }
    }
    try {
      this.opened = await this.rpc('open', {
        source: this.source(), format: this.format, ext: this.ext, options,
        readOnly: this.readOnly, readOnlyReason: this.readOnlyReason, backup,
      });
      if (backup && this.opened.restored) { this.depth = 1; this.restoredFromBackup = true; }
    } catch (e) {
      this.fatal = friendlyError(e, this.format);
      this.closing = true;
      if (this.worker) { this.worker.terminate(); }
    }
  }

  source() { return this.uri.scheme === 'file' ? { path: this.uri.fsPath } : { bytes: this.bytes }; }

  dispose() {
    this.disposed = true;
    if (this.watcher) this.watcher.dispose();
    if (this.worker) this.worker.terminate();
    this._onDispose.fire();
    this._onDispose.dispose();
  }
}

function friendlyError(e, format) {
  const msg = e && e.message ? e.message : String(e);
  if (format === 'xlsx' && /end of central directory|zip|signature/i.test(msg) && !/bomb|unpacks|parts/i.test(msg)) return `This workbook could not be read: ${msg}. It may be damaged or not an .xlsx file.`;
  return msg;
}

// ---------------------------------------------------------------------------------------------------------
// License (Zovo Pro). Off in this build: config.PRO_ENABLED is false, so nothing is locked, no license
// command shows, and no network call can happen.

function entitlement() {
  const enabled = !!config.PRO_ENABLED;
  const licensed = enabled && !!(license && license.isPro(config.SKU));
  return { enabled, licensed };
}

function userSetKeys() {
  const c = vscode.workspace.getConfiguration(SECTION);
  if (typeof c.inspect !== 'function') return [];
  return ['maxEditSizeMB', 'maxFileSizeMB', 'maxExcelSizeMB'].filter(k => {
    const i = c.inspect(k);
    return !!i && [i.globalValue, i.workspaceValue, i.workspaceFolderValue].some(v => v !== undefined);
  });
}

// ---------------------------------------------------------------------------------------------------------

// The panel that has focus, shared by both providers (Find and Replace commands).
const shared = { active: null };

// One provider per view type: VS Code listens to each provider's onDidChangeCustomDocument for its own view
// type, so a shared emitter would report every edit to the other view type too.
class SpreadsheetEditorProvider {
  constructor(context) {
    this.context = context;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this._onDidChange.event;
    this.viewSeq = 0;
  }

  async openCustomDocument(uri, openContext) {
    const doc = new SheetDocument(uri, this.context);
    openDocs.add(doc);
    doc.onDidDispose(() => openDocs.delete(doc));
    await doc.open(openContext);
    if (uri.scheme === 'file' && !doc.fatal && typeof vscode.workspace.createFileSystemWatcher === 'function') {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), path.posix.basename(uri.path)));
      let timer = null;
      const onChange = () => { clearTimeout(timer); timer = setTimeout(() => this.onDiskChange(doc), 500); };
      w.onDidChange(onChange);
      w.onDidCreate(onChange);
      w.onDidDelete(() => { for (const v of doc.views.values()) v.post({ type: 'notice', level: 'warn', message: 'The file was deleted or moved on disk. Save to write it again.' }); });
      doc.watcher = w;
    }
    if (doc.restoredFromBackup) {
      // Unsaved edits came back from the last session: VS Code must show the tab as dirty.
      setTimeout(() => this.fireEdit(doc, 'Restore unsaved edits', true), 0);
    }
    return doc;
  }

  fireEdit(doc, label, restoredOnly) {
    if (doc.disposed) return; // the tab closed while the edit was on its way
    this._onDidChange.fire({
      document: doc,
      label,
      undo: restoredOnly ? () => {} : async () => { const r = await doc.rpc('undo'); if (r.done) doc.depth--; doc.notifyDirty(); },
      redo: restoredOnly ? () => {} : async () => { const r = await doc.rpc('redo'); if (r.done) doc.depth++; doc.notifyDirty(); },
    });
  }

  async onDiskChange(doc) {
    if (doc.disposed || !doc.worker) return;
    let st;
    try { st = await vscode.workspace.fs.stat(doc.uri); } catch { return; }
    if (doc.stamp && st.size === doc.stamp.size && Math.abs(st.mtime - doc.stamp.mtimeMs) < 2) return; // our own save
    if (!doc.dirty && settings().autoReload) {
      try {
        doc.readOnly = doc.readOnly && true;
        await doc.rpc('revert', { source: doc.source() });
        doc.stamp = { size: st.size, mtimeMs: st.mtime };
        for (const v of doc.views.values()) v.post({ type: 'notice', level: 'info', message: 'The file changed on disk and was read again.' });
      } catch (e) {
        for (const v of doc.views.values()) v.post({ type: 'notice', level: 'warn', message: `The file changed on disk but could not be read again: ${e.message}` });
      }
      return;
    }
    doc.conflict = true;
    for (const v of doc.views.values()) v.post({ type: 'conflict', message: 'The file changed on disk while you have unsaved edits. Your edits are kept. Saving asks before it overwrites the newer file.' });
  }

  async checkConflict(doc) {
    let st = null;
    try { st = await vscode.workspace.fs.stat(doc.uri); } catch { return true; }
    const changed = doc.stamp && (st.size !== doc.stamp.size || Math.abs(st.mtime - doc.stamp.mtimeMs) >= 2);
    if (!changed) return true;
    const name = path.posix.basename(doc.uri.path);
    const pick = await vscode.window.showWarningMessage(
      `${name} changed on disk after it was opened here.`,
      { modal: true, detail: 'Overwrite replaces the newer file on disk with your version. Save As writes your version to another file, and the file on disk stays as it is.' },
      'Overwrite', 'Save As...');
    if (pick === 'Overwrite') return true;
    if (pick === 'Save As...') { await vscode.commands.executeCommand('workbench.action.files.saveAs'); }
    throw new vscode.CancellationError();
  }

  async excelNote(doc, target) {
    if (doc.format !== 'xlsx') return 'save';
    const info = doc.opened && doc.opened.workbook;
    const d = await doc.rpc('describe').catch(() => null);
    const wb = d || info || {};
    const risky = (wb.atRisk || []).filter(x => x !== 'macros (VBA)');
    const xlsm = doc.ext === 'xlsm';
    if (xlsm) {
      // exceljs cannot write a macro workbook: saving in place would break the file. Only a copy is offered.
      const pick = await vscode.window.showWarningMessage(
        'Macros cannot be kept when this workbook is saved here.',
        { modal: true, detail: 'This is a macro workbook (.xlsm). To keep your original file and its macros safe, your edits are saved to a new .xlsx copy. The .xlsm file is not changed.' },
        'Save As .xlsx Copy...');
      if (pick) return 'copy';
      throw new vscode.CancellationError();
    }
    if (doc.excelNoteShown || (!risky.length && !wb.formulas)) return 'save';
    const seen = this.context.globalState.get(EXCEL_NOTE_KEY, false);
    if (!risky.length && seen) return 'save';
    const lines = [];
    if (risky.length) lines.push(`These parts of the workbook will not survive the save: ${risky.join(', ')}. Choose Save a Copy to keep the original as it is.`);
    lines.push('Kept: cell values, styles, number formats, merged cells, column widths and the other sheets.');
    if (wb.formulas) lines.push('Formulas stay formulas. Their results are calculated again when the file opens in Excel.');
    const pick = await vscode.window.showInformationMessage(
      `Before the first save of ${path.posix.basename(target.path)}`,
      { modal: true, detail: lines.join('\n\n') },
      'Save', 'Save a Copy...');
    if (!pick) throw new vscode.CancellationError();
    doc.excelNoteShown = true;
    if (!risky.length) this.context.globalState.update(EXCEL_NOTE_KEY, true);
    return pick === 'Save' ? 'save' : 'copy';
  }

  async saveCopy(doc) {
    const dir = vscode.Uri.joinPath(doc.uri, '..');
    const base = path.posix.basename(doc.uri.path).replace(/\.[^.]+$/, '');
    const ext = doc.format === 'xlsx' ? 'xlsx' : doc.ext;
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(dir, `${base} (edited).${ext}`), filters: doc.format === 'xlsx' ? { 'Excel workbook': ['xlsx'] } : undefined, saveLabel: 'Save Copy' });
    if (!target) throw new vscode.CancellationError();
    await this.writeTo(doc, target);
    vscode.window.showInformationMessage(`Saved a copy to ${path.posix.basename(target.path)}. The original file is unchanged, and your edits stay unsaved in this tab.`);
    throw new vscode.CancellationError();
  }

  async writeTo(doc, target, extra = {}) {
    if (target.scheme === 'file') {
      const r = await doc.rpc('save', { path: target.fsPath, ...extra });
      return r;
    }
    const r = await doc.rpc('save', { ...extra });
    await vscode.workspace.fs.writeFile(target, new Uint8Array(r.bytes.buffer || r.bytes, r.bytes.byteOffset || 0, r.bytes.byteLength || r.bytes.length));
    const st = await vscode.workspace.fs.stat(target);
    return { size: st.size, mtimeMs: st.mtime };
  }

  async saveCustomDocument(doc) {
    if (doc.readOnly) throw new Error(doc.readOnlyReason || 'This file is open read-only.');
    // Nothing edited and the file on disk is the one we read: write nothing, so the file stays byte for byte (EXEC6).
    if (!doc.dirty && !doc.conflict && doc.stamp && await vscode.workspace.fs.stat(doc.uri).then(st => st.size === doc.stamp.size && Math.abs(st.mtime - doc.stamp.mtimeMs) < 2, () => false)) return;
    const mode = await this.excelNote(doc, doc.uri);
    if (mode === 'copy') return this.saveCopy(doc);
    await this.checkConflict(doc);
    try {
      const r = await this.writeTo(doc, doc.uri);
      doc.stamp = { size: r.size, mtimeMs: r.mtimeMs };
      doc.savedDepth = doc.depth;
      doc.conflict = false;
      for (const v of doc.views.values()) v.post({ type: 'saved', ms: r.ms });
      doc.notifyDirty();
    } catch (e) {
      if (e instanceof vscode.CancellationError) throw e;
      if (e && e.code === 'ENCODE') {
        const pick = await vscode.window.showErrorMessage(e.message, { modal: true }, 'Save a Copy as UTF-8...');
        if (pick) await this.saveUtf8Copy(doc);
        throw new vscode.CancellationError();
      }
      throw new Error(`Not saved: ${e.message}. The file on disk is unchanged.`);
    }
  }

  async saveCustomDocumentAs(doc, destination) {
    const mode = await this.excelNote(doc, destination);
    if (mode === 'copy' && doc.ext === 'xlsm' && /\.xlsm$/i.test(destination.path)) {
      throw new Error('A macro workbook cannot be written here. Save As a .xlsx file.');
    }
    try {
      await this.writeTo(doc, destination);
    } catch (e) {
      if (e && e.code === 'ENCODE') throw new Error(`${e.message}`);
      throw new Error(`Not saved: ${e.message}`);
    }
  }

  async saveUtf8Copy(doc) {
    const dir = vscode.Uri.joinPath(doc.uri, '..');
    const base = path.posix.basename(doc.uri.path).replace(/\.[^.]+$/, '');
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(dir, `${base}-utf8.${doc.ext}`), saveLabel: 'Save UTF-8 Copy' });
    if (!target) return;
    try {
      await this.writeTo(doc, target, { encoding: 'utf-8', bom: false });
      vscode.window.showInformationMessage(`Saved a UTF-8 copy to ${path.posix.basename(target.path)}.`);
    } catch (e) {
      vscode.window.showErrorMessage(`Not saved: ${e.message}`);
    }
  }

  async revertCustomDocument(doc) {
    await doc.rpc('revert', { source: doc.source() });
    try { const st = await vscode.workspace.fs.stat(doc.uri); doc.stamp = { size: st.size, mtimeMs: st.mtime }; } catch { /* keep */ }
    doc.depth = 0;
    doc.savedDepth = 0;
    doc.conflict = false;
    doc.notifyDirty();
  }

  async backupCustomDocument(doc, context) {
    const dest = context.destination;
    await doc.rpc('backup', { path: dest.fsPath });
    return {
      id: dest.toString(),
      delete: () => { try { fs.unlinkSync(dest.fsPath); } catch { /* gone */ } },
    };
  }

  async resolveCustomEditor(doc, panel) {
    const ctx = this.context;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris(SECTION) };
    const name = path.posix.basename(doc.uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
      showSupportLinks: showLinks(vscode, SECTION),
    });
    const viewId = ++this.viewSeq;
    shared.active = panel;
    panel.onDidChangeViewState(e => { if (e.webviewPanel.active) shared.active = panel; });
    let ready = false;
    let counted = false;
    const queue = [];
    const post = m => {
      if (ready) panel.webview.postMessage(m);
      else if (m.type !== 'rows' && m.type !== 'meta') queue.push(m);
    };
    const bridge = {
      post,
      meta: m => {
        if (!counted && m.columns && m.columns.length && !doc.fatal) { counted = true; rating.success(doc.uri); }
        post({ ...m, dirty: doc.dirty, conflict: doc.conflict, fileName: name });
      },
    };
    doc.views.set(viewId, bridge);
    if (doc.fatal) rating.failure();

    const reply = (reqId, type, value) => panel.webview.postMessage({ type, reqId, ...value });

    panel.webview.onDidReceiveMessage(async raw => {
      const m = validateWebviewMessage(raw);
      if (!m) return;
      try {
        switch (m.type) {
          case 'ready':
            ready = true;
            panel.webview.postMessage({ type: 'init', fileName: name, format: doc.format, ext: doc.ext, maxCopyRows: settings().maxCopyRows });
            while (queue.length) panel.webview.postMessage(queue.shift());
            if (doc.fatal) { panel.webview.postMessage({ type: 'fatal', message: doc.fatal, tooBig: !!doc.tooBig }); return; }
            doc.send({ type: 'hello', view: viewId });
            return;
          case 'undo': await vscode.commands.executeCommand('undo'); return;
          case 'redo': await vscode.commands.executeCommand('redo'); return;
          case 'save': await vscode.commands.executeCommand('workbench.action.files.save'); return;
          case 'saveAsUtf8': await this.saveUtf8Copy(doc); return;
          case 'openSettings': await vscode.commands.executeCommand('workbench.action.openSettings', SECTION); return;
          case 'openAsText': await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default'); return;
          case 'getRows': case 'sort': case 'filter': case 'sheet': case 'refreshView':
            doc.send({ ...m, view: viewId });
            return;
          case 'edit': {
            const r = await doc.rpc('edit', { view: viewId, edit: m.edit });
            if (r.changed && !doc.disposed) {
              doc.depth++;
              this.fireEdit(doc, r.label);
              doc.notifyDirty();
            }
            reply(m.reqId, 'edited', { kind: m.edit.kind, changed: r.changed, count: r.count });
            return;
          }
          case 'find': { const r = await doc.rpc('find', { view: viewId, query: m.query }); reply(m.reqId, 'found', r); return; }
          case 'count': { const r = await doc.rpc('count', { view: viewId, query: m.query }); reply(m.reqId, 'counted', r); return; }
          case 'getCell': { const r = await doc.rpc('getCell', { view: viewId, id: m.id, col: m.col }); reply(m.reqId, 'cell', { ...r, purpose: m.purpose }); return; }
          case 'stats': { const r = await doc.rpc('stats', { view: viewId, col: m.col }); reply(m.reqId, 'stats', r); return; }
          case 'copy': {
            const max = settings().maxCopyRows;
            const r = await doc.rpc('copy', { view: viewId, ...m, max });
            await vscode.env.clipboard.writeText(r.text);
            panel.webview.postMessage({ type: 'copied', rows: r.rows, truncated: m.r1 - m.r0 + 1 > r.rows });
            return;
          }
          case 'csvOptions': {
            saveCsvOptions(ctx, doc.uri.toString(), m.options);
            await doc.rpc('reparse', { options: m.options });
            return;
          }
          default:
        }
      } catch (e) {
        if (e instanceof vscode.CancellationError) return;
        panel.webview.postMessage({ type: 'error', message: e.message || String(e) });
      }
    });

    panel.onDidDispose(() => {
      if (shared.active === panel) shared.active = null;
      doc.views.delete(viewId);
      doc.send({ type: 'closeView', view: viewId, rpc: 0 });
    });
  }
}

/** Delimiter, encoding, quote, header and comment choices per file, kept in workspace state (newest 200). */
function savedCsvOptions(context, key) {
  const all = (context.workspaceState && context.workspaceState.get(CSV_OPTIONS_KEY)) || {};
  const o = all[key];
  if (!o || typeof o !== 'object') return {};
  const out = {};
  for (const k of ['delimiter', 'encoding', 'quote', 'commentPrefix']) if (typeof o[k] === 'string') out[k] = o[k];
  if (typeof o.header === 'boolean') out.header = o.header;
  return out;
}

function saveCsvOptions(context, key, opts) {
  if (!context.workspaceState) return;
  const all = { ...(context.workspaceState.get(CSV_OPTIONS_KEY) || {}) };
  const prev = all[key] || {};
  delete all[key];
  all[key] = { ...prev, ...opts };
  const keys = Object.keys(all);
  for (let i = 0; i < keys.length - CSV_OPTIONS_MAX; i++) delete all[keys[i]];
  context.workspaceState.update(CSV_OPTIONS_KEY, all);
}

async function setDefaultForCsv(on) {
  const cfg = vscode.workspace.getConfiguration('workbench');
  const current = cfg.get('editorAssociations') || {};
  const next = Array.isArray(current) ? {} : { ...current };
  for (const pat of ['*.csv', '*.tsv']) {
    if (on) next[pat] = CSV_VIEW_TYPE;
    else if (next[pat] === CSV_VIEW_TYPE) delete next[pat];
  }
  await cfg.update('editorAssociations', next, vscode.ConfigurationTarget.Global);
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: SELF_ID, section: SECTION, name: 'Spreadsheet Editor' });
  registerSupport({ vscode, context, prefix: SECTION, selfId: SELF_ID });
  if (config.PRO_ENABLED) {
    // eslint-disable-next-line global-require
    const { createLicense } = require('./license');
    license = createLicense({ vscode, context, sku: config.SKU, name: 'Spreadsheet Editor', commandPrefix: SECTION });
    context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: uri => license.handleUri(uri) }));
    context.subscriptions.push(vscode.commands.registerCommand('spreadsheetEditor.replaceInFiles', () => replaceInFiles(context)));
  }
  vscode.commands.executeCommand('setContext', 'spreadsheetEditor.proEnabled', !!config.PRO_ENABLED);

  context.subscriptions.push(
    ...[VIEW_TYPE, CSV_VIEW_TYPE].map(id => vscode.window.registerCustomEditorProvider(id, new SpreadsheetEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    })),
    vscode.commands.registerCommand('spreadsheetEditor.find', () => { if (shared.active) shared.active.webview.postMessage({ type: 'openFind', replace: false }); }),
    vscode.commands.registerCommand('spreadsheetEditor.replace', () => { if (shared.active) shared.active.webview.postMessage({ type: 'openFind', replace: true }); }),
    vscode.commands.registerCommand('spreadsheetEditor.open', async uri => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
      if (!target) { vscode.window.showInformationMessage('Open a CSV, TSV or Excel file first.'); return; }
      if (!formatOf(target)) { vscode.window.showInformationMessage('Spreadsheet Editor opens .csv, .tsv, .tab, .psv, .xlsx and .xlsm files.'); return; }
      await vscode.commands.executeCommand('vscode.openWith', target, formatOf(target).format === 'xlsx' ? VIEW_TYPE : CSV_VIEW_TYPE);
    }),
    vscode.commands.registerCommand('spreadsheetEditor.openAsText', async uri => {
      const target = uri instanceof vscode.Uri ? uri : activeUri();
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),
    vscode.commands.registerCommand('spreadsheetEditor.makeDefaultForCsv', async () => {
      await setDefaultForCsv(true);
      vscode.window.showInformationMessage('CSV and TSV files now open in Spreadsheet Editor. "Open as Text" in the editor title switches back for one file.');
    }),
    vscode.commands.registerCommand('spreadsheetEditor.removeDefaultForCsv', async () => {
      await setDefaultForCsv(false);
      vscode.window.showInformationMessage('CSV and TSV files open as text again.');
    }),
    vscode.commands.registerCommand('spreadsheetEditor.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${SELF_ID}#spreadsheetEditor.start`, false)),
  );
}

/**
 * Find and Replace in CSV Files (Zovo Pro candidate). Registered only when config.PRO_ENABLED is true; this build
 * ships with it off, so the command is neither registered nor shown. Rows that do not change stay byte for byte.
 */
async function replaceInFiles(context) {
  if (!license || !license.isPro(config.SKU)) {
    const ok = await license.requirePro('Find and Replace in CSV Files', 'Replace text in every CSV and TSV file of the workspace at once. Rows that do not change stay byte for byte.');
    if (!ok) return;
  }
  const find = await vscode.window.showInputBox({ title: 'Find and Replace in CSV Files (1/3)', prompt: 'Find: text, or a regular expression if you pick that option next', ignoreFocusOut: true });
  if (!find) return;
  const replace = await vscode.window.showInputBox({ title: 'Find and Replace in CSV Files (2/3)', prompt: `Replace "${find}" with ($1 puts back a regex group)`, ignoreFocusOut: true });
  if (replace === undefined) return;
  const opts = await vscode.window.showQuickPick([
    { label: 'Regular expression', id: 'regex' }, { label: 'Match case', id: 'matchCase' }, { label: 'Whole cell', id: 'wholeCell' },
  ], { title: 'Find and Replace in CSV Files (3/3): options', canPickMany: true, placeHolder: 'Pick none for plain text, any case' });
  if (!opts) return;
  const query = { find, regex: false, matchCase: false, wholeCell: false };
  for (const o of opts) query[o.id] = true;
  if (query.regex) { try { new RegExp(find, 'u'); } catch (e) { vscode.window.showErrorMessage(`The pattern is not valid: ${e.message}`); return; } }
  const files = (await vscode.workspace.findFiles('**/*.{csv,tsv}', '**/node_modules/**', 5000)).filter(u => u.scheme === 'file');
  if (!files.length) { vscode.window.showInformationMessage('No CSV or TSV files in this workspace.'); return; }
  const busy = new Set([...openDocs].filter(d => d.dirty).map(d => d.uri.toString()));
  for (const d of vscode.workspace.textDocuments) if (d.isDirty) busy.add(d.uri.toString());
  const maxBytes = settings().maxEditSizeMB * 1048576;
  const w = new Worker(path.join(context.extensionPath, 'dist', 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
  let seq = 0;
  const pending = new Map();
  w.on('message', m => { const p = m && m.type === 'rpc' ? pending.get(m.rpc) : null; if (!p) return; pending.delete(m.rpc); if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error.message)); });
  const call = msg => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); w.postMessage({ ...msg, type: 'replaceInFile', rpc: id }); });
  try {
    const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Searching CSV files', cancellable: true }, async (prog, token) => {
      const out = [];
      for (let i = 0; i < files.length && !token.isCancellationRequested; i++) {
        prog.report({ message: `${i + 1} of ${files.length}`, increment: 100 / files.length });
        try { const r = await call({ path: files[i].fsPath, query, replace, maxBytes, apply: false }); if (r.count) out.push({ uri: files[i], count: r.count }); } catch { /* unreadable file: skipped */ }
      }
      return out;
    });
    if (!found.length) { vscode.window.showInformationMessage(`No cell matches "${find}" in ${files.length} files.`); return; }
    const picks = await vscode.window.showQuickPick(found.map(f => ({
      label: vscode.workspace.asRelativePath(f.uri), description: `${f.count.toLocaleString('en-US')} cells${busy.has(f.uri.toString()) ? ', has unsaved edits: skipped' : ''}`,
      picked: !busy.has(f.uri.toString()), f,
    })), { title: 'Replace in these files', canPickMany: true, placeHolder: 'Untick a file to leave it as it is' });
    if (!picks || !picks.length) return;
    let cells = 0, written = 0;
    for (const p of picks) {
      if (busy.has(p.f.uri.toString())) continue;
      const r = await call({ path: p.f.uri.fsPath, query, replace, maxBytes, apply: true });
      if (r.written) { written++; cells += r.count; }
    }
    vscode.window.showInformationMessage(`Replaced ${cells.toLocaleString('en-US')} cells in ${written} ${written === 1 ? 'file' : 'files'}.`);
  } catch (e) {
    vscode.window.showErrorMessage(`Replace in files stopped: ${e.message}. Files already done are saved; the others are unchanged.`);
  } finally {
    w.terminate();
  }
}

function activeUri() {
  const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab && tab.input && tab.input.uri) return tab.input.uri;
  return vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : null;
}

function deactivate() {}

module.exports = { activate, deactivate, savedCsvOptions, saveCsvOptions, formatOf, friendlyError, SpreadsheetEditorProvider, SheetDocument, isEnabled };
