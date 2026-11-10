'use strict';
// Bundles the extension host, the worker and the webview with esbuild (from the table viewer's install,
// so this repo does not need its own esbuild copy).
const path = require('path');
const root = path.join(__dirname, '..');
let esbuild;
try { esbuild = require('esbuild'); } catch { esbuild = require(path.join(root, '..', 'table-viewer-vscode', 'node_modules', 'esbuild')); }
const prod = process.argv.includes('--production') || process.argv.includes('production');
const common = { bundle: true, minify: prod, sourcemap: !prod, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] }),
  esbuild.build({ ...common, entryPoints: ['src/worker.js'], outfile: 'dist/worker.js', platform: 'node', format: 'cjs', target: 'node18' }),
  esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
]).catch(() => process.exit(1));
