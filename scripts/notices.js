'use strict';
// Writes THIRD-PARTY-NOTICES.txt: the license text of every npm package that esbuild puts in dist/.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let esbuild;
try { esbuild = require('esbuild'); } catch { esbuild = require(path.join(root, '..', 'table-viewer-vscode', 'node_modules', 'esbuild')); }
(async () => {
  const pkgs = new Map();
  for (const entry of ['src/extension.js', 'src/worker.js', 'src/webview/main.js']) {
    const r = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, metafile: true, platform: entry.includes('webview') ? 'browser' : 'node', external: ['vscode'], absWorkingDir: root, logLevel: 'silent' });
    for (const f of Object.keys(r.metafile.inputs)) {
      const m = f.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g);
      if (!m) continue;
      const last = m[m.length - 1];
      const dir = path.join(root, f.slice(0, f.lastIndexOf(last) + last.length));
      pkgs.set(dir, true);
    }
  }
  const out = ['Third-party software in Spreadsheet Editor (bundled into dist/). Each package keeps its own license.', ''];
  const own = ['src/core/encoding.js, csv.js, table.js, query.js, stats.js: from Table Viewer by Zovo (MIT, same author).', ''];
  out.push(...own);
  for (const dir of [...pkgs.keys()].sort()) {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const lic = fs.readdirSync(dir).find(f => /^(licen[sc]e|copying)/i.test(f));
    out.push('='.repeat(78), `${pj.name} ${pj.version} (${typeof pj.license === 'string' ? pj.license : JSON.stringify(pj.license)})`, pj.homepage || (pj.repository && (pj.repository.url || pj.repository)) || '', '');
    out.push(lic ? fs.readFileSync(path.join(dir, lic), 'utf8').trim() : `License: ${pj.license}`, '');
  }
  fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'), out.join('\n') + '\n');
  console.log([...pkgs.keys()].map(d => path.basename(d)).join(' '));
})();
