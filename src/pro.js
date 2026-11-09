'use strict';
// Free and Pro features, and the limits each tier gets. Pure functions so tests can run them with the
// Pro switch on or off. Opening, viewing, editing, saving, find and replace, sort, filter and SQL filter are
// free and stay free. Pro (when the owner turns it on) only raises the size limits past the free defaults.

const FREE_FEATURES = Object.freeze([
  'open-csv', 'open-excel', 'edit', 'save', 'undo', 'find-replace', 'regex', 'sort', 'filter', 'sql-filter',
  'insert-delete-move', 'paste', 'fill-down', 'column-stats', 'encodings', 'delimiters', 'save-utf8-copy',
]);

const PRO_FEATURES = Object.freeze([
  { id: 'large-files', title: 'Edit files past the free size limits (CSV over 512 MB, workbooks over 40 MB)' },
  // New in 0.1 and hidden while PRO_ENABLED is false, so no free user ever had it: locking it later takes nothing away.
  { id: 'multi-file-replace', title: 'Find and Replace in every CSV and TSV file of the workspace' },
]);

// Free caps, used only when Pro is switched on. They equal the defaults of this release, so a free user
// keeps everything this version gives.
const FREE_LIMITS = Object.freeze({ maxEditSizeMB: 512, maxFileSizeMB: 1024, maxExcelSizeMB: 40 });
// Pro defaults, used for a setting the user has not set. A value the user set always wins.
const PRO_DEFAULTS = Object.freeze({ maxEditSizeMB: 2048, maxFileSizeMB: 4096, maxExcelSizeMB: 200 });

function isEnabled(featureId, ent) {
  if (FREE_FEATURES.includes(featureId)) return true;
  if (!PRO_FEATURES.some(f => f.id === featureId)) return false;
  return !!(ent && ent.enabled && ent.licensed);
}

/**
 * Limits for this tier.
 * - Pro switched off: the settings as they are.
 * - Pro on, no license: settings capped at FREE_LIMITS.
 * - Licensed: settings the user set win; the rest use PRO_DEFAULTS.
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

module.exports = { FREE_FEATURES, PRO_FEATURES, FREE_LIMITS, PRO_DEFAULTS, isEnabled, effectiveLimits };
