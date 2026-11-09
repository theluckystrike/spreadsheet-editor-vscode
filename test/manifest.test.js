'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const { buildHtml } = require('../src/html');
const { validateWebviewMessage } = require('../src/core/protocol');
const { effectiveLimits, isEnabled, FREE_LIMITS } = require('../src/pro');
const config = require('../src/config');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('engine floor works in Cursor and Windsurf (OVX1): ^1.90.0 and @types/vscode ~1.90.0', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
});

test('display name has every word of the target phrases', () => {
  const name = pkg.displayName.toLowerCase();
  for (const phrase of ['edit csv', 'xlsx editor', 'excel editor', 'spreadsheet editor', 'csv editor']) {
    for (const w of phrase.split(' ')) assert.ok(name.includes(w), `${w} (${phrase})`);
  }
});

test('every contributed command is registered in the code', () => {
  const src = ['src/extension.js', 'src/support.js', 'src/license/index.js'].map(read).join('\n');
  for (const c of pkg.contributes.commands) {
    const short = c.command.split('.').pop();
    assert.ok(src.includes(`'${c.command}'`) || src.includes(`\`\${prefix}.${short}\``) || src.includes(`.${short}\``) || src.includes(`${short}:`), c.command);
  }
});

test('CSP: default-src none, scripts by nonce only, no remote sources', () => {
  const html = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 'a.js', styleUri: 'a.css', title: '<x>' });
  const csp = html.match(/content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]{32}'/);
  assert.match(csp, /img-src vscode-resource: blob: data:/);
  assert.ok(!/https?:/.test(csp));
  assert.ok(html.includes('&lt;x&gt;'));
});

test('no network in the shipped code: no http, https, net or fetch outside the switched-off license module', () => {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(root, 'src'));
  for (const f of files) {
    if (f.includes(`${path.sep}license${path.sep}`)) continue;
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/require\(['"](https?|net|tls|dgram|http2)['"]\)/.test(s), f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket\(/.test(s), f);
  }
  assert.equal(config.PRO_ENABLED, false, 'Pro is switched off in this build, so the license module is never loaded');
  assert.match(read('src/extension.js'), /if \(config\.PRO_ENABLED\) \{[\s\S]*require\('\.\/license'\)/);
});

test('Pro switched off: limits are the settings, nothing is locked; switched on, free keeps the defaults', () => {
  const s = { maxEditSizeMB: 512, maxFileSizeMB: 1024, maxExcelSizeMB: 40 };
  assert.deepEqual(effectiveLimits(s, { enabled: false }).maxEditSizeMB, 512);
  const free = effectiveLimits({ ...s, maxEditSizeMB: 4000 }, { enabled: true, licensed: false });
  assert.equal(free.maxEditSizeMB, FREE_LIMITS.maxEditSizeMB);
  for (const k of Object.keys(FREE_LIMITS)) assert.equal(FREE_LIMITS[k], pkg.contributes.configuration.properties[`spreadsheetEditor.${k}`].default, k);
  assert.equal(isEnabled('edit', { enabled: true, licensed: false }), true);
  assert.equal(isEnabled('find-replace', { enabled: true, licensed: false }), true);
  assert.equal(isEnabled('large-files', { enabled: true, licensed: false }), false);
  assert.equal(isEnabled('large-files', { enabled: true, licensed: true }), true);
});

test('webview messages are validated; junk is dropped', () => {
  assert.equal(validateWebviewMessage(null), null);
  assert.equal(validateWebviewMessage({ type: 'nope' }), null);
  assert.equal(validateWebviewMessage({ type: 'edit', edit: { kind: 'set', cells: [{ id: -1, col: 0, value: 'x' }] } }), null);
  assert.equal(validateWebviewMessage({ type: 'edit', edit: { kind: 'set', cells: [{ id: 1, col: 0, value: 5 }] } }), null);
  assert.deepEqual(validateWebviewMessage({ type: 'edit', edit: { kind: 'set', cells: [{ id: 1, col: 2, value: 'x' }] } }).edit.cells, [{ id: 1, col: 2, value: 'x' }]);
  assert.equal(validateWebviewMessage({ type: 'csvOptions', delimiter: '\n' }), null);
  assert.deepEqual(validateWebviewMessage({ type: 'csvOptions', delimiter: '~' }).options, { delimiter: '~' });
  assert.deepEqual(validateWebviewMessage({ type: 'csvOptions', delimiter: 'auto' }).options, { delimiter: 'auto' });
  assert.equal(validateWebviewMessage({ type: 'csvOptions', encoding: 'ebcdic' }), null);
  assert.equal(validateWebviewMessage({ type: 'getRows', start: 0, count: 99999, reqId: 1 }), null);
  assert.equal(validateWebviewMessage({ type: 'edit', edit: { kind: 'moveRows', ids: [1], dir: 2 } }), null);
});

test('CSV is an option, not the default; Excel files open here by default', () => {
  const [x, c] = pkg.contributes.customEditors;
  assert.equal(x.priority, 'default');
  assert.deepEqual(x.selector.map(s => s.filenamePattern), ['*.xlsx', '*.xlsm']);
  assert.equal(c.priority, 'option');
  assert.ok(c.selector.some(s => s.filenamePattern === '*.csv'));
});
