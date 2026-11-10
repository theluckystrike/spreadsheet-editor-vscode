'use strict';
// A small stand-in for the vscode module (pattern of the ELF & PE Viewer stub): enough for activation, the custom
// editor with its real worker, the Pro tools and the license module. Tests script the dialogs through `ui`, can fake
// a file size through `sizes` (path -> bytes) and read what happened from `log`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function create() {
  const log = { info: [], warn: [], error: [], status: [], external: [], commands: [], saved: [], progress: [], closed: [] };
  const ui = { save: [], input: [], quick: [], info: [], warn: [] };
  const commands = new Map();
  const providers = new Map();
  const state = new Map();
  const config = {};
  const sizes = new Map();
  const tabs = [];
  const docs = [];
  class EventEmitter { constructor() { this.l = new Set(); this.event = (f) => { this.l.add(f); return { dispose: () => this.l.delete(f) }; }; } fire(v) { for (const f of [...this.l]) f(v); } dispose() { this.l.clear(); } }
  class Uri {
    constructor(scheme, p) { this.scheme = scheme; this.path = p; this.fsPath = p; }
    static file(p) { return new Uri('file', path.resolve(p)); }
    static parse(s) { const u = new Uri(s.split(':')[0], s); u.str = s; return u; }
    static joinPath(u, ...parts) { return new Uri(u.scheme, path.join(u.path, ...parts)); }
    toString() { return this.str || `${this.scheme}://${this.path}`; }
    with() { return this; }
  }
  class CancellationError extends Error {}
  const nextOf = (q, dflt) => (q.length ? q.shift() : dflt);
  const msg = (kind) => async (text, ...rest) => {
    const opts = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) ? rest.shift() : {};
    log[kind].push({ text, opts, buttons: rest.map((b) => (typeof b === 'string' ? b : b.title)) });
    return kind === 'info' ? nextOf(ui.info, undefined) : kind === 'warn' ? nextOf(ui.warn, undefined) : undefined;
  };
  const vscode = {
    version: '1.90.2',
    EventEmitter, Uri, CancellationError,
    RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
    ViewColumn: { Beside: -2, Active: -1, One: 1 },
    ProgressLocation: { Notification: 15, Window: 10 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    env: { appName: 'Visual Studio Code', uriScheme: 'vscode', machineId: 'test', clipboard: { writeText: async (t) => { log.clipboard = t; } }, openExternal: async (u) => { log.external.push(String(u)); return true; }, asExternalUri: async (u) => u },
    workspace: {
      workspaceFolders: undefined,
      textDocuments: [],
      getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d), inspect: (k) => (k in config ? { globalValue: config[k] } : {}), update: async () => {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      findFiles: async () => (vscode.workspace._files || []).map((p) => Uri.file(p)),
      asRelativePath: (u) => path.basename(u.fsPath || String(u)),
      fs: {
        stat: async (u) => { const st = fs.statSync(u.fsPath); return { size: sizes.has(u.fsPath) ? sizes.get(u.fsPath) : st.size, mtime: st.mtimeMs }; },
        readFile: async (u) => fs.readFileSync(u.fsPath),
        writeFile: async (u, b) => { fs.writeFileSync(u.fsPath, b); log.saved.push(u.fsPath); },
      },
      isTrusted: true,
    },
    window: {
      state: { focused: true },
      activeTextEditor: undefined,
      onDidChangeWindowState: () => ({ dispose() {} }),
      registerCustomEditorProvider: (vt, p) => { providers.set(vt, p); return { dispose() {} }; },
      registerUriHandler: () => ({ dispose() {} }),
      showInformationMessage: msg('info'), showWarningMessage: msg('warn'), showErrorMessage: msg('error'),
      setStatusBarMessage: (t) => { log.status.push(t); return { dispose() {} }; },
      showSaveDialog: async () => nextOf(ui.save, undefined),
      showOpenDialog: async () => undefined,
      showInputBox: async () => nextOf(ui.input, undefined),
      showQuickPick: async (items) => { const f = nextOf(ui.quick, undefined); return typeof f === 'function' ? f(await items) : f; },
      withProgress: async (o, fn) => { log.progress.push(o.title); return fn({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }); },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      tabGroups: {
        get all() { return [{ viewColumn: 1, tabs: tabs.slice() }]; },
        close: async (list) => { for (const t of [].concat(list)) { const i = tabs.indexOf(t); if (i >= 0) tabs.splice(i, 1); log.closed.push(t.input.uri.fsPath); t.close(); } return true; },
      },
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id, ...a) => { log.commands.push([id, ...a]); if (commands.has(id)) return commands.get(id)(...a); return undefined; },
      getCommands: async () => [...commands.keys()],
    },
    extensions: { all: [], getExtension: () => undefined, onDidChange: () => ({ dispose() {} }) },
    authentication: { getSession: async () => undefined, onDidChangeSessions: () => ({ dispose() {} }) },
    l10n: { t: (s) => s },
  };
  const secrets = new Map();
  const root = path.join(__dirname, '..', '..');
  const context = {
    subscriptions: [],
    extensionUri: Uri.file(root),
    extensionPath: root,
    extension: undefined,
    globalStorageUri: Uri.file(os.tmpdir()),
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); }, keys: () => [...state.keys()], setKeysForSync() {} },
    workspaceState: { get: () => undefined, update: async () => {} },
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); }, onDidChange: () => ({ dispose() {} }) },
  };
  return { vscode, context, log, ui, commands, providers, state, config, sizes, tabs, docs };
}

/** Load src/extension.js with a fresh stub; returns the stub and the module. */
function loadExtension() {
  const stub = create();
  const orig = Module._load;
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return stub.vscode; return orig.call(this, req, parent, isMain); };
  const root = path.join(__dirname, '..', '..', 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(root)) delete require.cache[k];
  try { stub.ext = require(path.join(root, 'extension.js')); } finally { Module._load = orig; }
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return stub.vscode; return orig.call(this, req, parent, isMain); };
  stub.restore = () => { Module._load = orig; for (const d of stub.docs) if (!d.disposed) d.dispose(); };
  return stub;
}

/** Open a file in the custom editor (as VS Code does), wait for the first meta or fatal message. */
async function openInEditor(stub, file, vt) {
  const viewType = vt || (/\.xlsx?m?$/i.test(file) ? 'spreadsheetEditor.xlsx' : 'spreadsheetEditor.csv');
  const posted = [];
  let onMsg;
  let onDispose = () => {};
  const panel = {
    active: true, visible: true,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: (f) => { onDispose = f; return { dispose() {} }; }, reveal() {},
  };
  const p = stub.providers.get(viewType);
  const uri = stub.vscode.Uri.file(file);
  const doc = await p.openCustomDocument(uri, {});
  stub.docs.push(doc);
  await p.resolveCustomEditor(doc, panel);
  stub.tabs.push({ input: { uri, viewType }, close: () => { onDispose(); doc.dispose(); } });
  await onMsg({ type: 'ready' });
  const until = async (pred, ms = 5000) => { const t0 = Date.now(); while (!posted.some(pred)) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } return posted.find(pred); };
  if (!doc.fatal) await until((m) => m.type === 'meta');
  return { doc, panel, posted, send: (m) => onMsg(m), until };
}

module.exports = { create, loadExtension, openInEditor };
