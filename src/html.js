'use strict';
// Builds the webview HTML. Kept free of the vscode module so tests can check the CSP.

const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

/** CSP nonce from a cryptographic source: 32 base64url characters (192 bits). */
function nonce() {
  return crypto.randomBytes(24).toString('base64url');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * p.showSupportLinks: false leaves out the small Sponsor and More free viewers line (setting spreadsheetEditor.showSupportLinks).
 * The webview script moves that line into the status bar at the bottom of the table.
 * @param {{cspSource:string, scriptUri:string, styleUri:string, title:string, nonce?:string, showSupportLinks?:boolean}} p
 */
function buildHtml(p) {
  const n = p.nonce || nonce();
  const footer = footerHtml('spreadsheetEditor', p.showSupportLinks !== false);
  const csp = [
    "default-src 'none'",
    `style-src ${p.cspSource} 'nonce-${n}'`,
    `script-src 'nonce-${n}'`,
    `img-src ${p.cspSource} blob: data:`,
    `font-src ${p.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
<title>${escapeAttr(p.title)}</title>
</head>
<body>
<div id="app" data-title="${escapeAttr(p.title)}"></div>
${footer}
<script nonce="${n}" src="${escapeAttr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, escapeAttr, nonce };
