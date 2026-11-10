'use strict';
// Zovo Pro for Spreadsheet Editor, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license by apply.sh). Three Pro tools, 3 free tries each on this computer. A try counts only after
// the tool produced its output (a replacement written, a large file opened, a new file saved); Escape or Cancel never
// uses one. Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no
// tries left. Opening, viewing, editing, saving, find and replace, sort, filter and SQL filter are free and stay free.
const { createLicense } = require('./license');

const SKU = 'spreadsheet-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'spreadsheetEditor.proTrial';

const FEATURES = {
  'multi-file-replace': {
    title: 'Find and Replace in CSV Files',
    detail: 'Replaces text in every CSV and TSV file of the workspace at once, with match case, regex and whole cell. Rows that do not change stay byte for byte.',
  },
  'large-files': {
    title: 'Edit files past the free size limits',
    detail: 'Opens CSV files over 512 MB for editing (up to 2,000 MB) and workbooks over 40 MB (up to 200 MB).',
  },
  'save-filtered': {
    title: 'Save filtered rows as a new file',
    detail: 'Writes the rows that the filter or SQL condition shows, in their sorted order, to a new CSV or XLSX file. The open file is not changed.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

const FREE_FEATURES = Object.freeze([
  'open-csv', 'open-excel', 'edit', 'save', 'undo', 'find-replace', 'regex', 'sort', 'filter', 'sql-filter',
  'insert-delete-move', 'paste', 'fill-down', 'column-stats', 'encodings', 'delimiters', 'save-utf8-copy',
]);
const PRO_FEATURES = Object.freeze(Object.entries(FEATURES).map(([id, f]) => ({ id, title: f.title })));

// Free caps. They equal the setting defaults of this release, so a free user keeps everything the free build gives.
const FREE_LIMITS = Object.freeze({ maxEditSizeMB: 512, maxFileSizeMB: 1024, maxExcelSizeMB: 40 });
// Pro defaults, used for a setting the user has not set. A value the user set always wins. CSV stays under 2 GiB:
// Node reads a file into one buffer of at most 2 GiB.
const PRO_DEFAULTS = Object.freeze({ maxEditSizeMB: 2000, maxFileSizeMB: 2000, maxExcelSizeMB: 200 });

function isEnabled(featureId, ent) {
  if (FREE_FEATURES.includes(featureId)) return true;
  if (!PRO_FEATURES.some((f) => f.id === featureId)) return false;
  return !!(ent && ent.enabled && ent.licensed);
}

/**
 * Limits for this tier.
 * - ent.enabled false: the settings as they are (kept for tests of the old switch).
 * - Pro on, no license: settings capped at FREE_LIMITS (a lower setting still wins).
 * - Licensed, or a Pro try for this one file: settings the user set win; the rest use PRO_DEFAULTS.
 */
function effectiveLimits(settings, ent, userSet = []) {
  const out = { ...settings, capped: [] };
  if (!ent || !ent.enabled) return out;
  for (const k of Object.keys(FREE_LIMITS)) {
    if (ent.licensed) {
      if (!userSet.includes(k)) out[k] = PRO_DEFAULTS[k];
    } else if (Number(out[k]) > FREE_LIMITS[k]) {
      out[k] = FREE_LIMITS[k];
      out.capped.push(k);
    }
  }
  return out;
}

function createPro({ vscode, context, license, prefix = 'spreadsheetEditor', productName = 'Spreadsheet Editor' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  const used = (f) => Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0;
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => !!lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, triesUsed: used(f), tools: TOOLS }));
  }

  /** After the tool produced its output: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    m[f] = used(f) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, TOOLS, SKU, TRIAL_USES, TRIAL_KEY, FREE_FEATURES, PRO_FEATURES, FREE_LIMITS, PRO_DEFAULTS, isEnabled, effectiveLimits };
