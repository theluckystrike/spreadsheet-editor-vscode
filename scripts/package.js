'use strict';
// npm run package: vsce package into dist/, without npm dependencies (esbuild bundles them into dist/*.js).
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const args = ['-y', '@vscode/vsce', 'package', '--no-dependencies', '-o', 'dist/', ...process.argv.slice(2)];
const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: 'inherit', cwd: root });
process.exit(r.status === null ? 1 : r.status);
